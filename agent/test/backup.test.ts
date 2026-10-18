import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { BackupError, createBackup, DEFAULT_BACKUP_LIMITS, estimateBackup, listZip, restoreBackup } from "../src/backup.js";
import { writeZip } from "./zip_helper.js";
import { tempDir } from "./helpers.js";
import { connect, startDaemon } from "./host_helpers.js";

function put(root: string, rel: string, data: string | Buffer) {
	const p = join(root, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, data);
}

function rig(t: TestContext) {
	const base = tempDir(t);
	const agentDir = join(base, "agent");
	const workspace = join(base, "ws");
	mkdirSync(agentDir);
	mkdirSync(workspace);
	put(agentDir, "sessions/--ws--/one.jsonl", '{"type":"session"}\n'.repeat(50));
	put(agentDir, "skills/demo/SKILL.md", "# demo");
	put(agentDir, "skills/demo/.git/config", "[core]");
	put(agentDir, "prompts/p.md", "prompt");
	put(agentDir, "settings.json", '{"a":1}');
	put(agentDir, "AGENTS.md", "notes");
	put(agentDir, "andropi/runs.json", "[]");
	put(agentDir, "auth.json", '{"secret":"sk-live"}'); // never in a backup
	put(agentDir, "models.json", '{"providers":{"x":{"apiKey":"sk-also-secret"}}}');
	put(workspace, "app/index.html", "<h1>hi</h1>");
	put(workspace, "app/src/main.ts", "export const x = 1;\n".repeat(1000));
	put(workspace, "app/data.bin", randomBytes(100_000));
	put(workspace, "app/empty.txt", "");
	put(workspace, "app/café ünï.txt", "unicode name");
	put(workspace, "app/node_modules/dep/index.js", "skip me");
	put(workspace, "app/.git/HEAD", "skip me");
	put(workspace, "backups/old.zip", "skip me");
	put(workspace, ".venv/bin/python", "skip me");
	return { base, agentDir, workspace, target: join(base, "out", "b.zip") };
}

const names = async (zip: string) => (await listZip(zip)).map((e) => e.name).sort();

test("a backup holds the agent's state and the workspace, without secrets or heavy folders", async (t) => {
	const r = rig(t);
	const result = await createBackup({ agentDir: r.agentDir, workspace: r.workspace, includeWorkspace: true }, r.target);
	const all = await names(r.target);
	assert.deepEqual(all, [
		"agent/AGENTS.md",
		"agent/andropi/runs.json",
		"agent/prompts/p.md",
		"agent/sessions/--ws--/one.jsonl",
		"agent/settings.json",
		"agent/skills/demo/SKILL.md",
		"workspace/app/café ünï.txt",
		"workspace/app/data.bin",
		"workspace/app/empty.txt",
		"workspace/app/index.html",
		"workspace/app/src/main.ts",
	]);
	assert.equal(result.files, all.length);
	assert.deepEqual(result.left, []);
	assert.ok(!all.some((n) => /auth|models|node_modules|\.git|backups|venv/.test(n)), "no secrets, no heavy folders");

	const without = await createBackup({ agentDir: r.agentDir, workspace: r.workspace, includeWorkspace: false }, join(r.base, "out", "small.zip"));
	assert.equal(without.files, 6);
});

test("what is backed up comes back identical", async (t) => {
	const r = rig(t);
	await createBackup({ agentDir: r.agentDir, workspace: r.workspace, includeWorkspace: true }, r.target);
	const fresh = tempDir(t);
	const roots = { agent: join(fresh, "agent"), workspace: join(fresh, "ws") };
	const res = await restoreBackup(r.target, roots);
	assert.deepEqual([res.restored, res.skipped], [11, []]);
	for (const [rel, root, back] of [
		["app/data.bin", r.workspace, roots.workspace],
		["app/src/main.ts", r.workspace, roots.workspace],
		["app/café ünï.txt", r.workspace, roots.workspace],
		["app/empty.txt", r.workspace, roots.workspace],
		["settings.json", r.agentDir, roots.agent],
		["sessions/--ws--/one.jsonl", r.agentDir, roots.agent],
	] as const) {
		assert.ok(readFileSync(join(root, rel)).equals(readFileSync(join(back, rel))), rel);
	}
	assert.ok(!existsSync(join(roots.agent, "auth.json")));
});

test("ordinary zip tools read it", async (t) => {
	const r = rig(t);
	await createBackup({ agentDir: r.agentDir, workspace: r.workspace, includeWorkspace: true }, r.target);
	const out = execFileSync("unzip", ["-t", r.target], { encoding: "utf8" });
	assert.match(out, /No errors detected/);
	const py = execFileSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print(len(z.namelist()))", r.target], { encoding: "utf8" });
	assert.equal(py.trim(), "None\n11");
});

test("a backup made the old way (everything in memory) still restores", async (t) => {
	const base = tempDir(t);
	const zip = join(base, "old.zip");
	writeFileSync(zip, writeZip([{ name: "agent/settings.json", data: Buffer.from("{}") }, { name: "workspace/a/b.txt", data: Buffer.from("old way".repeat(100)) }]));
	const roots = { agent: join(base, "a"), workspace: join(base, "w") };
	const res = await restoreBackup(zip, roots);
	assert.equal(res.restored, 2);
	assert.equal(readFileSync(join(roots.workspace, "a/b.txt"), "utf8"), "old way".repeat(100));
});

test("links are never followed: not into a folder loop, not out to a file elsewhere", async (t) => {
	const r = rig(t);
	put(r.base, "outside/secret.txt", "private");
	symlinkSync(join(r.base, "outside", "secret.txt"), join(r.workspace, "app", "leak.txt"));
	symlinkSync(r.workspace, join(r.workspace, "app", "loop"));
	symlinkSync(join(r.base, "outside"), join(r.agentDir, "skills", "door"));
	const res = await createBackup({ agentDir: r.agentDir, workspace: r.workspace, includeWorkspace: true }, r.target);
	const all = await names(r.target);
	assert.ok(!all.some((n) => /leak|loop|secret|door/.test(n)));
	assert.deepEqual(res.left.map((l) => l.reason), ["link", "link", "link"]);
});

test("a backup that cannot be made says why, up front, and leaves nothing behind", async (t) => {
	const r = rig(t);
	const src = { agentDir: r.agentDir, workspace: r.workspace, includeWorkspace: true };
	const limits = { ...DEFAULT_BACKUP_LIMITS };
	await assert.rejects(() => createBackup(src, r.target, { ...limits, maxEntries: 5 }), (e: any) => e instanceof BackupError && e.code === "too_many_files" && /at most 5/.test(e.message));
	await assert.rejects(() => createBackup(src, r.target, { ...limits, maxBytes: 1000 }), (e: any) => e.code === "too_large");
	assert.ok(!existsSync(r.target) && !existsSync(`${r.target}.part`));
	const dir = join(r.base, "out");
	assert.ok(!existsSync(dir) || readdirSync(dir).length === 0);
});

test("a file over the size cap is left out and listed, not silently dropped", async (t) => {
	const r = rig(t);
	const res = await createBackup({ agentDir: r.agentDir, workspace: r.workspace, includeWorkspace: true }, r.target, { ...DEFAULT_BACKUP_LIMITS, maxFileBytes: 50_000 });
	assert.deepEqual(res.left, [{ path: "workspace/app/data.bin", reason: "large" }]);
	assert.ok(!(await names(r.target)).includes("workspace/app/data.bin"));
	assert.deepEqual(await estimateBackup({ agentDir: r.agentDir, workspace: r.workspace, includeWorkspace: true }, { ...DEFAULT_BACKUP_LIMITS, maxFileBytes: 50_000 }), {
		files: 10,
		bytes: res.bytes,
		tooLarge: 1,
	});
});

test("the host stays responsive while a big backup runs", async (t) => {
	const r = rig(t);
	for (let i = 0; i < 24; i++) put(r.workspace, `big/f${i}.bin`, randomBytes(2 * 1024 * 1024)); // does not compress: the slow case
	let worst = 0;
	let last = Date.now();
	const timer = setInterval(() => {
		const now = Date.now();
		worst = Math.max(worst, now - last - 20);
		last = now;
	}, 20);
	const res = await createBackup({ agentDir: r.agentDir, workspace: r.workspace, includeWorkspace: true }, r.target);
	clearInterval(timer);
	assert.ok(res.bytes > 48 * 1024 * 1024);
	assert.ok(worst < 250, `the event loop was blocked for ${worst} ms`);
});

// ---------------------------------------------------------------------------
// Restoring something that is not to be trusted

function craft(zip: string, members: [string, string][]) {
	execFileSync("python3", ["-c", `
import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)
for name, data in json.loads(sys.argv[2]):
    z.writestr(zipfile.ZipInfo(name), data)
z.close()
`, zip, JSON.stringify(members)]);
}

test("a hostile zip cannot write outside the places being restored, however its names are spelled", async (t) => {
	const base = tempDir(t);
	const roots = { agent: join(base, "agent"), workspace: join(base, "ws") };
	mkdirSync(roots.agent);
	mkdirSync(roots.workspace);
	const zip = join(base, "evil.zip");
	craft(zip, [
		["agent/ok.txt", "fine"],
		["../evil1.txt", "x"],
		["agent/../../evil2.txt", "x"],
		["workspace/../agent/evil3.txt", "x"],
		["/etc/evil4.txt", "x"],
		["agent//double.txt", "x"],
		["agent/./dot.txt", "x"],
		["other/thing.txt", "x"],
		["agent", "x"],
		["workspace\\..\\evil5.txt", "x"],
	]);
	const res = await restoreBackup(zip, roots);
	assert.equal(res.restored, 1);
	assert.equal(readFileSync(join(roots.agent, "ok.txt"), "utf8"), "fine");
	assert.deepEqual(readdirSync(base).sort(), ["agent", "evil.zip", "ws"], "nothing appeared beside the roots");
	assert.deepEqual(readdirSync(roots.agent), ["ok.txt"]);
	assert.deepEqual(readdirSync(roots.workspace), []);
	assert.equal(res.skipped.length, 9);
});

test("a link inside the workspace cannot be used to write outside it", async (t) => {
	const base = tempDir(t);
	const roots = { agent: join(base, "agent"), workspace: join(base, "ws") };
	mkdirSync(roots.agent);
	mkdirSync(roots.workspace);
	mkdirSync(join(base, "elsewhere"));
	put(base, "elsewhere/target.txt", "untouched");
	symlinkSync(join(base, "elsewhere"), join(roots.workspace, "door"));
	symlinkSync(join(base, "elsewhere", "target.txt"), join(roots.workspace, "direct.txt"));
	const zip = join(base, "z.zip");
	craft(zip, [
		["workspace/door/target.txt", "overwritten!"],
		["workspace/door/new.txt", "planted!"],
		["workspace/direct.txt", "through the link?"],
	]);
	const res = await restoreBackup(zip, roots);
	assert.equal(readFileSync(join(base, "elsewhere/target.txt"), "utf8"), "untouched");
	assert.ok(!existsSync(join(base, "elsewhere/new.txt")));
	assert.deepEqual(res.skipped.map((s) => s.reason), ["goes through a link", "goes through a link"]);
	// A link as the file itself is replaced by the file, not written through.
	assert.equal(lstatSync(join(roots.workspace, "direct.txt")).isSymbolicLink(), false);
	assert.equal(readFileSync(join(roots.workspace, "direct.txt"), "utf8"), "through the link?");
	assert.equal(readlinkSync(join(roots.workspace, "door")), join(base, "elsewhere"));
});

test("damaged files are reported as such, and a damaged entry does not stop the rest", async (t) => {
	const r = rig(t);
	await createBackup({ agentDir: r.agentDir, workspace: r.workspace, includeWorkspace: false }, r.target);
	const good = readFileSync(r.target);

	const notZip = join(r.base, "x.zip");
	writeFileSync(notZip, "this is not a zip file at all");
	await assert.rejects(() => restoreBackup(notZip, { agent: join(r.base, "ra"), workspace: join(r.base, "rw") }), (e: any) => e.code === "bad_zip");
	writeFileSync(notZip, good.subarray(0, good.length - 40));
	await assert.rejects(() => restoreBackup(notZip, { agent: join(r.base, "ra"), workspace: join(r.base, "rw") }), (e: any) => e.code === "bad_zip");
	await assert.rejects(() => restoreBackup(join(r.base, "missing.zip"), { agent: "a", workspace: "w" }), (e: any) => e.code === "io");

	// One byte flipped inside one file's data: that file fails its checksum, the others come back.
	const entries = await listZip(r.target);
	const victim = entries.find((e) => e.name === "agent/skills/demo/SKILL.md")!;
	const bad = Buffer.from(good);
	bad[victim.offset + 30 + Buffer.byteLength(victim.name) + 1] ^= 0xff;
	writeFileSync(notZip, bad);
	const roots = { agent: join(r.base, "ra"), workspace: join(r.base, "rw") };
	const res = await restoreBackup(notZip, roots);
	assert.equal(res.restored, entries.length - 1);
	assert.equal(res.skipped.length, 1);
	assert.equal(res.skipped[0].name, "agent/skills/demo/SKILL.md");
	assert.ok(!existsSync(join(roots.agent, "skills/demo/SKILL.md")), "the damaged file is not left half-written");
	assert.deepEqual(readdirSync(join(roots.agent, "skills/demo")), [], "and no staging file is left");
});

test("an entry that holds more than it says (a zip bomb) is stopped", async (t) => {
	const base = tempDir(t);
	const zip = join(base, "bomb.zip");
	writeFileSync(zip, writeZip([{ name: "workspace/zeros.bin", data: Buffer.alloc(8 * 1024 * 1024) }]));
	const buf = readFileSync(zip);
	const central = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	buf.writeUInt32LE(100, central + 24); // claims 100 bytes
	writeFileSync(zip, buf);
	const roots = { agent: join(base, "a"), workspace: join(base, "w") };
	mkdirSync(roots.workspace);
	const res = await restoreBackup(zip, roots);
	assert.equal(res.restored, 0);
	assert.match(res.skipped[0].reason, /holds more than it says/);
	assert.deepEqual(readdirSync(roots.workspace), []);

	// And one that declares more than a backup may hold is refused outright.
	buf.writeUInt32LE(0xfffffff0, central + 24);
	writeFileSync(zip, buf);
	await assert.rejects(() => restoreBackup(zip, roots, { ...DEFAULT_BACKUP_LIMITS, maxBytes: 1024 * 1024 }), (e: any) => e.code === "too_large");
});

// ---------------------------------------------------------------------------

test("through the host: estimate, create and restore, with the file where the app can fetch it", async (t) => {
	const d = await startDaemon(t);
	const c = await connect(d.sock);
	put(d.workspace, "proj/a.txt", "alpha");
	put(d.agentDir, "settings.json", '{"restored":false}');
	const est = await c.call("backup_estimate", { includeWorkspace: true });
	assert.ok(est.files >= 2 && est.tooLarge === 0);
	const made = await c.call("backup_create", { includeWorkspace: true });
	assert.ok(made.path.startsWith(join(d.workspace, "backups")), "on a server it lands in the workspace, which the app can read");
	assert.ok(existsSync(made.path));

	writeFileSync(join(d.workspace, "proj/a.txt"), "changed");
	writeFileSync(join(d.agentDir, "settings.json"), '{"restored":true}');
	const back = await c.call("backup_restore", { path: made.path });
	assert.equal(back.skippedCount, 0);
	assert.equal(readFileSync(join(d.workspace, "proj/a.txt"), "utf8"), "alpha");
	await assert.rejects(() => c.call("backup_restore", { path: join(d.workspace, "proj/a.txt") }), /not a zip/);
});
