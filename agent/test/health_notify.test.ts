import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { GB, Health, type HealthChange, humanBytes } from "../src/health.js";
import { checkConfig, Notifier } from "../src/notify.js";

// ---------------------------------------------------------------------------
// Health

function health(free: { value: number }, extra: { enforce?: boolean; rss?: { value: number } } = {}) {
	const changes: HealthChange[] = [];
	const h = new Health({
		path: "/work",
		limits: { diskWarnBytes: 10 * GB, diskMinBytes: 5 * GB, memoryWarnBytes: 1000 },
		enforce: extra.enforce,
		onChange: (c) => changes.push(c),
		statfs: async () => ({ bsize: 1, bavail: free.value, blocks: 100 * GB }),
		memory: () => ({ rss: extra.rss?.value ?? 100, heapUsed: 50 }),
	});
	return { h, changes };
}

test("health reports free space, the level it means, and memory", async () => {
	const free = { value: 40 * GB };
	const { h } = health(free);
	const s = await h.snapshot();
	assert.deepEqual(s.disk, { path: "/work", freeBytes: 40 * GB, totalBytes: 100 * GB, level: "ok" });
	assert.deepEqual(s.memory, { rssBytes: 100, heapUsedBytes: 50, level: "ok" });
	free.value = 8 * GB;
	assert.equal((await h.snapshot()).disk.level, "low");
	free.value = 4 * GB;
	assert.equal((await h.snapshot()).disk.level, "critical");
});

test("only a change of level is reported, once, and recovering needs a margin so it does not flap", async () => {
	const free = { value: 40 * GB };
	const { h, changes } = health(free);
	await h.check();
	await h.check();
	assert.deepEqual(changes, []);

	free.value = 9.9 * GB;
	await h.check();
	await h.check();
	assert.deepEqual(changes.map((c) => [c.what, (c as any).from, (c as any).to]), [["disk", "ok", "low"]]);

	free.value = 10.5 * GB; // above the warn line but inside the 10% margin: still low
	await h.check();
	assert.equal(changes.length, 1);
	free.value = 11.1 * GB;
	await h.check();
	assert.deepEqual(changes.at(-1), { what: "disk", from: "low", to: "ok", freeBytes: 11.1 * GB });

	free.value = 4 * GB;
	await h.check();
	assert.equal((changes.at(-1) as any).to, "critical");
	free.value = 5.2 * GB; // past the critical line, inside its margin
	await h.check();
	assert.equal((changes.at(-1) as any).to, "critical");
	free.value = 5.6 * GB;
	await h.check();
	assert.equal((changes.at(-1) as any).to, "low");
});

test("memory is watched the same way", async () => {
	const rss = { value: 500 };
	const { h, changes } = health({ value: 40 * GB }, { rss });
	await h.check();
	rss.value = 1500;
	await h.check();
	rss.value = 1600;
	await h.check();
	assert.deepEqual(changes, [{ what: "memory", from: "ok", to: "high", rssBytes: 1500 }]);
	rss.value = 400;
	await h.check();
	assert.equal((changes.at(-1) as any).to, "ok");
});

test("a nearly full disk refuses new work with a clear message and a code; a merely low one does not", async () => {
	const free = { value: 8 * GB };
	const { h } = health(free);
	await h.assertRoom();
	free.value = 3.2 * GB;
	await assert.rejects(
		() => h.assertRoom(),
		(e: any) => {
			assert.equal(e.code, "disk_low");
			assert.match(e.message, /almost full \(3\.2 GB free, at least 5\.0 GB needed\)/);
			return true;
		},
	);
	free.value = 30 * GB;
	await h.assertRoom();
});

test("on a phone the disk is watched but never blocks anything, and a failed look never blocks either", async () => {
	const { h } = health({ value: 1 * GB }, { enforce: false });
	await h.assertRoom();
	const broken = new Health({ path: "/x", statfs: async () => { throw new Error("no such file"); } });
	await broken.assertRoom();
	await assert.rejects(() => broken.snapshot(), /no such file/);
});

test("it can check on a timer, and stops", async () => {
	const free = { value: 40 * GB };
	const { h, changes } = health(free);
	free.value = 1 * GB;
	h.start(10);
	await new Promise((r) => setTimeout(r, 40));
	h.stop();
	assert.equal((changes[0] as any).to, "critical");
	assert.equal(humanBytes(1536 * 1024 * 1024), "1.5 GB");
	assert.equal(humanBytes(300 * 1024 * 1024), "300 MB");
});

// ---------------------------------------------------------------------------
// Notifier

const good = { url: "https://ntfy.example.com", topic: "coderra-abc12345" };

test("a config is valid or says what is wrong with it", () => {
	assert.equal(checkConfig(good), null);
	assert.equal(checkConfig({ url: "http://10.0.0.5:8080", topic: "a-long-topic-1" }), null);
	assert.match(checkConfig(null)!, /both needed/);
	assert.match(checkConfig({ url: "https://x" })!, /both needed/);
	assert.match(checkConfig({ url: "ftp://x", topic: "abcdefgh" })!, /https:\/\/ or http:\/\//);
	assert.match(checkConfig({ url: "nonsense", topic: "abcdefgh" })!, /not a valid URL/);
	assert.match(checkConfig({ url: "https://x", topic: "short" })!, /8 to 64/);
	assert.match(checkConfig({ url: "https://x", topic: "has spaces in it" })!, /8 to 64/);
	assert.match(checkConfig({ url: "https://x", topic: "../../etc/passwd" })!, /8 to 64/);
});

function notifier(over: { config?: () => any; away?: { value: boolean }; fetchImpl?: typeof fetch; clock?: { value: number } } = {}) {
	const calls: { url: string; init: RequestInit }[] = [];
	const logs: string[] = [];
	const n = new Notifier({
		config: over.config ?? (() => good),
		shouldSend: () => over.away?.value ?? true,
		now: () => over.clock?.value ?? 0,
		log: (m) => logs.push(m),
		fetch: over.fetchImpl ?? ((async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response("ok", { status: 200 }); }) as typeof fetch),
	});
	return { n, calls, logs };
}

test("a push goes to the topic with a plain title, a priority and tags, and says nothing about the project", async () => {
	const { n, calls } = notifier();
	assert.equal(await n.send("done", "Task finished", { priority: 4, tags: ["white_check_mark", "robot"] }), true);
	assert.equal(calls[0].url, "https://ntfy.example.com/coderra-abc12345");
	const h = calls[0].init.headers as Record<string, string>;
	assert.deepEqual([h.Title, h.Priority, h.Tags], ["Task finished", "4", "white_check_mark,robot"]);
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.body, "Open CoderRa to see.");
});

test("a trailing slash on the server is tolerated, and titles are kept to plain ASCII", async () => {
	const { n, calls } = notifier({ config: () => ({ url: "https://ntfy.example.com//", topic: "coderra-abc12345" }) });
	await n.send("k", "Selesai ✓ café");
	assert.equal(calls[0].url, "https://ntfy.example.com/coderra-abc12345");
	assert.equal((calls[0].init.headers as Record<string, string>).Title, "Selesai ? caf?");
	assert.equal((calls[0].init.headers as Record<string, string>).Priority, "3");
});

test("nothing is sent while someone is looking at the app, or when it is not set up", async () => {
	const away = { value: false };
	const { n, calls } = notifier({ away });
	assert.equal(await n.send("a", "Hi"), false);
	away.value = true;
	assert.equal(await n.send("a", "Hi"), true);
	assert.equal(calls.length, 1);

	const off = notifier({ config: () => null });
	assert.equal(await off.n.send("a", "Hi"), false);
	const broken = notifier({ config: () => ({ url: "nope", topic: "x" }) });
	assert.equal(await broken.n.send("a", "Hi"), false);
	assert.equal(off.calls.length + broken.calls.length, 0);
});

test("one message of a kind per minute, but different kinds do not hold each other back", async () => {
	const clock = { value: 1_000_000 };
	const { n, calls } = notifier({ clock });
	assert.equal(await n.send("approval", "Approval needed"), true);
	clock.value += 30_000;
	assert.equal(await n.send("approval", "Approval needed"), false);
	assert.equal(await n.send("done", "Agent finished"), true);
	clock.value += 31_000;
	assert.equal(await n.send("approval", "Approval needed"), true);
	assert.equal(calls.length, 3);
});

test("a server that is down or unhappy is logged, never thrown, and does not stop the next try after the interval", async () => {
	const clock = { value: 0 };
	let mode: "down" | "bad" | "ok" = "down";
	const fetchImpl = (async () => {
		if (mode === "down") throw new Error("connect ECONNREFUSED");
		return new Response("no", { status: mode === "bad" ? 429 : 200 });
	}) as typeof fetch;
	const { n, logs } = notifier({ clock, fetchImpl });
	assert.equal(await n.send("k", "t"), false);
	clock.value += 61_000;
	mode = "bad";
	assert.equal(await n.send("k", "t"), false);
	clock.value += 61_000;
	mode = "ok";
	assert.equal(await n.send("k", "t"), true);
	assert.match(logs[0], /ECONNREFUSED/);
	assert.match(logs[1], /ntfy answered 429/);
});

test("it really posts over HTTP", async (t) => {
	const got: { url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			got.push({ url: req.url, headers: req.headers, body });
			res.end("{}");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	t.after(() => void server.close());
	const port = (server.address() as { port: number }).port;
	const n = new Notifier({ config: () => ({ url: `http://127.0.0.1:${port}`, topic: "coderra-realtest1" }), shouldSend: () => true });
	assert.equal(await n.send("x", "Task needs you", { priority: 4 }), true);
	assert.equal(got[0].url, "/coderra-realtest1");
	assert.equal(got[0].headers.title, "Task needs you");
	assert.equal(got[0].headers.priority, "4");
	assert.equal(got[0].body, "Open CoderRa to see.");
});
