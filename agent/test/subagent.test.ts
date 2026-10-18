import assert from "node:assert/strict";
import { test } from "node:test";
import { Guard } from "../src/guard.js";
import { type ChildSession, childPrompt, MAX_REPORT_CHARS, progressLine, Slots, type SubagentDeps, subagentTool } from "../src/subagent.js";

interface Fake extends ChildSession {
	prompts: string[];
	disposed: boolean;
	aborted: boolean;
	tools(name: string, args?: Record<string, unknown>): void;
}

function fakeChild(behave: (c: Fake) => Promise<void> | void = () => {}, over: Partial<{ text: string; error: string; cost: number }> = {}): Fake {
	let listener: ((n: string, a: Record<string, unknown>) => void) | undefined;
	let release: (() => void) | undefined;
	const c: Fake = {
		sessionFile: "/sessions/child.jsonl",
		prompts: [],
		disposed: false,
		aborted: false,
		prompt: async (text) => {
			c.prompts.push(text);
			await Promise.race([behave(c), new Promise<void>((r) => (release = r))]);
		},
		lastText: () => over.text ?? "Found it in src/a.ts:12.",
		errorText: () => over.error,
		abort: async () => {
			c.aborted = true;
			release?.();
		},
		dispose: () => void (c.disposed = true),
		cost: () => over.cost ?? 0.0123,
		onTool: (cb) => void (listener = cb),
		tools: (name, args = {}) => listener?.(name, args),
	};
	return c;
}

function setup(child: () => Fake | Promise<Fake>, over: Partial<SubagentDeps> = {}) {
	const created: Parameters<SubagentDeps["create"]>[0][] = [];
	const costs: [string, number][] = [];
	const deps: SubagentDeps = {
		create: async (o) => {
			created.push(o);
			return child();
		},
		slots: new Slots(2, 80),
		recordCost: (id, c) => void costs.push([id, c]),
		progressEveryMs: 0,
		...over,
	};
	const tool = subagentTool(deps);
	const updates: string[] = [];
	const ctx = { cwd: "/proj", model: { provider: "anthropic", id: "sonnet" }, sessionManager: { getSessionId: () => "parent-1" } };
	const run = (params: Record<string, unknown>, signal?: AbortSignal) =>
		tool.execute("c1", params, signal, (r: any) => void updates.push(r.content[0].text), ctx);
	return { run, created, costs, updates, deps, tool };
}

const text = (r: any) => r.content[0].text as string;

test("the child gets the job written for it, its own folder and the parent's model, and the parent gets the report with a footer", async () => {
	const child = fakeChild();
	const s = setup(() => child);
	const r = await s.run({ task: "Where is login handled?\nLook in src/.", title: "Find login" });
	assert.deepEqual(s.created, [{ role: "explorer", cwd: "/proj", model: undefined, parentModel: "anthropic/sonnet", title: "Find login" }]);
	assert.match(child.prompts[0], /^Where is login handled\?\nLook in src\/\./);
	assert.match(child.prompts[0], /cannot answer questions/);
	assert.match(child.prompts[0], /can read and search but not change anything/);
	assert.match(text(r), /^Found it in src\/a\.ts:12\.\n\n\[Sub-agent explorer "Find login": 0 tool calls, \$0\.0123, \d+s, session \/sessions\/child\.jsonl\]$/);
	assert.deepEqual([r.details.status, r.details.role, r.details.cost], ["done", "explorer", 0.0123]);
	assert.equal(child.disposed, true);
	assert.deepEqual(s.costs, [["parent-1", 0.0123]]);
	assert.equal(s.deps.slots.active, 0, "the slot is given back");
});

test("a worker is told it may change files; a model of its own can be named; the title defaults to the first line", async () => {
	const s = setup(() => fakeChild());
	await s.run({ task: "Add a test for foo.\nUse node:test.", role: "worker", model: "openrouter/cheap" });
	assert.deepEqual([s.created[0].role, s.created[0].model, s.created[0].title], ["worker", "openrouter/cheap", "Add a test for foo."]);
	const child = fakeChild();
	const t = setup(() => child);
	await t.run({ task: "x", role: "worker" });
	assert.match(child.prompts[0], /You can change files and run commands/);
});

test("progress lines show what the child is doing, and are spaced out", async () => {
	const s = setup(
		() => fakeChild((c) => { c.tools("read", { path: "src/x.ts" }); c.tools("bash", { command: "npm   test\n--silent" }); c.tools("web_search", { query: "pi sdk" }); }),
		{ progressEveryMs: 10_000 },
	);
	const r = await s.run({ task: "x" });
	assert.deepEqual(s.updates, ["read src/x.ts"], "the rest came too soon after the first");
	assert.match(text(r), /3 tool calls/);

	const t = setup(() => fakeChild((c) => { c.tools("read", { path: "a" }); c.tools("grep", { pattern: "foo" }); }));
	await t.run({ task: "x" });
	assert.deepEqual(t.updates, ["read a", "grep foo"]);

	assert.equal(progressLine("bash", { command: "npm   test\n--silent" }), "bash npm test --silent");
	assert.equal(progressLine("web_fetch", { url: "https://x.dev" }), "web_fetch https://x.dev");
	assert.equal(progressLine("ls", {}), "ls");
	assert.equal(progressLine("bash", { command: "x".repeat(300) }).length, "bash ".length + 90);
});

test("a long report is cut, and says so", async () => {
	const s = setup(() => fakeChild(() => {}, { text: "y".repeat(MAX_REPORT_CHARS + 500) }));
	const r = await s.run({ task: "x" });
	assert.match(text(r), /\[Report cut: 500 more characters\./);
	assert.equal(text(r).split("\n\n[Report")[0].length, MAX_REPORT_CHARS);
});

test("the time limit stops the child and returns what it had", async () => {
	let child!: Fake;
	const s = setup(() => (child = fakeChild(() => new Promise(() => {}))), { minuteMs: 20 });
	const r = await s.run({ task: "x", maxMinutes: 2 });
	assert.equal(child.aborted, true);
	assert.equal(r.details.status, "timeout");
	assert.match(text(r), /^\[The sub-agent was stopped at its time limit of 2 min\. This is what it had so far\.\]\n\nFound it/);
	assert.equal(child.disposed, true);
	assert.equal(s.deps.slots.active, 0);
});

test("the parent stopping stops the child too, even before it starts", async () => {
	const ac = new AbortController();
	let child!: Fake;
	const s = setup(() => (child = fakeChild(() => new Promise(() => {}))));
	const running = s.run({ task: "x" }, ac.signal);
	await new Promise((r) => setTimeout(r, 20));
	ac.abort();
	const r = await running;
	assert.equal(child.aborted, true);
	assert.equal(r.details.status, "stopped");
	assert.match(text(r), /stopped before it finished/);
	assert.equal(s.deps.slots.active, 0);

	const early = new AbortController();
	early.abort();
	const c2 = fakeChild();
	const t = setup(() => c2);
	const r2 = await t.run({ task: "x" }, early.signal);
	assert.deepEqual([r2.details.status, c2.prompts.length, c2.disposed], ["stopped", 0, true]);
});

test("an error with nothing to show is an error; with a partial report it is reported along with it", async () => {
	const bad = setup(() => fakeChild(() => {}, { text: "", error: "401 invalid api key" }));
	await assert.rejects(() => bad.run({ task: "x" }), /The sub-agent failed: 401 invalid api key/);
	assert.equal(bad.deps.slots.active, 0);
	const partial = setup(() => fakeChild(() => {}, { error: "429 rate limit" }));
	const r = await partial.run({ task: "x" });
	assert.equal(r.details.status, "failed");
	assert.match(text(r), /hit an error \(429 rate limit\)/);
	const empty = setup(() => fakeChild(() => {}, { text: "" }));
	assert.match(text(await empty.run({ task: "x" })), /finished without writing a report/);
});

test("a session that cannot be created gives the slot back and the reason", async () => {
	const s = setup(() => { throw new Error('Unknown model "nope/x"'); });
	await assert.rejects(() => s.run({ task: "x", model: "nope/x" }), /Unknown model/);
	assert.equal(s.deps.slots.active, 0);
});

test("bad parameters are refused before anything starts", async () => {
	const s = setup(() => fakeChild());
	await assert.rejects(() => s.run({ task: "  " }), /task is empty/);
	await assert.rejects(() => s.run({ task: "x".repeat(20_001) }), /too long/);
	await assert.rejects(() => s.run({ task: "x", role: "boss" }), /Unknown role/);
	await assert.rejects(() => s.run({ task: "x", maxMinutes: 0 }), /maxMinutes/);
	await assert.rejects(() => s.run({ task: "x", maxMinutes: 9999 }), /maxMinutes/);
	assert.equal(s.created.length, 0);
});

test("a full disk or spent budget stops it before a session is made", async () => {
	const s = setup(() => fakeChild(), { preflight: () => { throw new Error("Daily budget reached"); } });
	await assert.rejects(() => s.run({ task: "x" }), /Daily budget reached/);
	assert.equal(s.created.length, 0);
});

test("only two run at once; a third waits for a free slot, and gives up with a clear message if none comes", async () => {
	const open: (() => void)[] = [];
	const slow = () => fakeChild(() => new Promise<void>((r) => open.push(r)));
	const s = setup(slow, { slots: new Slots(2, 150) });
	const firstTwo = open;
	const a = s.run({ task: "a" });
	const b = s.run({ task: "b" });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(s.deps.slots.active, 2);
	const c = s.run({ task: "c" });
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(s.deps.slots.waiting, 1);
	assert.equal(s.created.length, 2, "the third has not started");
	await assert.rejects(() => c, /Too many sub-agents are running \(2 at most\)/);
	assert.equal(s.deps.slots.waiting, 0);

	// With room freed in time, the waiting one goes ahead.
	firstTwo.forEach((f) => f());
	await Promise.all([a, b]);
	const later: (() => void)[] = [];
	const s2 = setup(() => fakeChild(() => new Promise<void>((r) => later.push(r))), { slots: new Slots(1, 2000) });
	const first = s2.run({ task: "1" });
	const second = s2.run({ task: "2" });
	await new Promise((r) => setTimeout(r, 20));
	later.shift()!();
	await first;
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(s2.created.length, 2);
	later.shift()!();
	await second;
	assert.equal(s2.deps.slots.active, 0);
});

test("stopping the parent while it waits for a slot leaves the line", async () => {
	const slots = new Slots(1, 5000);
	const hold = await slots.acquire();
	const ac = new AbortController();
	const waiting = slots.acquire(ac.signal);
	ac.abort();
	await assert.rejects(() => waiting, /Stopped while waiting/);
	assert.equal(slots.waiting, 0);
	hold();
	hold(); // releasing twice does not free two
	assert.equal(slots.active, 0);
	const one = await slots.acquire();
	await assert.rejects(() => Promise.race([slots.acquire(), new Promise((_, rej) => setTimeout(() => rej(new Error("still waiting")), 50))]), /still waiting/);
	one();
});

test("the prompt asks for a report in every role", () => {
	for (const role of ["explorer", "worker"] as const) assert.match(childPrompt("do it", role), /last message is the only thing/);
});

// ---------------------------------------------------------------------------
// The guard knows an explorer from a worker

function guardWith(setupGuard: (g: Guard) => void) {
	const sent: any[] = [];
	const g = new Guard({ send: (r) => void sent.push(r), checkpoint: async () => {}, cwd: () => "/proj" });
	setupGuard(g);
	let handler: any;
	g.extension({ on: (name: string, h: any) => name === "tool_call" && (handler = h) } as any);
	return { call: (toolName: string, input: object) => handler({ toolName, input }), sent };
}

test("plan mode lets an explorer research but not a worker change things", async () => {
	const { call } = guardWith((g) => (g.planMode = true));
	assert.equal(await call("subagent", { task: "x" }), undefined);
	assert.equal(await call("subagent", { task: "x", role: "explorer" }), undefined);
	assert.equal((await call("subagent", { task: "x", role: "worker" })).block, true);
});

test("asking for everything asks about a worker, not an explorer; an unattended run is not asked", async () => {
	const ask = guardWith((g) => (g.mode = "ask_all"));
	assert.equal(await ask.call("subagent", { task: "x" }), undefined);
	assert.equal(ask.sent.length, 0);
	const pending = ask.call("subagent", { task: "x", role: "worker", title: "Refactor" });
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(ask.sent[0].type, "approval");
	assert.equal(ask.sent[0].summary, "worker: Refactor");
	const calm = guardWith((g) => (g.mode = "deny_risky"));
	assert.equal(await calm.call("subagent", { task: "x", role: "worker" }), undefined, "a child cannot be refused for being a child; its own guard limits it");
	void pending;
});
