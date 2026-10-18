/**
 * Remote file access for the app: list, read, write and tidy files on the machine the host runs on.
 *
 * Nothing here goes through the approval Guard, so the only fence is the root list: every path is made absolute,
 * resolved with realpath (so symbolic links are followed) and must land inside one of the allowed roots. Links that
 * point outside a root are refused for reads and writes and are listed as unusable instead of leaking where they go.
 *
 * Writes are staged in a hidden file next to the target and renamed over it when the last chunk arrives, so a reader
 * (or the agent) never sees half a file. An optional `expectMtime` makes the final rename conditional on the file not
 * having changed since the caller read it.
 *
 * Known limit: a check and the operation that follows it are not atomic. Someone who can swap a path for a link
 * between the two (the agent itself, with a shell) could win that race. The window is a few microseconds.
 */

import { constants, type Stats } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isInside } from "./guard.js";

export interface FsRoot {
	path: string;
	readOnly?: boolean;
}

export interface FsLimits {
	/** Largest chunk accepted by `fs_write`, and largest returned by `fs_read`, in bytes. */
	chunk: number;
	/** Largest file `fs_write` will assemble. */
	maxWrite: number;
	/** Most entries `fs_list` returns. */
	maxList: number;
	/** How long an unfinished upload may sit idle before its staging file is removed. */
	uploadTtlMs: number;
}

const DEFAULT_LIMITS: FsLimits = {
	chunk: 256 * 1024,
	maxWrite: 256 * 1024 * 1024,
	maxList: 20_000,
	uploadTtlMs: 15 * 60_000,
};

const STAGING_PREFIX = ".coderra-up-";

/** An error with a stable `code` the app can act on (Node's own errors already carry ENOENT, EEXIST, ...). */
export class FsError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "FsError";
	}
}

/** The `code` to put on a failed response, if the error has a usable one. */
export function errorCode(e: unknown): string | undefined {
	const code = (e as { code?: unknown } | null)?.code;
	return typeof code === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(code) ? code : undefined;
}

type LiveRoot = { raw: string; real: string; readOnly: boolean };
type Upload = { target: string; staging: string; size: number; touched: number };

const ms = (st: Stats) => Math.floor(st.mtimeMs);
const kind = (st: Stats) => (st.isDirectory() ? "dir" : "file");

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]);
			}
		}),
	);
	return out;
}

function int(value: unknown, name: string, fallback: number, min = 0): number {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
		throw new FsError("invalid_argument", `${name} must be an integer of at least ${min}`);
	}
	return value;
}

export class Fs {
	private readonly roots: FsRoot[];
	private readonly limits: FsLimits;
	private readonly uploads = new Map<string, Upload>();

	constructor(roots: FsRoot[], limits: Partial<FsLimits> = {}) {
		this.roots = roots.map((r) => ({ path: resolve(r.path), readOnly: !!r.readOnly }));
		this.limits = { ...DEFAULT_LIMITS, ...limits };
	}

	// -------------------------------------------------------------------------
	// Path handling

	/** Roots that exist right now, with their real paths. A root created later (e.g. the updates folder) just appears. */
	private async liveRoots(): Promise<LiveRoot[]> {
		const out: LiveRoot[] = [];
		for (const r of this.roots) {
			try {
				out.push({ raw: r.path, real: await realpath(r.path), readOnly: !!r.readOnly });
			} catch {
				// Not created yet.
			}
		}
		return out;
	}

	private clean(path: unknown): string {
		if (typeof path !== "string" || path.length === 0 || path.includes("\0")) throw new FsError("invalid_path", "Invalid path");
		if (!isAbsolute(path)) throw new FsError("invalid_path", "The path must be absolute");
		// Collapses ".." and "." lexically. The collapsed path is what every later step uses, check and operation alike.
		return resolve(path);
	}

	/** Maps a path to the real location of the root it names, or refuses it without touching the disk. */
	private async locate(path: unknown): Promise<{ p: string; roots: LiveRoot[] }> {
		const p = this.clean(path);
		const roots = await this.liveRoots();
		for (const r of roots) {
			if (isInside(p, r.real)) return { p, roots };
			if (isInside(p, r.raw)) return { p: join(r.real, relative(r.raw, p)), roots };
		}
		throw new FsError("outside_root", "That path is outside the folders this server may use");
	}

	private rootOf(real: string, roots: LiveRoot[]): LiveRoot {
		const root = roots.find((r) => isInside(real, r.real));
		if (!root) throw new FsError("outside_root", "That path is outside the folders this server may use");
		return root;
	}

	/** An existing path with links followed. The place it really is must be inside a root. */
	private async existing(path: unknown, write = false) {
		const { p, roots } = await this.locate(path);
		const real = await realpath(p);
		const root = this.rootOf(real, roots);
		if (write && root.readOnly) throw new FsError("read_only", "This folder is read-only");
		return { path: real, root };
	}

	/**
	 * A path whose last segment may not exist yet, or is a link that must not be followed (delete, rename, create).
	 * The folder it sits in is resolved, walking up past folders that do not exist yet.
	 */
	private async entry(path: unknown, write = true) {
		const { p, roots } = await this.locate(path);
		const name = basename(p);
		let cur = dirname(p);
		const rest: string[] = [];
		let real: string | null = null;
		for (;;) {
			try {
				real = join(await realpath(cur), ...rest, name);
				break;
			} catch (e) {
				const code = (e as { code?: string }).code;
				const up = dirname(cur);
				if ((code !== "ENOENT" && code !== "ENOTDIR") || up === cur) throw e;
				rest.unshift(basename(cur));
				cur = up;
			}
		}
		const root = this.rootOf(real, roots);
		if (write && root.readOnly) throw new FsError("read_only", "This folder is read-only");
		return { path: real, root, isRoot: real === root.real };
	}

	// -------------------------------------------------------------------------
	// Reading

	async list(path: unknown, detectGit = false) {
		const dir = await this.existing(path);
		if (!(await stat(dir.path)).isDirectory()) throw new FsError("ENOTDIR", "Not a folder");
		const names = await readdir(dir.path);
		if (names.length > this.limits.maxList) {
			throw new FsError("too_large", `The folder has more than ${this.limits.maxList} entries`);
		}
		const roots = await this.liveRoots();
		const rows = await mapLimit(names, 64, async (name) => {
			const full = join(dir.path, name);
			let l: Stats;
			try {
				l = await lstat(full);
			} catch {
				return null; // removed while listing
			}
			if (l.isSymbolicLink()) {
				// Report the target's type only when it stays inside the roots; otherwise the link is just unusable.
				let t: Stats | null = null;
				try {
					const real = await realpath(full);
					if (roots.some((r) => isInside(real, r.real))) t = await stat(real);
				} catch {
					// Dangling.
				}
				return { name, type: t ? kind(t) : "missing", size: t?.size ?? 0, mtime: ms(t ?? l), link: true, git: false };
			}
			const isDir = l.isDirectory();
			let git = false;
			if (detectGit && isDir) git = await stat(join(full, ".git")).then((s) => s.isDirectory(), () => false);
			return { name, type: kind(l), size: l.size, mtime: ms(l), link: false, git };
		});
		return rows.filter((r) => r !== null);
	}

	async stat(path: unknown) {
		let st: Stats;
		try {
			st = await stat((await this.existing(path)).path);
		} catch (e) {
			const code = (e as { code?: string }).code;
			if (code === "ENOENT" || code === "ENOTDIR") return { exists: false, type: "missing", size: -1, mtime: 0 };
			throw e;
		}
		return { exists: true, type: kind(st), size: st.size, mtime: ms(st) };
	}

	async read(path: unknown, offset = 0, length?: number) {
		const off = int(offset, "offset", 0);
		const len = Math.min(int(length, "length", this.limits.chunk, 1), this.limits.chunk);
		const { path: real } = await this.existing(path);
		// O_NONBLOCK: opening a named pipe for reading would otherwise wait for a writer forever. The type is checked
		// on the open handle, so a path swapped for a pipe after the checks above cannot slip through either.
		const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			const st = await handle.stat();
			if (st.isDirectory()) throw new FsError("EISDIR", "That is a folder, not a file");
			if (!st.isFile()) throw new FsError("not_a_file", "That is not a regular file");
			const buf = Buffer.alloc(len);
			const { bytesRead } = await handle.read(buf, 0, len, off);
			return {
				data: buf.subarray(0, bytesRead).toString("base64"),
				size: st.size,
				mtime: ms(st),
				eof: off + bytesRead >= st.size,
			};
		} finally {
			await handle.close();
		}
	}

	// -------------------------------------------------------------------------
	// Writing

	/** Removes staging files of uploads that were started and never finished. */
	private async sweep() {
		const now = Date.now();
		for (const [id, u] of this.uploads) {
			if (now - u.touched > this.limits.uploadTtlMs) {
				this.uploads.delete(id);
				await unlink(u.staging).catch(() => {});
			}
		}
	}

	private async drop(id: string) {
		const u = this.uploads.get(id);
		this.uploads.delete(id);
		if (u) await unlink(u.staging).catch(() => {});
	}

	/** Where a write to `path` really lands: through a link if the last segment is one, never onto a folder. */
	private async writeTarget(path: unknown) {
		const e = await this.entry(path, true);
		let target = e.path;
		let current: Stats | null = await lstat(target).catch(() => null);
		if (current?.isSymbolicLink()) {
			// Keep the link: write to what it points at, which must itself be a writable place inside the roots.
			target = (await this.existing(path, true)).path;
			current = await stat(target);
		}
		if (e.isRoot || current?.isDirectory()) throw new FsError("EISDIR", "That is a folder, not a file");
		return { target, current };
	}

	/**
	 * `fs_write`: one chunk of a file. A file that fits in one chunk is a single call with `final: true`.
	 * Larger ones send consecutive chunks with the same `uploadId` and growing `offset`; the file appears at its path
	 * when the chunk marked `final` arrives. `abort: true` throws an unfinished upload away; `status: true` says how many
	 * bytes of one have arrived (`received`, or null if there is no such upload).
	 */
	async write(a: Record<string, any>) {
		await this.sweep();
		const id = a.uploadId === undefined ? undefined : String(a.uploadId);
		if (id !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new FsError("invalid_argument", "Invalid uploadId");
		if (a.abort === true) {
			if (id) await this.drop(id);
			return {};
		}
		// Where an upload stands, for a client that lost its connection and does not know whether its last chunk arrived.
		if (a.status === true) {
			const u = id ? this.uploads.get(id) : undefined;
			return { received: u ? u.size : null };
		}
		if (typeof a.data !== "string") throw new FsError("invalid_argument", "data must be a base64 string");
		const offset = int(a.offset, "offset", 0);
		const final = a.final !== false;
		const expect = a.expectMtime === undefined || a.expectMtime === null ? undefined : int(a.expectMtime, "expectMtime", 0);
		if (id === undefined && !(offset === 0 && final)) throw new FsError("invalid_argument", "A chunked write needs an uploadId");
		const bytes = Buffer.from(a.data, "base64");
		if (bytes.length > this.limits.chunk * 4) throw new FsError("too_large", "Chunk is too large");

		const { target, current } = await this.writeTarget(a.path);
		const key = id ?? `once-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		const conflict = () => new FsError("conflict", "The file changed since it was read");
		const unchanged = async () => {
			if (expect === undefined) return;
			const now = await stat(target).catch(() => null);
			if (!now || ms(now) !== expect) throw conflict();
		};

		try {
			let u: Upload;
			if (offset === 0) {
				await this.drop(key);
				await unchanged();
				u = { target, staging: join(dirname(target), STAGING_PREFIX + key), size: 0, touched: Date.now() };
				this.uploads.set(key, u);
				// A leftover name (even a link someone planted there) is removed, then created exclusively so nothing
				// is ever written through a link.
				await unlink(u.staging).catch(() => {});
				await this.append(u.staging, bytes, constants.O_EXCL | constants.O_CREAT, 0o600);
			} else {
				const found = this.uploads.get(key);
				if (!found || found.target !== target) throw new FsError("bad_offset", "No upload in progress for that file");
				if (found.size !== offset) throw new FsError("bad_offset", `Expected offset ${found.size}, got ${offset}`);
				u = found;
				await this.append(u.staging, bytes, 0);
			}
			u.size += bytes.length;
			u.touched = Date.now();
			if (u.size > this.limits.maxWrite) throw new FsError("too_large", "The file is too large");
			if (!final) return { received: u.size };

			await unchanged();
			// A rename gives the file a new inode; keep the mode so an edited script stays executable.
			await chmod(u.staging, current ? current.mode & 0o7777 : 0o644);
			await rename(u.staging, target);
			this.uploads.delete(key);
			const st = await stat(target);
			return { size: st.size, mtime: ms(st) };
		} catch (e) {
			// A chunk at the wrong offset says nothing against the upload so far: the client can ask where it stands.
			if (!(e instanceof FsError && e.code === "bad_offset" && offset !== 0)) await this.drop(key);
			throw e;
		}
	}

	/** Appends to a staging file without following links. */
	private async append(file: string, bytes: Buffer, extra: number, mode?: number) {
		const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | extra, mode);
		try {
			await handle.writeFile(bytes);
		} finally {
			await handle.close();
		}
	}

	async mkdir(path: unknown, recursive = true) {
		const e = await this.entry(path, true);
		if (e.isRoot) return {};
		await mkdir(e.path, { recursive });
		return {};
	}

	async rename(from: unknown, to: unknown) {
		const src = await this.entry(from, true);
		const dst = await this.entry(to, true);
		if (src.isRoot) throw new FsError("EPERM", "A root folder cannot be moved");
		await lstat(src.path); // ENOENT if it is not there
		if (src.path === dst.path) return {};
		if (isInside(dst.path, src.path)) throw new FsError("EINVAL", "A folder cannot be moved into itself");
		if (await lstat(dst.path).then(() => true, () => false)) throw new FsError("EEXIST", "Something with that name already exists");
		await rename(src.path, dst.path);
		return {};
	}

	async copy(from: unknown, to: unknown) {
		const src = await this.existing(from, false);
		const dst = await this.entry(to, true);
		const st = await stat(src.path);
		if (st.isDirectory() && isInside(dst.path, src.path)) throw new FsError("EINVAL", "A folder cannot be copied into itself");
		if (await lstat(dst.path).then(() => true, () => false)) throw new FsError("EEXIST", "Something with that name already exists");
		if (st.isDirectory()) {
			// Links inside the folder are copied as links, exactly as they are written.
			await cp(src.path, dst.path, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
		} else if (st.isFile()) {
			await copyFile(src.path, dst.path, constants.COPYFILE_EXCL);
		} else {
			throw new FsError("not_a_file", "That is not a regular file");
		}
		return {};
	}

	async delete(path: unknown, recursive = false) {
		const e = await this.entry(path, true);
		if (e.isRoot) throw new FsError("EPERM", "A root folder cannot be deleted");
		const l = await lstat(e.path);
		if (!l.isDirectory()) {
			// Files and links, including a link to a folder: only the name goes, never what it points at.
			await unlink(e.path);
		} else if (recursive) {
			await rm(e.path, { recursive: true });
		} else {
			await rmdir(e.path);
		}
		return {};
	}
}

export const isFsCommand = (type: unknown): boolean => typeof type === "string" && type.startsWith("fs_");

/** Runs one `fs_*` command from the app's JSONL protocol. */
export function runFsCommand(fs: Fs, cmd: Record<string, any>): Promise<unknown> {
	switch (cmd.type) {
		case "fs_list":
			return fs.list(cmd.path, cmd.detectGit === true);
		case "fs_stat":
			return fs.stat(cmd.path);
		case "fs_read":
			return fs.read(cmd.path, cmd.offset, cmd.length);
		case "fs_write":
			return fs.write(cmd);
		case "fs_mkdir":
			return fs.mkdir(cmd.path, cmd.recursive !== false);
		case "fs_rename":
			return fs.rename(cmd.from, cmd.to);
		case "fs_copy":
			return fs.copy(cmd.from, cmd.to);
		case "fs_delete":
			return fs.delete(cmd.path, cmd.recursive === true);
		default:
			return Promise.reject(new FsError("unknown_command", `Unknown command: ${cmd.type}`));
	}
}
