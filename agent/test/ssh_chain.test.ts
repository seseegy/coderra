import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { Hub, LineBuffer, listenOnSocket } from "../src/transport.js";
import { tempDir } from "./helpers.js";

// The whole path from the phone to the daemon, with a real sshd: ssh -> sshd -> coderra-attach -> the daemon's socket.
// The sshd is a private one started here, as the current user, on a loopback port, with throwaway keys. The key is
// authorised with the exact restrictions server/bootstrap.sh gives the app's key (read from that file, so the two
// cannot drift apart).

const SSHD = ["/usr/sbin/sshd", "/usr/local/sbin/sshd"].find((p) => existsSync(p));
const hasSsh = (() => {
	try {
		execFileSync("ssh", ["-V"], { stdio: "ignore" });
		execFileSync("ssh-keygen", ["-?"], { stdio: ["ignore", "ignore", "ignore"] });
		return true;
	} catch (e) {
		// ssh -V exits 0; ssh-keygen -? exits 1 but runs, which is all we need to know.
		return (e as { status?: number }).status !== undefined;
	}
})();
const SKIP = !SSHD || !hasSsh ? "needs sshd and the ssh client" : false;

const ATTACH = fileURLToPath(new URL("../../server/coderra-attach", import.meta.url));
const BOOTSTRAP = fileURLToPath(new URL("../../server/bootstrap.sh", import.meta.url));
const KEY_OPTIONS = /^KEY_OPTIONS='(.*)'$/m.exec(readFileSync(BOOTSTRAP, "utf8"))?.[1] ?? "";

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = net.createServer().listen(0, "127.0.0.1", () => {
			const port = (s.address() as net.AddressInfo).port;
			s.close(() => resolve(port));
		});
	});
}

async function startSshd(t: TestContext) {
	const dir = tempDir(t);
	const keygen = (name: string) => execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, name)]);
	keygen("host_key");
	keygen("client_key");
	keygen("other_key");
	const port = await freePort();
	const user = userInfo().username;
	writeFileSync(
		join(dir, "sshd_config"),
		[
			`Port ${port}`,
			"ListenAddress 127.0.0.1",
			`HostKey ${join(dir, "host_key")}`,
			`PidFile ${join(dir, "sshd.pid")}`,
			`AuthorizedKeysFile ${join(dir, "authorized_keys")}`,
			"PasswordAuthentication no",
			"KbdInteractiveAuthentication no",
			"PubkeyAuthentication yes",
			"UsePAM no",
			"StrictModes no",
			`AllowUsers ${user}`,
			"LogLevel ERROR",
		].join("\n"),
	);
	writeFileSync(join(dir, "authorized_keys"), `${KEY_OPTIONS} ${readFileSync(join(dir, "client_key.pub"), "utf8")}`);
	const hostPub = readFileSync(join(dir, "host_key.pub"), "utf8").split(" ").slice(0, 2).join(" ");
	writeFileSync(join(dir, "known_hosts"), `[127.0.0.1]:${port} ${hostPub}\n`);

	const sshd = spawn(SSHD!, ["-D", "-e", "-f", join(dir, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
	let log = "";
	sshd.stderr!.setEncoding("utf8").on("data", (d) => (log += d));
	t.after(() => void sshd.kill("SIGKILL"));
	for (let i = 0; i < 100; i++) {
		const up = await new Promise<boolean>((r) => net.connect(port, "127.0.0.1").once("connect", function (this: net.Socket) { this.destroy(); r(true); }).once("error", () => r(false)));
		if (up) break;
		if (sshd.exitCode !== null) throw new Error(`sshd would not start: ${log}`);
		await new Promise((r) => setTimeout(r, 50));
	}

	const sshArgs = (key = "client_key", knownHosts = "known_hosts") => [
		"-p", String(port),
		"-i", join(dir, key),
		"-o", "IdentitiesOnly=yes",
		"-o", `UserKnownHostsFile=${join(dir, knownHosts)}`,
		"-o", "StrictHostKeyChecking=yes",
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=10",
		"-o", "LogLevel=ERROR",
	];
	return { dir, port, user, sshArgs, hostPub, target: `${user}@127.0.0.1` };
}

/** Starts the real attach program on the far side of ssh. */
function sshAttach(t: TestContext, s: Awaited<ReturnType<typeof startSshd>>, sock: string) {
	const child = spawn("ssh", [...s.sshArgs(), s.target, `env CODERRA_SOCK=${sock} ${process.execPath} ${ATTACH}`], { stdio: ["pipe", "pipe", "pipe"] });
	t.after(() => void child.kill("SIGKILL"));
	const records: any[] = [];
	let stderr = "";
	const lines = new LineBuffer();
	child.stdout!.setEncoding("utf8").on("data", (c: string) => {
		for (const l of lines.push(c)) records.push(JSON.parse(l));
	});
	child.stderr!.setEncoding("utf8").on("data", (d) => (stderr += d));
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const send = (r: object) => child.stdin!.write(`${JSON.stringify(r)}\n`);
	const until = async (ok: () => boolean, ms = 8000) => {
		const t0 = Date.now();
		while (!ok()) {
			if (Date.now() - t0 > ms) throw new Error(`timed out; got ${JSON.stringify(records.map((r) => r.type))} stderr=${stderr}`);
			await new Promise((r) => setTimeout(r, 10));
		}
	};
	return { child: child as ChildProcess, records, send, until, exited, stderr: () => stderr };
}

async function hubDaemon(t: TestContext, sock: string) {
	const hub = new Hub({ replay: true, pingIntervalMs: 0, handle: async (cmd) => ({ echo: cmd.type }) });
	hub.setReady({ type: "ready", version: "1" });
	const server = await listenOnSocket(hub, sock);
	t.after(async () => {
		hub.close();
		await server.close();
	});
	return hub;
}

/** A TCP server on all interfaces that says "echo-ready" and hangs up, so a tunnel to it is easy to recognise. */
async function echoServer(t: TestContext): Promise<number> {
	const server = net.createServer((c) => c.end("echo-ready\n"));
	await new Promise<void>((r) => server.listen(0, "0.0.0.0", () => r()));
	t.after(() => void server.close());
	return (server.address() as net.AddressInfo).port;
}

async function throughTunnel(local: number): Promise<string> {
	return new Promise((resolve) => {
		const c = net.connect(local, "127.0.0.1");
		let data = "";
		c.setEncoding("utf8").on("data", (d) => (data += d));
		c.on("close", () => resolve(data.trim() || "closed-without-data"));
		c.on("error", () => resolve("error"));
		setTimeout(() => (c.destroy(), resolve(data.trim() || "timeout")), 3000);
	});
}

test("the key line in bootstrap.sh is the restricted one the rest of this file relies on", () => {
	assert.match(KEY_OPTIONS, /^restrict,/);
	assert.match(KEY_OPTIONS, /permitopen="127\.0\.0\.1:\*"/);
	assert.match(KEY_OPTIONS, /permitlisten=/);
});

test("the app reaches the daemon through ssh, and the daemon outlives the connection", { skip: SKIP }, async (t) => {
	const s = await startSshd(t);
	const sock = join(s.dir, "host.sock");
	const hub = await hubDaemon(t, sock);

	const first = sshAttach(t, s, sock);
	await first.until(() => first.records.length >= 2);
	assert.deepEqual(first.records.map((r) => r.type), ["hello_server", "ready"]);
	first.send({ id: 1, type: "resume", since: null });
	first.send({ id: 2, type: "ping_me" });
	await first.until(() => first.records.some((r) => r.id === 2));
	assert.deepEqual(first.records.find((r) => r.id === 2).data, { echo: "ping_me" });

	// The connection drops the way a phone's does: the client process just goes away.
	const seen = hub.stats().seq;
	first.child.kill("SIGKILL");
	await first.exited;
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(hub.hasClient(), false, "the daemon noticed the client left");
	hub.emit({ type: "event", n: 1 });

	const second = sshAttach(t, s, sock);
	await second.until(() => second.records.length >= 2);
	second.send({ id: 1, type: "resume", since: seen, epoch: hub.epoch });
	await second.until(() => second.records.some((r) => r.id === 1));
	assert.deepEqual(second.records.find((r) => r.id === 1).data, { replayed: 1, gap: false, seq: seen + 1, epoch: hub.epoch });
	second.child.stdin!.end();
	assert.equal(await second.exited, 0);
});

test("when the daemon is down, why reaches the app on stderr", { skip: SKIP }, async (t) => {
	const s = await startSshd(t);
	const a = sshAttach(t, s, join(s.dir, "nobody-home.sock"));
	assert.equal(await a.exited, 3, "ssh passes the remote exit status through");
	assert.match(a.stderr(), /the host is not running/);
});

test("tunnels to the server's own loopback work; to anywhere else they are refused", { skip: SKIP }, async (t) => {
	const s = await startSshd(t);
	const echo = await echoServer(t);
	for (const [target, expected] of [
		["127.0.0.1", "echo-ready"],
		["127.0.0.2", "closed-without-data"], // reachable on this machine, but not what the key allows
	] as const) {
		const local = await freePort();
		const tunnel = spawn("ssh", [...s.sshArgs(), "-N", "-L", `127.0.0.1:${local}:${target}:${echo}`, s.target], { stdio: "ignore" });
		t.after(() => void tunnel.kill("SIGKILL"));
		await new Promise((r) => setTimeout(r, 700));
		assert.equal(await throughTunnel(local), expected, `-L to ${target}`);
		tunnel.kill("SIGKILL");
	}
});

test("a remote forward (ssh -R) is refused: nothing on the phone's side can open a port on the server", { skip: SKIP }, async (t) => {
	const s = await startSshd(t);
	const r = spawnSync("ssh", [...s.sshArgs(), "-o", "ExitOnForwardFailure=yes", "-R", "127.0.0.1:0:127.0.0.1:9", s.target, "echo should-not-run"], { encoding: "utf8", timeout: 15000 });
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /remote port forwarding failed/);
	assert.doesNotMatch(r.stdout, /should-not-run/);
});

test("a key that is not authorised is refused", { skip: SKIP }, async (t) => {
	const s = await startSshd(t);
	const r = spawnSync("ssh", [...s.sshArgs("other_key"), s.target, "echo hi"], { encoding: "utf8", timeout: 15000 });
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /Permission denied/);
});

test("a server whose host key is not the pinned one is refused before anything is sent", { skip: SKIP }, async (t) => {
	const s = await startSshd(t);
	// What the setup code would pin, but for some other machine's key.
	const impostor = execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(s.dir, "impostor")]) && readFileSync(join(s.dir, "impostor.pub"), "utf8").split(" ").slice(0, 2).join(" ");
	writeFileSync(join(s.dir, "pinned_wrong"), `[127.0.0.1]:${s.port} ${impostor}\n`);
	const r = spawnSync("ssh", [...s.sshArgs("client_key", "pinned_wrong"), s.target, "echo hi"], { encoding: "utf8", timeout: 15000 });
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/);
	assert.doesNotMatch(r.stdout, /hi/);
});

test("the pinned key is accepted, and an unknown server is not trusted on first use", { skip: SKIP }, async (t) => {
	const s = await startSshd(t);
	assert.equal(spawnSync("ssh", [...s.sshArgs(), s.target, "echo hi"], { encoding: "utf8", timeout: 15000 }).stdout.trim(), "hi");
	writeFileSync(join(s.dir, "empty_known_hosts"), "");
	const r = spawnSync("ssh", [...s.sshArgs("client_key", "empty_known_hosts"), s.target, "echo hi"], { encoding: "utf8", timeout: 15000 });
	assert.notEqual(r.status, 0, "with StrictHostKeyChecking=yes an unknown host is an error, not a question");
});
