import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { FsError } from "../src/fs.js";
import { type Conn, Hub, type HubOptions, LineBuffer, listenOnSocket, PROTOCOL, RestartGate } from "../src/transport.js";
import { dial, tempDir } from "./helpers.js";

/** A connection that records what the hub writes to it. */
class FakeConn implements Conn {
	lines: string[] = [];
	closed = false;
	failWrites = false;

	write(line: string) {
		if (this.failWrites) throw new Error("broken pipe");
		this.lines.push(line);
	}
	close() {
		this.closed = true;
	}
	get records(): any[] {
		return this.lines.map((l) => JSON.parse(l));
	}
	get types(): string[] {
		return this.records.map((r) => r.type);
	}
	clear() {
		this.lines = [];
	}
}

function daemon(opts: Partial<HubOptions> = {}) {
	const calls: any[] = [];
	const hub = new Hub({
		replay: true,
		pingIntervalMs: 0,
		hostVersion: "9.9.9",
		handle: async (cmd) => {
			calls.push(cmd);
			if (cmd.type === "boom") throw new FsError("EEXIST", "already there");
			if (cmd.type === "plain-boom") throw new Error("nope");
			if (cmd.type === "slow") return new Promise((r) => setTimeout(() => r("late"), 20));
			if (cmd.type === "circular") {
				const a: any = {};
				a.a = a;
				return a;
			}
			return { echo: cmd.type, args: cmd.args };
		},
		...opts,
	});
	return { hub, calls };
}

/** Attaches a client the way a daemon connection does and subscribes it to live records. */
function connect(hub: Hub, since: number | null = null, epoch?: string) {
	const conn = new FakeConn();
	const client = hub.attach(conn);
	client.receive(JSON.stringify({ id: 1, type: "resume", since, ...(epoch ? { epoch } : {}) }));
	return { conn, client };
}

const resumeResponse = (conn: FakeConn) => conn.records.find((r) => r.type === "response" && r.id === 1);

// ---------------------------------------------------------------------------
// Lines

test("LineBuffer splits on LF only, trims CR, skips blanks and keeps partial lines", () => {
	const b = new LineBuffer();
	assert.deepEqual(b.push('{"a":1}\n{"b"'), ['{"a":1}']);
	assert.deepEqual(b.push(':2}\r\n\n  \n{"c":3}\n'), ['{"b":2}', '{"c":3}']);
	// U+2028 is legal inside JSON strings and must not end a line.
	assert.deepEqual(b.push('{"s":"a\u2028b"}\n'), ['{"s":"a\u2028b"}']);
	assert.deepEqual(b.push("no newline yet"), []);
	assert.deepEqual(b.push("\n"), ["no newline yet"]);
});

test("LineBuffer refuses a line that never ends", () => {
	const b = new LineBuffer(100);
	assert.throws(() => b.push("x".repeat(101)), /too long/);
});

// ---------------------------------------------------------------------------
// stdio mode: the app's own child process

test("stdio mode passes records through untouched: no seq, no hello, no buffering", () => {
	const { hub } = daemon({ replay: false });
	const conn = new FakeConn();
	hub.attach(conn);
	hub.emit({ type: "event", n: 1 });
	hub.emit({ type: "auth_prompt", n: 2 });
	hub.setReady({ type: "ready", version: "1" });
	assert.deepEqual(conn.records, [{ type: "event", n: 1 }, { type: "auth_prompt", n: 2 }, { type: "ready", version: "1" }]);
	assert.deepEqual(hub.stats(), { seq: 0, firstSeq: 1, buffered: 0, bytes: 0 });
});

test("stdio mode answers commands, with the failure's code", async () => {
	const { hub } = daemon({ replay: false });
	const conn = new FakeConn();
	const client = hub.attach(conn);
	client.receive(JSON.stringify({ id: 7, type: "hello", args: 1 }));
	client.receive(JSON.stringify({ id: 8, type: "boom" }));
	client.receive(JSON.stringify({ id: 9, type: "plain-boom" }));
	await new Promise((r) => setTimeout(r, 10));
	const byId = Object.fromEntries(conn.records.map((r) => [r.id, r]));
	assert.deepEqual(byId[7], { type: "response", id: 7, ok: true, data: { echo: "hello", args: 1 } });
	assert.deepEqual(byId[8], { type: "response", id: 8, ok: false, error: "already there", code: "EEXIST" });
	assert.equal(byId[9].ok, false);
	assert.equal(byId[9].error, "nope");
	assert.equal(byId[9].code, undefined);
});

test("bad JSON gets an error response without an id; non-objects too", () => {
	const { hub } = daemon({ replay: false });
	const conn = new FakeConn();
	const client = hub.attach(conn);
	client.receive("{not json");
	client.receive("[1,2]");
	client.receive("42");
	assert.equal(conn.records.length, 3);
	for (const r of conn.records) {
		assert.equal(r.type, "response");
		assert.equal(r.ok, false);
		assert.match(r.error, /^Bad JSON/);
	}
});

test("a result that cannot be serialised becomes an error response, not a crash", async () => {
	const { hub } = daemon({ replay: false });
	const conn = new FakeConn();
	hub.attach(conn).receive(JSON.stringify({ id: 3, type: "circular" }));
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(conn.records[0].ok, false);
	assert.equal(conn.records[0].id, 3);
});

// ---------------------------------------------------------------------------
// Daemon mode: attach, resume, replay

test("attaching says hello and then ready; nothing live arrives before resume", () => {
	const { hub } = daemon();
	hub.setReady({ type: "ready", version: "1.2.3" });
	hub.emit({ type: "event", n: 1 });
	const conn = new FakeConn();
	hub.attach(conn);
	assert.deepEqual(conn.types, ["hello_server", "ready"]);
	const hello = conn.records[0];
	assert.equal(hello.protocol, PROTOCOL);
	assert.equal(hello.epoch, hub.epoch);
	assert.equal(hello.seq, 1);
	assert.equal(hello.firstSeq, 1);
	assert.equal(hello.hostVersion, "9.9.9");

	hub.emit({ type: "event", n: 2 });
	assert.deepEqual(conn.types, ["hello_server", "ready"], "gated until the client subscribes");
});

test("resume with since:null goes live without replaying", () => {
	const { hub } = daemon();
	hub.emit({ type: "event", n: 1 });
	const { conn } = connect(hub, null);
	assert.deepEqual(resumeResponse(conn).data, { replayed: 0, gap: false, seq: 1, epoch: hub.epoch });
	conn.clear();
	hub.emit({ type: "event", n: 2 });
	assert.deepEqual(conn.records, [{ type: "event", n: 2, seq: 2 }]);
});

test("replayable records get consecutive seq numbers; others are live-only and have none", () => {
	const { hub } = daemon();
	const { conn } = connect(hub);
	conn.clear();
	hub.emit({ type: "event", n: 1 });
	hub.emit({ type: "auth_prompt", authId: 1 });
	hub.emit({ type: "approval", approvalId: "a1" });
	hub.emit({ type: "task", line: "x" });
	assert.deepEqual(
		conn.records.map((r) => [r.type, r.seq]),
		[["event", 1], ["auth_prompt", undefined], ["approval", 2], ["task", 3]],
	);
	// The live-only record is not remembered.
	assert.equal(hub.stats().buffered, 3);
});

test("a client that drops and comes back gets exactly what it missed, in order, once", () => {
	const { hub } = daemon();
	const first = connect(hub);
	hub.emit({ type: "event", n: 1 });
	hub.emit({ type: "event", n: 2 });
	assert.deepEqual(first.conn.records.filter((r) => r.type === "event").map((r) => r.seq), [1, 2]);

	first.client.detach(); // the phone went to sleep
	hub.emit({ type: "event", n: 3 });
	hub.emit({ type: "approval", approvalId: "a1" });
	hub.emit({ type: "event", n: 4 });

	const second = connect(hub, 2, hub.epoch);
	const got = second.conn.records;
	assert.deepEqual(got.map((r) => r.type), ["hello_server", "event", "approval", "event", "response"]);
	assert.deepEqual(got.filter((r) => r.type !== "hello_server" && r.seq).map((r) => r.seq), [3, 4, 5]);
	assert.deepEqual(resumeResponse(second.conn).data, { replayed: 3, gap: false, seq: 5, epoch: hub.epoch });
	// The response comes after the replay, and live delivery continues from the next seq.
	assert.equal(got.at(-1)?.type, "response");
	second.conn.clear();
	hub.emit({ type: "event", n: 5 });
	assert.deepEqual(second.conn.records.map((r) => r.seq), [6]);
});

test("resuming exactly at the head replays nothing", () => {
	const { hub } = daemon();
	hub.emit({ type: "event" });
	hub.emit({ type: "event" });
	const { conn } = connect(hub, 2, hub.epoch);
	assert.deepEqual(resumeResponse(conn).data, { replayed: 0, gap: false, seq: 2, epoch: hub.epoch });
});

test("a record emitted while the client is being replayed is neither lost nor sent twice", () => {
	const { hub } = daemon();
	hub.emit({ type: "event", n: 1 });
	const conn = new FakeConn();
	const client = hub.attach(conn);
	hub.emit({ type: "event", n: 2 }); // arrives between attach and resume
	client.receive(JSON.stringify({ id: 1, type: "resume", since: 0 }));
	hub.emit({ type: "event", n: 3 });
	assert.deepEqual(
		conn.records.filter((r) => r.type === "event").map((r) => r.seq),
		[1, 2, 3],
	);
});

test("when the buffer no longer reaches back far enough, resume reports a gap and replays nothing", () => {
	const { hub } = daemon({ capacityRecords: 3 });
	for (let n = 1; n <= 10; n++) hub.emit({ type: "event", n });
	assert.deepEqual(hub.stats(), { seq: 10, firstSeq: 8, buffered: 3, bytes: hub.stats().bytes });

	const stale = connect(hub, 5, hub.epoch);
	assert.deepEqual(resumeResponse(stale.conn).data, { replayed: 0, gap: true, seq: 10, epoch: hub.epoch });
	assert.equal(stale.conn.types.includes("event"), false);
	// The client is live after a gap, too.
	stale.conn.clear();
	hub.emit({ type: "event", n: 11 });
	assert.deepEqual(stale.conn.records.map((r) => r.seq), [11]);

	// Just inside the window is fine: the oldest record kept is 9 now (3 kept: 9, 10, 11), so since=8 still works.
	const ok = connect(hub, 8, hub.epoch);
	assert.deepEqual(resumeResponse(ok.conn).data, { replayed: 3, gap: false, seq: 11, epoch: hub.epoch });
});

test("the byte budget evicts too, and a record bigger than the whole budget is never replayable", () => {
	const { hub } = daemon({ capacityBytes: 500 });
	for (let n = 1; n <= 5; n++) hub.emit({ type: "event", pad: "x".repeat(100) });
	assert.ok(hub.stats().bytes <= 500);
	assert.ok(hub.stats().buffered < 5);
	hub.emit({ type: "event", pad: "y".repeat(2000) });
	assert.equal(hub.stats().buffered, 0);
	assert.equal(hub.stats().firstSeq, 7);
	const { conn } = connect(hub, 5, hub.epoch);
	assert.equal(resumeResponse(conn).data.gap, true);
});

test("a client from another daemon instance (different epoch) or from the future gets a gap", () => {
	const { hub } = daemon();
	hub.emit({ type: "event" });
	assert.equal(resumeResponse(connect(hub, 1, "someone-else").conn).data.gap, true);
	assert.equal(resumeResponse(connect(hub, 99, hub.epoch).conn).data.gap, true);
	// Without an epoch the client cannot tell; the numbers decide.
	assert.equal(resumeResponse(connect(hub, 1).conn).data.gap, false);
});

test("a bad since is refused", () => {
	const { hub } = daemon();
	for (const since of [-1, 1.5, "3", {}]) {
		const conn = new FakeConn();
		const client = hub.attach(conn);
		client.receive(JSON.stringify({ id: 1, type: "resume", since }));
		const r = resumeResponse(conn);
		assert.equal(r.ok, false, JSON.stringify(since));
		assert.equal(r.code, "invalid_argument");
	}
});

// ---------------------------------------------------------------------------
// One client at a time

test("a new connection kicks the old one, which gets no more records", async () => {
	const { hub } = daemon();
	const old = connect(hub);
	old.conn.clear();
	const fresh = connect(hub);
	assert.deepEqual(old.conn.types, ["kicked"]);
	assert.equal(old.conn.closed, true);
	assert.equal(hub.hasClient(), true);

	fresh.conn.clear();
	hub.emit({ type: "event", n: 1 });
	assert.equal(fresh.conn.records.length, 1);
	assert.deepEqual(old.conn.types, ["kicked"], "nothing after being kicked");

	// Whatever the kicked client still sends is ignored.
	old.client.receive(JSON.stringify({ id: 5, type: "anything" }));
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(old.conn.records.length, 1);
	// Detaching the kicked client does not disturb the new one.
	old.client.detach();
	assert.equal(hub.hasClient(), true);
});

test("commands are answered on the connection they came from, and a drop mid-command loses only the answer", async () => {
	const { hub } = daemon();
	const a = connect(hub);
	a.conn.clear();
	a.client.receive(JSON.stringify({ id: 21, type: "slow" }));
	a.client.detach(); // the app went away while the command ran
	const b = connect(hub);
	b.conn.clear();
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(a.conn.records, [], "nothing written to a dropped connection");
	assert.deepEqual(b.conn.records, [], "and nothing leaked to the new one");
	b.client.receive(JSON.stringify({ id: 22, type: "x" }));
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(b.conn.records[0].id, 22);
});

test("a connection that throws on write is dropped and the hub carries on", () => {
	const { hub } = daemon();
	const bad = connect(hub);
	bad.conn.failWrites = true;
	hub.emit({ type: "event", n: 1 }); // must not throw
	assert.equal(hub.hasClient(), false);
	assert.equal(bad.conn.closed, true);
	hub.emit({ type: "event", n: 2 });
	assert.equal(hub.stats().seq, 2);
	const again = connect(hub, 0, hub.epoch);
	assert.deepEqual(resumeResponse(again.conn).data.replayed, 2);
});

// ---------------------------------------------------------------------------
// Pings

test("ping is answered with pong, and records whether the app is in the background", () => {
	const { hub } = daemon();
	const { conn, client } = connect(hub);
	conn.clear();
	assert.equal(hub.clientInBackground(), false);
	client.receive(JSON.stringify({ type: "ping", background: true }));
	assert.deepEqual(conn.records, [{ type: "pong" }]);
	assert.equal(hub.clientInBackground(), true);
	client.receive(JSON.stringify({ type: "ping" }));
	assert.equal(hub.clientInBackground(), false);
	client.detach();
	assert.equal(hub.clientInBackground(), true, "nobody connected counts as nobody looking");
});

test("tick pings a live client and drops one that has gone silent", () => {
	let now = 1_000_000;
	const { hub } = daemon({ now: () => now, idleTimeoutMs: 45_000 });
	const { conn, client } = connect(hub);
	conn.clear();
	now += 15_000;
	hub.tick();
	assert.deepEqual(conn.records, [{ type: "ping" }]);

	client.receive(JSON.stringify({ type: "pong" })); // any traffic counts as life
	now += 40_000;
	hub.tick();
	assert.equal(hub.hasClient(), true);

	now += 46_000;
	hub.tick();
	assert.equal(hub.hasClient(), false);
	assert.equal(conn.closed, true);
	hub.tick(); // nothing to do, and no crash
});

// ---------------------------------------------------------------------------
// Restart when idle

test("RestartGate restarts at once when idle, or when not asked to wait", async () => {
	let exits = 0;
	const idle = new RestartGate({ isIdle: () => true, exit: () => exits++, graceMs: 1 });
	assert.deepEqual(idle.request(true), { restarting: true });
	const busy = new RestartGate({ isIdle: () => false, exit: () => exits++, graceMs: 1 });
	assert.deepEqual(busy.request(false), { restarting: true });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(exits, 2);
});

test("RestartGate waits for the host to go idle, then restarts once", async () => {
	let exits = 0;
	let idle = false;
	const gate = new RestartGate({ isIdle: () => idle, exit: () => exits++, pollMs: 1_000_000 });
	assert.deepEqual(gate.request(true), { restarting: false, pending: true });
	assert.deepEqual(gate.request(true), { restarting: false, pending: true }, "asking twice does not stack");
	assert.equal(gate.pending, true);
	gate.poll();
	assert.equal(exits, 0, "still busy");
	idle = true;
	gate.poll();
	gate.poll();
	assert.equal(exits, 1);
	assert.equal(gate.pending, false);
});

test("RestartGate can be called off", () => {
	let exits = 0;
	const gate = new RestartGate({ isIdle: () => false, exit: () => exits++, pollMs: 1_000_000 });
	gate.request(true);
	gate.cancel();
	assert.equal(gate.pending, false);
	gate.poll();
	assert.equal(exits, 0);
});

// ---------------------------------------------------------------------------
// The real socket

test("a daemon on a real socket: private permissions, hello, commands, kick, resume after a drop", async (t) => {
	const dir = tempDir(t);
	const path = join(dir, "run", "host.sock");
	const { hub } = daemon();
	hub.setReady({ type: "ready", version: "1" });
	const server = await listenOnSocket(hub, path);
	t.after(async () => {
		hub.close();
		await server.close();
	});

	assert.equal(statSync(path).mode & 0o777, 0o600, "only this user can connect");
	assert.equal(statSync(join(dir, "run")).mode & 0o777, 0o700);

	const one = await dial(path);
	await one.until(() => one.records.length >= 2);
	assert.deepEqual(one.records.map((r) => r.type), ["hello_server", "ready"]);
	one.send({ id: 1, type: "resume", since: null });
	one.send({ id: 2, type: "hello", args: "x" });
	await one.until(() => one.records.some((r) => r.id === 2));
	assert.deepEqual(one.records.find((r) => r.id === 2).data, { echo: "hello", args: "x" });

	hub.emit({ type: "event", n: 1 });
	await one.until(() => one.records.some((r) => r.type === "event"));

	// A second connection takes over; the first is told and closed.
	const two = await dial(path);
	await one.until(() => one.ended);
	assert.ok(one.records.some((r) => r.type === "kicked"));
	await two.until(() => two.records.length >= 2);

	// The second one drops; events keep coming; a third picks them up from where the second stopped.
	two.send({ id: 1, type: "resume", since: null });
	await two.until(() => two.records.some((r) => r.id === 1));
	const seen = hub.stats().seq;
	two.socket.destroy();
	await new Promise((r) => setTimeout(r, 20));
	hub.emit({ type: "event", n: 2 });
	hub.emit({ type: "approval", approvalId: "a1" });
	const three = await dial(path);
	await three.until(() => three.records.length >= 2);
	three.send({ id: 1, type: "resume", since: seen, epoch: hub.epoch });
	await three.until(() => three.records.some((r) => r.id === 1));
	assert.deepEqual(
		three.records.filter((r) => r.type !== "hello_server" && r.seq).map((r) => [r.type, r.seq]),
		[["event", seen + 1], ["approval", seen + 2]],
	);
	three.socket.destroy();
});

test("big messages with multi-byte characters survive the socket intact", async (t) => {
	const dir = tempDir(t);
	const path = join(dir, "h.sock");
	const { hub } = daemon({ handle: async (cmd) => ({ text: cmd.text }) });
	const server = await listenOnSocket(hub, path);
	t.after(async () => {
		hub.close();
		await server.close();
	});
	const c = await dial(path);
	c.send({ id: 1, type: "resume", since: null });
	const text = "héllo ✓ 日本語 \u2028 🎉 ".repeat(150_000); // a few MB, with characters split across TCP chunks
	c.send({ id: 2, type: "echo", text });
	await c.until(() => c.records.some((r) => r.id === 2), 10_000);
	assert.equal(c.records.find((r) => r.id === 2).data.text, text);
	c.socket.destroy();
});

test("a socket left behind by a crashed daemon is replaced; a live one or a plain file is not", async (t) => {
	const dir = tempDir(t);
	const path = join(dir, "h.sock");

	// A process that listens and is then killed without cleaning up leaves a stale socket file.
	const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(process.argv[1], () => console.log("up"))`, path]);
	await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
	const dead = new Promise((r) => child.once("exit", r));
	child.kill("SIGKILL");
	await dead;
	assert.equal(existsSync(path), true, "the stale socket is still there");

	const { hub } = daemon();
	const server = await listenOnSocket(hub, path);
	await assert.rejects(() => listenOnSocket(daemon().hub, path), /already listening/);
	assert.equal(statSync(path).isSocket(), true, "the live one was not touched");
	await server.close();
	assert.equal(existsSync(path), false, "closing removes the socket file");

	const plain = join(dir, "not-a-socket");
	writeFileSync(plain, "data");
	await assert.rejects(() => listenOnSocket(daemon().hub, plain), /not a socket/);
	assert.equal(existsSync(plain), true);

	await assert.rejects(() => listenOnSocket(daemon().hub, join(dir, "x".repeat(120), "h.sock")), /too long/);
	mkdirSync(join(dir, "ok"));
});
