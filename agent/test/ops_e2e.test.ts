import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { all, connect, fakeNtfy, mockModel, startDaemon, usingMockModel, usingSettings, waitFor } from "./host_helpers.js";
import { tempDir } from "./helpers.js";

// Keeping a server alive for a day: the disk, the pushes to the phone, and noticing when the host was killed.

const quiet = usingSettings({ retry: { enabled: false } });
const PETABYTE = "1000000000000000";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a nearly full disk is reported and refuses new work; a phone is never refused", async (t) => {
	const model = await mockModel(t, [{ text: "fine" }]);
	const full = { CODERRA_DISK_MIN_BYTES: PETABYTE, CODERRA_DISK_WARN_BYTES: PETABYTE };
	const d = await startDaemon(t, full, tempDir(t), all(usingMockModel(model.baseUrl), quiet));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });

	const h = await c.call("health");
	assert.equal(h.disk.level, "critical");
	assert.ok(h.disk.freeBytes > 0 && h.disk.totalBytes >= h.disk.freeBytes);
	assert.deepEqual([h.mode, h.transport, h.epoch], ["vps", "socket", c.records[0].epoch]);
	assert.ok(h.memory.rssBytes > 0 && h.uptimeSec >= 0);
	assert.deepEqual(h.runs, { running: 0, queued: 0 });

	await assert.rejects(
		() => c.call("prompt", { text: "hello" }),
		(e: any) => e.code === "disk_low" && /almost full/.test(e.message),
	);
	await assert.rejects(() => c.call("run_enqueue", { prompt: "x", dir: d.workspace }), (e: any) => e.code === "disk_low");
	assert.equal(model.requests.length, 0, "nothing reached the model");

	// The warning went out when the host noticed at startup, and stays available to a client that missed it.
	await c.call("resume", { since: 0, epoch: c.records[0].epoch });
	assert.ok(c.ofType("notice").some((n) => /disk is almost full/.test(n.message)));

	// The same host in phone mode only reports.
	const phone = await startDaemon(t, { ...full, ANDROPI_MODE: "local" }, tempDir(t), all(usingMockModel(model.baseUrl), quiet));
	const p = await connect(phone.sock);
	await p.call("set_model", { provider: "mock", model: "mock-1" });
	assert.equal((await p.call("health")).disk.level, "critical");
	await p.call("prompt", { text: "hello" });
	await waitFor("the phone's run", () => p.settled() >= 1);
});

test("with room to spare the disk is fine", async (t) => {
	const d = await startDaemon(t, { CODERRA_DISK_MIN_BYTES: "1", CODERRA_DISK_WARN_BYTES: "2" });
	const c = await connect(d.sock);
	assert.equal((await c.call("health")).disk.level, "ok");
});

test("pushes go out only when nobody is looking, and say nothing about the work", async (t) => {
	const ntfy = await fakeNtfy(t);
	const model = await mockModel(t, [
		{ text: "one" }, // chat, app in the foreground
		{ text: "two" }, // chat, app in the background
		{ delayMs: 300, text: "three" }, // background run, nobody connected
	]);
	const d = await startDaemon(t, ntfy.env, tempDir(t), all(usingMockModel(model.baseUrl), quiet));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });

	// Looking at the app: no push for what you can see.
	await c.call("prompt", { text: "private project name: Falcon" });
	await waitFor("the first run", () => c.settled() >= 1);
	await pause(250);
	assert.deepEqual(ntfy.got, []);

	// The app says it is in the background (a ping each few seconds does that): now there is a push.
	c.send({ type: "ping", background: true });
	await waitFor("the pong", () => c.ofType("pong").length > 0);
	await c.call("prompt", { text: "again" });
	await waitFor("the push", () => ntfy.got.length === 1);
	assert.deepEqual([ntfy.got[0].title, ntfy.got[0].priority, ntfy.got[0].url], ["Agent finished", "3", "/coderra-test-topic-1"]);
	assert.equal(ntfy.got[0].body, "Open CoderRa to see.");
	assert.ok(!JSON.stringify(ntfy.got).includes("Falcon"), "nothing about the project leaves the server");

	// The phone is gone entirely; a background task finishes.
	await c.call("run_enqueue", { prompt: "background job", dir: d.workspace });
	c.socket.destroy();
	await waitFor("the task push", () => ntfy.titles().includes("Task finished"));
});

test("an approval that comes up with nobody connected is pushed with high priority", async (t) => {
	const ntfy = await fakeNtfy(t);
	const model = await mockModel(t, [{ delayMs: 400, calls: [{ name: "write", args: { path: "x.txt", content: "x" } }] }]);
	const d = await startDaemon(t, ntfy.env, tempDir(t), all(usingMockModel(model.baseUrl), quiet));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });
	await c.call("settings_set", { settings: { approvalMode: "ask_all" } });
	await c.call("prompt", { text: "write a file" });
	c.socket.destroy(); // the user puts the phone away while the model thinks
	await waitFor("the push", () => ntfy.titles().includes("Approval needed"));
	const push = ntfy.got.find((g) => g.title === "Approval needed")!;
	assert.deepEqual([push.priority, push.tags], ["4", "raised_hand"]);
	assert.equal(existsSync(join(d.workspace, "x.txt")), false, "and the file waits for an answer");
});

test("a task that needs the user is pushed with its own plain title and priority", async (t) => {
	const ntfy = await fakeNtfy(t);
	const model = await mockModel(t, [
		{ delayMs: 200, text: "ok" }, // a plain run: done
		{ delayMs: 200, text: "x" }, // a long task that gets nowhere: blocked
		{ delayMs: 200, text: "x" },
		{ delayMs: 200, text: "x" },
	]);
	const d = await startDaemon(t, ntfy.env, tempDir(t), all(usingMockModel(model.baseUrl), quiet));
	let c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });
	await c.call("run_enqueue", { prompt: "a", dir: d.workspace });
	c.socket.destroy();
	await waitFor("done push", () => ntfy.titles().includes("Task finished"));

	c = await connect(d.sock);
	await c.call("run_enqueue", { prompt: "b", dir: d.workspace, task: { noProgressLimit: 2 } });
	c.socket.destroy();
	await waitFor("blocked push", () => ntfy.titles().includes("Task needs you"), 20_000);
	const blocked = ntfy.got.find((g) => g.title === "Task needs you")!;
	assert.deepEqual([blocked.priority, blocked.tags], ["4", "raised_hand"]);
});

test("notifications can be turned off, are visible to their owner, and are checked when changed", async (t) => {
	const ntfy = await fakeNtfy(t);
	const model = await mockModel(t, [{ text: "one" }, { text: "two" }]);
	const d = await startDaemon(t, ntfy.env, tempDir(t), all(usingMockModel(model.baseUrl), quiet));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });

	const settings = await c.call("settings_get");
	assert.deepEqual(settings.notify, { enabled: true, url: ntfy.env.NTFY_URL, topic: "coderra-test-topic-1" });

	await assert.rejects(() => c.call("settings_set", { settings: { notify: { topic: "bad topic!" } } }), /Notifications: .*8 to 64/);
	await assert.rejects(() => c.call("settings_set", { settings: { notify: { url: "gopher://x", topic: "coderra-test-topic-2" } } }), /https:\/\/ or http:\/\//);

	await c.call("settings_set", { settings: { notify: { enabled: false } } });
	assert.equal((await c.call("settings_get")).notify.enabled, false);
	c.send({ type: "ping", background: true });
	await c.call("prompt", { text: "x" });
	await waitFor("the run", () => c.settled() >= 1);
	await pause(300);
	assert.deepEqual(ntfy.got, [], "switched off");

	await c.call("settings_set", { settings: { notify: { enabled: true, url: ntfy.env.NTFY_URL, topic: "my-own-topic-99" } } });
	await c.call("prompt", { text: "y" });
	await waitFor("the push", () => ntfy.got.length === 1);
	assert.equal(ntfy.got[0].url, "/my-own-topic-99", "a topic chosen in the app wins over the default");
});

test("a host that was killed says so when it comes back; one that was stopped properly does not", async (t) => {
	const ntfy = await fakeNtfy(t);
	const home = tempDir(t);
	const marker = join(home, ".coderra", "running");

	const first = await startDaemon(t, ntfy.env, home);
	assert.ok(existsSync(marker), "a running host leaves its marker");
	first.child.kill("SIGTERM");
	assert.equal((await first.exited).code, 0);
	assert.equal(existsSync(marker), false, "and a clean stop takes it away");

	const second = await startDaemon(t, ntfy.env, home);
	await pause(400);
	assert.deepEqual(ntfy.got, [], "a clean stop is not a surprise");
	second.child.kill("SIGKILL");
	await second.exited;
	assert.ok(existsSync(marker), "a killed host cannot clean up");

	const third = await startDaemon(t, ntfy.env, home);
	await waitFor("the push", () => ntfy.titles().includes("Host restarted unexpectedly"));
	assert.equal(ntfy.got[0].priority, "4");
	const c = await connect(third.sock);
	await c.call("resume", { since: 0, epoch: c.records[0].epoch });
	assert.ok(c.ofType("notice").some((n) => /restarted unexpectedly/.test(n.message)));
});

test("while a long task runs the host says so now and then", async (t) => {
	const ntfy = await fakeNtfy(t);
	const model = await mockModel(t, [{ delayMs: 1500, text: "still going" }]);
	const d = await startDaemon(t, { ...ntfy.env, CODERRA_HEARTBEAT_MS: "200" }, tempDir(t), all(usingMockModel(model.baseUrl), quiet));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });
	await c.call("run_enqueue", { prompt: "long", dir: d.workspace, task: { maxIterations: 1 } });
	c.socket.destroy();
	await waitFor("a heartbeat", () => ntfy.titles().includes("Task still running"), 10_000);
	assert.equal(ntfy.got.find((g) => g.title === "Task still running")!.priority, "2");
	await pause(500);
	assert.equal(ntfy.titles().filter((x) => x === "Task still running").length, 1, "not more than one a minute");
});
