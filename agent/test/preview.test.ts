import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Preview } from "../src/preview.js";
import { tempDir } from "./helpers.js";
import { connect, startDaemon, waitFor } from "./host_helpers.js";

function get(port: number, path: string, method = "GET", host = "127.0.0.1"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host, port, path, method }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
		});
		req.on("error", reject);
		req.end();
	});
}

function setup(t: TestContext, opts: { idleMs?: number; maxServers?: number } = {}) {
	const root = tempDir(t);
	const site = join(root, "site");
	mkdirSync(join(site, "css"), { recursive: true });
	mkdirSync(join(site, "docs"));
	writeFileSync(join(site, "index.html"), "<h1>home</h1>");
	writeFileSync(join(site, "page.html"), "<p>page</p>");
	writeFileSync(join(site, "css", "a.css"), "body{}");
	writeFileSync(join(site, "docs", "index.html"), "<p>docs</p>");
	writeFileSync(join(site, ".env"), "SECRET=1");
	mkdirSync(join(site, ".git"));
	writeFileSync(join(site, ".git", "config"), "[core]");
	writeFileSync(join(root, "outside.txt"), "outside the site");
	symlinkSync(join(root, "outside.txt"), join(site, "leak.txt"));
	symlinkSync(root, join(site, "up"));
	const preview = new Preview({ roots: [root], ...opts });
	t.after(() => preview.stopAll());
	return { root, site, preview };
}

test("serves a folder on the loopback under a secret prefix, with the right types and no caching", async (t) => {
	const { site, preview } = setup(t);
	const { port, token } = await preview.serve(site);
	assert.match(token, /^[0-9a-f]{24}$/);

	const index = await get(port, `/${token}/`);
	assert.deepEqual([index.status, index.body.toString()], [200, "<h1>home</h1>"]);
	assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
	assert.equal(index.headers["cache-control"], "no-store");
	assert.equal(index.headers["x-content-type-options"], "nosniff");

	assert.equal((await get(port, `/${token}/page.html`)).body.toString(), "<p>page</p>");
	assert.equal((await get(port, `/${token}/css/a.css`)).headers["content-type"], "text/css; charset=utf-8");
	assert.equal((await get(port, `/${token}/docs/`)).body.toString(), "<p>docs</p>");

	const head = await get(port, `/${token}/page.html`, "HEAD");
	assert.deepEqual([head.status, head.body.length, head.headers["content-length"]], [200, 0, "11"]);

	// A page being edited is seen as it is now.
	writeFileSync(join(site, "page.html"), "<p>changed</p>");
	assert.equal((await get(port, `/${token}/page.html`)).body.toString(), "<p>changed</p>");
});

test("a folder asked for without the slash is redirected, so its relative links resolve", async (t) => {
	const { site, preview } = setup(t);
	const { port, token } = await preview.serve(site);
	const r = await get(port, `/${token}/docs`);
	assert.deepEqual([r.status, r.headers.location], [301, `/${token}/docs/`]);
	const root = await get(port, `/${token}`);
	assert.deepEqual([root.status, root.headers.location], [301, `/${token}/`]);
});

test("without the token, or with a wrong one, there is nothing to see", async (t) => {
	const { site, preview } = setup(t);
	const { port, token } = await preview.serve(site);
	// Wrong tokens that are certainly different from the real one (the real one ends in "0" one time in sixteen, and has no
	// letters to capitalise very rarely).
	const lastWrong = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
	const firstWrong = `${token.startsWith("0") ? "1" : "0"}${token.slice(1)}`;
	const paths = ["/", "/page.html", `/${lastWrong}/page.html`, `/${firstWrong}/page.html`, `/x/${token}/page.html`, `/${token}x/page.html`, `/${token.slice(1)}/page.html`];
	if (token.toUpperCase() !== token) paths.push(`/${token.toUpperCase()}/page.html`);
	for (const path of paths) {
		assert.equal((await get(port, path)).status, 404, path);
	}
	assert.equal((await get(port, `/${token}/page.html`)).status, 200, "and the real one works");
});

test("nothing outside the folder is reachable: dot segments, encodings, links, hidden files", async (t) => {
	const { site, preview } = setup(t);
	const { port, token } = await preview.serve(site);
	const attempts = [
		`/${token}/../outside.txt`,
		`/${token}/%2e%2e/outside.txt`,
		`/${token}/..%2foutside.txt`,
		`/${token}/css/../../outside.txt`,
		`/${token}/%2e%2e%2foutside.txt`,
		`/${token}/..\\outside.txt`,
		`/${token}/css/..%5c..%5coutside.txt`,
		`/${token}//etc/passwd`,
		`/${token}/%00page.html`,
		`/${token}/leak.txt`, // a link to a file outside
		`/${token}/up/outside.txt`, // a link to the folder above
		`/${token}/.env`,
		`/${token}/.git/config`,
		`/${token}/%2eenv`,
	];
	for (const path of attempts) {
		const r = await get(port, path);
		assert.equal(r.status, 404, path);
		assert.ok(!r.body.toString().includes("outside the site") && !r.body.toString().includes("SECRET"), path);
	}
});

test("only GET and HEAD, and no folder listings", async (t) => {
	const { site, preview } = setup(t);
	const { port, token } = await preview.serve(site);
	assert.equal((await get(port, `/${token}/page.html`, "POST")).status, 405);
	assert.equal((await get(port, `/${token}/page.html`, "DELETE")).status, 405);
	assert.equal((await get(port, `/${token}/css/`)).status, 404, "a folder without an index page is not listed");
});

test("a big file arrives intact", async (t) => {
	const { site, preview } = setup(t);
	const big = Buffer.alloc(6 * 1024 * 1024, "abcdefghij");
	writeFileSync(join(site, "big.bin"), big);
	const { port, token } = await preview.serve(site);
	const r = await get(port, `/${token}/big.bin`);
	assert.equal(r.status, 200);
	assert.equal(r.headers["content-type"], "application/octet-stream");
	assert.ok(r.body.equals(big));
});

test("only folders inside the allowed places can be served, and only real ones", async (t) => {
	const { root, site, preview } = setup(t);
	const other = tempDir(t);
	await assert.rejects(() => preview.serve(other), (e: any) => e.code === "outside_root");
	await assert.rejects(() => preview.serve("/"), (e: any) => e.code === "outside_root");
	await assert.rejects(() => preview.serve(join(root, "nope")), (e: any) => e.code === "ENOENT");
	await assert.rejects(() => preview.serve(join(site, "page.html")), (e: any) => e.code === "not_dir");
	await assert.rejects(() => preview.serve("site"), (e: any) => e.code === "bad_path");
	await assert.rejects(() => preview.serve(undefined), (e: any) => e.code === "bad_path");
	// A link inside the allowed place that leads out is the outside.
	symlinkSync(other, join(root, "door"));
	await assert.rejects(() => preview.serve(join(root, "door")), (e: any) => e.code === "outside_root");
	// But the allowed place itself, and a link that stays inside it, are fine.
	symlinkSync(site, join(root, "alias"));
	assert.ok((await preview.serve(join(root, "alias"))).port > 0);
});

test("the same folder is served once; each folder has its own token; a few at most; stopping gives the room back", async (t) => {
	const { root, site, preview } = setup(t, { maxServers: 2 });
	const a = await preview.serve(site);
	const again = await preview.serve(site);
	assert.deepEqual(again, a);
	const b = await preview.serve(join(site, "docs"));
	assert.notEqual(b.port, a.port);
	assert.notEqual(b.token, a.token);
	mkdirSync(join(root, "third"));
	await assert.rejects(() => preview.serve(join(root, "third")), (e: any) => e.code === "busy");

	assert.equal(preview.stop(a.port), true);
	assert.equal(preview.stop(a.port), false);
	await assert.rejects(() => get(a.port, `/${a.token}/`), /ECONNREFUSED/);
	const c = await preview.serve(join(root, "third"));
	assert.ok(c.port > 0);
	assert.equal(preview.list().length, 2);
});

test("a server nobody asks anything of stops by itself; a used one does not", async (t) => {
	const { site, preview } = setup(t, { idleMs: 150 });
	const used = await preview.serve(site);
	const idle = await preview.serve(join(site, "docs"));
	for (let i = 0; i < 6; i++) {
		await get(used.port, `/${used.token}/`);
		await new Promise((r) => setTimeout(r, 60));
	}
	assert.deepEqual(preview.list().map((p) => p.port), [used.port]);
	await assert.rejects(() => get(idle.port, `/${idle.token}/`), /ECONNREFUSED/);
	await waitFor("the last one to time out", () => preview.list().length === 0, 3000);
});

test("it listens on the loopback only", async (t) => {
	const { site, preview } = setup(t);
	const { port } = await preview.serve(site);
	const addr = await new Promise<string>((resolve) => {
		const s = http.get({ host: "127.0.0.1", port, path: "/x" }, (res) => {
			resolve(res.socket.remoteAddress ?? "");
			res.resume();
		});
		s.on("error", () => resolve("error"));
	});
	assert.equal(addr, "127.0.0.1");
});

test("through the host: preview_serve and preview_stop over the protocol, fenced to the workspace", async (t) => {
	const d = await startDaemon(t);
	const c = await connect(d.sock);
	mkdirSync(join(d.workspace, "site"));
	writeFileSync(join(d.workspace, "site", "index.html"), "<h1>from the host</h1>");
	const { port, token } = await c.call("preview_serve", { dir: join(d.workspace, "site") });
	assert.equal((await get(port, `/${token}/`)).body.toString(), "<h1>from the host</h1>");
	await assert.rejects(() => c.call("preview_serve", { dir: "/etc" }), (e: any) => e.code === "outside_root");
	assert.deepEqual(await c.call("preview_stop", { port }), { stopped: true });
	await assert.rejects(() => get(port, `/${token}/`), /ECONNREFUSED/);
	assert.deepEqual(await c.call("preview_stop", { port }), { stopped: false });
});
