import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RESUME_PROMPT } from "../src/longtask.js";
import { type Run, Runner, type RunSession } from "../src/runs.js";
import { type Checklist, emptyChecklist } from "../src/tasks.js";
import { tempDir } from "./helpers.js";

// The background runner: queue, long tasks, being picked up again after a restart, schedules and triggers.

class FakeSession implements RunSession {
	sessionFile: string;
	prompts: string[] = [];
	disposed = false;
	aborted = false;
	spent = 0;
	list: Checklist = emptyChecklist();
	error: string | undefined;
	text = "all finished";
	gate?: Promise<void>;
	changed = true;
	constructor(
		readonly cwd: string,
		file?: string,
		readonly behave: (s: FakeSession, text: string) => void | Promise<void> = () => {},
	) {
		this.sessionFile = file ?? `/sessions/${Math.random().toString(36).slice(2)}.jsonl`;
	}
	async prompt(text: string) {
		this.prompts.push(text);
		await this.gate;
		if (this.aborted) throw new Error("aborted");
		await this.behave(this, text);
	}
	lastText() {
		return this.text;
	}
	errorText() {
		return this.error;
	}
	cost() {
		return this.spent;
	}
	checklist() {
		return this.list;
	}
	async runCommand() {
		return { code: 0, output: "" };
	}
	async snapshot() {
		return this.changed;
	}
	async abort() {
		this.aborted = true;
	}
	dispose() {
		this.disposed = true;
	}
}

function setup(t: TestContext, opts: { behave?: FakeSession["behave"]; seed?: object } = {}) {
	const dir = tempDir(t);
	const file = join(dir, "runs.json");
	if (opts.seed) writeFileSync(file, JSON.stringify(opts.seed));
	const sessions: FakeSession[] = [];
	const made: { cwd: string; file?: string }[] = [];
	const sent: any[] = [];
	const make = async (cwd: string, file?: string) => {
		made.push({ cwd, file });
		const s = new FakeSession(cwd, file, opts.behave);
		sessions.push(s);
		return s;
	};
	// Records are copied as the hub would serialise them: the runner mutates its run objects as it goes.
	const runner = new Runner(file, make, (r) => sent.push(JSON.parse(JSON.stringify(r))), async () => [], {});
	t.after(() => runner.dispose());
	const finished = () => sent.filter((r) => r.type === "run_finished").map((r) => r.run as Run);
	const settle = async (n = 1) => {
		const t0 = Date.now();
		while (finished().length < n) {
			if (Date.now() - t0 > 3000) throw new Error(`timed out; finished=${finished().length}`);
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	const stored = (): { runs: Run[] } => JSON.parse(readFileSync(file, "utf8"));
	return { runner, sessions, made, sent, finished, settle, file, stored };
}

const doneList = (): Checklist => ({ nextId: 2, items: [{ id: "t1", title: "x", status: "done" }] });

// ---------------------------------------------------------------------------
// Plain runs

test("a queued prompt runs in its own session and ends as done with the agent's last words", async (t) => {
	const r = setup(t);
	const run = r.runner.enqueue("tidy the repo", "/proj", "Tidy");
	assert.ok(["queued", "running"].includes(run.status), "it starts as soon as there is room");
	await r.settle();
	const [done] = r.finished();
	assert.deepEqual([done.status, done.title, done.summary, done.source], ["done", "Tidy", "all finished", "queue"]);
	assert.deepEqual(r.made, [{ cwd: "/proj", file: undefined }]);
	assert.deepEqual(r.sessions[0].prompts, ["tidy the repo"]);
	assert.equal(r.sessions[0].disposed, true);
	assert.ok(done.startedAt && done.finishedAt);
	assert.equal(done.sessionFile, r.sessions[0].sessionFile, "so the result can be opened as a chat");
	assert.equal(r.stored().runs[0].status, "done", "and it was saved");
});

test("a failed request makes the run an error with the message, and the title defaults to the first line", async (t) => {
	const r = setup(t, { behave: (s) => void (s.error = "429 rate limited") });
	r.runner.enqueue("first line\nsecond line", "/p");
	await r.settle();
	assert.deepEqual([r.finished()[0].status, r.finished()[0].summary, r.finished()[0].title], ["error", "429 rate limited", "first line"]);

	const crash = setup(t, { behave: () => { throw new Error("boom"); } });
	crash.runner.enqueue("x", "/p");
	await crash.settle();
	assert.deepEqual([crash.finished()[0].status, crash.finished()[0].summary], ["error", "boom"]);
	assert.equal(crash.sessions[0].disposed, true);
});

test("runs go one at a time by default and in the order they were queued; raising the limit runs more together", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const r = setup(t, { behave: () => {} });
	// Hold the first session open.
	const make = (r.runner as any).makeSession;
	(r.runner as any).makeSession = async (cwd: string, f?: string) => {
		const s = (await make(cwd, f)) as FakeSession;
		s.gate = gate;
		return s;
	};
	r.runner.enqueue("one", "/p");
	r.runner.enqueue("two", "/p");
	r.runner.enqueue("three", "/p");
	await new Promise((x) => setTimeout(x, 50));
	assert.equal(r.runner.summary().running, 1);
	r.runner.setConcurrency(3);
	await new Promise((x) => setTimeout(x, 50));
	assert.equal(r.runner.summary().running, 3);
	assert.deepEqual(r.sessions.map((s) => s.prompts[0]), ["one", "two", "three"]);
	release();
	await r.settle(3);
	assert.equal(r.runner.setConcurrency(99), undefined);
	assert.equal(r.runner.summary().concurrency, 3, "capped at 3");
	r.runner.setConcurrency(0);
	assert.equal(r.runner.summary().concurrency, 1, "and at least 1");
});

test("cancelling a queued run, and a running one, stops them and is not reported as an error", async (t) => {
	const r = setup(t, { behave: () => {} });
	const make = (r.runner as any).makeSession;
	let release!: () => void;
	const gate = new Promise<void>((x) => (release = x));
	(r.runner as any).makeSession = async (cwd: string, f?: string) => ((s) => ((s.gate = gate), s))((await make(cwd, f)) as FakeSession);
	const running = r.runner.enqueue("long", "/p");
	const waiting = r.runner.enqueue("never", "/p");
	await new Promise((x) => setTimeout(x, 30));
	await r.runner.cancel(waiting.id);
	assert.equal(waiting.status, "cancelled");
	await r.runner.cancel(running.id);
	release();
	await r.settle();
	assert.equal(running.status, "cancelled");
	assert.equal(r.sessions[0].aborted, true);
	assert.equal(r.sessions.length, 1, "the cancelled one never started");
	await r.runner.cancel("nope"); // harmless
});

test("finished runs can be cleared, running and queued ones stay", async (t) => {
	const r = setup(t);
	r.runner.enqueue("a", "/p");
	await r.settle();
	r.runner.clearFinished();
	assert.deepEqual(r.runner.summary().runs, []);
});

// ---------------------------------------------------------------------------
// Long tasks

test("a long task keeps going round after round and ends as done, with progress recorded as it goes", async (t) => {
	let round = 0;
	const r = setup(t, {
		behave: (s) => {
			round++;
			s.spent += 0.25;
			s.changed = true;
			if (round === 3) s.list = doneList();
		},
	});
	const run = r.runner.enqueue("migrate everything", "/proj", "Migrate", "queue", { maxIterations: 10 });
	assert.deepEqual([run.task?.doneWhen, run.iteration, run.cost], [["checklist"], 0, 0]);
	await r.settle();
	const done = r.finished()[0];
	assert.deepEqual([done.status, done.iteration, done.cost], ["done", 3, 0.75]);
	assert.match(done.reason!, /Everything the job required is done/);
	assert.match(done.summary!, /all finished/);
	assert.match(r.sessions[0].prompts[0], /migrate everything/);
	assert.match(r.sessions[0].prompts[0], /\[Unattended task\]/);
	assert.match(r.sessions[0].prompts[1], /^Keep going/);
	// The app was told about the rounds as they happened.
	const rounds = r.sent.filter((x) => x.type === "runs").map((x) => x.runs[0].iteration);
	assert.ok(rounds.includes(1) && rounds.includes(2) && rounds.includes(3));
});

test("a long task that gets nowhere ends as blocked, one that hits its limit as limit", async (t) => {
	const stuck = setup(t, { behave: (s) => void (s.changed = false) });
	stuck.runner.enqueue("x", "/p", "stuck", "queue", { noProgressLimit: 2 });
	await stuck.settle();
	assert.equal(stuck.finished()[0].status, "blocked");
	assert.match(stuck.finished()[0].reason!, /No progress/);

	const endless = setup(t, { behave: (s) => void (s.changed = true) });
	endless.runner.enqueue("x", "/p", "endless", "queue", { maxIterations: 3 });
	await endless.settle();
	assert.deepEqual([endless.finished()[0].status, endless.finished()[0].iteration], ["limit", 3]);
});

test("an invalid long-task setup is refused up front and nothing is queued", async (t) => {
	const r = setup(t);
	assert.throws(() => r.runner.enqueue("x", "/p", "t", "queue", { doneWhen: ["command"] }), /needs a command/);
	assert.throws(() => r.runner.enqueue("x", "/p", "t", "queue", { maxIterations: 0 }), /maxIterations/);
	assert.deepEqual(r.runner.summary().runs, []);
});

test("stopping a long task between rounds ends it as cancelled", async (t) => {
	const r = setup(t, { behave: async (s) => { s.changed = true; await new Promise((x) => setTimeout(x, 3)); } });
	const run = r.runner.enqueue("x", "/p", "t", "queue", { maxIterations: 500 });
	await new Promise((x) => setTimeout(x, 40));
	await r.runner.cancel(run.id);
	await r.settle();
	assert.equal(run.status, "cancelled");
	assert.ok(run.iteration! < 500);
});

test("the pre-round check ends a long task as blocked when the disk is full", async (t) => {
	const dir = tempDir(t);
	const sent: any[] = [];
	let calls = 0;
	const runner = new Runner(
		join(dir, "runs.json"),
		async (cwd, f) => new FakeSession(cwd, f, (s) => void (s.changed = true)),
		(x) => sent.push(x),
		async () => [],
		{ preflight: () => { if (++calls === 3) throw Object.assign(new Error("Disk almost full"), { code: "disk_low" }); } },
	);
	t.after(() => runner.dispose());
	runner.enqueue("x", "/p", "t", "queue", { maxIterations: 20 });
	const t0 = Date.now();
	while (!sent.some((r) => r.type === "run_finished")) {
		if (Date.now() - t0 > 3000) throw new Error("timed out");
		await new Promise((x) => setTimeout(x, 5));
	}
	const run: Run = sent.find((r) => r.type === "run_finished").run;
	assert.deepEqual([run.status, run.iteration, run.reason], ["blocked", 2, "Disk almost full"]);
});

// ---------------------------------------------------------------------------
// Being picked up again after a restart

const seeded = (over: Partial<Run>, extra: object = {}) => ({
	runs: [{ id: "r1", title: "T", prompt: "do it", cwd: "/proj", status: "running", source: "queue", createdAt: 1, startedAt: 2, sessionFile: "/s/old.jsonl", ...over }],
	schedules: [],
	concurrency: 1,
	...extra,
});

test("a run that was going when the host died continues its old conversation", async (t) => {
	const r = setup(t, { seed: seeded({}) });
	await r.settle();
	assert.deepEqual(r.made, [{ cwd: "/proj", file: "/s/old.jsonl" }], "the same session file is reopened");
	assert.deepEqual(r.sessions[0].prompts, [RESUME_PROMPT], "and told what happened, not given the job again");
	const run = r.finished()[0];
	assert.deepEqual([run.status, run.resumes, run.resume], ["done", 1, false]);
	assert.match(run.reason!, /Picked up again after a restart \(1 of 3\)/);
	assert.ok(r.sent.some((x) => x.type === "notice" && /Picking up 1 background task again/.test(x.message)));
});

test("a run that had not yet got a session starts over from its prompt", async (t) => {
	const r = setup(t, { seed: seeded({ sessionFile: undefined }) });
	await r.settle();
	assert.deepEqual(r.made, [{ cwd: "/proj", file: undefined }]);
	assert.deepEqual(r.sessions[0].prompts, ["do it"]);
});

test("a run that keeps getting caught by restarts is given up on after three", async (t) => {
	const r = setup(t, { seed: seeded({ resumes: 3 }) });
	await new Promise((x) => setTimeout(x, 50));
	const run = r.runner.summary().runs[0];
	assert.deepEqual([run.status, run.resumes], ["error", 3]);
	assert.match(run.reason!, /restarted 3 times/);
	assert.equal(r.made.length, 0);
});

test("a long task resumes mid-job: it keeps its round count and time, and starts by saying what happened", async (t) => {
	const task = { doneWhen: ["checklist"], maxIterations: 10, maxHours: 24, maxCostUsd: 0, noProgressLimit: 2 };
	const r = setup(t, { seed: seeded({ task: task as Run["task"], iteration: 4, cost: 1.5, startedAt: Date.now() - 3_600_000 }), behave: (s) => void (s.list = doneList()) });
	await r.settle();
	const run = r.finished()[0];
	assert.deepEqual([run.status, run.iteration], ["done", 5]);
	assert.equal(r.sessions[0].prompts[0], RESUME_PROMPT);
});

test("a long task that was already past its time limit when the host died ends at once", async (t) => {
	const task = { doneWhen: ["checklist"], maxIterations: 10, maxHours: 2, maxCostUsd: 0, noProgressLimit: 2 };
	const r = setup(t, { seed: seeded({ task: task as Run["task"], iteration: 4, startedAt: Date.now() - 3 * 3_600_000 }) });
	await r.settle();
	assert.deepEqual([r.finished()[0].status, r.sessions[0].prompts.length], ["limit", 0]);
});

test("queued and finished runs are left alone by a restart", async (t) => {
	const r = setup(t, { seed: { runs: [{ ...seeded({}).runs[0], id: "q", status: "queued", sessionFile: undefined }, { ...seeded({}).runs[0], id: "d", status: "done" }], schedules: [], concurrency: 1 } });
	await r.settle();
	assert.equal(r.runner.summary().runs.find((x) => x.id === "d")!.resumes, undefined);
	assert.equal(r.sent.some((x) => x.type === "notice" && /Picking up/.test(x.message)), false);
});

// ---------------------------------------------------------------------------
// Schedules and triggers

test("schedules need a name, a prompt and a way to repeat; short intervals are raised to 15 minutes", (t) => {
	const r = setup(t);
	assert.throws(() => r.runner.saveSchedule({ name: "x" }), /needs a name and a prompt/);
	assert.throws(() => r.runner.saveSchedule({ name: "x", prompt: "p" }), /how often/);
	const s = r.runner.saveSchedule({ name: " nightly ", prompt: " check ", everyMinutes: 3 });
	assert.deepEqual([s.name, s.prompt, s.everyMinutes, s.enabled], ["nightly", "check", 15, true]);
	const again = r.runner.saveSchedule({ id: s.id, name: "nightly", prompt: "check", everyMinutes: 60 });
	assert.equal(r.runner.summary().schedules.length, 1);
	assert.equal(again.everyMinutes, 60);
	r.runner.deleteSchedule(s.id);
	assert.equal(r.runner.summary().schedules.length, 0);
});

test("a schedule that is due queues a run, once, and 'run now' queues one at once", async (t) => {
	const r = setup(t);
	const s = r.runner.saveSchedule({ name: "every hour", prompt: "report", everyMinutes: 60, cwd: "/p" });
	await (r.runner as any).tick();
	await r.settle();
	assert.deepEqual([r.finished()[0].source, r.finished()[0].title], ["schedule", "every hour"]);
	await (r.runner as any).tick();
	assert.equal(r.runner.summary().runs.length, 1, "not due again yet");
	r.runner.runScheduleNow(s.id);
	assert.equal(r.runner.summary().runs.length, 2);
	assert.throws(() => r.runner.runScheduleNow("nope"), /Unknown schedule/);
	r.runner.saveSchedule({ id: s.id, name: "every hour", prompt: "report", everyMinutes: 60, enabled: false, lastRun: 0 });
	await (r.runner as any).tick();
	assert.equal(r.runner.summary().runs.length, 2, "a disabled schedule does not run");
});

test("a GitHub issue trigger records what exists on the first poll and queues only new issues after that", async (t) => {
	const dir = tempDir(t);
	const sent: any[] = [];
	let issues: any[] = [
		{ number: 1, title: "old", body: "b", html_url: "u1" },
		{ number: 2, title: "a pull request", pull_request: {}, html_url: "u2" },
	];
	const runner = new Runner(join(dir, "runs.json"), async (c, f) => new FakeSession(c, f), (x) => sent.push(x), async () => issues);
	t.after(() => runner.dispose());
	const s = runner.saveSchedule({ name: "triage", prompt: "Triage this", trigger: { type: "github_issues", repo: "o/r", label: "bug" } });
	await (runner as any).tick();
	assert.equal(runner.summary().runs.length, 0, "existing issues are only noted");

	issues = [{ number: 3, title: "new bug", body: "it breaks", html_url: "u3" }, ...issues];
	s.lastRun = 0; // pretend ten minutes have passed
	await (runner as any).tick();
	const runs = runner.summary().runs;
	assert.equal(runs.length, 1);
	assert.equal(runs[0].source, "trigger");
	assert.match(runs[0].prompt, /Triage this\n\nGitHub issue o\/r#3: new bug\n\nit breaks\n\nu3/);
	assert.ok(existsSync(join(dir, "runs.json")));
});
