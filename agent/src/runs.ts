/**
 * Background agent runs: a queue (with a concurrency limit, so several agents can work at once), scheduled tasks, and
 * GitHub issue triggers. Each run is its own pi session, so the result can be opened later as a normal chat.
 *
 * A run is either a single prompt, or a long task: a job the agent is kept at, round after round, until it is done,
 * stuck or out of allowance (longtask.ts). If the process dies while a run is going, the run is picked up again from its
 * session file when the host starts, a few times, instead of being lost.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { LongTaskError, type LongTask, normalizeTask, RESUME_PROMPT, superviseTask, type TaskSession } from "./longtask.js";

export interface RunSession extends TaskSession {
	sessionFile?: string;
	abort(): Promise<void>;
	dispose(): void;
}

export type RunStatus = "queued" | "running" | "done" | "error" | "cancelled" | "blocked" | "limit";

export interface Run {
	id: string;
	title: string;
	prompt: string;
	cwd: string;
	status: RunStatus;
	source: "queue" | "schedule" | "trigger";
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	sessionFile?: string;
	summary?: string;
	/** Why it ended, or what happened to it on the way (resumed after a restart). */
	reason?: string;
	/** Present for a long task. */
	task?: LongTask;
	/** Rounds done and money spent so far, for a long task. */
	iteration?: number;
	cost?: number;
	/** How many times it was picked up again after the host restarted. */
	resumes?: number;
	/** Set while it waits to be picked up again: the next start continues the old session. */
	resume?: boolean;
}

export interface Schedule {
	id: string;
	name: string;
	prompt: string;
	cwd: string;
	enabled: boolean;
	/** Run every N minutes, or daily at "HH:MM" (device time). */
	everyMinutes?: number;
	dailyAt?: string;
	/** Optional trigger instead of a clock: new GitHub issues with a label. */
	trigger?: { type: "github_issues"; repo: string; label: string; seen?: number[] };
	lastRun?: number;
}

interface Store {
	runs: Run[];
	schedules: Schedule[];
	concurrency: number;
}

export interface RunnerOptions {
	/** A restart picks a run up again at most this many times. */
	maxResumes?: number;
	/** Called before every round of a long task; a throw ends the task (disk full, daily budget). */
	preflight?: () => Promise<void> | void;
}

const CLOCK_MS = 60_000;

export class Runner {
	private store: Store = { runs: [], schedules: [], concurrency: 1 };
	private active = new Map<string, RunSession>();
	/** Runs the user asked to stop; the loop of a long task looks here between rounds. */
	private stopping = new Set<string>();
	private timer?: NodeJS.Timeout;
	private first?: NodeJS.Timeout;
	private readonly maxResumes: number;

	constructor(
		private readonly file: string,
		private readonly makeSession: (cwd: string, sessionFile?: string) => Promise<RunSession>,
		private readonly notify: (record: object) => void,
		private readonly github: (path: string) => Promise<any>,
		private readonly options: RunnerOptions = {},
	) {
		this.maxResumes = options.maxResumes ?? 3;
		if (existsSync(file)) {
			try {
				this.store = { runs: [], schedules: [], concurrency: 1, ...JSON.parse(readFileSync(file, "utf8")) };
			} catch {}
		}
		const resumed = this.recoverInterrupted();
		this.timer = setInterval(() => void this.tick(), CLOCK_MS);
		this.timer.unref();
		this.first = setTimeout(() => void this.tick(), 5_000);
		this.first.unref();
		if (resumed > 0) {
			this.notify({ type: "notice", message: `Picking up ${resumed} background ${resumed === 1 ? "task" : "tasks"} again after the host restarted.` });
		}
		// Let whoever built the runner finish setting up before the first run starts.
		setTimeout(() => this.pump(), 0).unref();
	}

	/**
	 * A run that was going when the process died cannot continue in memory, but its conversation is on disk. Put it back
	 * in the queue to continue from there, unless it has already been through this too many times.
	 */
	private recoverInterrupted(): number {
		let resumed = 0;
		for (const r of this.store.runs) {
			if (r.status !== "running") continue;
			const n = (r.resumes ?? 0) + 1;
			if (n > this.maxResumes) {
				r.status = "error";
				r.reason = `The host restarted ${this.maxResumes} times while this was running; giving up.`;
				r.summary = r.reason;
				r.finishedAt = Date.now();
				continue;
			}
			r.status = "queued";
			r.resumes = n;
			r.resume = !!r.sessionFile;
			r.reason = `Picked up again after a restart (${n} of ${this.maxResumes}).`;
			resumed++;
		}
		if (this.store.runs.length) this.save();
		return resumed;
	}

	private save() {
		this.store.runs = this.store.runs.slice(0, 100);
		writeFileSync(this.file, JSON.stringify(this.store, null, 1));
	}

	summary() {
		return {
			runs: this.store.runs,
			schedules: this.store.schedules,
			concurrency: this.store.concurrency,
			running: this.runningCount(),
			keepAlive: this.keepAlive(),
		};
	}

	/** Whether the app should stay alive in the background (runs or schedules pending). */
	keepAlive() {
		return this.runningCount() > 0 || this.store.runs.some((r) => r.status === "queued") || this.store.schedules.some((s) => s.enabled);
	}

	/** Long tasks that are going right now, for progress reports. */
	runningTasks(): Run[] {
		return this.store.runs.filter((r) => r.status === "running" && r.task);
	}

	private changed() {
		this.save();
		this.notify({ type: "runs", ...this.summary() });
	}

	setConcurrency(n: number) {
		this.store.concurrency = Math.min(Math.max(Math.round(n) || 1, 1), 3);
		this.changed();
		this.pump();
	}

	/** Adds a run to the queue. With `task`, it is a long task and `task` is checked and completed (throws if it makes no sense). */
	enqueue(prompt: string, cwd: string, title?: string, source: Run["source"] = "queue", task?: unknown) {
		let spec: LongTask | undefined;
		if (task !== undefined && task !== null) {
			try {
				spec = normalizeTask(task);
			} catch (e) {
				if (e instanceof LongTaskError) throw new Error(e.message);
				throw e;
			}
		}
		const run: Run = {
			id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
			title: title || prompt.split("\n")[0].slice(0, 80),
			prompt,
			cwd,
			status: "queued",
			source,
			createdAt: Date.now(),
			...(spec ? { task: spec, iteration: 0, cost: 0 } : {}),
		};
		this.store.runs.unshift(run);
		this.changed();
		this.pump();
		return run;
	}

	async cancel(id: string) {
		const run = this.store.runs.find((r) => r.id === id);
		if (!run) return;
		if (run.status === "running") {
			// Say so first: a long task checks this between rounds, and the abort below makes the round in progress end.
			this.stopping.add(id);
			await this.active.get(id)?.abort();
		}
		if (run.status === "queued" || run.status === "running") {
			run.status = "cancelled";
			run.finishedAt ??= Date.now();
		}
		this.changed();
	}

	clearFinished() {
		this.store.runs = this.store.runs.filter((r) => r.status === "queued" || r.status === "running");
		this.changed();
	}

	/** Runs that have begun, counted by status: a run is "running" from the moment it starts, before its session exists. */
	private runningCount() {
		return this.store.runs.filter((r) => r.status === "running").length;
	}

	private pump() {
		while (this.runningCount() < this.store.concurrency) {
			const next = [...this.store.runs].reverse().find((r) => r.status === "queued");
			if (!next) return;
			void this.start(next);
		}
	}

	private async start(run: Run) {
		const resumed = !!run.resume;
		run.resume = false;
		run.status = "running";
		run.startedAt ??= Date.now();
		this.changed();
		let session: RunSession | undefined;
		try {
			session = await this.makeSession(run.cwd, resumed ? run.sessionFile : undefined);
			this.active.set(run.id, session);
			run.sessionFile = session.sessionFile;
			this.changed();
			if (run.task) await this.superviseRun(run, session, resumed);
			else await this.single(run, session, resumed);
		} catch (e) {
			if ((run.status as string) !== "cancelled") {
				run.status = "error";
				run.summary = String((e as Error).message ?? e).slice(0, 600);
			}
		} finally {
			run.finishedAt = Date.now();
			this.active.delete(run.id);
			this.stopping.delete(run.id);
			session?.dispose();
			this.changed();
			this.notify({ type: "run_finished", run });
			this.pump();
		}
	}

	private async single(run: Run, session: RunSession, resumed: boolean) {
		await session.prompt(resumed ? RESUME_PROMPT : run.prompt);
		const err = session.errorText();
		if ((run.status as string) === "cancelled") return;
		run.status = err ? "error" : "done";
		run.summary = (err ?? session.lastText() ?? "").slice(0, 600);
	}

	private async superviseRun(run: Run, session: RunSession, resumed: boolean) {
		const outcome = await superviseTask({
			session,
			prompt: run.prompt,
			task: run.task!,
			iteration: run.iteration ?? 0,
			resumed,
			startedAt: run.startedAt!,
			shouldStop: () => this.stopping.has(run.id),
			preflight: this.options.preflight,
			onRound: ({ iteration, cost }) => {
				run.iteration = iteration;
				run.cost = cost;
				this.changed();
			},
		});
		run.iteration = outcome.iterations;
		run.cost = outcome.cost;
		if ((run.status as string) === "cancelled") return;
		run.status = outcome.status;
		run.reason = outcome.reason;
		run.summary = [outcome.reason, session.lastText()].filter(Boolean).join("\n\n").slice(0, 600);
	}

	// -------------------------------------------------------------------------
	// Schedules

	saveSchedule(s: Partial<Schedule>) {
		if (!s.name?.trim() || !s.prompt?.trim()) throw new Error("A schedule needs a name and a prompt");
		if (!s.trigger && !s.everyMinutes && !s.dailyAt) throw new Error("Choose how often it runs");
		const entry: Schedule = {
			id: s.id ?? `s${Date.now().toString(36)}`,
			name: s.name.trim(),
			prompt: s.prompt.trim(),
			cwd: s.cwd ?? "",
			enabled: s.enabled ?? true,
			everyMinutes: s.everyMinutes ? Math.max(15, Math.round(s.everyMinutes)) : undefined,
			dailyAt: s.dailyAt || undefined,
			trigger: s.trigger,
			lastRun: s.lastRun,
		};
		const i = this.store.schedules.findIndex((x) => x.id === entry.id);
		if (i >= 0) this.store.schedules[i] = { ...this.store.schedules[i], ...entry };
		else this.store.schedules.push(entry);
		this.changed();
		return entry;
	}

	deleteSchedule(id: string) {
		this.store.schedules = this.store.schedules.filter((s) => s.id !== id);
		this.changed();
	}

	runScheduleNow(id: string) {
		const s = this.store.schedules.find((x) => x.id === id);
		if (!s) throw new Error("Unknown schedule");
		s.lastRun = Date.now();
		return this.enqueue(s.prompt, s.cwd, s.name, "schedule");
	}

	private due(s: Schedule, now: Date) {
		if (s.everyMinutes) return !s.lastRun || now.getTime() - s.lastRun >= s.everyMinutes * 60_000;
		if (s.dailyAt) {
			const [h, m] = s.dailyAt.split(":").map(Number);
			const today = new Date(now);
			today.setHours(h, m, 0, 0);
			return now >= today && (!s.lastRun || s.lastRun < today.getTime());
		}
		return false;
	}

	private async tick() {
		const now = new Date();
		for (const s of this.store.schedules) {
			if (!s.enabled) continue;
			if (s.trigger?.type === "github_issues") {
				// Poll at most every 10 minutes.
				if (s.lastRun && now.getTime() - s.lastRun < 10 * 60_000) continue;
				s.lastRun = now.getTime();
				await this.pollIssues(s).catch((e) => this.notify({ type: "notice", message: `Trigger ${s.name}: ${e.message}` }));
				continue;
			}
			if (this.due(s, now)) {
				s.lastRun = now.getTime();
				this.enqueue(s.prompt, s.cwd, s.name, "schedule");
			}
		}
		this.save();
	}

	private async pollIssues(s: Schedule) {
		const t = s.trigger!;
		const issues: any[] = await this.github(
			`/repos/${t.repo}/issues?state=open&labels=${encodeURIComponent(t.label)}&per_page=20&sort=created&direction=desc`,
		);
		const seen = new Set(t.seen ?? []);
		const first = t.seen === undefined;
		for (const issue of issues.filter((i) => !i.pull_request)) {
			if (seen.has(issue.number)) continue;
			seen.add(issue.number);
			// The first poll only records what already exists.
			if (first) continue;
			this.enqueue(
				`${s.prompt}\n\nGitHub issue ${t.repo}#${issue.number}: ${issue.title}\n\n${issue.body ?? ""}\n\n${issue.html_url}`,
				s.cwd,
				`${s.name}: #${issue.number} ${issue.title}`,
				"trigger",
			);
		}
		t.seen = [...seen].slice(-200);
		this.changed();
	}

	dispose() {
		if (this.timer) clearInterval(this.timer);
		if (this.first) clearTimeout(this.first);
	}
}
