/**
 * The `subagent` tool: hand a self-contained job to a second, short-lived agent and get back its report. The parent's
 * context stays small (a repository search that reads fifty files costs the parent one paragraph), and the child can be
 * a cheaper model.
 *
 * Version 1 is deliberately plain: the parent waits (synchronous), one level only (a child has no `subagent` tool), at
 * most a couple at once because every session shares the host's memory, and a child never asks anyone anything.
 * Sessions are created by the host (`SubagentDeps.create`); this file is the rules around them.
 */

import { Type } from "typebox";

export type Role = "explorer" | "worker";

export const EXPLORER_TOOLS = ["read", "grep", "find", "ls", "web_search", "web_fetch"];

/** Roles and what they may do. */
export const ROLES: Record<Role, { defaultMinutes: number; about: string }> = {
	explorer: { defaultMinutes: 20, about: "reads and searches only; for finding things out" },
	worker: { defaultMinutes: 60, about: "can change files and run commands in the project; for a bounded piece of work" },
};

export const MAX_REPORT_CHARS = 8000;
export const MAX_TASK_CHARS = 20_000;

/** The part of a pi session the tool uses. The host wraps a real session in this; tests use a fake. */
export interface ChildSession {
	sessionFile?: string;
	prompt(text: string): Promise<void>;
	lastText(): string;
	errorText(): string | undefined;
	abort(): Promise<void>;
	dispose(): void;
	cost(): number;
	/** Called each time the child starts a tool. */
	onTool(cb: (name: string, args: Record<string, unknown>) => void): void;
}

export interface SubagentDeps {
	/** Builds a session for the child. Throws a readable error for an unknown model. */
	create(o: { role: Role; cwd: string; model?: string; parentModel?: string; title: string }): Promise<ChildSession>;
	slots: Slots;
	/** Runs before a child is started: refuses when the disk is full or the daily budget is spent. */
	preflight?(): Promise<void> | void;
	/** What a child cost, so the parent's job can count it. */
	recordCost?(parentSessionId: string, cost: number): void;
	/** Milliseconds in a "minute". Only tests change this. */
	minuteMs?: number;
	/** Milliseconds between progress lines. */
	progressEveryMs?: number;
}

// ---------------------------------------------------------------------------
// Limiting how many run at once

/** A counting semaphore with a waiting line, a wait limit, and cancellation. */
export class Slots {
	private inUse = 0;
	private line: { grant: () => void; timer?: ReturnType<typeof setTimeout> }[] = [];

	constructor(
		readonly capacity: number,
		private readonly waitMs = 120_000,
	) {}

	get active() {
		return this.inUse;
	}

	get waiting() {
		return this.line.length;
	}

	/** Resolves with a release function; rejects when it waited too long or `signal` fired. */
	acquire(signal?: AbortSignal): Promise<() => void> {
		const release = () => {
			let done = false;
			return () => {
				if (done) return;
				done = true;
				this.inUse--;
				this.line.shift()?.grant();
			};
		};
		if (this.inUse < this.capacity) {
			this.inUse++;
			return Promise.resolve(release());
		}
		return new Promise((resolve, reject) => {
			const entry: (typeof this.line)[number] = {
				grant: () => {
					cleanup();
					this.inUse++;
					resolve(release());
				},
			};
			const leave = (error: Error) => {
				cleanup();
				this.line = this.line.filter((e) => e !== entry);
				reject(error);
			};
			const onAbort = () => leave(new Error("Stopped while waiting for a free sub-agent slot."));
			const cleanup = () => {
				if (entry.timer) clearTimeout(entry.timer);
				signal?.removeEventListener("abort", onAbort);
			};
			entry.timer = setTimeout(
				() => leave(new Error(`Too many sub-agents are running (${this.capacity} at most) and none finished within ${Math.round(this.waitMs / 1000)} s. Do this part yourself, or try again later.`)),
				this.waitMs,
			);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.line.push(entry);
		});
	}
}

// ---------------------------------------------------------------------------
// Pieces

/** One short line for what a child just started doing, e.g. "read src/x.ts" or "bash npm test". */
export function progressLine(tool: string, args: Record<string, unknown>): string {
	const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
	const detail = tool === "bash" ? text(args.command) : tool === "web_search" ? text(args.query) : tool === "web_fetch" ? text(args.url) : text(args.path) || text(args.pattern);
	return `${tool}${detail ? ` ${detail.length > 90 ? `${detail.slice(0, 89)}…` : detail}` : ""}`;
}

/** The first message the child gets: the job, and the facts of its situation. */
export function childPrompt(task: string, role: Role): string {
	const can =
		role === "explorer"
			? "You can read and search but not change anything. Report what you found: file paths with line numbers, and short quotes where they matter."
			: "You can change files and run commands in this project, within the usual limits. Do only the job described; report what you changed.";
	return `${task.trim()}\n\n[Sub-agent] Another agent started you to do exactly this job and cannot answer questions, so decide sensibly and carry on. ${can} Your last message is the only thing the other agent will see: make it a complete, short report, including anything you could not do.`;
}

function clip(text: string): { text: string; cut: number } {
	return text.length <= MAX_REPORT_CHARS ? { text, cut: 0 } : { text: text.slice(0, MAX_REPORT_CHARS), cut: text.length - MAX_REPORT_CHARS };
}

export type ChildStatus = "done" | "timeout" | "stopped" | "failed";

export interface SubagentDetails {
	role: Role;
	title: string;
	status: ChildStatus;
	sessionFile?: string;
	toolCalls: number;
	cost: number;
	seconds: number;
}

// ---------------------------------------------------------------------------
// The tool

const Params = Type.Object({
	task: Type.String({
		description:
			"The complete job, written for someone who has seen nothing of this conversation: what to do, where to look, what to report back. Include any file names, constraints and the form you want the answer in.",
	}),
	role: Type.Optional(
		Type.Unsafe<Role>({
			type: "string",
			enum: ["explorer", "worker"],
			description: "explorer (default): reads and searches only. worker: can change files and run commands.",
		}),
	),
	title: Type.Optional(Type.String({ description: "A few words naming the job, shown in the app" })),
	model: Type.Optional(Type.String({ description: "provider/model for the sub-agent, for example a cheaper one. Defaults to your own model." })),
	maxMinutes: Type.Optional(Type.Number({ description: "Time limit in minutes. Default 20 for explorer, 60 for worker." })),
});

/** What the tool needs from the session it runs in (pi's ExtensionToolContext has all of this). */
interface ToolContext {
	cwd: string;
	model?: { provider?: string; id?: string };
	sessionManager: { getSessionId(): string };
}

export function subagentTool(deps: SubagentDeps) {
	const minute = deps.minuteMs ?? 60_000;
	const every = deps.progressEveryMs ?? 500;

	return {
		name: "subagent",
		label: "Sub-agent",
		description:
			"Hand a self-contained job to a separate agent and wait for its report. Use an explorer for work that means reading many files or searching the web (it returns only its conclusions, which keeps your context small), and a worker for a bounded piece of work that changes files. The sub-agent sees nothing of this conversation, so the task must stand on its own. It cannot ask questions or start other sub-agents.",
		promptSnippet: "subagent: give a self-contained job to a separate agent and get its report (role explorer reads only, worker can change files)",
		promptGuidelines: [
			"Use the subagent tool when a job would fill your context with material you only need the conclusion of (searching a large codebase, reading documentation), or to run a cheaper model on a bounded piece of work. Write the task so it needs no other context. Do not use it for small jobs you can do in a step or two, and do not start a worker for work that overlaps with what you are editing yourself.",
		],
		parameters: Params,
		// Two children at once would make the parent wait for both anyway, and they share one process.
		executionMode: "sequential" as const,
		async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: ((r: any) => void) | undefined, ctx: ToolContext) {
			const task = String(params.task ?? "").trim();
			if (!task) throw new Error("task is empty: describe the whole job for the sub-agent.");
			if (task.length > MAX_TASK_CHARS) throw new Error(`task is too long (${task.length} characters, at most ${MAX_TASK_CHARS}). Put long material in a file and say where it is.`);
			const role = (params.role ?? "explorer") as Role;
			if (!ROLES[role]) throw new Error(`Unknown role "${String(params.role)}". Use explorer or worker.`);
			const minutes = params.maxMinutes === undefined ? ROLES[role].defaultMinutes : Number(params.maxMinutes);
			if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) throw new Error("maxMinutes must be between 0 and 240.");
			const title = String(params.title ?? "").trim().slice(0, 60) || task.split("\n")[0].slice(0, 60);
			const model = params.model ? String(params.model) : undefined;
			const parentModel = ctx.model?.provider && ctx.model.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

			await deps.preflight?.();
			const release = await deps.slots.acquire(signal);
			const started = Date.now();
			let child: ChildSession | undefined;
			let status: ChildStatus = "done";
			let toolCalls = 0;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let stopping: Promise<void> | undefined;
			const stop = (why: ChildStatus) => {
				if (stopping) return;
				status = why;
				stopping = child?.abort().catch(() => {});
			};
			const onAbort = () => stop("stopped");
			try {
				child = await deps.create({ role, cwd: ctx.cwd, model, parentModel, title });
				let lastSent = 0;
				child.onTool((name, args) => {
					toolCalls++;
					const now = Date.now();
					if (!onUpdate || now - lastSent < every) return;
					lastSent = now;
					onUpdate({ content: [{ type: "text", text: progressLine(name, args) }], details: { role, title, toolCalls } });
				});
				if (signal?.aborted) status = "stopped";
				else {
					signal?.addEventListener("abort", onAbort, { once: true });
					timer = setTimeout(() => stop("timeout"), minutes * minute);
					await child.prompt(childPrompt(task, role));
				}
				await stopping;
				const error = child.errorText();
				const report = clip(child.lastText().trim());
				if (status === "done" && error) status = "failed";
				if (status === "failed" && !report.text) throw new Error(`The sub-agent failed: ${error}`);

				const details: SubagentDetails = {
					role,
					title,
					status,
					sessionFile: child.sessionFile,
					toolCalls,
					cost: child.cost(),
					seconds: Math.round((Date.now() - started) / 1000),
				};
				deps.recordCost?.(ctx.sessionManager.getSessionId(), details.cost);
				const head: Record<ChildStatus, string> = {
					done: "",
					timeout: `[The sub-agent was stopped at its time limit of ${minutes} min. This is what it had so far.]\n\n`,
					stopped: "[The sub-agent was stopped before it finished. This is what it had so far.]\n\n",
					failed: `[The sub-agent hit an error (${String(error).slice(0, 200)}). This is what it had so far.]\n\n`,
				};
				const body = report.text || "(the sub-agent finished without writing a report)";
				const foot = [
					report.cut ? `[Report cut: ${report.cut} more characters. The full conversation is in the sub-agent's session.]` : "",
					`[Sub-agent ${role} "${title}": ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}, $${details.cost.toFixed(4)}, ${details.seconds}s${child.sessionFile ? `, session ${child.sessionFile}` : ""}]`,
				]
					.filter(Boolean)
					.join("\n");
				return { content: [{ type: "text" as const, text: `${head[status]}${body}\n\n${foot}` }], details };
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				try {
					child?.dispose();
				} finally {
					release();
				}
			}
		},
	};
}
