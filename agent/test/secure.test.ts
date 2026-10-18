import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readSecureJson, writeSecureJson } from "../src/secure.js";
import { tempDir, withEnv } from "./helpers.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

test("round-trips encrypted JSON and does not store it in the clear", (t) => {
	withEnv(t, { ANDROPI_STORE_KEY: KEY_A });
	const file = join(tempDir(t), "store.json");
	writeSecureJson(file, { token: "ghp_secret", n: 1 });
	const raw = readFileSync(file, "utf8");
	assert.ok(raw.startsWith("enc1:"));
	assert.ok(!raw.includes("ghp_secret"));
	assert.deepEqual(readSecureJson(file, null), { token: "ghp_secret", n: 1 });
});

test("uses a fresh IV each time", (t) => {
	withEnv(t, { ANDROPI_STORE_KEY: KEY_A });
	const dir = tempDir(t);
	writeSecureJson(join(dir, "1.json"), { a: 1 });
	writeSecureJson(join(dir, "2.json"), { a: 1 });
	assert.notEqual(readFileSync(join(dir, "1.json"), "utf8"), readFileSync(join(dir, "2.json"), "utf8"));
});

test("returns the fallback for the wrong key, a tampered file, or a missing file", (t) => {
	withEnv(t, { ANDROPI_STORE_KEY: KEY_A });
	const dir = tempDir(t);
	const file = join(dir, "store.json");
	writeSecureJson(file, { a: 1 });

	process.env.ANDROPI_STORE_KEY = KEY_B;
	assert.deepEqual(readSecureJson(file, { fallback: true }), { fallback: true });

	process.env.ANDROPI_STORE_KEY = KEY_A;
	const raw = readFileSync(file, "utf8");
	writeFileSync(file, raw.slice(0, -4) + (raw.endsWith("AAAA") ? "BBBB" : "AAAA"));
	assert.deepEqual(readSecureJson(file, { fallback: true }), { fallback: true });

	assert.deepEqual(readSecureJson(join(dir, "missing.json"), { fallback: true }), { fallback: true });
});

test("without a key it writes plain JSON, and plain files stay readable once a key exists", (t) => {
	withEnv(t, { ANDROPI_STORE_KEY: undefined });
	const file = join(tempDir(t), "store.json");
	writeSecureJson(file, { a: 1 });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1 });

	process.env.ANDROPI_STORE_KEY = KEY_A;
	assert.deepEqual(readSecureJson(file, null), { a: 1 });
	writeSecureJson(file, { a: 2 });
	assert.ok(readFileSync(file, "utf8").startsWith("enc1:"));
});

test("an encrypted file cannot be read without the key", (t) => {
	withEnv(t, { ANDROPI_STORE_KEY: KEY_A });
	const file = join(tempDir(t), "store.json");
	writeSecureJson(file, { a: 1 });
	delete process.env.ANDROPI_STORE_KEY;
	assert.deepEqual(readSecureJson(file, { fallback: true }), { fallback: true });
});

test("ignores a malformed key", (t) => {
	withEnv(t, { ANDROPI_STORE_KEY: "not-hex" });
	const file = join(tempDir(t), "store.json");
	writeSecureJson(file, { a: 1 });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1 });
});
