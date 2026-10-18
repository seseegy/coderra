import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectFiles, detectTests, readZip, Templates, usageSummary, writeZip } from "../src/workbench.js";
import { tempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// Zip

test("zip round-trips stored and deflated entries, UTF-8 names and empty files", () => {
	const entries = [
		{ name: "a.txt", data: Buffer.from("hello") },
		{ name: "dir/ünï.txt", data: Buffer.alloc(10_000, "x") },
		{ name: "empty", data: Buffer.alloc(0) },
		{ name: "bin", data: Buffer.from([0, 255, 1, 254, 2, 253]) },
	];
	const zip = writeZip(entries);
	const back = readZip(zip);
	assert.deepEqual(
		back.map((e) => e.name),
		entries.map((e) => e.name),
	);
	for (const [i, e] of entries.entries()) assert.ok(back[i].data.equals(e.data), e.name);
	// The 10 KB run of "x" must actually have been compressed.
	assert.ok(zip.length < 5_000);
});

test("readZip rejects data that is not a zip", () => {
	assert.throws(() => readZip(Buffer.from("definitely not a zip")), /Not a zip file/);
});

// ---------------------------------------------------------------------------
// collectFiles

test("collectFiles lists relative paths and skips heavy folders", (t) => {
	const dir = tempDir(t);
	for (const f of ["a.txt", "sub/b.txt", "node_modules/x.js", ".git/config", "bin/tool", ".cache/c"]) {
		mkdirSync(join(dir, f, ".."), { recursive: true });
		writeFileSync(join(dir, f), f);
	}
	assert.deepEqual(
		collectFiles(dir, dir)
			.map((e) => e.name)
			.sort(),
		["a.txt", "sub/b.txt"],
	);
});

// ---------------------------------------------------------------------------
// detectTests

test("detectTests recognises the project type", (t) => {
	const make = (files: Record<string, string>) => {
		const dir = tempDir(t);
		for (const [name, body] of Object.entries(files)) {
			mkdirSync(join(dir, name, ".."), { recursive: true });
			writeFileSync(join(dir, name), body);
		}
		return dir;
	};
	assert.deepEqual(detectTests(make({ "package.json": '{"scripts":{"test":"vitest"}}' })), { command: "npm test --silent", framework: "npm" });
	assert.equal(detectTests(make({ "package.json": '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })), null);
	assert.equal(detectTests(make({ "package.json": "{ not json" })), null);
	assert.equal(detectTests(make({ "pytest.ini": "" }))?.framework, "pytest");
	assert.equal(detectTests(make({ "go.mod": "module x" }))?.framework, "go");
	assert.equal(detectTests(make({ "Cargo.toml": "" }))?.framework, "cargo");
	assert.equal(detectTests(make({ "pubspec.yaml": "" }))?.framework, "dart");
	assert.equal(detectTests(make({ Makefile: "test:" }))?.framework, "make");
	assert.equal(detectTests(make({ "README.md": "" })), null);
});

// ---------------------------------------------------------------------------
// usageSummary

test("usageSummary adds up requests per day, provider and model, and ignores old or unrelated lines", (t) => {
	const dir = tempDir(t);
	mkdirSync(join(dir, "nested"), { recursive: true });
	const now = Date.now();
	const reply = (timestamp: number, cost: number, model = "m1") =>
		JSON.stringify({
			message: {
				role: "assistant",
				provider: "anthropic",
				model,
				timestamp,
				usage: { input: 100, output: 50, cacheRead: 10, cost: { total: cost } },
			},
		});
	writeFileSync(
		join(dir, "nested", "s1.jsonl"),
		[
			reply(now, 0.25),
			reply(now, 0.5),
			reply(now, 1, "m2"),
			reply(now - 60 * 86400_000, 9), // older than the 30-day window
			JSON.stringify({ message: { role: "user", content: "hi", usage: { input: 1 } } }), // not an assistant message
			"not json but mentions \"usage\"",
		].join("\n"),
	);
	writeFileSync(join(dir, "ignored.txt"), reply(now, 99));

	const rows = usageSummary(dir, 30);
	const day = new Date(now).toISOString().slice(0, 10);
	const m1 = rows.find((r) => r.model === "m1");
	assert.deepEqual(m1, { day, provider: "anthropic", model: "m1", input: 200, output: 100, cacheRead: 20, cost: 0.75, requests: 2 });
	assert.equal(rows.find((r) => r.model === "m2")?.requests, 1);
	assert.equal(rows.length, 2);
});

test("usageSummary skips session files not modified inside the window", (t) => {
	const dir = tempDir(t);
	const file = join(dir, "old.jsonl");
	writeFileSync(file, JSON.stringify({ message: { role: "assistant", provider: "p", model: "m", timestamp: Date.now(), usage: { input: 1 } } }));
	const old = new Date(Date.now() - 90 * 86400_000);
	utimesSync(file, old, old);
	assert.deepEqual(usageSummary(dir, 30), []);
	assert.deepEqual(usageSummary(join(dir, "missing"), 30), []);
});

// ---------------------------------------------------------------------------
// Prompt templates

test("templates are seeded once, and a deleted default stays deleted", (t) => {
	const root = tempDir(t);
	const templates = new Templates(root);
	const seeded = join(root, "state", "seeded.json");
	templates.seed(seeded);
	assert.deepEqual(
		templates.list().map((x) => x.name),
		["commit", "docs", "explain", "fix", "refactor", "review", "test"],
	);
	const review = templates.list().find((x) => x.name === "review")!;
	assert.equal(review.description, "Review recent changes for bugs and risks");
	assert.equal(review.argumentHint, "[focus]");

	templates.remove("docs");
	templates.seed(seeded);
	assert.equal(existsSync(join(templates.dir, "docs.md")), false);
});

test("saving a template cleans its name and writes frontmatter that list() reads back", (t) => {
	const templates = new Templates(tempDir(t));
	const name = templates.save("My Test!", "line one\nline two", "do the thing", "[arg]");
	assert.equal(name, "my-test");
	const saved = templates.list().find((x) => x.name === "my-test")!;
	assert.equal(saved.description, "line one line two");
	assert.equal(saved.argumentHint, "[arg]");
	assert.equal(saved.body.trim(), "do the thing");
	assert.match(readFileSync(join(templates.dir, "my-test.md"), "utf8"), /^---\n/);

	assert.throws(() => templates.save("!!!", "", "x"), /name/i);
	templates.remove("my-test");
	assert.equal(templates.list().some((x) => x.name === "my-test"), false);
	// remove() only takes the base name, so a crafted path cannot leave the folder.
	templates.remove("../../etc/passwd");
});
