import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_LONG_TASK,
	type LongTask,
	normalizeTask,
	RESUME_PROMPT,
	startPrompt,
	superviseTask,
	type SuperviseOptions,
	type TaskSession,
} from "../src/longtask.js";
import { type Checklist, emptyChecklist, type TaskStatus } from "../src/tasks.js";

// ---------------------------------------------------------------------------
// normalizeTask

const bad = (input: unknown) => {
	try {
		normalizeTask(input);
		return "no error";
	} catch (e) {
		return (e as Error).message;
	}
};

test("a long task gets sensible defaults", () => {
	assert.deepEqual(normalizeTask(undefined), DEFAULT_LONG_TASK);
	assert.deepEqual(normalizeTask({}), DEFAULT_LONG_TASK);
	assert.deepEqual(DEFAULT_LONG_TASK, { doneWhen: ["checklist"], maxIterations: 50, maxHours: 24, maxCostUsd: 0, noProgressLimit: 2 });
});

test("what the app sends is checked and tidied", () => {
	const t = normalizeTask({ doneWhen: ["command", "checklist", "command"], command: "  npm test  ", maxIterations: "12", maxHours: 2.5, maxCostUsd: "3.5", noProgressLimit: 3.9 });
	assert.deepEqual(t, { doneWhen: ["command", "checklist"], command: "npm test", maxIterations: 12, maxHours: 2.5, maxCostUsd: 3.5, noProgressLimit: 3 });
	assert.equal("command" in normalizeTask({ doneWhen: ["checklist"], command: "ignored" }), false, "a command nobody asked to run is dropped");
});

test("things that make no sense are refused with a reason", () => {
	assert.match(bad({ doneWhen: [] }), /at least one/);
	assert.match(bad({ doneWhen: "checklist" }), /at least one/);
	assert.match(bad({ doneWhen: ["tests"] }), /Unknown doneWhen "tests"/);
	assert.match(bad({ doneWhen: ["manual", "checklist"] }), /manual cannot be combined/);
	assert.match(bad({ doneWhen: ["command"] }), /needs a command/);
	assert.match(bad({ doneWhen: ["command"], command: "x".repeat(2001) }), /too long/);
	assert.match(bad({ maxIterations: 0 }), /maxIterations must be a number from 1 to 500/);
	assert.match(bad({ maxIterations: 501 }), /from 1 to 500/);
	assert.match(bad({ maxHours: 0 }), /maxHours/);
	assert.match(bad({ maxHours: 1000 }), /maxHours/);
	assert.match(bad({ maxCostUsd: -1 }), /maxCostUsd/);
	assert.match(bad({ noProgressLimit: 0 }), /noProgressLimit/);
	assert.match(bad({ maxIterations: "lots" }), /maxIterations/);
});

// ---------------------------------------------------------------------------
// The loop

type Step = (s: Fake) => void | Promise<void>;

/** A session that does what a script says in each round. */
class Fake implements TaskSession {
	messages: string[] = [];
	list: Checklist = emptyChecklist();
	spent = 0;
	error: string | undefined;
	changed = false;
	commandResults: { code: number; output: string }[] = [];
	commandRuns = 0;
	snapshotFails = false;
	commandThrows = false;
	snapshots: string[] = [];
	constructor(public script: Step[] = []) {}

	async prompt(text: string) {
		this.messages.push(text);
		const step = this.script[this.messages.length - 1];
		this.changed = false;
		await step?.(this);
	}
	lastText() {
		return "last words";
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
		this.commandRuns++;
		if (this.commandThrows) throw new Error("could not start");
		return this.commandResults.shift() ?? { code: 0, output: "" };
	}
	async snapshot(label: string) {
		this.snapshots.push(label);
		if (this.snapshotFails) throw new Error("git is gone");
		return this.changed;
	}
}

const setList = (...statuses: (TaskStatus | [TaskStatus, string])[]): Step => (s) => {
	s.list = {
		nextId: statuses.length + 1,
		items: statuses.map((st, i) => {
			const [status, note] = Array.isArray(st) ? st : [st, undefined];
			return { id: `t${i + 1}`, title: `task ${i + 1}`, status, ...(note ? { note } : {}) };
		}),
	};
	s.changed = true;
};

const run = (session: Fake, over: Partial<SuperviseOptions> & { task?: Partial<LongTask> } = {}) =>
	superviseTask({ session, prompt: "build the thing", startedAt: 1_000, now: () => 1_000, ...over, task: { ...DEFAULT_LONG_TASK, ...over.task } });

test("it stops as soon as the checklist is complete, having told the agent how to work and what is left", async () => {
	const s = new Fake([setList("todo", "todo"), setList("done", "in_progress"), setList("done", "done")]);
	const out = await run(s);
	assert.deepEqual([out.status, out.iterations], ["done", 3]);

	assert.equal(s.messages[0], startPrompt("build the thing", DEFAULT_LONG_TASK));
	assert.match(s.messages[0], /^build the thing\n/);
	assert.match(s.messages[0], /\[Unattended task\] Nobody is watching/);
	assert.match(s.messages[0], /every task on your checklist is done/);
	assert.match(s.messages[0], /mark that task blocked with a note/);
	assert.match(s.messages[1], /^Keep going with the job\.\nStill open:\n- t1 \[todo\] task 1\n- t2 \[todo\] task 2/);
	assert.match(s.messages[2], /Still open:\n- t2 \[in_progress\] task 2/);
	assert.doesNotMatch(s.messages[2], /t1/, "finished tasks are not repeated");
	assert.deepEqual(s.snapshots, ["Task round 1", "Task round 2", "Task round 3"], "each round leaves an undo point");
});

test("with no checklist after a round, the agent is told to write one", async () => {
	const s = new Fake([(f) => void (f.changed = true), setList("done")]);
	const out = await run(s);
	assert.equal(out.status, "done");
	assert.match(s.messages[1], /You have not written a checklist yet/);
});

test("an empty checklist is never 'done'", async () => {
	const s = new Fake([(f) => void (f.changed = true), (f) => void (f.changed = true)]);
	const out = await run(s, { task: { maxIterations: 2 } });
	assert.equal(out.status, "limit");
});

test("a command is the judge: it is run every round, its failure is passed on, and success ends the job", async () => {
	const s = new Fake([(f) => void (f.changed = true), (f) => void (f.changed = true), (f) => void (f.changed = true)]);
	s.commandResults = [
		{ code: 1, output: `${"noise\n".repeat(40)}FAIL: 2 tests\nexpected 1 got 2` },
		{ code: 2, output: "still failing" },
		{ code: 0, output: "ok" },
	];
	const out = await run(s, { task: { doneWhen: ["command"], command: "npm test" } });
	assert.deepEqual([out.status, out.iterations, s.commandRuns], ["done", 3, 3]);
	assert.match(s.messages[0], /counts as done only when `npm test` succeeds/);
	assert.doesNotMatch(s.messages[0], /every task on your checklist/);
	assert.match(s.messages[1], /`npm test` failed \(exit code 1\)\. Its output ended with:\n(?:.*\n)*expected 1 got 2/);
	assert.equal(s.messages[1].split("\n").filter((l) => l === "noise").length, 18, "only the last 20 lines of a long output are passed on");
	assert.doesNotMatch(s.messages[1], /Still open/, "with no checklist there is nothing to list");
});

test("with both, the command waits until the checklist is complete", async () => {
	const s = new Fake([setList("todo"), setList("done"), setList("done")]);
	s.commandResults = [{ code: 1, output: "red" }, { code: 0, output: "green" }];
	const out = await run(s, { task: { doneWhen: ["checklist", "command"], command: "make test" } });
	assert.deepEqual([out.status, out.iterations, s.commandRuns], ["done", 3, 2]);
	assert.match(s.messages[0], /make test.*succeeds/s);
	assert.match(s.messages[0], /every task on your checklist is done/);
	// Round 1: checklist not complete, so the command was not run; round 2: complete, command fails; round 3: passes.
	assert.match(s.messages[2], /`make test` failed/);
});

test("a command that cannot even start counts as a failure, not a crash", async () => {
	const s = new Fake([(f) => void (f.changed = true), (f) => void (f.changed = true)]);
	s.commandThrows = true;
	const out = await run(s, { task: { doneWhen: ["command"], command: "x", maxIterations: 2 } });
	assert.equal(out.status, "limit");
	assert.match(s.messages[1], /could not start/);
});

test("manual never finishes by itself", async () => {
	const s = new Fake([setList("done"), setList("done", "done"), setList("done", "done", "done")]);
	const out = await run(s, { task: { doneWhen: ["manual"], maxIterations: 3 } });
	assert.deepEqual([out.status, out.iterations], ["limit", 3]);
	assert.match(out.reason, /Used all 3 rounds/);
});

test("it stops at the round limit, the time limit and the money limit, and says which", async () => {
	const changing = () => Array.from({ length: 10 }, (_, i) => setList(...Array<TaskStatus>(i + 2).fill("todo")));
	const rounds = await run(new Fake(changing()), { task: { maxIterations: 4 } });
	assert.deepEqual([rounds.status, rounds.iterations, rounds.reason], ["limit", 4, "Used all 4 rounds."]);

	let clock = 1_000;
	const timed = new Fake(changing().map((step) => (f: Fake) => { step(f); clock += 3_600_000; }));
	const hours = await run(timed, { now: () => clock, task: { maxHours: 2.5 } });
	assert.deepEqual([hours.status, hours.iterations], ["limit", 3]);
	assert.match(hours.reason, /Ran for 2\.5 hours/);

	const costly = new Fake(changing().map((step) => (f: Fake) => { step(f); f.spent += 1.5; }));
	const money = await run(costly, { task: { maxCostUsd: 4 } });
	assert.deepEqual([money.status, money.iterations, money.cost], ["limit", 3, 4.5]);
	assert.match(money.reason, /Spent \$4\.50 of the \$4\.00 allowed/);

	const free = new Fake(changing().map((step) => (f: Fake) => { step(f); f.spent += 100; }));
	assert.equal((await run(free, { task: { maxCostUsd: 0, maxIterations: 3 } })).iterations, 3, "0 means no limit of its own");
});

test("the time limit counts from the start of the whole job, so it holds across a restart", async () => {
	const s = new Fake([setList("todo")]);
	const out = await run(s, { startedAt: 0, now: () => 25 * 3_600_000, iteration: 7, resumed: true });
	assert.deepEqual([out.status, out.iterations, s.messages.length], ["limit", 7, 0]);
});

test("rounds with nothing new are stuck: two in a row end the job as blocked", async () => {
	const s = new Fake([setList("todo", "todo"), () => {}, () => {}, () => {}]);
	const out = await run(s);
	assert.deepEqual([out.status, out.iterations], ["blocked", 3]);
	assert.match(out.reason, /No progress in the last 2 rounds: no file changed and the checklist stayed the same/);
});

test("a changed file or a changed checklist counts as progress and resets the count", async () => {
	const s = new Fake([
		setList("todo", "todo"),
		() => {}, // nothing
		(f) => void (f.changed = true), // a file changed
		() => {}, // nothing
		setList("done", "todo"), // checklist moved
		() => {}, // nothing
		setList("done", "done"),
	]);
	const out = await run(s);
	assert.deepEqual([out.status, out.iterations], ["done", 7]);
});

test("the no-progress limit is adjustable, and a failing snapshot is treated as a change rather than as stuck", async () => {
	const patient = new Fake([setList("todo"), () => {}, () => {}, () => {}, () => {}]);
	assert.deepEqual((await run(patient, { task: { noProgressLimit: 4 } })).iterations, 5);

	const blind = new Fake([setList("todo"), () => {}, () => {}, () => {}]);
	blind.snapshotFails = true;
	const out = await run(blind, { task: { maxIterations: 4 } });
	assert.equal(out.status, "limit", "could not tell, so it kept going");
});

test("when everything left is blocked there is nothing more to do", async () => {
	const s = new Fake([setList("done", ["blocked", "needs a key"], ["blocked", "needs approval"])]);
	const out = await run(s);
	assert.deepEqual([out.status, out.iterations], ["blocked", 1]);
	assert.equal(out.reason, "Every remaining task is blocked: t2 (needs a key), t3 (needs approval).");
	// One blocked task among others still open is not the end.
	const s2 = new Fake([setList(["blocked", "x"], "todo"), setList(["blocked", "x"], "done")]);
	assert.equal((await run(s2)).status, "blocked");
	assert.equal(s2.messages.length, 2);
});

test("errors end the job with the reason: a failed request, a thrown error, a full disk, the daily budget", async () => {
	const failed = new Fake([(f) => void (f.error = "401 invalid key")]);
	assert.deepEqual(await run(failed).then((o) => [o.status, o.reason]), ["error", "401 invalid key"]);

	const thrown = new Fake([() => { throw new Error("socket hang up"); }]);
	assert.deepEqual(await run(thrown).then((o) => [o.status, o.reason]), ["error", "socket hang up"]);

	const disk = new Fake([() => { throw Object.assign(new Error("Disk almost full"), { code: "disk_low" }); }]);
	assert.deepEqual(await run(disk).then((o) => [o.status, o.reason]), ["blocked", "Disk almost full"]);

	const budget = new Fake([() => { throw new Error("Daily budget of $5.00 reached ($5.01 spent)."); }]);
	assert.equal((await run(budget)).status, "limit");
});

test("a check before each round can stop it: a full disk blocks, anything else is a limit", async () => {
	const s = new Fake([setList("todo")]);
	let n = 0;
	const out = await run(s, { preflight: () => { if (++n === 2) throw Object.assign(new Error("Disk almost full"), { code: "disk_low" }); } });
	assert.deepEqual([out.status, out.iterations, s.messages.length], ["blocked", 1, 1]);

	const other = await run(new Fake(), { preflight: () => { throw new Error("daily budget reached"); } });
	assert.deepEqual([other.status, other.iterations], ["limit", 0]);
});

test("the user can stop it between rounds or while a round runs", async () => {
	let stop = false;
	const s = new Fake([(f) => { setList("todo")(f); stop = true; }]);
	const out = await run(s, { shouldStop: () => stop });
	assert.deepEqual([out.status, out.iterations, s.messages.length], ["cancelled", 1, 1]);

	const early = new Fake();
	assert.equal((await run(early, { shouldStop: () => true })).iterations, 0);

	// A round that fails because it was stopped is a stop, not an error.
	let aborted = false;
	const during = new Fake([() => { aborted = true; throw new Error("aborted"); }]);
	assert.equal((await run(during, { shouldStop: () => aborted })).status, "cancelled");
});

test("after a restart it begins by saying so, and keeps counting rounds", async () => {
	const s = new Fake([setList("done")]);
	const rounds: number[] = [];
	const out = await run(s, { resumed: true, iteration: 4, onRound: (r) => rounds.push(r.iteration) });
	assert.equal(s.messages[0], RESUME_PROMPT);
	assert.deepEqual([out.status, out.iterations], ["done", 5]);
	assert.deepEqual(rounds, [5]);
});

test("each round is reported with the spend so far", async () => {
	const seen: [number, number][] = [];
	const s = new Fake([(f) => { f.spent = 0.5; setList("todo")(f); }, (f) => { f.spent = 1.25; setList("done")(f); }]);
	await run(s, { onRound: (r) => seen.push([r.iteration, r.cost]) });
	assert.deepEqual(seen, [[1, 0], [2, 0.5]]);
});
