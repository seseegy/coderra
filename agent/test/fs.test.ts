import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { errorCode, Fs, FsError, isFsCommand, runFsCommand } from "../src/fs.js";
import { tempDir } from "./helpers.js";

/** A workspace, a read-only skills folder, and a folder next to them that must stay out of reach. */
function setup(t: TestContext, limits = {}) {
	const base = tempDir(t);
	const ws = join(base, "ws");
	const skills = join(base, "skills");
	const outside = join(base, "outside");
	for (const d of [ws, skills, outside]) mkdirSync(d);
	writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
	writeFileSync(join(skills, "SKILL.md"), "skill");
	const fs = new Fs([{ path: ws }, { path: skills, readOnly: true }], limits);
	return { base, ws, skills, outside, fs };
}

/** What an operation ends with: "ok", or the code it failed with. */
async function outcome(p: Promise<unknown>): Promise<string | undefined> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return errorCode(e) ?? `no-code:${(e as Error).message}`;
	}
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");
const stagingFiles = (dir: string) => readdirSync(dir).filter((f) => f.startsWith(".coderra-up-"));

// ---------------------------------------------------------------------------
// Which paths are allowed at all

test("refuses relative paths, empty paths and NUL bytes", async (t) => {
	const { fs, ws } = setup(t);
	for (const bad of ["relative/path", "", "a\0b", `${ws}/a\0b`, undefined, 42]) {
		assert.equal(await outcome(fs.list(bad)), "invalid_path", String(bad));
	}
});

test("refuses everything outside the roots without saying whether it exists", async (t) => {
	const { fs, ws, outside, base } = setup(t);
	for (const path of [outside, join(outside, "secret.txt"), "/etc/passwd", "/definitely/not/there", "/", `${ws}-evil/x`, join(base, "wsx")]) {
		assert.equal(await outcome(fs.list(path)), "outside_root", `list ${path}`);
		assert.equal(await outcome(fs.stat(path)), "outside_root", `stat ${path}`);
		assert.equal(await outcome(fs.read(path)), "outside_root", `read ${path}`);
	}
});

test("resolves .. before deciding, so it cannot be used to climb out", async (t) => {
	const { fs, ws } = setup(t);
	assert.equal(await outcome(fs.read(`${ws}/../outside/secret.txt`)), "outside_root");
	assert.equal(await outcome(fs.list(`${ws}/sub/../../outside`)), "outside_root");
	mkdirSync(join(ws, "sub"));
	writeFileSync(join(ws, "a.txt"), "a");
	assert.equal((await fs.read(`${ws}/sub/../a.txt`)).data, b64("a"));
});

test("a link that points outside the roots cannot be read, listed, written or copied from", async (t) => {
	const { fs, ws, outside } = setup(t);
	symlinkSync(outside, join(ws, "dirlink"));
	symlinkSync(join(outside, "secret.txt"), join(ws, "filelink"));

	assert.equal(await outcome(fs.list(join(ws, "dirlink"))), "outside_root");
	assert.equal(await outcome(fs.read(join(ws, "dirlink/secret.txt"))), "outside_root");
	assert.equal(await outcome(fs.read(join(ws, "filelink"))), "outside_root");
	assert.equal(await outcome(fs.stat(join(ws, "filelink"))), "outside_root");
	assert.equal(await outcome(fs.write({ path: join(ws, "dirlink/new.txt"), data: b64("x") })), "outside_root");
	assert.equal(await outcome(fs.write({ path: join(ws, "filelink"), data: b64("overwritten") })), "outside_root");
	assert.equal(await outcome(fs.mkdir(join(ws, "dirlink/sub"))), "outside_root");
	assert.equal(await outcome(fs.copy(join(ws, "filelink"), join(ws, "stolen.txt"))), "outside_root");
	assert.equal(await outcome(fs.copy(join(ws, "dirlink"), join(ws, "stolen"))), "outside_root");
	assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "TOP SECRET");
	assert.equal(existsSync(join(outside, "new.txt")), false);
	assert.equal(existsSync(join(ws, "stolen.txt")), false);
});

test("listing shows outside links as unusable, without their target", async (t) => {
	const { fs, ws, outside } = setup(t);
	symlinkSync(outside, join(ws, "escape"));
	symlinkSync(join(ws, "nowhere"), join(ws, "dangling"));
	mkdirSync(join(ws, "real"));
	symlinkSync(join(ws, "real"), join(ws, "inside"));

	const rows = Object.fromEntries((await fs.list(ws)).map((r) => [r.name, r]));
	assert.deepEqual([rows.escape.type, rows.escape.link], ["missing", true]);
	assert.deepEqual([rows.dangling.type, rows.dangling.link], ["missing", true]);
	assert.deepEqual([rows.inside.type, rows.inside.link], ["dir", true]);
	assert.deepEqual([rows.real.type, rows.real.link], ["dir", false]);
	assert.equal(JSON.stringify(rows).includes(outside), false, "the target path is not reported");
});

test("a root reached through a link still works", async (t) => {
	const base = tempDir(t);
	mkdirSync(join(base, "real"));
	symlinkSync(join(base, "real"), join(base, "alias"));
	writeFileSync(join(base, "real/a.txt"), "a");
	const fs = new Fs([{ path: join(base, "alias") }]);
	assert.deepEqual((await fs.list(join(base, "alias"))).map((r) => r.name), ["a.txt"]);
	assert.equal((await fs.read(join(base, "alias/a.txt"))).data, b64("a"));
	assert.equal((await fs.read(join(base, "real/a.txt"))).data, b64("a"));
});

test("a root that does not exist yet becomes usable once it is created", async (t) => {
	const base = tempDir(t);
	const later = join(base, "updates");
	const fs = new Fs([{ path: join(base, "ws") }, { path: later, readOnly: true }]);
	assert.equal(await outcome(fs.list(later)), "outside_root");
	mkdirSync(later);
	writeFileSync(join(later, "app.apk"), "apk");
	assert.equal((await fs.read(join(later, "app.apk"))).data, b64("apk"));
});

// ---------------------------------------------------------------------------
// list and stat

test("list reports type, size, modification time and git folders", async (t) => {
	const { fs, ws } = setup(t);
	writeFileSync(join(ws, "a.txt"), "hello");
	mkdirSync(join(ws, "repo/.git"), { recursive: true });
	mkdirSync(join(ws, "plain"));

	const rows = Object.fromEntries((await fs.list(ws, true)).map((r) => [r.name, r]));
	assert.deepEqual([rows["a.txt"].type, rows["a.txt"].size, rows["a.txt"].git], ["file", 5, false]);
	assert.equal(rows.repo.type, "dir");
	assert.equal(rows.repo.git, true);
	assert.equal(rows.plain.git, false);
	assert.ok(Math.abs(rows["a.txt"].mtime - Date.now()) < 60_000);
	assert.equal(Number.isInteger(rows["a.txt"].mtime), true);
	// Without detectGit nothing is flagged.
	assert.equal((await fs.list(ws)).some((r) => r.git), false);
});

test("list errors: missing folder, a file, too many entries", async (t) => {
	const { fs, ws } = setup(t, { maxList: 3 });
	assert.equal(await outcome(fs.list(join(ws, "nope"))), "ENOENT");
	writeFileSync(join(ws, "f"), "x");
	assert.equal(await outcome(fs.list(join(ws, "f"))), "ENOTDIR");
	for (const n of ["a", "b", "c"]) writeFileSync(join(ws, n), n);
	assert.equal(await outcome(fs.list(ws)), "too_large");
});

test("stat tells files, folders and nothing apart", async (t) => {
	const { fs, ws } = setup(t);
	writeFileSync(join(ws, "a.txt"), "abc");
	mkdirSync(join(ws, "d"));
	symlinkSync(join(ws, "nowhere"), join(ws, "dangling"));
	assert.deepEqual(await fs.stat(join(ws, "a.txt")), { exists: true, type: "file", size: 3, mtime: Math.floor(statSync(join(ws, "a.txt")).mtimeMs) });
	assert.equal((await fs.stat(join(ws, "d"))).type, "dir");
	assert.equal((await fs.stat(join(ws, "nope"))).exists, false);
	assert.equal((await fs.stat(join(ws, "dangling"))).exists, false);
	assert.equal((await fs.stat(join(ws, "a.txt/inside"))).exists, false, "a path below a file");
});

// ---------------------------------------------------------------------------
// read

test("read returns a file in chunks with size, mtime and eof", async (t) => {
	const { fs, ws } = setup(t);
	const data = Buffer.alloc(600 * 1024);
	for (let i = 0; i < data.length; i++) data[i] = i % 251;
	writeFileSync(join(ws, "big.bin"), data);

	const parts: Buffer[] = [];
	let offset = 0;
	let reads = 0;
	for (;;) {
		const r = await fs.read(join(ws, "big.bin"), offset, 1024 * 1024); // asks for more than the cap
		const chunk = unb64(r.data);
		assert.ok(chunk.length <= 256 * 1024, "the chunk cap holds");
		assert.equal(r.size, data.length);
		parts.push(chunk);
		offset += chunk.length;
		reads++;
		if (r.eof) break;
	}
	assert.equal(reads, 3);
	assert.ok(Buffer.concat(parts).equals(data));
});

test("read handles empty files, offsets past the end, and bad arguments", async (t) => {
	const { fs, ws } = setup(t);
	writeFileSync(join(ws, "empty"), "");
	assert.deepEqual(await fs.read(join(ws, "empty")), { data: "", size: 0, mtime: Math.floor(statSync(join(ws, "empty")).mtimeMs), eof: true });
	writeFileSync(join(ws, "short"), "abc");
	assert.deepEqual(await fs.read(join(ws, "short"), 10).then((r) => [r.data, r.eof]), ["", true]);
	assert.equal(await outcome(fs.read(join(ws, "short"), -1)), "invalid_argument");
	assert.equal(await outcome(fs.read(join(ws, "short"), 1.5)), "invalid_argument");
	assert.equal(await outcome(fs.read(join(ws, "short"), 0, 0)), "invalid_argument");
	assert.equal(await outcome(fs.read(join(ws, "short"), "0" as any)), "invalid_argument");
});

test("read refuses folders and special files", async (t) => {
	const { fs, ws } = setup(t);
	mkdirSync(join(ws, "d"));
	assert.equal(await outcome(fs.read(join(ws, "d"))), "EISDIR");
	assert.equal(await outcome(fs.read(join(ws, "missing"))), "ENOENT");
});

test("read refuses a named pipe instead of hanging on it", async (t) => {
	const { fs, ws } = setup(t);
	try {
		execFileSync("mkfifo", [join(ws, "pipe")]);
	} catch {
		t.skip("mkfifo is not available");
		return;
	}
	assert.equal(await outcome(fs.read(join(ws, "pipe"))), "not_a_file");
});

// ---------------------------------------------------------------------------
// write

test("write creates and replaces files in one call", async (t) => {
	const { fs, ws } = setup(t);
	const r = await fs.write({ path: join(ws, "a.txt"), data: b64("héllo ✓") });
	assert.equal(r.size, Buffer.byteLength("héllo ✓"));
	assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "héllo ✓");
	assert.equal(r.mtime, Math.floor(statSync(join(ws, "a.txt")).mtimeMs));
	await fs.write({ path: join(ws, "a.txt"), data: b64("v2") });
	assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "v2");
	await fs.write({ path: join(ws, "empty"), data: "" });
	assert.equal(statSync(join(ws, "empty")).size, 0);
	assert.deepEqual(stagingFiles(ws), [], "no staging file is left behind");
});

test("write keeps the mode of the file it replaces, and gives new files 0644", async (t) => {
	const { fs, ws } = setup(t);
	writeFileSync(join(ws, "run.sh"), "#!/bin/sh\n");
	chmodSync(join(ws, "run.sh"), 0o755);
	await fs.write({ path: join(ws, "run.sh"), data: b64("#!/bin/sh\necho hi\n") });
	assert.equal(statSync(join(ws, "run.sh")).mode & 0o777, 0o755);
	await fs.write({ path: join(ws, "new.txt"), data: b64("x") });
	assert.equal(statSync(join(ws, "new.txt")).mode & 0o777, 0o644);
});

test("write follows a link inside the roots and keeps the link", async (t) => {
	const { fs, ws } = setup(t);
	writeFileSync(join(ws, "real.txt"), "old");
	symlinkSync(join(ws, "real.txt"), join(ws, "alias.txt"));
	await fs.write({ path: join(ws, "alias.txt"), data: b64("new") });
	assert.equal(readFileSync(join(ws, "real.txt"), "utf8"), "new");
	assert.equal(lstatSync(join(ws, "alias.txt")).isSymbolicLink(), true);
	assert.equal(readlinkSync(join(ws, "alias.txt")), join(ws, "real.txt"));
});

test("a chunked upload shows up only when the last chunk arrives", async (t) => {
	const { fs, ws } = setup(t);
	const path = join(ws, "big.bin");
	const data = Buffer.from("0123456789".repeat(100));
	let r: any = await fs.write({ path, data: b64(data.subarray(0, 400)), offset: 0, final: false, uploadId: "up1" });
	assert.equal(r.received, 400);
	r = await fs.write({ path, data: b64(data.subarray(400, 900)), offset: 400, final: false, uploadId: "up1" });
	assert.equal(r.received, 900);
	assert.equal(existsSync(path), false, "not visible yet");
	assert.equal(stagingFiles(ws).length, 1);
	r = await fs.write({ path, data: b64(data.subarray(900)), offset: 900, final: true, uploadId: "up1" });
	assert.equal(r.size, 1000);
	assert.ok(readFileSync(path).equals(data));
	assert.deepEqual(stagingFiles(ws), []);
});

test("a chunk at the wrong offset, or for an unknown upload, is refused; a started upload is kept so the client can ask where it stands", async (t) => {
	const { fs, ws } = setup(t);
	const path = join(ws, "f");
	assert.equal(await outcome(fs.write({ path, data: b64("x"), offset: 5, final: true, uploadId: "never" })), "bad_offset");
	await fs.write({ path, data: b64("abcd"), offset: 0, final: false, uploadId: "u" });
	assert.equal(await outcome(fs.write({ path, data: b64("zz"), offset: 2, final: false, uploadId: "u" })), "bad_offset");
	assert.equal(stagingFiles(ws).length, 1, "the upload so far is still there");
	assert.deepEqual(await fs.write({ uploadId: "u", status: true }), { received: 4 });
	const done: any = await fs.write({ path, data: b64("efgh"), offset: 4, final: true, uploadId: "u" });
	assert.equal(done.size, 8);
	assert.equal(readFileSync(path, "utf8"), "abcdefgh");
	assert.deepEqual(stagingFiles(ws), []);
});

test("a first chunk that fails (here: the file changed) drops what it started", async (t) => {
	const { fs, ws } = setup(t);
	const path = join(ws, "f");
	writeFileSync(path, "old");
	assert.equal(await outcome(fs.write({ path, data: b64("new"), offset: 0, final: true, uploadId: "c", expectMtime: 1 })), "conflict");
	assert.deepEqual(stagingFiles(ws), []);
	assert.equal(readFileSync(path, "utf8"), "old");
});

test("status says how much of an upload has arrived, or that there is none", async (t) => {
	const { fs, ws } = setup(t);
	assert.deepEqual(await fs.write({ uploadId: "nothing", status: true }), { received: null });
	await fs.write({ path: join(ws, "f"), data: b64("abc"), offset: 0, final: false, uploadId: "s" });
	assert.deepEqual(await fs.write({ uploadId: "s", status: true }), { received: 3 });
	await fs.write({ uploadId: "s", abort: true });
	assert.deepEqual(await fs.write({ uploadId: "s", status: true }), { received: null });
	assert.equal(await outcome(fs.write({ uploadId: "../x", status: true })), "invalid_argument");
});

test("a chunked write must carry an uploadId, and ids are validated", async (t) => {
	const { fs, ws } = setup(t);
	assert.equal(await outcome(fs.write({ path: join(ws, "f"), data: b64("x"), offset: 0, final: false })), "invalid_argument");
	for (const id of ["../x", "a b", "", "x".repeat(65)]) {
		assert.equal(await outcome(fs.write({ path: join(ws, "f"), data: b64("x"), uploadId: id })), "invalid_argument", id);
	}
	assert.equal(await outcome(fs.write({ path: join(ws, "f"), data: 123 as any })), "invalid_argument");
});

test("abort throws an unfinished upload away", async (t) => {
	const { fs, ws } = setup(t);
	await fs.write({ path: join(ws, "f"), data: b64("abc"), offset: 0, final: false, uploadId: "gone" });
	assert.equal(stagingFiles(ws).length, 1);
	await fs.write({ uploadId: "gone", abort: true });
	assert.deepEqual(stagingFiles(ws), []);
	await fs.write({ uploadId: "unknown", abort: true }); // harmless
});

test("an upload nobody finishes is cleaned up by the next write", async (t) => {
	const { fs, ws } = setup(t, { uploadTtlMs: 1 });
	await fs.write({ path: join(ws, "f"), data: b64("abc"), offset: 0, final: false, uploadId: "stale" });
	await new Promise((r) => setTimeout(r, 15));
	await fs.write({ path: join(ws, "other"), data: b64("x") });
	assert.deepEqual(stagingFiles(ws), []);
});

test("a file over the size limit is refused and leaves nothing behind", async (t) => {
	const { fs, ws } = setup(t, { maxWrite: 10, chunk: 8 });
	await fs.write({ path: join(ws, "f"), data: b64("12345678"), offset: 0, final: false, uploadId: "u" });
	assert.equal(await outcome(fs.write({ path: join(ws, "f"), data: b64("12345678"), offset: 8, final: true, uploadId: "u" })), "too_large");
	assert.deepEqual(stagingFiles(ws), []);
	assert.equal(existsSync(join(ws, "f")), false);
	assert.equal(await outcome(fs.write({ path: join(ws, "g"), data: b64("x".repeat(40)) })), "too_large", "a single chunk far over the cap");
});

test("expectMtime: a save goes through only if the file is unchanged since it was read", async (t) => {
	const { fs, ws } = setup(t);
	const path = join(ws, "a.txt");
	writeFileSync(path, "v1");
	const { mtime } = await fs.stat(path);

	const saved: any = await fs.write({ path, data: b64("v2"), expectMtime: mtime as number });
	assert.equal(readFileSync(path, "utf8"), "v2");

	// Someone else changes it; a save based on the old mtime is refused and nothing is overwritten.
	writeFileSync(path, "theirs");
	const later = new Date(Date.now() + 5000);
	(await import("node:fs")).utimesSync(path, later, later);
	assert.equal(await outcome(fs.write({ path, data: b64("mine"), expectMtime: saved.mtime })), "conflict");
	assert.equal(readFileSync(path, "utf8"), "theirs");
	assert.deepEqual(stagingFiles(ws), []);
});

test("expectMtime is also checked when the last chunk arrives, and a vanished file is a conflict", async (t) => {
	const { fs, ws } = setup(t);
	const path = join(ws, "a.txt");
	writeFileSync(path, "v1");
	const { mtime } = await fs.stat(path);
	await fs.write({ path, data: b64("part"), offset: 0, final: false, uploadId: "u", expectMtime: mtime as number });
	writeFileSync(path, "changed meanwhile");
	const later = new Date(Date.now() + 5000);
	(await import("node:fs")).utimesSync(path, later, later);
	assert.equal(await outcome(fs.write({ path, data: b64("rest"), offset: 4, final: true, uploadId: "u", expectMtime: mtime as number })), "conflict");
	assert.equal(readFileSync(path, "utf8"), "changed meanwhile");
	assert.deepEqual(stagingFiles(ws), []);

	assert.equal(await outcome(fs.write({ path: join(ws, "deleted.txt"), data: b64("x"), expectMtime: 123 })), "conflict");
	assert.equal(existsSync(join(ws, "deleted.txt")), false);
});

test("write refuses folders, read-only roots and missing parents", async (t) => {
	const { fs, ws, skills } = setup(t);
	mkdirSync(join(ws, "d"));
	assert.equal(await outcome(fs.write({ path: join(ws, "d"), data: b64("x") })), "EISDIR");
	assert.equal(await outcome(fs.write({ path: ws, data: b64("x") })), "EISDIR");
	assert.equal(await outcome(fs.write({ path: join(skills, "SKILL.md"), data: b64("hacked") })), "read_only");
	assert.equal(await outcome(fs.write({ path: join(skills, "new.md"), data: b64("x") })), "read_only");
	assert.equal(readFileSync(join(skills, "SKILL.md"), "utf8"), "skill");
	assert.equal(await outcome(fs.write({ path: join(ws, "no/such/dir/f"), data: b64("x") })), "ENOENT");
});

test("a leftover staging name, even a planted link, is never written through", async (t) => {
	const { fs, ws, outside } = setup(t);
	symlinkSync(join(outside, "secret.txt"), join(ws, ".coderra-up-trap"));
	await fs.write({ path: join(ws, "f"), data: b64("fine"), uploadId: "trap" });
	assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "TOP SECRET");
	assert.equal(readFileSync(join(ws, "f"), "utf8"), "fine");
});

// ---------------------------------------------------------------------------
// mkdir, rename, copy, delete

test("mkdir is recursive by default and idempotent; it refuses a file in the way and read-only roots", async (t) => {
	const { fs, ws, skills } = setup(t);
	await fs.mkdir(join(ws, "a/b/c"));
	await fs.mkdir(join(ws, "a/b/c"));
	assert.equal(statSync(join(ws, "a/b/c")).isDirectory(), true);
	await fs.mkdir(ws); // the root itself already exists
	writeFileSync(join(ws, "file"), "x");
	assert.equal(await outcome(fs.mkdir(join(ws, "file"))), "EEXIST");
	assert.equal(await outcome(fs.mkdir(join(ws, "file/sub"))), "ENOTDIR");
	assert.equal(await outcome(fs.mkdir(join(ws, "x/y"), false)), "ENOENT");
	assert.equal(await outcome(fs.mkdir(join(skills, "new"))), "read_only");
});

test("rename moves files and folders, and refuses to overwrite", async (t) => {
	const { fs, ws } = setup(t);
	writeFileSync(join(ws, "a.txt"), "a");
	writeFileSync(join(ws, "b.txt"), "b");
	mkdirSync(join(ws, "d/inner"), { recursive: true });
	await fs.rename(join(ws, "a.txt"), join(ws, "moved.txt"));
	assert.equal(readFileSync(join(ws, "moved.txt"), "utf8"), "a");
	await fs.rename(join(ws, "d"), join(ws, "e"));
	assert.equal(existsSync(join(ws, "e/inner")), true);
	assert.equal(await outcome(fs.rename(join(ws, "moved.txt"), join(ws, "b.txt"))), "EEXIST");
	assert.equal(readFileSync(join(ws, "b.txt"), "utf8"), "b");
	assert.equal(await outcome(fs.rename(join(ws, "nope"), join(ws, "x"))), "ENOENT");
	assert.equal(await outcome(fs.rename(join(ws, "e"), join(ws, "e/inner/deeper"))), "EINVAL");
	assert.equal(await outcome(fs.rename(ws, join(ws, "x"))), "EPERM");
	await fs.rename(join(ws, "b.txt"), join(ws, "b.txt")); // no-op
});

test("rename never leaves the roots or touches read-only ones", async (t) => {
	const { fs, ws, skills, outside } = setup(t);
	writeFileSync(join(ws, "a.txt"), "a");
	assert.equal(await outcome(fs.rename(join(ws, "a.txt"), join(outside, "a.txt"))), "outside_root");
	assert.equal(await outcome(fs.rename(join(outside, "secret.txt"), join(ws, "s.txt"))), "outside_root");
	assert.equal(await outcome(fs.rename(join(ws, "a.txt"), join(skills, "a.txt"))), "read_only");
	assert.equal(await outcome(fs.rename(join(skills, "SKILL.md"), join(ws, "SKILL.md"))), "read_only");
	assert.equal(existsSync(join(skills, "SKILL.md")), true);
});

test("renaming a link renames the link, not what it points at", async (t) => {
	const { fs, ws, outside } = setup(t);
	symlinkSync(outside, join(ws, "escape"));
	await fs.rename(join(ws, "escape"), join(ws, "renamed"));
	assert.equal(lstatSync(join(ws, "renamed")).isSymbolicLink(), true);
	assert.equal(existsSync(join(outside, "secret.txt")), true);
});

test("copy copies files and whole folders, links verbatim, and refuses to overwrite", async (t) => {
	const { fs, ws } = setup(t);
	writeFileSync(join(ws, "run.sh"), "#!/bin/sh");
	chmodSync(join(ws, "run.sh"), 0o755);
	await fs.copy(join(ws, "run.sh"), join(ws, "run2.sh"));
	assert.equal(statSync(join(ws, "run2.sh")).mode & 0o777, 0o755);

	mkdirSync(join(ws, "src/deep/er"), { recursive: true });
	writeFileSync(join(ws, "src/a.txt"), "A");
	writeFileSync(join(ws, "src/deep/er/b.txt"), "B");
	mkdirSync(join(ws, "src/empty"));
	symlinkSync("a.txt", join(ws, "src/link"));
	await fs.copy(join(ws, "src"), join(ws, "dst"));
	assert.equal(readFileSync(join(ws, "dst/a.txt"), "utf8"), "A");
	assert.equal(readFileSync(join(ws, "dst/deep/er/b.txt"), "utf8"), "B");
	assert.equal(statSync(join(ws, "dst/empty")).isDirectory(), true);
	assert.equal(readlinkSync(join(ws, "dst/link")), "a.txt");
	assert.equal(readFileSync(join(ws, "src/a.txt"), "utf8"), "A", "the source is untouched");

	assert.equal(await outcome(fs.copy(join(ws, "src"), join(ws, "dst"))), "EEXIST");
	assert.equal(await outcome(fs.copy(join(ws, "run.sh"), join(ws, "run2.sh"))), "EEXIST");
	assert.equal(await outcome(fs.copy(join(ws, "src"), join(ws, "src/inside"))), "EINVAL");
	assert.equal(await outcome(fs.copy(join(ws, "nope"), join(ws, "x"))), "ENOENT");
});

test("copy can read from a read-only root but not write into one", async (t) => {
	const { fs, ws, skills } = setup(t);
	await fs.copy(join(skills, "SKILL.md"), join(ws, "SKILL.md"));
	assert.equal(readFileSync(join(ws, "SKILL.md"), "utf8"), "skill");
	assert.equal(await outcome(fs.copy(join(ws, "SKILL.md"), join(skills, "copy.md"))), "read_only");
});

test("delete removes files, links and folders; a link goes without its target", async (t) => {
	const { fs, ws, outside } = setup(t);
	writeFileSync(join(ws, "a.txt"), "a");
	await fs.delete(join(ws, "a.txt"));
	assert.equal(existsSync(join(ws, "a.txt")), false);

	symlinkSync(outside, join(ws, "escape"));
	await fs.delete(join(ws, "escape"));
	assert.equal(existsSync(join(ws, "escape")), false);
	assert.equal(existsSync(join(outside, "secret.txt")), true, "the link's target is untouched");

	mkdirSync(join(ws, "d/inner"), { recursive: true });
	writeFileSync(join(ws, "d/inner/f"), "x");
	assert.equal(await outcome(fs.delete(join(ws, "d"))), "ENOTEMPTY");
	assert.equal(existsSync(join(ws, "d/inner/f")), true);
	await fs.delete(join(ws, "d"), true);
	assert.equal(existsSync(join(ws, "d")), false);
	assert.equal(await outcome(fs.delete(join(ws, "gone"))), "ENOENT");
});

test("recursive delete does not follow links inside the folder", async (t) => {
	const { fs, ws, outside } = setup(t);
	mkdirSync(join(ws, "d"));
	symlinkSync(outside, join(ws, "d/escape"));
	await fs.delete(join(ws, "d"), true);
	assert.equal(existsSync(join(outside, "secret.txt")), true);
});

test("delete refuses roots, paths outside the roots and read-only roots", async (t) => {
	const { fs, ws, skills, outside } = setup(t);
	assert.equal(await outcome(fs.delete(ws, true)), "EPERM");
	assert.equal(await outcome(fs.delete(outside, true)), "outside_root");
	assert.equal(await outcome(fs.delete(join(outside, "secret.txt"))), "outside_root");
	assert.equal(await outcome(fs.delete(join(skills, "SKILL.md"))), "read_only");
	assert.equal(existsSync(join(skills, "SKILL.md")), true);
	assert.equal(existsSync(join(outside, "secret.txt")), true);
});

// ---------------------------------------------------------------------------
// The command layer

test("runFsCommand maps protocol commands onto the operations", async (t) => {
	const { fs, ws } = setup(t);
	await runFsCommand(fs, { type: "fs_mkdir", path: join(ws, "p/q") });
	await runFsCommand(fs, { type: "fs_write", path: join(ws, "p/q/f.txt"), data: b64("hi") });
	assert.equal(((await runFsCommand(fs, { type: "fs_read", path: join(ws, "p/q/f.txt") })) as any).data, b64("hi"));
	assert.equal(((await runFsCommand(fs, { type: "fs_stat", path: join(ws, "p/q/f.txt") })) as any).size, 2);
	await runFsCommand(fs, { type: "fs_copy", from: join(ws, "p"), to: join(ws, "p2") });
	await runFsCommand(fs, { type: "fs_rename", from: join(ws, "p2"), to: join(ws, "p3") });
	assert.equal(((await runFsCommand(fs, { type: "fs_list", path: join(ws, "p3/q") })) as any[])[0].name, "f.txt");
	await runFsCommand(fs, { type: "fs_delete", path: join(ws, "p3"), recursive: true });
	assert.equal(existsSync(join(ws, "p3")), false);
	assert.equal(await outcome(runFsCommand(fs, { type: "fs_nope" })), "unknown_command");
});

test("isFsCommand and errorCode", () => {
	assert.equal(isFsCommand("fs_list"), true);
	assert.equal(isFsCommand("prompt"), false);
	assert.equal(isFsCommand(undefined), false);
	assert.equal(errorCode(new FsError("conflict", "x")), "conflict");
	assert.equal(errorCode(Object.assign(new Error("x"), { code: "ENOENT" })), "ENOENT");
	assert.equal(errorCode(new Error("plain")), undefined);
	assert.equal(errorCode(Object.assign(new Error("x"), { code: 404 })), undefined);
	assert.equal(errorCode(Object.assign(new Error("x"), { code: "has spaces!" })), undefined);
	assert.equal(errorCode(null), undefined);
});
