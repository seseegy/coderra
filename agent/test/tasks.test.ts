import assert from "node:assert/strict";
import { test } from "node:test";
import {
	apply,
	type Checklist,
	counts,
	emptyChecklist,
	isComplete,
	latestChecklist,
	MAX_ITEMS,
	MAX_NOTE,
	MAX_TITLE,
	record,
	render,
	tasksTool,
} from "../src/tasks.js";

const set = (...titles: string[]) => apply(emptyChecklist(), { action: "set", items: titles.map((title) => ({ title })) }).list;
const msg = (fn: () => unknown) => {
	try {
		fn();
		return "no error";
	} catch (e) {
		return (e as Error).message;
	}
};

// ---------------------------------------------------------------------------
// The list itself

test("set writes a numbered list, all todo, and replaces what was there", () => {
	const a = apply(emptyChecklist(), { action: "set", items: [{ title: "Write tests" }, { title: "Fix bug", note: "see issue 4" }] });
	assert.deepEqual(a.list.items, [
		{ id: "t1", title: "Write tests", status: "todo" },
		{ id: "t2", title: "Fix bug", status: "todo", note: "see issue 4" },
	]);
	assert.equal(a.list.nextId, 3);
	assert.match(a.message, /set with 2 tasks/);

	const b = apply(a.list, { action: "set", items: [{ title: "Only one" }] });
	assert.deepEqual(b.list.items, [{ id: "t1", title: "Only one", status: "todo" }], "numbering starts again");
	assert.match(b.message, /1 task\./);
});

test("add appends one task or several, and ids keep counting after removals", () => {
	let list = set("a", "b");
	list = apply(list, { action: "add", title: "c" }).list;
	list = apply(list, { action: "remove", id: "t2" }).list;
	const added = apply(list, { action: "add", items: [{ title: "d" }, { title: "e", note: "n" }] });
	assert.deepEqual(added.list.items.map((i) => i.id), ["t1", "t3", "t4", "t5"], "t2 is gone and never reused");
	assert.match(added.message, /Added t4, t5/);
});

test("update changes status, title and note, and clears a note with an empty one", () => {
	let list = set("a", "b");
	list = apply(list, { action: "update", id: "t1", status: "in_progress" }).list;
	assert.equal(list.items[0].status, "in_progress");
	list = apply(list, { action: "update", id: "t1", status: "done", note: "tests pass" }).list;
	assert.deepEqual(list.items[0], { id: "t1", title: "a", status: "done", note: "tests pass" });
	list = apply(list, { action: "update", id: "t1", note: "" }).list;
	assert.equal("note" in list.items[0], false);
	const renamed = apply(list, { action: "update", id: "T2 ", title: "  better   name " });
	assert.equal(renamed.list.items[1].title, "better name", "ids are matched ignoring case and spaces; titles are tidied");
	assert.match(renamed.message, /t2: renamed/);
});

test("update does not touch the list it was given", () => {
	const before = set("a");
	const snapshot = JSON.stringify(before);
	apply(before, { action: "update", id: "t1", status: "done" });
	apply(before, { action: "add", title: "b" });
	assert.equal(JSON.stringify(before), snapshot);
});

test("remove and list", () => {
	const list = set("a", "b");
	assert.deepEqual(apply(list, { action: "remove", id: "t1" }).list.items.map((i) => i.id), ["t2"]);
	const same = apply(list, { action: "list" });
	assert.deepEqual(same.list, list);
	assert.match(same.message, /Current checklist/);
	assert.match(apply(emptyChecklist(), { action: "list" }).message, /empty/);
});

test("titles and notes are tidied and clipped", () => {
	const long = "x".repeat(MAX_TITLE + 50);
	const longNote = "y".repeat(MAX_NOTE + 50);
	const { list } = apply(emptyChecklist(), { action: "set", items: [{ title: `  spaced \n out\ttitle  ` }, { title: long, note: longNote }] });
	assert.equal(list.items[0].title, "spaced out title");
	assert.equal(list.items[1].title.length, MAX_TITLE);
	assert.ok(list.items[1].title.endsWith("…"));
	assert.equal(list.items[1].note!.length, MAX_NOTE);
});

test("calls that cannot be applied say why", () => {
	const list = set("a", "b");
	assert.match(msg(() => apply(list, { action: "explode" })), /Unknown action "explode"\. Use set, add, update, remove or list/);
	assert.match(msg(() => apply(list, {})), /Unknown action "undefined"/);
	assert.match(msg(() => apply(list, { action: "set" })), /set needs items/);
	assert.match(msg(() => apply(list, { action: "add" })), /add needs a title/);
	assert.match(msg(() => apply(list, { action: "add", title: "   " })), /needs a title/);
	assert.match(msg(() => apply(list, { action: "update", id: "t9", status: "done" })), /No task with id "t9"\. The ids are: t1, t2/);
	assert.match(msg(() => apply(emptyChecklist(), { action: "update", id: "t1", status: "done" })), /The list is empty/);
	assert.match(msg(() => apply(list, { action: "update", id: "t1" })), /at least one of status, title or note/);
	assert.match(msg(() => apply(list, { action: "update", id: "t1", status: "finished" })), /status must be one of: todo, in_progress, done, blocked/);
	assert.match(msg(() => apply(list, { action: "update", id: "t1", note: 5 })), /note must be text/);
	assert.match(msg(() => apply(list, { action: "remove" })), /No task with id/);
});

test("a checklist is limited in size", () => {
	const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ title: `task ${i}` }));
	assert.match(msg(() => apply(emptyChecklist(), { action: "set", items: many })), new RegExp(`at most ${MAX_ITEMS}`));
	const full = apply(emptyChecklist(), { action: "set", items: many.slice(0, MAX_ITEMS) }).list;
	assert.match(msg(() => apply(full, { action: "add", title: "one more" })), new RegExp(`at most ${MAX_ITEMS}`));
});

test("it warns about two tasks in progress and about a finished list", () => {
	let list = set("a", "b");
	list = apply(list, { action: "update", id: "t1", status: "in_progress" }).list;
	const both = apply(list, { action: "update", id: "t2", status: "in_progress" });
	assert.equal(both.warnings.length, 1);
	assert.match(both.warnings[0], /2 tasks are in progress \(t1, t2\)/);

	list = apply(list, { action: "update", id: "t1", status: "done" }).list;
	const finished = apply(list, { action: "update", id: "t2", status: "done" });
	assert.match(finished.warnings.join(" "), /Every task is done/);
	assert.equal(apply(list, { action: "update", id: "t2", status: "blocked", note: "no access" }).warnings.length, 0);
});

test("counts, completeness and rendering", () => {
	let list = set("a", "b", "c", "d");
	list = apply(list, { action: "update", id: "t1", status: "done" }).list;
	list = apply(list, { action: "update", id: "t2", status: "in_progress" }).list;
	list = apply(list, { action: "update", id: "t3", status: "blocked", note: "needs a key" }).list;
	assert.deepEqual(counts(list), { todo: 1, in_progress: 1, done: 1, blocked: 1, total: 4 });
	assert.equal(isComplete(list), false);
	assert.equal(render(list), "1/4 done, 1 blocked, 1 in progress\n[x] t1 a\n[~] t2 b\n[!] t3 c — needs a key\n[ ] t4 d");
	assert.equal(render(emptyChecklist()), "(no tasks)");
	assert.equal(isComplete(emptyChecklist()), false, "nothing written down is not the same as done");
	const done: Checklist = { items: [{ id: "t1", title: "a", status: "done" }], nextId: 2 };
	assert.equal(isComplete(done), true);
});

test("the record sent to the app carries the session, the items and the counts", () => {
	const list = set("a");
	assert.deepEqual(record("s1", list), { type: "tasks", sessionId: "s1", items: list.items, counts: { todo: 1, in_progress: 0, done: 0, blocked: 0, total: 1 } });
});

// ---------------------------------------------------------------------------
// Reading the list out of a session

const result = (list: Checklist | undefined, extra: object = {}) => ({
	type: "message",
	message: { role: "toolResult", toolName: "tasks", details: list ? { checklist: list } : undefined, ...extra },
});

test("the current list is the latest successful tasks result on the branch", () => {
	const v1 = set("a");
	const v2 = apply(v1, { action: "add", title: "b" }).list;
	const branch = [
		{ type: "message", message: { role: "user", content: "hi" } },
		result(v1),
		{ type: "message", message: { role: "toolResult", toolName: "bash", details: { checklist: set("not ours") } } },
		result(v2),
		{ type: "message", message: { role: "assistant" } },
		result(undefined, { isError: true }), // a failed call has no details and changes nothing
	];
	assert.deepEqual(latestChecklist(branch), v2);
	assert.deepEqual(latestChecklist(branch.slice(0, 2)), v1, "rewinding the conversation rewinds the list");
	assert.deepEqual(latestChecklist(branch.slice(0, 1)), emptyChecklist());
	assert.deepEqual(latestChecklist([]), emptyChecklist());
});

test("damaged details are skipped rather than trusted", () => {
	const good = set("a");
	const branch = [
		result(good),
		{ type: "message", message: { role: "toolResult", toolName: "tasks", details: { checklist: { items: [{ id: 1, title: "x", status: "todo" }] } } } },
		{ type: "message", message: { role: "toolResult", toolName: "tasks", details: { checklist: { items: [{ id: "t1", title: "x", status: "wat" }] } } } },
		{ type: "message", message: { role: "toolResult", toolName: "tasks", details: { checklist: "nope" } } },
		null,
		{ type: "custom" },
	];
	assert.deepEqual(latestChecklist(branch), good);
	// Missing or bad nextId is repaired from the list.
	const odd = { type: "message", message: { role: "toolResult", toolName: "tasks", details: { checklist: { items: [{ id: "t4", title: "x", status: "todo" }], nextId: "five" } } } };
	assert.equal(latestChecklist([odd]).nextId, 2);
});

// ---------------------------------------------------------------------------
// The tool, as pi calls it

function fakeSession(id = "s1") {
	let seq = 0;
	let leaf: string | null = "root";
	const branch: unknown[] = [];
	return {
		branch,
		sm: { getBranch: () => branch, getSessionId: () => id, getLeafId: () => leaf },
		/** pi appends the tool's result to the branch and moves the leaf. */
		commit(r: { details?: unknown }) {
			branch.push({ type: "message", message: { role: "toolResult", toolName: "tasks", details: r.details } });
			leaf = `e${++seq}`;
		},
		rewindTo(n: number, newLeaf: string) {
			branch.length = n;
			leaf = newLeaf;
		},
	};
}

test("the tool describes itself for the model", () => {
	const tool = tasksTool(() => {});
	assert.equal(tool.name, "tasks");
	assert.equal(tool.executionMode, "sequential");
	assert.ok(tool.description.length > 50);
	assert.ok(tool.promptSnippet.startsWith("tasks:"));
	assert.match(tool.promptGuidelines[0], /more than two steps/);
	const schema = tool.parameters as unknown as { properties: Record<string, any>; required: string[] };
	assert.deepEqual(Object.keys(schema.properties).sort(), ["action", "id", "items", "note", "status", "title"]);
	assert.deepEqual(schema.required, ["action"]);
	assert.deepEqual(schema.properties.action.enum, ["set", "add", "update", "remove", "list"]);
	assert.deepEqual(schema.properties.status.enum, ["todo", "in_progress", "done", "blocked"]);
	assert.equal(schema.properties.action.type, "string", "plain string enums: no anyOf, which some providers reject");
});

test("each call builds on the last, is reported to the app, and returns the list as text and as details", async () => {
	const sent: any[] = [];
	const tool = tasksTool((r) => sent.push(r));
	const s = fakeSession();

	const first: any = await tool.execute("c1", { action: "set", items: [{ title: "a" }, { title: "b" }] }, undefined, undefined, { sessionManager: s.sm });
	s.commit(first);
	assert.match(first.content[0].text, /Checklist set with 2 tasks\.\n0\/2 done\n\[ \] t1 a\n\[ \] t2 b/);
	assert.equal(first.details.action, "set");
	assert.equal(first.details.checklist.items.length, 2);

	const second: any = await tool.execute("c2", { action: "update", id: "t1", status: "done" }, undefined, undefined, { sessionManager: s.sm });
	s.commit(second);
	assert.match(second.content[0].text, /1\/2 done/);

	assert.deepEqual(sent.map((r) => [r.sessionId, r.counts.done, r.counts.total]), [["s1", 0, 2], ["s1", 1, 2]]);
	assert.deepEqual(latestChecklist(s.branch), second.details.checklist);
});

test("calls in the same turn, before pi has stored the earlier results, still add up", async () => {
	const tool = tasksTool(() => {});
	const s = fakeSession();
	const a: any = await tool.execute("c1", { action: "set", items: [{ title: "a" }, { title: "b" }] }, undefined, undefined, { sessionManager: s.sm });
	// No commit: the branch has not moved.
	const b: any = await tool.execute("c2", { action: "update", id: "t1", status: "done" }, undefined, undefined, { sessionManager: s.sm });
	const c: any = await tool.execute("c3", { action: "update", id: "t2", status: "in_progress" }, undefined, undefined, { sessionManager: s.sm });
	assert.deepEqual(c.details.checklist.items.map((i: any) => i.status), ["done", "in_progress"]);
	assert.ok(a && b);
});

test("after the conversation is rewound the next call starts from the rewound list", async () => {
	const tool = tasksTool(() => {});
	const s = fakeSession();
	for (const params of [
		{ action: "set", items: [{ title: "a" }, { title: "b" }] },
		{ action: "update", id: "t1", status: "done" },
		{ action: "update", id: "t2", status: "done" },
	]) s.commit(await tool.execute("c", params, undefined, undefined, { sessionManager: s.sm }));
	assert.equal(latestChecklist(s.branch).items.every((i) => i.status === "done"), true);

	// The user edits an earlier message: the branch is cut back to after the first update, on a new leaf.
	s.rewindTo(2, "forked");
	const r: any = await tool.execute("c", { action: "list" }, undefined, undefined, { sessionManager: s.sm });
	assert.deepEqual(r.details.checklist.items.map((i: any) => i.status), ["done", "todo"]);
});

test("a call that cannot be applied fails the call, changes nothing and tells the app nothing", async () => {
	const sent: any[] = [];
	const tool = tasksTool((r) => sent.push(r));
	const s = fakeSession();
	await assert.rejects(() => tool.execute("c", { action: "update", id: "t1", status: "done" }, undefined, undefined, { sessionManager: s.sm }), /The list is empty/);
	assert.deepEqual(sent, []);
	assert.deepEqual(latestChecklist(s.branch), emptyChecklist());
});

test("list shows the list without announcing a change", async () => {
	const sent: any[] = [];
	const tool = tasksTool((r) => sent.push(r));
	const s = fakeSession();
	s.commit(await tool.execute("c", { action: "set", items: [{ title: "a" }] }, undefined, undefined, { sessionManager: s.sm }));
	sent.length = 0;
	const r: any = await tool.execute("c", { action: "list" }, undefined, undefined, { sessionManager: s.sm });
	assert.match(r.content[0].text, /Current checklist\.\n0\/1 done/);
	assert.deepEqual(sent, []);
});

test("sessions do not share a list", async () => {
	const tool = tasksTool(() => {});
	const a = fakeSession("A");
	const b = fakeSession("B");
	const ra: any = await tool.execute("c", { action: "set", items: [{ title: "only in A" }] }, undefined, undefined, { sessionManager: a.sm });
	const rb: any = await tool.execute("c", { action: "list" }, undefined, undefined, { sessionManager: b.sm });
	assert.equal(ra.details.checklist.items.length, 1);
	assert.equal(rb.details.checklist.items.length, 0);
});
