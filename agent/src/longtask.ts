/**
 * Long tasks: a job handed to the agent to work on until it is finished, with nobody watching.
 *
 * A normal run is one prompt. The agent answers, uses its tools, and stops when it has nothing more to say, which is
 * often before the job is really done. A long task wraps that in a loop: after each round it checks whether the job is
 * finished (the agent's own checklist is complete, and/or a command such as the tests succeeds), and if not, tells the
 * agent what is left and asks it to carry on. It stops when the job is done, when it is stuck, or when it has used up
 * what it was allowed (rounds, hours, money).
 */

import { type Checklist, isComplete } from "./tasks.js";

export type DoneWhen = "checklist" | "command" | "manual";

export interface LongTask {
	/** What has to hold for the job to count as finished. All of them. `manual` never holds: only a limit or the user ends it. */
	doneWhen: DoneWhen[];
	/** For `command`: a shell command that succeeds (exit code 0) when the job is done, such as the test suite. */
	command?: string;
	maxIterations: number;
	maxHours: number;
	/** 0 means no limit of its own (the daily budget still applies). */
	maxCostUsd: number;
	/** Stop after this many rounds in a row in which nothing changed. */
	noProgressLimit: number;
}

export const DEFAULT_LONG_TASK: LongTask = {
	doneWhen: ["checklist"],
	maxIterations: 50,
	maxHours: 24,
	maxCostUsd: 0,
	noProgressLimit: 2,
};

export class LongTaskError extends Error {}

function number(value: unknown, name: string, fallback: number, min: number, max: number): number {
	if (value === undefined || value === null || value === "") return fallback;
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw new LongTaskError(`${name} must be a number from ${min} to ${max}.`);
	return n;
}

/** Checks and completes what the app sent for a long task. */
export function normalizeTask(input: unknown): LongTask {
	const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const wanted = raw.doneWhen === undefined ? DEFAULT_LONG_TASK.doneWhen : raw.doneWhen;
	if (!Array.isArray(wanted) || wanted.length === 0) throw new LongTaskError("doneWhen must list at least one of checklist, command, manual.");
	const doneWhen: DoneWhen[] = [];
	for (const w of wanted) {
		if (w !== "checklist" && w !== "command" && w !== "manual") throw new LongTaskError(`Unknown doneWhen "${String(w)}".`);
		if (!doneWhen.includes(w)) doneWhen.push(w);
	}
	if (doneWhen.includes("manual") && doneWhen.length > 1) throw new LongTaskError("manual cannot be combined with the others: it never finishes by itself.");
	let command: string | undefined;
	if (doneWhen.includes("command")) {
		command = typeof raw.command === "string" ? raw.command.trim() : "";
		if (!command) throw new LongTaskError("doneWhen command needs a command to run.");
		if (command.length > 2000) throw new LongTaskError("The command is too long.");
	}
	return {
		doneWhen,
		...(command ? { command } : {}),
		maxIterations: Math.floor(number(raw.maxIterations, "maxIterations", DEFAULT_LONG_TASK.maxIterations, 1, 500)),
		maxHours: number(raw.maxHours, "maxHours", DEFAULT_LONG_TASK.maxHours, 0.05, 168),
		maxCostUsd: number(raw.maxCostUsd, "maxCostUsd", DEFAULT_LONG_TASK.maxCostUsd, 0, 100000),
		noProgressLimit: Math.floor(number(raw.noProgressLimit, "noProgressLimit", DEFAULT_LONG_TASK.noProgressLimit, 1, 20)),
	};
}

// ---------------------------------------------------------------------------
// The loop

/** What the loop needs from a session. `RunSession` in runs.ts is this plus a few things a plain run does not use. */
export interface TaskSession {
	prompt(text: string): Promise<void>;
	lastText(): string | undefined;
	errorText(): string | undefined;
	/** Spend so far, in USD, across the whole conversation (so it includes rounds before a restart). */
	cost(): number;
	checklist(): Checklist;
	runCommand(command: string): Promise<{ code: number; output: string }>;
	/** Records the project folder as it is now; true if anything changed since the previous snapshot. */
	snapshot(label: string): Promise<boolean>;
}

export type TaskStatus = "done" | "blocked" | "limit" | "error" | "cancelled";

export interface TaskOutcome {
	status: TaskStatus;
	reason: string;
	iterations: number;
	cost: number;
}

export interface SuperviseOptions {
	session: TaskSession;
	/** What the user asked for. */
	prompt: string;
	task: LongTask;
	/** Rounds already done (nonzero after a restart). */
	iteration?: number;
	/** The session is being picked up after the process restarted, so the first message says that instead of the job. */
	resumed?: boolean;
	/** When the whole job began, for the time limit; survives restarts. */
	startedAt: number;
	now?: () => number;
	/** Polled between rounds; true ends the loop with `cancelled`. */
	shouldStop?: () => boolean;
	/** Throws if a round must not start (disk full, daily budget). A thrown error with code `disk_low` ends the job as blocked. */
	preflight?: () => Promise<void> | void;
	onRound?: (info: { iteration: number; cost: number }) => void;
}

export const RESUME_PROMPT =
	"The process was restarted while you were working. Carry on from where you left off. If a command was cut off, check what state it left behind before running it again.";

export function startPrompt(prompt: string, task: LongTask): string {
	const checks: string[] = [];
	if (task.doneWhen.includes("command")) checks.push(`The job counts as done only when \`${task.command}\` succeeds.`);
	if (task.doneWhen.includes("checklist")) checks.push("It also counts as done when every task on your checklist is done.");
	return [
		prompt.trim(),
		"",
		"[Unattended task] Nobody is watching this run and nobody can answer questions. Start by writing the plan as a checklist with the tasks tool, then work through it, marking each task done only when it is finished and checked.",
		...checks,
		"If something is refused, do not look for a way around it: mark that task blocked with a note and carry on with the rest.",
	].join("\n");
}

function continuation(list: Checklist, failures: string[]): string {
	const lines = ["Keep going with the job."];
	if (list.items.length === 0) {
		lines.push("You have not written a checklist yet. Write one now with the tasks tool, then continue.");
	} else {
		const left = list.items.filter((i) => i.status !== "done");
		if (left.length) lines.push(`Still open:\n${left.map((i) => `- ${i.id} [${i.status}] ${i.title}${i.note ? ` (${i.note})` : ""}`).join("\n")}`);
	}
	for (const f of failures) lines.push(f);
	lines.push("If you are stuck on something only the user can decide, mark that task blocked with a note and move on.");
	return lines.join("\n");
}

const tail = (text: string, lines = 20) => text.trim().split("\n").slice(-lines).join("\n");

function fingerprint(list: Checklist): string {
	return JSON.stringify(list.items.map((i) => [i.id, i.status, i.note ?? ""]));
}

/** Runs rounds until the job is done, stuck or out of allowance. Never throws: every way it can end is an outcome. */
export async function superviseTask(o: SuperviseOptions): Promise<TaskOutcome> {
	const now = o.now ?? Date.now;
	const { session, task } = o;
	let iteration = o.iteration ?? 0;
	let message = o.resumed ? RESUME_PROMPT : startPrompt(o.prompt, task);
	let stagnant = 0;
	let lastFingerprint = fingerprint(session.checklist());
	const end = (status: TaskStatus, reason: string): TaskOutcome => ({ status, reason, iterations: iteration, cost: session.cost() });

	for (;;) {
		if (o.shouldStop?.()) return end("cancelled", "Stopped by the user.");
		if (iteration >= task.maxIterations) return end("limit", `Used all ${task.maxIterations} rounds.`);
		if ((now() - o.startedAt) / 3_600_000 >= task.maxHours) return end("limit", `Ran for ${task.maxHours} hours.`);
		if (task.maxCostUsd > 0 && session.cost() >= task.maxCostUsd) return end("limit", `Spent $${session.cost().toFixed(2)} of the $${task.maxCostUsd.toFixed(2)} allowed.`);
		try {
			await o.preflight?.();
		} catch (e) {
			return end(codeOf(e) === "disk_low" ? "blocked" : "limit", String((e as Error).message ?? e));
		}

		iteration++;
		o.onRound?.({ iteration, cost: session.cost() });
		try {
			await session.prompt(message);
		} catch (e) {
			const reason = String((e as Error).message ?? e);
			if (o.shouldStop?.()) return end("cancelled", "Stopped by the user.");
			if (codeOf(e) === "disk_low") return end("blocked", reason);
			return end(/budget/i.test(reason) ? "limit" : "error", reason);
		}
		if (o.shouldStop?.()) return end("cancelled", "Stopped by the user.");
		const failed = session.errorText();
		if (failed) return end("error", failed);

		const changedFiles = await session.snapshot(`Task round ${iteration}`).catch(() => true);
		const list = session.checklist();
		// Is the job finished? Every condition asked for has to hold. The command is only worth running once the
		// checklist (if that is also asked for) says everything is done; on its own it is run every round.
		const failures: string[] = [];
		let satisfied = !task.doneWhen.includes("manual");
		if (satisfied && task.doneWhen.includes("checklist") && !isComplete(list)) satisfied = false;
		if (satisfied && task.doneWhen.includes("command")) {
			const r = await session.runCommand(task.command!).catch((e: Error) => ({ code: 1, output: String(e?.message ?? e) }));
			if (r.code !== 0) {
				satisfied = false;
				failures.push(`\`${task.command}\` failed (exit code ${r.code}). Its output ended with:\n${tail(r.output)}`);
			}
		}
		if (satisfied) return end("done", "Everything the job required is done.");

		// Nothing left that could still be done: everything open is blocked.
		const open = list.items.filter((i) => i.status !== "done");
		if (open.length > 0 && open.every((i) => i.status === "blocked")) {
			return end("blocked", `Every remaining task is blocked: ${open.map((i) => `${i.id}${i.note ? ` (${i.note})` : ""}`).join(", ")}.`);
		}

		const fp = fingerprint(list);
		const progressed = changedFiles || fp !== lastFingerprint;
		lastFingerprint = fp;
		stagnant = progressed ? 0 : stagnant + 1;
		if (stagnant >= task.noProgressLimit) {
			return end("blocked", `No progress in the last ${stagnant} ${stagnant === 1 ? "round" : "rounds"}: no file changed and the checklist stayed the same.`);
		}
		message = continuation(list, failures);
	}
}

function codeOf(e: unknown): string | undefined {
	const c = (e as { code?: unknown } | null)?.code;
	return typeof c === "string" ? c : undefined;
}
