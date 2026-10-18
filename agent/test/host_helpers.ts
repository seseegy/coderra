import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { dial, tempDir } from "./helpers.js";

// Starting the real host as a process, and a stand-in for the model it talks to, so tests can run the real pi session,
// tools and guard end to end without an account or a network.

export const HOST = fileURLToPath(new URL("./harness/host.mjs", import.meta.url));

export interface Spawned {
	child: ChildProcess;
	stderr: () => string;
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	home: string;
	agentDir: string;
	workspace: string;
}

export function spawnHost(
	t: TestContext,
	args: string[],
	home = tempDir(t),
	extraEnv: Record<string, string> = {},
	beforeStart?: (dirs: { home: string; agentDir: string; workspace: string }) => void,
): Spawned {
	const workspace = join(home, "workspace");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	beforeStart?.({ home, agentDir, workspace });
	const child = spawn(process.execPath, [HOST, ...args], {
		env: {
			...process.env,
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			ANDROPI_WORKSPACE: workspace,
			PI_SKIP_VERSION_CHECK: "1",
			PI_TELEMETRY: "0",
			// Keep the test off the user's real accounts.
			GITHUB_TOKEN: "",
			GH_TOKEN: "",
			...extraEnv,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let err = "";
	child.stderr!.setEncoding("utf8").on("data", (d) => (err += d));
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	t.after(() => {
		child.kill("SIGKILL");
	});
	return { child, stderr: () => err, exited, home, agentDir, workspace };
}

export async function waitFor(what: string, ok: () => boolean, ms = 30_000) {
	const t0 = Date.now();
	while (!ok()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

export async function startDaemon(
	t: TestContext,
	extraEnv: Record<string, string> = {},
	home = tempDir(t),
	beforeStart?: Parameters<typeof spawnHost>[4],
) {
	const sock = join(home, "run", "host.sock");
	const host = spawnHost(t, ["--listen", sock], home, extraEnv, beforeStart);
	await waitFor("the daemon to listen", () => host.stderr().includes("listening on") || host.child.exitCode !== null);
	if (host.child.exitCode !== null) throw new Error(`the daemon exited early:\n${host.stderr()}`);
	return { ...host, sock };
}

// ---------------------------------------------------------------------------
// A client for the daemon

/** Connects, subscribes to live records, and offers `call(type, args)` that resolves with the response data. */
export async function connect(sock: string) {
	const c = await dial(sock);
	await c.until(() => c.records.length >= 2);
	let n = 0;
	const call = async (type: string, args: object = {}, ms = 30_000) => {
		const id = ++n;
		c.send({ id, type, ...args });
		await c.until(() => c.records.some((r) => r.type === "response" && r.id === id), ms);
		const r = c.records.find((x) => x.type === "response" && x.id === id);
		if (!r.ok) throw Object.assign(new Error(r.error), { code: r.code });
		return r.data;
	};
	await call("resume", { since: null });
	const events = () => c.records.filter((r) => r.type === "event").map((r) => r.event);
	const settled = () => events().filter((e) => e.type === "agent_settled").length;
	return { ...c, call, events, settled, ofType: (type: string) => c.records.filter((r) => r.type === type) };
}

// ---------------------------------------------------------------------------
// A pretend model: an OpenAI-compatible /chat/completions endpoint that answers from a script.

export interface Reply {
	text?: string;
	calls?: { name: string; args: object }[];
	/** Answer with this HTTP error instead (429 for a rate limit, 503 for an outage). */
	status?: number;
	/** Wait this long before answering, to keep a run busy. */
	delayMs?: number;
}

/**
 * Serves the replies in order, one per request the host makes (a tool result going back to the model is another
 * request). Anything after the script ends gets "ok". `requests` keeps what the host sent, so tests can check what the
 * model was told (the system prompt, the tools on offer, the tool results).
 */
export async function mockModel(t: TestContext, script: Reply[] = []) {
	const requests: { url?: string; body: any }[] = [];
	const queue = [...script];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			const json = JSON.parse(body || "{}");
			requests.push({ url: req.url, body: json });
			const reply = queue.shift() ?? { text: "ok" };
			void respond(reply);
			async function respond(reply: Reply) {
				if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
				answer(reply);
			}
			function answer(reply: Reply) {
			if (reply.status) {
				res.writeHead(reply.status, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: reply.status === 429 ? "Rate limit exceeded, try again later" : "Service unavailable", type: reply.status === 429 ? "rate_limit_error" : "server_error" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const base = { id: "mock", object: "chat.completion.chunk", created: 0, model: "mock-1" };
			const send = (choices: object[], extra: object = {}) => res.write(`data: ${JSON.stringify({ ...base, choices, ...extra })}\n\n`);
			const delta: Record<string, unknown> = { role: "assistant" };
			if (reply.text) delta.content = reply.text;
			if (reply.calls?.length) {
				delta.tool_calls = reply.calls.map((c, index) => ({
					index,
					id: `call_${requests.length}_${index}`,
					type: "function",
					function: { name: c.name, arguments: JSON.stringify(c.args) },
				}));
			}
			send([{ index: 0, delta, finish_reason: null }]);
			send([{ index: 0, delta: {}, finish_reason: reply.calls?.length ? "tool_calls" : "stop" }]);
			send([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
			res.write("data: [DONE]\n\n");
			res.end();
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	t.after(() => void server.close());
	const port = (server.address() as { port: number }).port;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		/** Adds replies to the end of the script. */
		say: (...replies: Reply[]) => void queue.push(...replies),
		/** The text of every tool result the model has been sent so far, in order. */
		toolResults: () =>
			requests.flatMap((r) => (r.body.messages ?? []).filter((m: any) => m.role === "tool")).map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))),
	};
}

/** models.json with one provider pointing at the pretend model, written before the host starts. */
export function usingMockModel(baseUrl: string) {
	return ({ agentDir }: { agentDir: string }) => {
		if (existsSync(join(agentDir, "models.json"))) return;
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { mock: { name: "Mock", baseUrl, api: "openai-completions", apiKey: "x", models: [{ id: "mock-1" }] } } }),
		);
	};
}

/** models.json with the pretend model available under several ids, for tests that switch between them. */
export function usingMockModels(baseUrl: string, ids: string[]) {
	return ({ agentDir }: { agentDir: string }) => {
		if (existsSync(join(agentDir, "models.json"))) return;
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { mock: { name: "Mock", baseUrl, api: "openai-completions", apiKey: "x", models: ids.map((id) => ({ id })) } } }),
		);
	};
}

/** pi's settings.json (and the app's own settings in it), written before the host starts. */
export function usingSettings(settings: object) {
	return ({ agentDir }: { agentDir: string }) => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	};
}

/** Runs several preparation steps in order. */
export function all(...steps: ((dirs: { home: string; agentDir: string; workspace: string }) => void)[]) {
	return (dirs: { home: string; agentDir: string; workspace: string }) => {
		for (const step of steps) step(dirs);
	};
}

/** A stand-in for an ntfy server: remembers every push it is sent. */
export async function fakeNtfy(t: TestContext) {
	const got: { url?: string; title?: string; priority?: string; tags?: string; body: string }[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			got.push({ url: req.url, title: req.headers.title as string, priority: req.headers.priority as string, tags: req.headers.tags as string, body });
			res.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	t.after(() => void server.close());
	const port = (server.address() as { port: number }).port;
	return {
		got,
		env: { NTFY_URL: `http://127.0.0.1:${port}`, NTFY_TOPIC: "coderra-test-topic-1" },
		titles: () => got.map((g) => g.title),
	};
}
