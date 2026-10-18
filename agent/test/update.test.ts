import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { appUpdateDownloadStatus, checkAppUpdate, pickAsset, startAppUpdateDownload } from "../src/update.js";
import { tempDir } from "./helpers.js";
import { connect, startDaemon, waitFor } from "./host_helpers.js";

const release = (tag = "b120", over: object = {}) => ({
	tag_name: tag,
	name: `Build ${tag.slice(1)}`,
	html_url: "https://example.test/release",
	assets: [
		{ id: 1, name: "notes.txt", size: 10 },
		{ id: 2, name: "app-armeabi-v7a-full-release.apk", size: 111 },
		{ id: 3, name: "app-arm64-v8a-full-release.apk", size: 222 },
		{ id: 4, name: "app-x86_64-full-release.apk", size: 333 },
	],
	...over,
});

function api(rel: object | Error) {
	const calls: string[] = [];
	return {
		calls,
		fn: async (path: string) => {
			calls.push(path);
			if (rel instanceof Error) throw rel;
			return rel;
		},
	};
}

test("the verdict is about the build that asks, not the machine the host runs on", async (t) => {
	const dir = tempDir(t);
	const github = api(release());
	const old = await checkAppUpdate(dir, github.fn, false, { build: 100, version: "1.2.0" });
	assert.deepEqual([old.status, old.currentBuild, old.currentVersion, old.latestBuild, old.tag], ["available", 100, "1.2.0", 120, "b120"]);
	const current = await checkAppUpdate(dir, github.fn, false, { build: 120 });
	assert.deepEqual([current.status, current.currentBuild], ["current", 120]);
	const newer = await checkAppUpdate(dir, github.fn, false, { build: 500 });
	assert.equal(newer.status, "current");
	assert.equal(github.calls.length, 1, "the second and third answers came from the cache of the newest release");
});

test("a host on the phone itself still reads its own build from the environment", async (t) => {
	const dir = tempDir(t);
	const saved = [process.env.ANDROPI_APP_BUILD, process.env.ANDROPI_APP_VERSION];
	process.env.ANDROPI_APP_BUILD = "90";
	process.env.ANDROPI_APP_VERSION = "0.9";
	t.after(() => {
		for (const [k, v] of [["ANDROPI_APP_BUILD", saved[0]], ["ANDROPI_APP_VERSION", saved[1]]] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
	const r = await checkAppUpdate(dir, api(release()).fn);
	assert.deepEqual([r.status, r.currentBuild, r.currentVersion], ["available", 90, "0.9"]);
	assert.equal((await checkAppUpdate(dir, api(release()).fn, true, { build: 130 })).status, "current", "what the app says wins");
});

test("the APK offered is the one for the phone's CPU", async () => {
	const rel = release();
	assert.equal(pickAsset(rel, "armeabi-v7a")!.name, "app-armeabi-v7a-full-release.apk");
	assert.equal(pickAsset(rel, "arm64-v8a")!.name, "app-arm64-v8a-full-release.apk");
	assert.equal(pickAsset(rel, "x86_64")!.name, "app-x86_64-full-release.apk");
	assert.equal(pickAsset(rel)!.name, "app-arm64-v8a-full-release.apk", "arm64 when not said");
	assert.equal(pickAsset(rel, "mips")!.name, "app-arm64-v8a-full-release.apk", "and when there is none for it");
	assert.equal(pickAsset(rel, "../../etc")!.name, "app-arm64-v8a-full-release.apk", "a CPU name is not a pattern");
	assert.equal(pickAsset({ assets: [{ id: 9, name: "universal.apk", size: 5 }] })!.name, "universal.apk");
	assert.equal(pickAsset({ assets: [{ id: 9, name: "notes.txt" }] }), null);
});

test("the check names the APK for the asking phone, from the same cached release", async (t) => {
	const dir = tempDir(t);
	const github = api(release());
	const a = await checkAppUpdate(dir, github.fn, false, { build: 1, abi: "armeabi-v7a" });
	const b = await checkAppUpdate(dir, github.fn, false, { build: 1, abi: "x86_64" });
	assert.deepEqual([a.assetName, a.assetSize], ["app-armeabi-v7a-full-release.apk", 111]);
	assert.deepEqual([b.assetName, b.assetSize], ["app-x86_64-full-release.apk", 333]);
	assert.equal(github.calls.length, 1);
});

test("errors are not remembered, a missing release is, and an old cache format is ignored", async (t) => {
	const dir = tempDir(t);
	const failing = api(new Error("network down"));
	assert.deepEqual((await checkAppUpdate(dir, failing.fn, false, { build: 1 })).status, "error");
	const signedOut = api(new Error("GitHub: not signed in"));
	assert.equal((await checkAppUpdate(dir, signedOut.fn, false, { build: 1 })).status, "signed-out");
	const good = api(release());
	assert.equal((await checkAppUpdate(dir, good.fn, false, { build: 1 })).status, "available", "the failures left nothing behind");

	const none = tempDir(t);
	const missing = api(Object.assign(new Error("Not Found"), { status: 404 }));
	assert.equal((await checkAppUpdate(none, missing.fn, false, { build: 1 })).status, "none");
	assert.equal((await checkAppUpdate(none, missing.fn, false, { build: 1 })).status, "none");
	assert.equal(missing.calls.length, 1);

	const legacy = tempDir(t);
	mkdirSync(join(legacy, "andropi"));
	writeFileSync(join(legacy, "andropi", "update-check.json"), JSON.stringify({ at: Date.now(), result: { status: "current", latestBuild: 3 } }));
	const fresh = api(release());
	assert.equal((await checkAppUpdate(legacy, fresh.fn, false, { build: 1 })).status, "available");
	assert.equal(fresh.calls.length, 1);
});

test("a download lands in the updates folder under a safe name, whatever GitHub calls the file", async (t) => {
	const dir = tempDir(t);
	const body = Buffer.alloc(222, 7);
	const rel = release("b130", { assets: [{ id: 3, name: "../../evil name.apk", size: 222 }] });
	const raw = async (path: string) => {
		assert.match(path, /\/releases\/assets\/3$/);
		return new Response(body);
	};
	const started = await startAppUpdateDownload(dir, api(rel).fn, raw, "arm64-v8a");
	assert.equal(started.size, 222);
	await waitFor("the download", () => appUpdateDownloadStatus(started.id).state !== "downloading", 5000);
	const st = appUpdateDownloadStatus(started.id);
	assert.equal(st.state, "done");
	assert.equal(st.path, join(dir, "updates", "b130-.._.._evil_name.apk"));
	assert.ok(readFileSync(st.path!).equals(body));
	assert.deepEqual(readdirSync(join(dir, "updates")), ["b130-.._.._evil_name.apk"]);
	assert.equal(existsSync(join(dir, "..", "evil name.apk")), false);
});

test("a download that comes up short is an error and leaves no file", async (t) => {
	const dir = tempDir(t);
	const rel = release("b131", { assets: [{ id: 3, name: "app-arm64.apk", size: 500 }] });
	const started = await startAppUpdateDownload(dir, api(rel).fn, async () => new Response(Buffer.alloc(100)));
	await waitFor("the download", () => appUpdateDownloadStatus(started.id).state !== "downloading", 5000);
	const st = appUpdateDownloadStatus(started.id);
	assert.equal(st.state, "error");
	assert.match(st.message ?? "", /incomplete \(100 of 500/);
	assert.deepEqual(readdirSync(join(dir, "updates")), []);
	await assert.rejects(() => startAppUpdateDownload(dir, api({ tag_name: "b1", assets: [] }).fn, async () => new Response("")), /no APK/);
});



test("through the host: asking about a download gets an answer (it is looked up by downloadId, not by the request's id)", async (t) => {
	const d = await startDaemon(t);
	const c = await connect(d.sock);
	const unknown = await c.call("app_update_status", { downloadId: "nope" });
	assert.deepEqual([unknown.state, unknown.message], ["error", "Unknown download"]);
});
