import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AGENTS_MARKER, agentsFileText, LEGACY_STARTS } from "../src/agents-file.js";
import { Integrations } from "../src/integrations.js";
import { tempDir, withEnv } from "./helpers.js";

// What differs when the host runs on a server instead of inside the phone app.

test("the phone's notes are about Android, the server's are not", () => {
	const phone = agentsFileText({ mode: "local", workspace: "/data/ws" });
	assert.ok(phone.startsWith(AGENTS_MARKER));
	assert.match(phone, /an Android app, on the user's phone/);
	assert.match(phone, /\/system\/bin\/sh \(mksh\)/);
	assert.match(phone, /workspace directory is \/data\/ws\./);

	for (const box of [true, false]) {
		const server = agentsFileText({ mode: "vps", workspace: "/home/coderra/workspace", box });
		assert.ok(server.startsWith(AGENTS_MARKER));
		assert.match(server, /Linux server/);
		assert.match(server, /workspace directory is \/home\/coderra\/workspace\./);
		for (const wrong of [/Android/, /mksh/, /toybox/, /proot/, /on the user's phone/, /pkg/, /-S ssh/]) {
			assert.doesNotMatch(server, wrong, `${wrong} should not appear in the server notes`);
		}
		assert.match(server, /unattended run/);
	}
});

test("the server notes follow whether bash runs in the container", () => {
	const inBox = agentsFileText({ mode: "vps", workspace: "/w", box: true });
	assert.match(inBox, /inside an Ubuntu container as root/);
	assert.match(inBox, /apt-get install -y/);
	assert.doesNotMatch(inBox, /There is no sudo/);

	const bare = agentsFileText({ mode: "vps", workspace: "/w", box: false });
	assert.match(bare, /directly on the server as an unprivileged user/);
	assert.match(bare, /There is no sudo/);
	assert.doesNotMatch(bare, /apt-get install -y/);
});

test("old files without the marker are still recognised as ours", () => {
	assert.equal(LEGACY_STARTS.length, 2);
	for (const start of LEGACY_STARTS) assert.ok(start.startsWith("# Environment\n\nYou are running inside"));
});

test("on a server the DNS default is the system resolver; a saved choice still wins; the phone keeps DNS-over-HTTPS", (t) => {
	const make = () => {
		const base = tempDir(t);
		mkdirSync(join(base, "agent"));
		mkdirSync(join(base, "ws"));
		return { agentDir: join(base, "agent"), ws: join(base, "ws") };
	};
	withEnv(t, { ANDROPI_MODE: "vps", ANDROPI_STORE_KEY: undefined, GITHUB_TOKEN: undefined });
	const a = make();
	assert.equal(new Integrations(a.agentDir, a.ws).settings.dns, "system");

	// A choice made in the app is kept.
	writeFileSync(join(a.agentDir, "andropi", "integrations.json"), JSON.stringify({ sshHosts: [], settings: { dns: "google" } }));
	assert.equal(new Integrations(a.agentDir, a.ws).settings.dns, "google");

	process.env.ANDROPI_MODE = "local";
	const b = make();
	assert.equal(new Integrations(b.agentDir, b.ws).settings.dns, "cloudflare");
	delete process.env.ANDROPI_MODE;
	const c = make();
	assert.equal(new Integrations(c.agentDir, c.ws).settings.dns, "cloudflare");
});
