import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Checkpoints } from "../src/checkpoints.js";
import { tempDir } from "./helpers.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;

test("checkpoints snapshot, skip no-ops, diff and restore a folder", { skip: !hasGit && "git is not installed" }, async (t) => {
	const state = tempDir(t);
	const project = tempDir(t);
	const checkpoints = new Checkpoints(join(state, "checkpoints"));
	const write = (rel: string, body: string) => {
		mkdirSync(join(project, rel, ".."), { recursive: true });
		writeFileSync(join(project, rel), body);
	};

	write("a.txt", "1");
	const first = await checkpoints.snapshot(project, "first");
	assert.ok(first);
	assert.equal(first.label, "first");
	assert.equal(await checkpoints.snapshot(project, "nothing changed"), null);

	write("a.txt", "2");
	write("b.txt", "new");
	write("node_modules/dep/index.js", "ignored");
	const second = await checkpoints.snapshot(project, "second");
	assert.ok(second);

	const list = await checkpoints.list(project);
	assert.deepEqual(
		list.map((c) => c.label),
		["second", "first"],
	);
	assert.equal(list[0].files, 2);

	const changes = await checkpoints.diff(project, first.id);
	assert.deepEqual(changes.files.map((f) => f.path).sort(), ["a.txt", "b.txt"]);
	assert.match(changes.patch, /\+new/);

	const restored = await checkpoints.restore(project, first.id);
	assert.equal(restored.restored, first.id);
	assert.equal(readFileSync(join(project, "a.txt"), "utf8"), "1");
	assert.equal(existsSync(join(project, "b.txt")), false, "files added after the checkpoint are removed");
	assert.equal(existsSync(join(project, "node_modules/dep/index.js")), true, "excluded folders are left alone");
});

test("checkpoint history is kept per folder and outside the project", { skip: !hasGit && "git is not installed" }, async (t) => {
	const state = tempDir(t);
	const one = tempDir(t);
	const two = tempDir(t);
	const checkpoints = new Checkpoints(join(state, "checkpoints"));
	writeFileSync(join(one, "f"), "1");
	writeFileSync(join(two, "f"), "2");
	await checkpoints.snapshot(one, "in one");
	assert.equal((await checkpoints.list(two)).length, 0);
	assert.equal(existsSync(join(one, ".git")), false, "no .git is created inside the project");
	assert.equal(await checkpoints.snapshot(join(one, "does-not-exist"), "x"), null);
});
