import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { dial, tempDir } from "./helpers.js";

// server/coderra-hostd.service, run for real as a systemd *user* service: the same file the bootstrap installs, with
// only the paths changed to a throwaway home. Checks what the unit promises: it starts the daemon, restarts it when it
// exits (host_restart) or is killed, stops it cleanly, applies its memory limit, and stays quiet until the host has
// been copied over. Skipped where there is no systemd user manager (most CI containers).

const UNIT_FILE = fileURLToPath(new URL("../../server/coderra-hostd.service", import.meta.url));
const HOST_BUNDLE = fileURLToPath(new URL("./harness/host.mjs", import.meta.url));
const AGENT_MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));

const hasUserManager = (() => {
	const r = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" });
	return /running|degraded/.test(r.stdout ?? "") && spawnSync("systemd-run", ["--version"]).status === 0;
})();
const SKIP = hasUserManager ? false : "needs a systemd user manager";

const ctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8" }).trim();
const show = (unit: string, prop: string) => ctl("show", unit, `-p`, prop, "--value");

async function waitFor(what: string, ok: () => boolean | Promise<boolean>, ms = 20_000) {
	const t0 = Date.now();
	while (!(await ok())) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** Installs the unit under a unique name for a throwaway home, and removes it afterwards. */
function installUnit(t: TestContext, { withHost = true }: { withHost?: boolean } = {}) {
	const name = `coderra-hostd-test-${process.pid}-${Date.now().toString(36)}.service`;
	const dir = join(homedir(), ".config", "systemd", "user");
	const path = join(dir, name);
	// Registered before the throwaway home is created: hooks run in the order they were added, and the service has to be
	// stopped before its home is deleted, or it would write there again and leave the folder behind.
	t.after(() => {
		spawnSync("systemctl", ["--user", "stop", name]);
		spawnSync("systemctl", ["--user", "reset-failed", name]);
		rmSync(path, { force: true });
		spawnSync("systemctl", ["--user", "daemon-reload"]);
	});

	const home = tempDir(t, "cr-svc-");
	mkdirSync(join(home, ".coderra", "host"), { recursive: true });
	if (withHost) {
		copyFileSync(HOST_BUNDLE, join(home, ".coderra", "host", "host.mjs"));
		symlinkSync(AGENT_MODULES, join(home, ".coderra", "host", "node_modules"));
	}
	writeFileSync(join(home, ".coderra", "env"), `ANDROPI_STORE_KEY=${"ab".repeat(32)}\n`, { mode: 0o600 });

	const text = readFileSync(UNIT_FILE, "utf8")
		.replaceAll("%h", home)
		.replace("/usr/local/bin/node", process.execPath)
		// The user manager's HOME is the real one; the real unit runs as an account whose HOME is %h.
		.replace("[Service]\n", `[Service]\nEnvironment=HOME=${home}\n`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, text);
	ctl("daemon-reload");
	return { name, home, sock: join(home, ".coderra", "host.sock") };
}

/** Connects, reads the greeting, returns the daemon's epoch (it changes with every new process). */
async function epochOf(sock: string): Promise<string | null> {
	if (!existsSync(sock)) return null;
	try {
		const c = await dial(sock);
		await c.until(() => c.records.length >= 1, 3000);
		const epoch = c.records[0].epoch as string;
		c.socket.destroy();
		return epoch;
	} catch {
		return null;
	}
}

test("the unit file passes systemd's own checks", { skip: SKIP }, (t) => {
	const dir = tempDir(t);
	const text = readFileSync(UNIT_FILE, "utf8").replace("/usr/local/bin/node", process.execPath);
	const copy = join(dir, "coderra-hostd.service");
	writeFileSync(copy, text);
	chmodSync(copy, 0o644);
	const r = spawnSync("systemd-analyze", ["--user", "verify", copy], { encoding: "utf8" });
	assert.equal(`${r.stdout}${r.stderr}`.trim(), "");
});

test("it starts the daemon, with the memory limit and the settings from the unit", { skip: SKIP }, async (t) => {
	const u = installUnit(t);
	ctl("start", u.name);
	await waitFor("the daemon's socket", () => existsSync(u.sock));
	assert.equal(show(u.name, "ActiveState"), "active");
	assert.equal(show(u.name, "MemoryMax"), String(1280 * 1024 * 1024));
	assert.equal(show(u.name, "CPUWeight"), "200");
	const epoch = await epochOf(u.sock);
	assert.ok(epoch, "the daemon answers");

	const c = await dial(u.sock);
	await c.until(() => c.records.length >= 2);
	c.send({ id: 1, type: "resume", since: null });
	c.send({ id: 2, type: "hello" });
	await c.until(() => c.records.some((r) => r.id === 2));
	const hello = c.records.find((r) => r.id === 2).data;
	assert.equal(hello.transport, "socket");
	assert.equal(hello.workspace, join(u.home, "workspace"));
	assert.equal(hello.agentDir, join(u.home, ".pi", "agent"));
	c.socket.destroy();
});

test("host_restart makes the daemon exit and systemd brings up a fresh one", { skip: SKIP }, async (t) => {
	const u = installUnit(t);
	ctl("start", u.name);
	await waitFor("the daemon", () => existsSync(u.sock));
	const before = await epochOf(u.sock);
	const pidBefore = show(u.name, "MainPID");

	const c = await dial(u.sock);
	await c.until(() => c.records.length >= 2);
	c.send({ id: 1, type: "host_restart", whenIdle: true });
	await c.until(() => c.records.some((r) => r.id === 1));
	assert.deepEqual(c.records.find((r) => r.id === 1).data, { restarting: true });

	await waitFor("a different daemon process", async () => {
		const e = await epochOf(u.sock);
		return !!e && e !== before;
	});
	assert.notEqual(show(u.name, "MainPID"), pidBefore);
	assert.equal(show(u.name, "ActiveState"), "active");
});

test("a daemon that is killed outright is started again", { skip: SKIP }, async (t) => {
	const u = installUnit(t);
	ctl("start", u.name);
	await waitFor("the daemon", () => existsSync(u.sock));
	const before = await epochOf(u.sock);
	process.kill(Number(show(u.name, "MainPID")), "SIGKILL");
	await waitFor("a different daemon process", async () => {
		const e = await epochOf(u.sock);
		return !!e && e !== before;
	});
	assert.ok(Number(show(u.name, "NRestarts")) >= 1);
});

test("stopping the service shuts the daemon down cleanly and removes its socket", { skip: SKIP }, async (t) => {
	const u = installUnit(t);
	ctl("start", u.name);
	await waitFor("the daemon", () => existsSync(u.sock));
	ctl("stop", u.name);
	assert.equal(show(u.name, "ActiveState"), "inactive");
	assert.equal(show(u.name, "Result"), "success");
	assert.equal(existsSync(u.sock), false);
});

test("until the app has copied the host over, starting the unit does nothing and fails nothing", { skip: SKIP }, async (t) => {
	const u = installUnit(t, { withHost: false });
	ctl("start", u.name);
	assert.equal(show(u.name, "ActiveState"), "inactive");
	assert.equal(show(u.name, "ConditionResult"), "no");
	assert.equal(existsSync(u.sock), false);
});
