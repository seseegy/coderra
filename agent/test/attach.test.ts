import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { Hub, LineBuffer, listenOnSocket } from "../src/transport.js";
import { tempDir } from "./helpers.js";

// server/coderra-attach: the little program the app runs over ssh to reach the daemon's socket.
const ATTACH = fileURLToPath(new URL("../../server/coderra-attach", import.meta.url));

function startAttach(t: TestContext, env: Record<string, string>) {
	const child = spawn(process.execPath, [ATTACH], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => void child.kill("SIGKILL"));
	const records: any[] = [];
	let stderr = "";
	const lines = new LineBuffer();
	child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
		for (const l of lines.push(chunk)) records.push(JSON.parse(l));
	});
	child.stderr!.setEncoding("utf8").on("data", (d) => (stderr += d));
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const send = (record: object) => child.stdin!.write(`${JSON.stringify(record)}\n`);
	const until = async (ok: () => boolean, ms = 5000) => {
		const t0 = Date.now();
		while (!ok()) {
			if (Date.now() - t0 > ms) throw new Error(`timed out; got ${JSON.stringify(records.map((r) => r.type))} stderr=${stderr}`);
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	return { child: child as ChildProcess, records, send, until, exited, stderr: () => stderr };
}

async function daemon(t: TestContext) {
	const dir = tempDir(t);
	const sock = join(dir, "host.sock");
	const hub = new Hub({ replay: true, pingIntervalMs: 0, handle: async (cmd) => ({ echo: cmd.type, text: cmd.text }) });
	hub.setReady({ type: "ready", version: "1" });
	const server = await listenOnSocket(hub, sock);
	t.after(async () => {
		hub.close();
		await server.close();
	});
	return { hub, sock, dir };
}

test("relays the protocol both ways", async (t) => {
	const d = await daemon(t);
	const a = startAttach(t, { CODERRA_SOCK: d.sock });
	await a.until(() => a.records.length >= 2);
	assert.deepEqual(a.records.map((r) => r.type), ["hello_server", "ready"]);
	a.send({ id: 1, type: "resume", since: null });
	a.send({ id: 2, type: "hello", text: "héllo ✓" });
	await a.until(() => a.records.some((r) => r.id === 2));
	assert.deepEqual(a.records.find((r) => r.id === 2).data, { echo: "hello", text: "héllo ✓" });
	d.hub.emit({ type: "event", n: 1 });
	await a.until(() => a.records.some((r) => r.type === "event"));
});

test("megabytes in both directions arrive intact", async (t) => {
	const d = await daemon(t);
	const a = startAttach(t, { CODERRA_SOCK: d.sock });
	await a.until(() => a.records.length >= 2);
	a.send({ id: 1, type: "resume", since: null });
	const text = "x✓日本 \u2028🎉".repeat(300_000);
	a.send({ id: 2, type: "echo", text });
	await a.until(() => a.records.some((r) => r.id === 2), 20_000);
	assert.equal(a.records.find((r) => r.id === 2).data.text, text);
});

test("when ssh closes stdin the daemon sees the client leave, and attach exits cleanly", async (t) => {
	const d = await daemon(t);
	const a = startAttach(t, { CODERRA_SOCK: d.sock });
	await a.until(() => a.records.length >= 2);
	assert.equal(d.hub.hasClient(), true);
	a.child.stdin!.end();
	assert.equal(await a.exited, 0);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(d.hub.hasClient(), false);
});

test("when the daemon drops the client (kicked) attach delivers the last words and exits cleanly", async (t) => {
	const d = await daemon(t);
	const a = startAttach(t, { CODERRA_SOCK: d.sock });
	await a.until(() => a.records.length >= 2);
	// A newer connection takes over.
	const b = startAttach(t, { CODERRA_SOCK: d.sock });
	await b.until(() => b.records.length >= 2);
	assert.equal(await a.exited, 0);
	assert.ok(a.records.some((r) => r.type === "kicked"), "the kicked notice was not cut off");
	b.child.stdin!.end();
	await b.exited;
});

test("when the daemon is not running it says so on stderr and exits with 3", async (t) => {
	const dir = tempDir(t);
	const a = startAttach(t, { CODERRA_SOCK: join(dir, "nope.sock") });
	assert.equal(await a.exited, 3);
	assert.match(a.stderr(), /the host is not running/);
	assert.match(a.stderr(), /nope\.sock/);
	assert.deepEqual(a.records, []);
});

test("without CODERRA_SOCK it uses ~/.coderra/host.sock", async (t) => {
	const home = tempDir(t);
	mkdirSync(join(home, ".coderra"));
	const hub = new Hub({ replay: true, pingIntervalMs: 0, handle: async () => ({}) });
	const server = await listenOnSocket(hub, join(home, ".coderra", "host.sock"));
	t.after(async () => {
		hub.close();
		await server.close();
	});
	const a = startAttach(t, { HOME: home, CODERRA_SOCK: "" });
	await a.until(() => a.records.length >= 1);
	assert.equal(a.records[0].type, "hello_server");
	a.child.stdin!.end();
	await a.exited;
});
