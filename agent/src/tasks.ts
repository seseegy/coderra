/**
 * The `tasks` tool: a checklist the agent keeps while it works, so a long job has a visible plan, the user can see how
 * far it is, and an unattended run has something to be measured against.
 *
 * The list lives in the session itself: every result of this tool carries the whole list in its `details`, and the
 * current list is whatever the latest result on the current branch says. That makes it follow the conversation like
 * everything else: editing an earlier message, forking a chat, or reopening a session after a restart gives the list
 * as it was at that point, with no separate file to keep in step.
 */

import { Type } from "typebox";

export type TaskStatus = "todo" | "in_progress" | "done" | "blocked";
const STATUSES: TaskStatus[] = ["todo", "in_progress", "done", "blocked"];

export interface TaskItem {
	id: string;
	title: string;
	status: TaskStatus;
	note?: string;
}

export interface Checklist {
	items: TaskItem[];
	/** Numbering continues after removals, so an id never means two different things in one session. */
	nextId: number;
}

export interface TaskCounts {
	todo: number;
	in_progress: number;
	done: number;
	blocked: number;
	total: number;
}

export const MAX_ITEMS = 100;
export const MAX_TITLE = 200;
export const MAX_NOTE = 500;

export const emptyChecklist = (): Checklist => ({ items: [], nextId: 1 });

export function counts(list: Checklist): TaskCounts {
	const c: TaskCounts = { todo: 0, in_progress: 0, done: 0, blocked: 0, total: list.items.length };
	for (const item of list.items) c[item.status]++;
	return c;
}

/** True for a list that is finished: something to do was written down, and all of it is done. */
export function isComplete(list: Checklist): boolean {
	return list.items.length > 0 && list.items.every((i) => i.status === "done");
}

// ---------------------------------------------------------------------------
// Reading the list back out of a session

function asChecklist(value: unknown): Checklist | null {
	const v = value as { items?: unknown; nextId?: unknown } | null;
	if (!v || !Array.isArray(v.items)) return null;
	const items: TaskItem[] = [];
	for (const raw of v.items as Record<string, unknown>[]) {
		if (!raw || typeof raw.id !== "string" || typeof raw.title !== "string" || !STATUSES.includes(raw.status as TaskStatus)) return null;
		items.push({
			id: raw.id,
			title: raw.title,
			status: raw.status as TaskStatus,
			...(typeof raw.note === "string" && raw.note ? { note: raw.note } : {}),
		});
	}
	const nextId = typeof v.nextId === "number" && Number.isInteger(v.nextId) && v.nextId >= 1 ? v.nextId : items.length + 1;
	return { items, nextId };
}

/** The list as of the end of `entries` (a session branch, oldest first): the latest successful `tasks` result. */
export function latestChecklist(entries: readonly unknown[]): Checklist {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; toolName?: string; details?: { checklist?: unknown } } };
		const m = entry?.type === "message" ? entry.message : undefined;
		if (m?.role === "toolResult" && m.toolName === "tasks") {
			const list = asChecklist(m.details?.checklist);
			if (list) return list;
		}
	}
	return emptyChecklist();
}

// ---------------------------------------------------------------------------
// Changing the list

export class TaskError extends Error {}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function cleanTitle(value: unknown): string {
	const t = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	if (!t) throw new TaskError("A task needs a title.");
	return clip(t, MAX_TITLE);
}

function cleanNote(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new TaskError("note must be text.");
	const n = value.replace(/\s+/g, " ").trim();
	return n ? clip(n, MAX_NOTE) : undefined;
}

function cleanStatus(value: unknown): TaskStatus {
	if (!STATUSES.includes(value as TaskStatus)) throw new TaskError(`status must be one of: ${STATUSES.join(", ")}.`);
	return value as TaskStatus;
}

function find(list: Checklist, id: unknown): TaskItem {
	const key = typeof id === "string" ? id.trim().toLowerCase() : "";
	const item = list.items.find((i) => i.id === key);
	if (!item) {
		const known = list.items.map((i) => i.id).join(", ");
		throw new TaskError(`No task with id "${String(id ?? "")}".${known ? ` The ids are: ${known}.` : " The list is empty."}`);
	}
	return item;
}

function entriesOf(params: Record<string, unknown>): { title: unknown; note?: unknown }[] {
	if (Array.isArray(params.items)) return params.items as { title: unknown; note?: unknown }[];
	if (params.title !== undefined) return [{ title: params.title, note: params.note }];
	return [];
}

export interface Applied {
	list: Checklist;
	/** What to tell the model about what just happened, before the list itself. */
	message: string;
	warnings: string[];
}

/** Applies one `tasks` call to a list and returns the new list. Throws a TaskError for a call that cannot be applied. */
export function apply(current: Checklist, params: Record<string, unknown>): Applied {
	const action = params.action;
	const warnings: string[] = [];
	const list: Checklist = { items: current.items.map((i) => ({ ...i })), nextId: current.nextId };
	let message: string;

	switch (action) {
		case "list":
			message = list.items.length ? "Current checklist." : "The checklist is empty.";
			break;

		case "set": {
			const given = entriesOf(params);
			if (given.length === 0) throw new TaskError("set needs items: a list of {title, note?}.");
			if (given.length > MAX_ITEMS) throw new TaskError(`A checklist holds at most ${MAX_ITEMS} tasks.`);
			list.items = [];
			list.nextId = 1;
			for (const g of given) list.items.push({ id: `t${list.nextId++}`, title: cleanTitle(g?.title), status: "todo", ...withNote(cleanNote(g?.note)) });
			message = `Checklist set with ${list.items.length} ${list.items.length === 1 ? "task" : "tasks"}.`;
			break;
		}

		case "add": {
			const given = entriesOf(params);
			if (given.length === 0) throw new TaskError("add needs a title (or items).");
			if (list.items.length + given.length > MAX_ITEMS) throw new TaskError(`A checklist holds at most ${MAX_ITEMS} tasks.`);
			const ids: string[] = [];
			for (const g of given) {
				const item: TaskItem = { id: `t${list.nextId++}`, title: cleanTitle(g?.title), status: "todo", ...withNote(cleanNote(g?.note)) };
				list.items.push(item);
				ids.push(item.id);
			}
			message = `Added ${ids.join(", ")}.`;
			break;
		}

		case "update": {
			const item = find(list, params.id);
			const changed: string[] = [];
			if (params.status !== undefined) {
				item.status = cleanStatus(params.status);
				changed.push(item.status.replace("_", " "));
			}
			if (params.title !== undefined) {
				item.title = cleanTitle(params.title);
				changed.push("renamed");
			}
			if (params.note !== undefined) {
				const note = cleanNote(params.note);
				if (note) item.note = note;
				else delete item.note;
				changed.push("note");
			}
			if (changed.length === 0) throw new TaskError("update needs at least one of status, title or note.");
			message = `${item.id}: ${changed.join(", ")}.`;
			break;
		}

		case "remove": {
			const item = find(list, params.id);
			list.items = list.items.filter((i) => i !== item);
			message = `Removed ${item.id}.`;
			break;
		}

		default:
			throw new TaskError(`Unknown action "${String(action)}". Use set, add, update, remove or list.`);
	}

	const active = list.items.filter((i) => i.status === "in_progress");
	if (active.length > 1) warnings.push(`${active.length} tasks are in progress (${active.map((i) => i.id).join(", ")}). Work on one at a time.`);
	if (action === "update" && isComplete(list)) warnings.push("Every task is done. If anything is left, add it; otherwise finish with your summary.");
	return { list, message, warnings };
}

const withNote = (note?: string) => (note ? { note } : {});

// ---------------------------------------------------------------------------
// Showing it

const MARK: Record<TaskStatus, string> = { done: "[x]", in_progress: "[~]", todo: "[ ]", blocked: "[!]" };

export function render(list: Checklist): string {
	if (list.items.length === 0) return "(no tasks)";
	const c = counts(list);
	const head = `${c.done}/${c.total} done${c.blocked ? `, ${c.blocked} blocked` : ""}${c.in_progress ? `, ${c.in_progress} in progress` : ""}`;
	const lines = list.items.map((i) => `${MARK[i.status]} ${i.id} ${i.title}${i.note ? ` — ${i.note}` : ""}`);
	return `${head}\n${lines.join("\n")}`;
}

/** The record sent to the app whenever the list changes (and by `tasks_get`). */
export function record(sessionId: string, list: Checklist) {
	return { type: "tasks" as const, sessionId, items: list.items, counts: counts(list) };
}

// ---------------------------------------------------------------------------
// The tool

const ACTIONS = ["set", "add", "update", "remove", "list"] as const;

const Params = Type.Object({
	action: Type.Unsafe<(typeof ACTIONS)[number]>({
		type: "string",
		enum: [...ACTIONS],
		description: "set: replace the whole list; add: append tasks; update: change one task; remove: delete one; list: show it",
	}),
	items: Type.Optional(
		Type.Array(Type.Object({ title: Type.String({ description: "What to do, in a few words" }), note: Type.Optional(Type.String()) }), {
			description: "For set and add: the tasks, in the order to do them",
		}),
	),
	id: Type.Optional(Type.String({ description: "For update and remove: the task id, such as t3" })),
	title: Type.Optional(Type.String({ description: "For add: a single task. For update: a new title" })),
	status: Type.Optional(
		Type.Unsafe<TaskStatus>({ type: "string", enum: [...STATUSES], description: "For update: todo, in_progress, done or blocked" }),
	),
	note: Type.Optional(Type.String({ description: "For update: a short note, such as why a task is blocked or how it was checked" })),
});

/** What the tool needs from the session it runs in (the pi ExtensionToolContext has all of this). */
export interface TasksContext {
	sessionManager: { getBranch(): readonly unknown[]; getSessionId(): string; getLeafId(): string | null | undefined };
}

export function tasksTool(onChange: (r: ReturnType<typeof record>) => void) {
	// Several calls in one assistant turn run one after another, and their results may not be in the branch yet when the
	// next one starts. If the branch has not moved since the last call in this session, continue from that call's list.
	const memo = new Map<string, { leaf: string | null; list: Checklist }>();

	return {
		name: "tasks",
		label: "Tasks",
		description:
			"Keep a checklist of the work for this job. Create it first for anything with more than two steps, mark a task in_progress before starting it and done as soon as it is finished and checked, and use blocked (with a note) when you cannot continue. The user sees the list, and an unattended run is judged by it.",
		promptSnippet: "tasks: keep a visible checklist of the steps of a job (set, add, update, remove, list)",
		promptGuidelines: [
			"For a job with more than two steps, start by writing the plan with the tasks tool (action set). Keep one task in_progress at a time; mark it done only when it is finished and you checked it (for example the tests pass). Use blocked with a note instead of silently skipping a task.",
		],
		parameters: Params,
		// The next call must see the previous one's result.
		executionMode: "sequential" as const,
		async execute(_id: string, params: Record<string, unknown>, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: TasksContext) {
			const sm = ctx.sessionManager;
			const sessionId = sm.getSessionId();
			const leaf = sm.getLeafId() ?? null;
			const seen = memo.get(sessionId);
			const current = seen && seen.leaf === leaf ? seen.list : latestChecklist(sm.getBranch());
			let applied: Applied;
			try {
				applied = apply(current, params);
			} catch (e) {
				if (e instanceof TaskError) throw new Error(e.message);
				throw e;
			}
			memo.set(sessionId, { leaf, list: applied.list });
			if (params.action !== "list") onChange(record(sessionId, applied.list));
			const text = [applied.message, ...applied.warnings.map((w) => `Note: ${w}`), render(applied.list)].join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: { action: String(params.action), checklist: applied.list },
			};
		},
	};
}
