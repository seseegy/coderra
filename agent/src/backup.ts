/**
 * Backups of the agent's state (and optionally the workspace) as a zip, and restoring them.
 *
 * The zip is written and read one file at a time, in small pieces, so a big workspace costs neither memory nor a frozen
 * host: on a server the same process also runs the agent and answers the app's pings, and a backup that held everything
 * in memory and compressed it in one blocking call could get the app disconnected or the process killed.
 *
 * The format is the ordinary (non-ZIP64) zip, which every tool reads, so it has two hard limits: 65,535 files and 4 GB.
 * They are checked before anything is written, and a backup that would break them says so instead of producing a damaged
 * file. Files over a size cap are left out and listed, never left out silently. Symbolic links are never followed.
 */

import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw, createInflateRaw } from "node:zlib";
import { isInside } from "./guard.js";

export interface BackupLimits {
	/** Zip without ZIP64 cannot hold more entries than this. */
	maxEntries: number;
	/** Total bytes before compression. */
	maxBytes: number;
	/** A file bigger than this is left out (and reported). */
	maxFileBytes: number;
}

export const DEFAULT_BACKUP_LIMITS: BackupLimits = {
	maxEntries: 60_000,
	maxBytes: 3 * 1024 ** 3,
	maxFileBytes: 256 * 1024 * 1024,
};

/** A problem the user can do something about (the code is for the app). */
export class BackupError extends Error {
	constructor(
		readonly code: "too_many_files" | "too_large" | "bad_zip" | "io",
		message: string,
	) {
		super(message);
		this.name = "BackupError";
	}
}

export interface Left {
	path: string;
	reason: "large" | "link" | "unreadable";
}

export interface BackupResult {
	path: string;
	files: number;
	bytes: number;
	left: Left[];
}

const NOT_IN_BACKUPS = new Set(["node_modules", ".git", "bin", ".cache"]);

interface Item {
	/** Name inside the zip. */
	name: string;
	file: string;
	size: number;
}

/** Every file under [dir] (not through links), named [prefix]/<path relative to dir>. */
async function walk(dir: string, prefix: string, skip: Set<string>, items: Item[], left: Left[], root = dir) {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (skip.has(name)) continue;
		const p = join(dir, name);
		try {
			const st = await lstat(p);
			if (st.isSymbolicLink()) left.push({ path: relative(root, p), reason: "link" });
			else if (st.isDirectory()) await walk(p, prefix, skip, items, left, root);
			else if (st.isFile()) items.push({ name: `${prefix}/${relative(root, p).split(sep).join("/")}`, file: p, size: st.size });
		} catch {
			left.push({ path: relative(root, p), reason: "unreadable" });
		}
	}
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crcUpdate(crc: number, buf: Uint8Array): number {
	let c = crc;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return c;
}

export interface BackupSources {
	agentDir: string;
	workspace: string;
	includeWorkspace: boolean;
}

/** What goes into a backup: the agent's sessions, skills, prompts and settings; secrets (provider keys, tokens) are left out on purpose. */
async function gather(src: BackupSources, left: Left[]): Promise<Item[]> {
	const items: Item[] = [];
	for (const sub of ["sessions", "skills", "prompts"]) await walk(join(src.agentDir, sub), "agent", NOT_IN_BACKUPS, items, left, src.agentDir);
	for (const f of ["settings.json", "AGENTS.md", "andropi/runs.json"]) {
		try {
			const p = join(src.agentDir, f);
			const st = await lstat(p);
			if (st.isFile()) items.push({ name: `agent/${f}`, file: p, size: st.size });
		} catch {
			// Not there: nothing to back up.
		}
	}
	if (src.includeWorkspace) {
		await walk(src.workspace, "workspace", new Set([...NOT_IN_BACKUPS, "backups", ".venv", "venv"]), items, left);
	}
	return items;
}

/** What a backup would contain, without making it: the app shows this before a big one. */
export async function estimateBackup(src: BackupSources, limits: BackupLimits = DEFAULT_BACKUP_LIMITS) {
	const left: Left[] = [];
	const items = await gather(src, left);
	const kept = items.filter((i) => i.size <= limits.maxFileBytes);
	return { files: kept.length, bytes: kept.reduce((n, i) => n + i.size, 0), tooLarge: items.length - kept.length };
}

/**
 * Writes the zip to [target] (through a temporary name, so a failed backup leaves nothing that looks complete).
 * Files are read and compressed as streams, one at a time.
 */
export async function createBackup(src: BackupSources, target: string, limits: BackupLimits = DEFAULT_BACKUP_LIMITS): Promise<BackupResult> {
	const left: Left[] = [];
	const all = await gather(src, left);
	const items: Item[] = [];
	for (const i of all) {
		if (i.size > limits.maxFileBytes) left.push({ path: i.name, reason: "large" });
		else items.push(i);
	}
	const total = items.reduce((n, i) => n + i.size, 0);
	if (items.length > limits.maxEntries) {
		throw new BackupError("too_many_files", `That is ${items.length} files; a zip holds at most ${limits.maxEntries}. Back up without the workspace files, or clean the workspace up first.`);
	}
	if (total > limits.maxBytes) {
		throw new BackupError("too_large", `That is ${(total / 1024 ** 3).toFixed(1)} GB; a backup holds at most ${(limits.maxBytes / 1024 ** 3).toFixed(1)} GB. Back up without the workspace files.`);
	}

	await mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.part`;
	const out = await open(tmp, "w", 0o600);
	let offset = 0;
	const central: Buffer[] = [];
	const write = async (b: Buffer) => {
		await out.write(b);
		offset += b.length;
	};
	try {
		for (const item of items) {
			const name = Buffer.from(item.name, "utf8");
			const headerOffset = offset;
			// Sizes and checksum are not known until the file has been read: they follow the data (flag bit 3).
			const local = Buffer.alloc(30);
			local.writeUInt32LE(0x04034b50, 0);
			local.writeUInt16LE(20, 4);
			local.writeUInt16LE(0x0808, 6); // UTF-8 names, sizes after the data
			local.writeUInt16LE(8, 8); // deflate
			local.writeUInt16LE(name.length, 26);
			await write(Buffer.concat([local, name]));

			let crc = 0xffffffff;
			let size = 0;
			let packed = 0;
			const deflate = createDeflateRaw();
			const source = createReadStream(item.file);
			source.on("data", (chunk) => {
				crc = crcUpdate(crc, chunk as Buffer);
				size += (chunk as Buffer).length;
			});
			source.on("error", (e) => deflate.destroy(e));
			source.pipe(deflate);
			for await (const piece of deflate) {
				packed += (piece as Buffer).length;
				await write(piece as Buffer);
			}
			const sum = (crc ^ 0xffffffff) >>> 0;

			const descriptor = Buffer.alloc(16);
			descriptor.writeUInt32LE(0x08074b50, 0);
			descriptor.writeUInt32LE(sum, 4);
			descriptor.writeUInt32LE(packed, 8);
			descriptor.writeUInt32LE(size, 12);
			await write(descriptor);

			const c = Buffer.alloc(46);
			c.writeUInt32LE(0x02014b50, 0);
			c.writeUInt16LE(20, 4);
			c.writeUInt16LE(20, 6);
			c.writeUInt16LE(0x0808, 8);
			c.writeUInt16LE(8, 10);
			c.writeUInt32LE(sum, 16);
			c.writeUInt32LE(packed, 20);
			c.writeUInt32LE(size, 24);
			c.writeUInt16LE(name.length, 28);
			c.writeUInt32LE(headerOffset, 42);
			central.push(c, name);
		}
		const cd = Buffer.concat(central);
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(items.length, 8);
		end.writeUInt16LE(items.length, 10);
		end.writeUInt32LE(cd.length, 12);
		end.writeUInt32LE(offset, 16);
		await write(cd);
		await write(end);
		await out.close();
		if (offset >= 0xffffffff) throw new BackupError("too_large", "The backup came out larger than a zip can hold. Back up without the workspace files.");
		await rename(tmp, target);
	} catch (e) {
		await out.close().catch(() => {});
		await rm(tmp, { force: true });
		if (e instanceof BackupError) throw e;
		throw new BackupError("io", `The backup could not be written: ${(e as Error).message}`);
	}
	return { path: target, files: items.length, bytes: total, left };
}

// ---------------------------------------------------------------------------
// Restoring

interface ZipEntry {
	name: string;
	method: number;
	crc: number;
	packed: number;
	size: number;
	offset: number;
}

async function readAt(fh: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
	const buf = Buffer.alloc(length);
	const { bytesRead } = await fh.read(buf, 0, length, position);
	return buf.subarray(0, bytesRead);
}

/** The entries of a zip, read from its central directory. */
export async function listZip(path: string): Promise<ZipEntry[]> {
	let fh: Awaited<ReturnType<typeof open>>;
	try {
		fh = await open(path, "r");
	} catch (e) {
		throw new BackupError("io", `Cannot open the backup: ${(e as Error).message}`);
	}
	try {
		const { size } = await fh.stat();
		const tailLength = Math.min(size, 22 + 65_535);
		const tail = await readAt(fh, size - tailLength, tailLength);
		const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
		if (eocd < 0 || eocd + 22 > tail.length) throw new BackupError("bad_zip", "That file is not a zip backup.");
		const count = tail.readUInt16LE(eocd + 10);
		const cdSize = tail.readUInt32LE(eocd + 12);
		const cdOffset = tail.readUInt32LE(eocd + 16);
		if (cdOffset + cdSize > size) throw new BackupError("bad_zip", "The backup is damaged (its table of contents is cut off).");
		const cd = await readAt(fh, cdOffset, cdSize);
		const entries: ZipEntry[] = [];
		let p = 0;
		for (let i = 0; i < count; i++) {
			if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new BackupError("bad_zip", "The backup is damaged (its table of contents is wrong).");
			const nameLen = cd.readUInt16LE(p + 28);
			const extra = cd.readUInt16LE(p + 30);
			const comment = cd.readUInt16LE(p + 32);
			entries.push({
				name: cd.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
				method: cd.readUInt16LE(p + 10),
				crc: cd.readUInt32LE(p + 16),
				packed: cd.readUInt32LE(p + 20),
				size: cd.readUInt32LE(p + 24),
				offset: cd.readUInt32LE(p + 42),
			});
			p += 46 + nameLen + extra + comment;
		}
		return entries;
	} finally {
		await fh.close();
	}
}

export interface RestoreResult {
	restored: number;
	skipped: { name: string; reason: string }[];
}

/** Where an entry goes, or why it does not: only agent/ and workspace/, only inside them, never up or absolute. */
function destination(name: string, roots: { agent: string; workspace: string }): { target: string; base: string } | string {
	const clean = name.replace(/\\/g, "/");
	if (clean.endsWith("/")) return "folder";
	const parts = clean.split("/");
	if (parts.some((p) => p === ".." || p === "." || p === "" || p.includes("\0"))) return "unsafe path";
	const [root, ...rest] = parts;
	if (rest.length === 0) return "not in agent/ or workspace/";
	const base = root === "agent" ? roots.agent : root === "workspace" ? roots.workspace : null;
	if (!base) return "not in agent/ or workspace/";
	const target = resolve(base, ...rest);
	return isInside(target, base) ? { target, base } : "unsafe path";
}

/**
 * Puts the files of a backup back. Each file is written beside its place and moved over it, so a failed restore never
 * leaves a half-written file, and nothing is written through a link. [limits] guards against a zip that claims to hold far
 * more than it should.
 */
export async function restoreBackup(path: string, roots: { agent: string; workspace: string }, limits: BackupLimits = DEFAULT_BACKUP_LIMITS): Promise<RestoreResult> {
	const entries = await listZip(path);
	const declared = entries.reduce((n, e) => n + e.size, 0);
	if (declared > limits.maxBytes) throw new BackupError("too_large", "That backup claims to hold more than a backup can; it is not restored.");
	const real = { agent: await realpath(roots.agent).catch(() => roots.agent), workspace: await realpath(roots.workspace).catch(() => roots.workspace) };
	const fh = await open(path, "r");
	const result: RestoreResult = { restored: 0, skipped: [] };
	try {
		for (const e of entries) {
			const where = destination(e.name, roots);
			if (typeof where === "string") {
				if (where !== "folder") result.skipped.push({ name: e.name, reason: where });
				continue;
			}
			try {
				await mkdir(dirname(where.target), { recursive: true });
				// A folder on the way may be a link that leads out of the place being restored into.
				const realBase = where.base === roots.agent ? real.agent : real.workspace;
				if (!isInside(await realpath(dirname(where.target)), realBase)) {
					result.skipped.push({ name: e.name, reason: "goes through a link" });
					continue;
				}
				await extract(fh, e, where.target);
				result.restored++;
			} catch (err) {
				result.skipped.push({ name: e.name, reason: (err as Error).message });
			}
		}
	} finally {
		await fh.close();
	}
	return result;
}

async function extract(fh: Awaited<ReturnType<typeof open>>, e: ZipEntry, target: string) {
	const local = await readAt(fh, e.offset, 30);
	if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error("damaged entry");
	const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
	if (e.method !== 0 && e.method !== 8) throw new Error(`unsupported compression (${e.method})`);

	const staging = `${target}.coderra-restore-${process.pid}`;
	await rm(staging, { force: true });
	// O_EXCL | O_NOFOLLOW: a name someone planted is not written through.
	const out = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
	let crc = 0xffffffff;
	let written = 0;
	async function* packed() {
		let position = start;
		const end = start + e.packed;
		while (position < end) {
			const chunk = await readAt(fh, position, Math.min(64 * 1024, end - position));
			if (chunk.length === 0) throw new Error("cut off");
			position += chunk.length;
			yield chunk;
		}
	}
	const sink = new Writable({
		async write(chunk: Buffer, _encoding, done) {
			try {
				// Never more than the entry says it holds, however well it compresses.
				if (written + chunk.length > e.size) throw new Error("holds more than it says");
				crc = crcUpdate(crc, chunk);
				written += chunk.length;
				await out.write(chunk);
				done();
			} catch (err) {
				done(err as Error);
			}
		},
	});
	try {
		await pipeline(Readable.from(packed()), ...(e.method === 8 ? [createInflateRaw()] : []), sink);
		if (written !== e.size || ((crc ^ 0xffffffff) >>> 0) !== e.crc) throw new Error("does not match its checksum");
		await out.close();
		await rename(staging, target);
	} catch (err) {
		await out.close().catch(() => {});
		await rm(staging, { force: true });
		throw err;
	}
}
