import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LineBuffer } from "../src/transport.js";
import { spawnHost, startDaemon, waitFor } from "./host_helpers.js";
import { dial, tempDir } from "./helpers.js";

// These start the real host (agent/src/host.ts, bundled by test/run.mjs) as a process, in daemon mode and in stdio
// mode, the two ways the app runs it. They need no model, account or network: the host just has to come up.

test("the daemon comes up, says hello, answers commands and keeps the file fence", async (t) => {
	const d = await startDaemon(t);
	assert.equal(statSync(d.sock).mode & 0o777, 0o600);

	const c = await dial(d.sock);
	await c.until(() => c.records.length >= 2);
	assert.deepEqual(c.records.slice(0, 2).map((r) => r.type), ["hello_server", "ready"]);
	assert.equal(c.records[0].protocol, 1);

	c.send({ id: 1, type: "resume", since: null });
	c.send({ id: 2, type: "hello" });
	c.send({ id: 3, type: "fs_write", path: join(d.workspace, "a.txt"), data: Buffer.from("hi").toString("base64") });
	await c.until(() => c.records.some((r) => r.id === 3)); // commands run concurrently; the list must follow the write
	c.send({ id: 4, type: "fs_list", path: d.workspace });
	c.send({ id: 5, type: "fs_list", path: "/etc" });
	c.send({ id: 6, type: "approvals_pending" });
	c.send({ id: 7, type: "no_such_command" });
	await c.until(() => [1, 2, 3, 4, 5, 6, 7].every((id) => c.records.some((r) => r.id === id)));
	const by = (id: number) => c.records.find((r) => r.id === id);

	assert.equal(by(2).data.transport, "socket");
	assert.equal(by(2).data.protocol, 1);
	assert.equal(by(2).data.workspace, d.workspace);
	assert.deepEqual(by(4).data.map((e: any) => e.name), ["a.txt"]);
	assert.equal(by(5).ok, false);
	assert.equal(by(5).code, "outside_root");
	assert.deepEqual(by(6).data, []);
	assert.equal(by(7).ok, false);
	assert.match(by(7).error, /Unknown command/);
	c.socket.destroy();
});

test("the daemon outlives its client: a new one connects to the same process and sees the same state", async (t) => {
	const d = await startDaemon(t);
	const first = await dial(d.sock);
	await first.until(() => first.records.length >= 2);
	const epoch = first.records[0].epoch;
	first.send({ id: 1, type: "fs_mkdir", path: join(d.workspace, "made-by-first") });
	await first.until(() => first.records.some((r) => r.id === 1));
	first.socket.destroy(); // the phone went to sleep

	await new Promise((r) => setTimeout(r, 200));
	assert.equal(d.child.exitCode, null, "the daemon is still running");

	const second = await dial(d.sock);
	await second.until(() => second.records.length >= 2);
	assert.equal(second.records[0].epoch, epoch, "same process, same epoch");
	second.send({ id: 1, type: "resume", since: 0, epoch });
	second.send({ id: 2, type: "fs_list", path: d.workspace });
	await second.until(() => second.records.some((r) => r.id === 2));
	assert.equal(second.records.find((r) => r.id === 1).data.gap, false);
	assert.deepEqual(second.records.find((r) => r.id === 2).data.map((e: any) => e.name), ["made-by-first"]);

	// And a third connection takes over from the second.
	const third = await dial(d.sock);
	await second.until(() => second.ended);
	assert.ok(second.records.some((r) => r.type === "kicked"));
	third.socket.destroy();
});

test("host_restart exits cleanly and removes the socket, for the service manager to start a fresh process", async (t) => {
	const d = await startDaemon(t);
	const c = await dial(d.sock);
	await c.until(() => c.records.length >= 2);
	c.send({ id: 1, type: "host_restart", whenIdle: true });
	await c.until(() => c.records.some((r) => r.id === 1));
	assert.deepEqual(c.records.find((r) => r.id === 1).data, { restarting: true });
	const { code } = await d.exited;
	assert.equal(code, 0);
	assert.equal(existsSync(d.sock), false);
});

test("SIGTERM shuts the daemon down cleanly", async (t) => {
	const d = await startDaemon(t);
	d.child.kill("SIGTERM");
	const { code, signal } = await d.exited;
	assert.deepEqual([code, signal], [0, null]);
	assert.equal(existsSync(d.sock), false);
});

test("a second daemon on the same socket refuses to start and leaves the first alone", async (t) => {
	const d = await startDaemon(t);
	const second = spawnHost(t, ["--listen", d.sock]);
	const { code } = await second.exited;
	assert.equal(code, 1);
	assert.match(second.stderr(), /already listening/);
	assert.equal(d.child.exitCode, null);
	const c = await dial(d.sock);
	await c.until(() => c.records.length >= 2);
	c.socket.destroy();
});

test("as the app's child process (stdio, no --listen) the host behaves as before", async (t) => {
	const host = spawnHost(t, []);
	const records: any[] = [];
	const lines = new LineBuffer();
	host.child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
		for (const l of lines.push(chunk)) records.push(JSON.parse(l));
	});
	await waitFor("ready", () => records.some((r) => r.type === "ready") || host.child.exitCode !== null);
	assert.equal(host.child.exitCode, null, host.stderr());
	assert.equal(records.some((r) => r.type === "hello_server"), false, "no daemon handshake in stdio mode");
	assert.equal(records.some((r) => "seq" in r), false, "no sequence numbers either");

	host.child.stdin!.write(`${JSON.stringify({ id: 1, type: "hello" })}\n`);
	host.child.stdin!.write(`${JSON.stringify({ id: 2, type: "host_restart" })}\n`);
	host.child.stdin!.write("not json\n");
	await waitFor("responses", () => records.filter((r) => r.type === "response").length >= 3);
	const response = (id: number) => records.find((r) => r.type === "response" && r.id === id);
	assert.equal(response(1).ok, true);
	assert.equal(response(1).data.transport, "stdio");
	assert.equal(response(2).ok, false, "restarting only makes sense for a daemon");
	assert.match(response(2).error, /daemon/);
	assert.match(records.find((r) => r.type === "response" && r.id === undefined).error, /^Bad JSON/);

	// Closing stdin is how the app stops the host.
	host.child.stdin!.end();
	const { code } = await host.exited;
	assert.equal(code, 0);
});

test("on a server without the container, the notes say bash runs on the machine and no shell is overridden", async (t) => {
	const home = tempDir(t);
	const d = await startDaemon(t, { CODERRA_BOX: join(home, "missing-box") }, home);
	const notes = readFileSync(join(d.home, ".pi", "agent", "AGENTS.md"), "utf8");
	assert.match(notes, /Linux server/);
	assert.match(notes, /directly on the server as an unprivileged user/);
	assert.doesNotMatch(notes, /Android/);
	const settings = join(d.home, ".pi", "agent", "settings.json");
	const configured = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")) : {};
	assert.equal(configured.shellPath, undefined);
});

test("on a server with the container set up, bash is pointed at it and the notes say so", async (t) => {
	const home = tempDir(t);
	const box = join(home, "box");
	writeFileSync(box, "#!/bin/sh\nexec /bin/sh \"$@\"\n");
	chmodSync(box, 0o755);
	const d = await startDaemon(t, { CODERRA_BOX: box }, home);
	// AGENTS.md is written before the shell is chosen, so give the settings write a moment.
	const settings = join(d.home, ".pi", "agent", "settings.json");
	await waitFor("the shell setting", () => existsSync(settings) && JSON.parse(readFileSync(settings, "utf8")).shellPath === box, 10_000);
	const notes = readFileSync(join(d.home, ".pi", "agent", "AGENTS.md"), "utf8");
	assert.match(notes, /inside an Ubuntu container as root/);
});

test("the phone's notes are written when the host is the app's child process", async (t) => {
	const host = spawnHost(t, []);
	await waitFor("the notes", () => existsSync(join(host.home, ".pi", "agent", "AGENTS.md")));
	const notes = readFileSync(join(host.home, ".pi", "agent", "AGENTS.md"), "utf8");
	assert.match(notes, /an Android app/);
	host.child.stdin!.end();
	await host.exited;
});
