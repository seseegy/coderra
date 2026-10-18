import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { all, connect, mockModel, startDaemon, usingMockModel, usingMockModels, usingSettings, waitFor } from "./host_helpers.js";
import { tempDir } from "./helpers.js";

// Sub-agents against the real host and real pi, with a pretend model that is asked first by the parent, then by the
// child (the parent waits), then by the parent again with the child's report.

const sub = (args: object) => ({ name: "subagent", args });
const toolNames = (req: { body: any }) => (req.body.tools ?? []).map((t: any) => t.function.name).sort();
const lastToolResult = (req: { body: any }) => JSON.stringify(req.body.messages.filter((m: any) => m.role === "tool").at(-1));

async function chat(t: TestContext, script: Parameters<typeof mockModel>[1], env: Record<string, string> = {}, ids?: string[]) {
	const model = await mockModel(t, script);
	const d = await startDaemon(t, env, tempDir(t), all(ids ? usingMockModels(model.baseUrl, ids) : usingMockModel(model.baseUrl), usingSettings({ retry: { enabled: false } })));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });
	return { model, d, c };
}

function sessionFiles(agentDir: string): string[] {
	const root = join(agentDir, "sessions");
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
		.map((e) => join(e.parentPath, e.name));
}

test("an explorer reads for the parent, with only read tools, and the parent gets its report", async (t) => {
	const { model, d, c } = await chat(t, [
		{ calls: [sub({ task: "What is in notes.txt?", title: "Read notes" })] }, // parent
		{ calls: [{ name: "read", args: { path: "notes.txt" } }] }, // child
		{ text: "The answer is 42 (notes.txt:1)." }, // child's report
		{ text: "The sub-agent says 42." }, // parent, after the report
	]);
	writeFileSync(join(d.workspace, "notes.txt"), "answer=42\n");
	await c.call("prompt", { text: "ask a helper to read the notes" });
	await waitFor("the parent to finish", () => c.settled() >= 1);

	assert.equal(model.requests.length, 4);
	assert.ok(toolNames(model.requests[0]).includes("subagent") && toolNames(model.requests[0]).includes("tasks"), "the parent can start sub-agents");
	assert.deepEqual(toolNames(model.requests[1]), ["find", "grep", "ls", "read", "web_fetch", "web_search"], "an explorer can only read");
	const told = JSON.stringify(model.requests[1].body.messages.filter((m: any) => m.role === "user"));
	assert.match(told, /What is in notes\.txt\?/);
	assert.doesNotMatch(told, /ask a helper to read the notes/, "it sees nothing of the parent's conversation");
	assert.match(lastToolResult(model.requests[3]), /The answer is 42 \(notes\.txt:1\)\./);
	assert.match(lastToolResult(model.requests[3]), /\[Sub-agent explorer \\"Read notes\\": 1 tool call/);

	// The app saw it working, and the child's conversation is kept under a recognisable name.
	assert.ok(JSON.stringify(c.events()).includes("read notes.txt"), "a progress line reached the app");
	const files = sessionFiles(d.agentDir);
	assert.equal(files.length, 2, "parent and child");
	assert.ok(files.some((f) => readFileSync(f, "utf8").includes("↳ Read notes")));
	assert.deepEqual((await c.call("health")).runs, { running: 0, queued: 0 });
});

test("a worker can change files, is held to the unattended rules, and cannot start sub-agents of its own", async (t) => {
	const { model, d, c } = await chat(t, [
		{ calls: [sub({ task: "Create out.txt containing hi. Then try to delete everything in /tmp/x.", role: "worker", title: "Make file" })] },
		{ calls: [{ name: "write", args: { path: "out.txt", content: "hi\n" } }] },
		{ calls: [{ name: "bash", args: { command: "rm -rf /tmp/coderra-never-existed" } }] },
		{ text: "Created out.txt. The delete was refused." },
		{ text: "Done." },
	]);
	await c.call("prompt", { text: "delegate" });
	await waitFor("the parent to finish", () => c.settled() >= 1);

	assert.equal(readFileSync(join(d.workspace, "out.txt"), "utf8"), "hi\n");
	const names = toolNames(model.requests[1]);
	for (const wanted of ["bash", "edit", "write", "read"]) assert.ok(names.includes(wanted), wanted);
	for (const refused of ["subagent", "tasks"]) assert.ok(!names.includes(refused), `a worker has no ${refused}`);
	assert.match(lastToolResult(model.requests[3]), /Blocked: .*unattended run/s, "its own risky command was refused, not asked about");
	assert.deepEqual(c.ofType("approval"), [], "nobody was asked");
});

test("plan mode lets an explorer through and keeps a worker out", async (t) => {
	const { model, c } = await chat(t, [
		{ calls: [sub({ task: "look", role: "worker" })] },
		{ text: "I will only plan." },
		{ calls: [sub({ task: "look around", title: "Look" })] },
		{ text: "nothing to report" },
		{ text: "ok" },
	]);
	await c.call("plan_mode", { on: true });
	await c.call("prompt", { text: "go" });
	await waitFor("the first answer", () => c.settled() >= 1);
	assert.match(lastToolResult(model.requests[1]), /Plan mode is on/);
	assert.equal(model.requests.length, 2, "no child was started");

	await c.call("prompt", { text: "go on" });
	await waitFor("the second answer", () => c.settled() >= 2);
	assert.equal(model.requests.length, 5, "this time a child ran");
	assert.match(lastToolResult(model.requests[4]), /nothing to report/);
});

test("another model can be named for the child, and an unknown one is an error the parent can read", async (t) => {
	const { model, c } = await chat(
		t,
		[
			{ calls: [sub({ task: "x", model: "mock/mock-2" })] },
			{ text: "from the cheaper model" },
			{ text: "parent done" },
			{ calls: [sub({ task: "x", model: "mock/nope" })] },
			{ text: "parent saw the error" },
		],
		{},
		["mock-1", "mock-2"],
	);
	await c.call("prompt", { text: "one" });
	await waitFor("the first", () => c.settled() >= 1);
	assert.deepEqual(model.requests.slice(0, 3).map((r) => r.body.model), ["mock-1", "mock-2", "mock-1"]);

	await c.call("prompt", { text: "two" });
	await waitFor("the second", () => c.settled() >= 2);
	assert.match(lastToolResult(model.requests[4]), /Unknown model \\"mock\/nope\\"/);
});

test("stopping the parent stops the child, and the next sub-agent can start", async (t) => {
	const { model, c } = await chat(t, [
		{ calls: [sub({ task: "slow" })] },
		{ delayMs: 4000, text: "never arrives" }, // the child's model is slow
		{ calls: [sub({ task: "again" })] },
		{ text: "second child report" },
		{ text: "all good" },
	]);
	await c.call("prompt", { text: "start" });
	await waitFor("the child to be asking the model", () => model.requests.length >= 2);
	await c.call("abort");
	await waitFor("the parent to settle", () => c.settled() >= 1, 10_000);

	await c.call("prompt", { text: "again" });
	await waitFor("the second job", () => c.settled() >= 2, 15_000);
	assert.match(lastToolResult(model.requests.at(-1)!), /second child report|all good|slow/);
	const h = await c.call("health");
	assert.equal(h.runs.running, 0);
});

test("an unattended long task can delegate too, and the child still has no sub-agent tool", async (t) => {
	const { model, d, c } = await chat(t, [
		{ calls: [{ name: "tasks", args: { action: "set", items: [{ title: "research" }] } }, sub({ task: "find the answer", title: "Research" })] },
		{ text: "The answer is 7." },
		{ calls: [{ name: "tasks", args: { action: "update", id: "t1", status: "done" } }] },
		{ text: "Finished." },
	]);
	await c.call("run_enqueue", { prompt: "long job with a helper", dir: d.workspace, task: { maxIterations: 4 } });
	await waitFor("the run to end", () => c.ofType("run_finished").length > 0);
	const run = c.ofType("run_finished")[0].run;
	assert.deepEqual([run.status, run.iteration], ["done", 1]);
	assert.ok(toolNames(model.requests[0]).includes("subagent"), "unattended runs may delegate too");
	assert.deepEqual(toolNames(model.requests[1]).filter((n) => n === "subagent"), []);
});
