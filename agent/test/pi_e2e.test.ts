import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { connect, mockModel, startDaemon, usingMockModel, waitFor } from "./host_helpers.js";
import { tempDir } from "./helpers.js";

// The real host with the real pi session, tools and guard, talking to a pretend model that follows a script. Nothing
// is mocked inside the host: what is checked is what a user's phone would get.

const set = (...titles: string[]) => ({ name: "tasks", args: { action: "set", items: titles.map((title) => ({ title })) } });
const update = (id: string, status: string, note?: string) => ({ name: "tasks", args: { action: "update", id, status, ...(note ? { note } : {}) } });

test("tasks: the model is offered the tool and its guidance, calls it twice in one turn, and the app is told", async (t) => {
	const model = await mockModel(t, [{ calls: [set("write the code", "test it"), update("t1", "done")] }, { text: "All done." }]);
	const d = await startDaemon(t, {}, tempDir(t), usingMockModel(model.baseUrl));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });

	assert.ok((await c.call("hello")).tools.includes("tasks"));
	await c.call("prompt", { text: "build me a thing" });
	await waitFor("the run to finish", () => c.settled() >= 1);

	// What the model was shown.
	const first = model.requests[0].body;
	assert.ok(first.tools.some((x: any) => x.function.name === "tasks"));
	const schema = first.tools.find((x: any) => x.function.name === "tasks").function.parameters;
	assert.deepEqual(schema.required, ["action"]);
	assert.deepEqual(schema.properties.action.enum, ["set", "add", "update", "remove", "list"]);
	const system = first.messages.find((m: any) => m.role === "system" || m.role === "developer");
	assert.match(JSON.stringify(system), /tasks: keep a visible checklist/);
	assert.match(JSON.stringify(system), /more than two steps/);

	// Two calls in one assistant turn: the second saw the first.
	assert.deepEqual(model.toolResults(), [
		"Checklist set with 2 tasks.\n0/2 done\n[ ] t1 write the code\n[ ] t2 test it",
		"t1: done.\n1/2 done\n[x] t1 write the code\n[ ] t2 test it",
	]);

	// What the app was sent, and what it gets when it asks.
	const sessionId = (await c.call("state")).sessionId;
	assert.deepEqual(c.ofType("tasks").map((r) => [r.sessionId, r.counts.done, r.counts.total]), [[sessionId, 0, 2], [sessionId, 1, 2]]);
	assert.ok(c.ofType("tasks").every((r) => typeof r.seq === "number"), "replayable: a client that dropped would get them back");
	const now = await c.call("tasks_get");
	assert.equal(now.sessionId, sessionId);
	assert.deepEqual(now.items.map((i: any) => [i.id, i.status]), [["t1", "done"], ["t2", "todo"]]);
	assert.ok(c.events().filter((e) => e.type === "tool_execution_end").every((e) => e.isError === false));
});

test("tasks: the list is part of the conversation, so it survives a restart and follows an edited message", async (t) => {
	const home = tempDir(t);
	const model = await mockModel(t, [{ calls: [set("a", "b", "c")] }, { text: "planned" }, { calls: [update("t2", "done")] }, { text: "step done" }]);
	let d = await startDaemon(t, {}, home, usingMockModel(model.baseUrl));
	let c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });
	await c.call("prompt", { text: "first request" });
	await waitFor("the first run", () => c.settled() >= 1);
	await c.call("prompt", { text: "second request" });
	await waitFor("the second run", () => c.settled() >= 2);
	const statuses = async () => (await c.call("tasks_get")).items.map((i: any) => i.status);
	assert.deepEqual(await statuses(), ["todo", "done", "todo"]);

	// The host is stopped and started again: the same chat, the same list.
	d.child.kill("SIGKILL");
	await d.exited;
	c.socket.destroy();
	d = await startDaemon(t, {}, home);
	c = await connect(d.sock);
	assert.deepEqual(await statuses(), ["todo", "done", "todo"]);

	// Editing the second request rewinds the conversation to just before it, and the list with it.
	const points = await c.call("fork_points");
	assert.equal(points.length, 2);
	const edited = await c.call("edit_message", { entryId: points[1].entryId });
	assert.equal(edited.text, "second request");
	assert.deepEqual(await statuses(), ["todo", "todo", "todo"]);

	// And editing the first one rewinds past the plan itself.
	await c.call("edit_message", { entryId: points[0].entryId });
	assert.deepEqual((await c.call("tasks_get")).items, []);
});

test("tasks: plan mode lets the checklist through but still blocks changes, and approving asks for a checklist", async (t) => {
	const model = await mockModel(t, [
		{ calls: [set("one", "two"), { name: "write", args: { path: "plan-should-not-exist.txt", content: "x" } }] },
		{ text: "Here is the plan." },
		{ text: "On it." },
	]);
	const d = await startDaemon(t, {}, tempDir(t), usingMockModel(model.baseUrl));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });
	await c.call("plan_mode", { on: true });
	await c.call("prompt", { text: "plan something" });
	await waitFor("the planning run", () => c.settled() >= 1);

	const [tasksResult, writeResult] = model.toolResults();
	assert.match(tasksResult, /Checklist set with 2 tasks/);
	assert.match(writeResult, /Plan mode is on/);
	assert.equal(existsSync(join(d.workspace, "plan-should-not-exist.txt")), false);
	assert.equal(c.ofType("approval").length, 0);

	await c.call("plan_approve", {});
	await waitFor("the run after approval", () => c.settled() >= 2);
	const lastUser = model.requests.at(-1)!.body.messages.filter((m: any) => m.role === "user").at(-1);
	assert.match(JSON.stringify(lastUser), /Write it down as a checklist with the tasks tool/);
});

test("tasks: needs no approval even when everything else does, and a bad call fails cleanly", async (t) => {
	const model = await mockModel(t, [
		{ calls: [update("t9", "done")] },
		{ text: "that did not work" },
		{ calls: [set("a")] },
		{ text: "listed" },
		{ calls: [{ name: "write", args: { path: "needs-approval.txt", content: "x" } }] },
		{ text: "finished" },
	]);
	const d = await startDaemon(t, {}, tempDir(t), usingMockModel(model.baseUrl));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });
	await c.call("settings_set", { settings: { approvalMode: "ask_all" } });

	// An update to a task that does not exist: an error the model can read, and nothing changes.
	await c.call("prompt", { text: "one" });
	await waitFor("run 1", () => c.settled() >= 1);
	assert.match(model.toolResults()[0], /No task with id "t9"\. The list is empty/);
	assert.equal(c.events().find((e) => e.type === "tool_execution_end")?.isError, true);
	assert.equal(c.ofType("tasks").length, 0);

	// With approvals on for every change, the checklist does not ask...
	await c.call("prompt", { text: "two" });
	await waitFor("run 2", () => c.settled() >= 2);
	assert.equal(c.ofType("approval").length, 0);
	assert.equal(c.ofType("tasks").length, 1);

	// ...while a file write does, which shows ask_all really was on.
	await c.call("prompt", { text: "three" });
	await waitFor("the approval", () => c.ofType("approval").length === 1);
	const ask = c.ofType("approval")[0];
	assert.equal(ask.toolName, "write");
	assert.deepEqual(await c.call("approvals_pending"), [{ type: "approval", approvalId: ask.approvalId, toolName: "write", summary: ask.summary, reason: ask.reason, key: ask.key }]);
	await c.call("approval_reply", { approvalId: ask.approvalId, allow: false });
	await waitFor("run 3", () => c.settled() >= 3);
	assert.match(model.toolResults().at(-1)!, /declined/);
	assert.equal(existsSync(join(d.workspace, "needs-approval.txt")), false);
});

test("an unattended run refuses what nobody can approve, keeps its checklist, and reports as done", async (t) => {
	const model = await mockModel(t, [
		{ calls: [{ name: "bash", args: { command: "rm -rf /tmp/coderra-e2e-never-created" } }, set("clean up")] },
		{ text: "Could not delete; finished the rest." },
	]);
	const d = await startDaemon(t, {}, tempDir(t), usingMockModel(model.baseUrl));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });
	const chatSession = (await c.call("state")).sessionId;

	await c.call("run_enqueue", { prompt: "tidy up", dir: d.workspace, title: "tidy" });
	await waitFor("the run to finish", () => c.ofType("run_finished").length === 1);
	const run = c.ofType("run_finished")[0].run;
	assert.equal(run.status, "done");
	assert.match(run.summary, /finished the rest/);

	const [blocked, listed] = model.toolResults();
	assert.match(blocked, /Blocked: this command can delete data/i);
	assert.match(blocked, /unattended run and nobody can approve/);
	assert.match(listed, /Checklist set with 1 task/);

	// The checklist belongs to the run's own session, not to the open chat.
	const mine = c.ofType("tasks").at(-1)!;
	assert.notEqual(mine.sessionId, chatSession);
	assert.equal((await c.call("tasks_get")).items.length, 0, "the chat has no checklist of its own");
	assert.equal(c.ofType("approval").length, 0, "and nobody was asked");

	// The run's session file is a normal session that can be opened later.
	assert.ok(existsSync(run.sessionFile));
	assert.match(readFileSync(run.sessionFile, "utf8"), /"toolName":"tasks"/);
});
