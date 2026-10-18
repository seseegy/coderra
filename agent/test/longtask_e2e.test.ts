import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CONTINUE_AFTER_ERROR } from "../src/retry.js";
import { RESUME_PROMPT } from "../src/longtask.js";
import { all, connect, mockModel, startDaemon, usingMockModel, usingMockModels, usingSettings, waitFor } from "./host_helpers.js";
import { tempDir } from "./helpers.js";

// Jobs that run for hours, against the real host and real pi with a pretend model: kept going until done, stopped when
// stuck, waiting out a model that is down, and picked up again after the host is killed.

const set = (...titles: string[]) => ({ name: "tasks", args: { action: "set", items: titles.map((title) => ({ title })) } });
const update = (id: string, status: string, note?: string) => ({ name: "tasks", args: { action: "update", id, status, ...(note ? { note } : {}) } });
const lastUser = (req: { body: any }) => JSON.stringify(req.body.messages.filter((m: any) => m.role === "user").at(-1));

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
type Client = Awaited<ReturnType<typeof connect>>;

async function session(t: TestContext, model: Awaited<ReturnType<typeof mockModel>>, env: Record<string, string> = {}, extra: Parameters<typeof all>[number][] = []) {
	const home = tempDir(t);
	const d = await startDaemon(t, env, home, all(usingMockModel(model.baseUrl), usingSettings({ retry: { enabled: false } }), ...extra));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });
	return { d, c, home };
}

async function finishedRun(c: Client, ms = 30_000) {
	await waitFor("the run to end", () => c.ofType("run_finished").length > 0, ms);
	return c.ofType("run_finished")[0].run;
}

test("a long task is kept at until its checklist is complete", async (t) => {
	const model = await mockModel(t, [
		{ calls: [set("write the code", "test it")] },
		{ text: "Plan written." },
		{ calls: [update("t1", "done"), update("t2", "done")] },
		{ text: "Everything is finished." },
	]);
	const { d, c } = await session(t, model);
	await c.call("run_enqueue", { prompt: "build the thing", dir: d.workspace, title: "Build", task: { maxIterations: 6 } });
	const run = await finishedRun(c);

	assert.deepEqual([run.status, run.iteration, run.title], ["done", 2, "Build"]);
	assert.match(run.reason, /Everything the job required is done/);
	assert.equal(model.requests.length, 4);
	assert.match(lastUser(model.requests[0]), /build the thing/);
	assert.match(lastUser(model.requests[0]), /\[Unattended task\] Nobody is watching/);
	assert.match(lastUser(model.requests[2]), /Keep going with the job\.\\nStill open:\\n- t1 \[todo\] write the code\\n- t2 \[todo\] test it/);
	assert.ok(c.ofType("runs").some((r) => r.runs[0]?.iteration === 1), "the app saw the first round");
});

test("a long task that gets nowhere is stopped as blocked instead of going round forever", async (t) => {
	const model = await mockModel(t, [{ text: "I had a look around." }, { text: "Still thinking." }, { text: "Thinking more." }, { text: "never reached" }]);
	const { d, c } = await session(t, model);
	await c.call("run_enqueue", { prompt: "do something vague", dir: d.workspace, task: { noProgressLimit: 2 } });
	const run = await finishedRun(c);
	assert.deepEqual([run.status, run.iteration], ["blocked", 3]);
	assert.match(run.reason, /No progress in the last 2 rounds/);
	assert.equal(model.requests.length, 3, "and it did not ask the model a fourth time");
});

test("a long task can be judged by a command, and the command's output is what the agent is told", async (t) => {
	const model = await mockModel(t, [
		{ text: "I think it is done." },
		{ calls: [{ name: "write", args: { path: "done.txt", content: "yes" } }] },
		{ text: "Wrote it." },
	]);
	const { d, c } = await session(t, model);
	await c.call("run_enqueue", { prompt: "make done.txt", dir: d.workspace, task: { doneWhen: ["command"], command: "test -f done.txt && echo found || (echo 'done.txt is missing'; exit 3)" } });
	const run = await finishedRun(c);
	assert.deepEqual([run.status, run.iteration], ["done", 2]);
	assert.ok(existsSync(join(d.workspace, "done.txt")), "an unattended run may write inside its project");
	const second = lastUser(model.requests[1]);
	assert.match(second, /failed \(exit code 3\)/);
	assert.match(second, /done\.txt is missing/);
});

test("a long task invalid in its setup is refused straight away", async (t) => {
	const model = await mockModel(t);
	const { d, c } = await session(t, model);
	await assert.rejects(() => c.call("run_enqueue", { prompt: "x", dir: d.workspace, task: { doneWhen: ["command"] } }), /needs a command/);
	await assert.rejects(() => c.call("run_enqueue", { prompt: "x", dir: d.workspace, task: { maxIterations: 9999 } }), /maxIterations/);
	assert.deepEqual((await c.call("runs")).runs, []);
});

test("a long task survives the host being killed: it is picked up again from its own conversation and keeps counting", async (t) => {
	const sleeper = "sleep 17.31";
	t.after(() => void spawnSync("pkill", ["-f", sleeper]));
	const home = tempDir(t);
	const model = await mockModel(t, [
		{ calls: [{ name: "bash", args: { command: sleeper } }] },
		// After the restart:
		{ calls: [set("only task"), update("t1", "done")] },
		{ text: "Back, and finished." },
	]);
	const prepare = all(usingMockModel(model.baseUrl), usingSettings({ retry: { enabled: false } }));
	const first = await startDaemon(t, {}, home, prepare);
	const c1 = await connect(first.sock);
	await c1.call("set_model", { provider: "mock", model: "mock-1" });
	await c1.call("run_enqueue", { prompt: "long job", dir: first.workspace, task: { maxIterations: 10 } });
	await waitFor("the command to be running", () => spawnSync("pgrep", ["-f", sleeper]).status === 0, 20_000);

	// The power goes out.
	first.child.kill("SIGKILL");
	await first.exited;
	spawnSync("pkill", ["-f", sleeper]);
	c1.socket.destroy();

	const second = await startDaemon(t, {}, home);
	const c2 = await connect(second.sock);
	let run: any;
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		run = (await c2.call("runs")).runs[0];
		if (run && !["queued", "running"].includes(run.status)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.deepEqual([run.status, run.resumes, run.iteration], ["done", 1, 2]);

	// What the model was told after the restart: the same conversation, the interrupted command accounted for, and why.
	const after = model.requests[1].body.messages;
	assert.ok(after.some((m: any) => m.role === "user" && /long job/.test(JSON.stringify(m))), "it is the same conversation");
	const orphan = after.find((m: any) => m.role === "tool");
	assert.match(JSON.stringify(orphan), /No result provided/, "pi closed off the command that never finished");
	assert.ok(lastUser(model.requests[1]).includes(RESUME_PROMPT), "and it was told what happened");
	assert.equal(model.requests.length, 3);
});

test("waiting out a rate limit: the run pauses, asks the agent to carry on, and finishes", async (t) => {
	const model = await mockModel(t, [{ status: 429 }, { status: 429 }, { text: "Finally through." }]);
	const { d, c } = await session(t, model, { CODERRA_RETRY_BACKOFF_MS: "30,30" });
	await c.call("run_enqueue", { prompt: "do the work", dir: d.workspace });
	const run = await finishedRun(c);
	assert.equal(run.status, "done");
	assert.equal(run.summary, "Finally through.");
	assert.equal(model.requests.length, 3);
	assert.match(lastUser(model.requests[2]), new RegExp(CONTINUE_AFTER_ERROR.slice(0, 40)));
});

test("a run gives up after the allowed number of retries and reports the error", async (t) => {
	const model = await mockModel(t, [{ status: 503 }, { status: 503 }, { status: 503 }, { text: "too late" }]);
	const { d, c } = await session(t, model, { CODERRA_RETRY_BACKOFF_MS: "10", CODERRA_RETRY_MAX: "2" });
	await c.call("run_enqueue", { prompt: "x", dir: d.workspace });
	const run = await finishedRun(c);
	assert.equal(run.status, "error");
	assert.match(run.summary, /503|unavailable/i);
	assert.equal(model.requests.length, 3, "the first try and two retries");
});

test("while waiting out an outage the run moves on to the configured fallback model", async (t) => {
	const model = await mockModel(t, [{ status: 503 }, { text: "The second model answered." }]);
	const home = tempDir(t);
	const d = await startDaemon(t, { CODERRA_RETRY_BACKOFF_MS: "20" }, home, all(usingMockModels(model.baseUrl, ["mock-1", "mock-2"]), usingSettings({ retry: { enabled: false } })));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });
	await c.call("settings_set", { settings: { fallbackModels: [{ provider: "mock", model: "mock-2" }] } });
	await c.call("run_enqueue", { prompt: "x", dir: d.workspace });
	const run = await finishedRun(c);
	assert.equal(run.status, "done");
	assert.deepEqual(model.requests.map((r) => r.body.model), ["mock-1", "mock-2"]);
});

test("a chat that was cut off by the host dying says so, and can be continued", async (t) => {
	const sleeper = "sleep 17.32";
	t.after(() => void spawnSync("pkill", ["-f", sleeper]));
	const home = tempDir(t);
	const model = await mockModel(t, [{ calls: [{ name: "bash", args: { command: sleeper } }] }, { text: "Picked up where I was." }]);
	const prepare = all(usingMockModel(model.baseUrl), usingSettings({ retry: { enabled: false } }));
	const first = await startDaemon(t, {}, home, prepare);
	const c1 = await connect(first.sock);
	await c1.call("set_model", { provider: "mock", model: "mock-1" });
	assert.equal((await c1.call("state")).interrupted, false);
	await c1.call("prompt", { text: "run the long thing" });
	await waitFor("the command to be running", () => spawnSync("pgrep", ["-f", sleeper]).status === 0, 20_000);
	assert.equal((await c1.call("state")).interrupted, false, "still running is not interrupted");
	first.child.kill("SIGKILL");
	await first.exited;
	spawnSync("pkill", ["-f", sleeper]);
	c1.socket.destroy();

	const second = await startDaemon(t, {}, home);
	const c2 = await connect(second.sock);
	assert.equal((await c2.call("state")).interrupted, true);
	// The startup notice is in the buffer for anyone who asks for it.
	await c2.call("resume", { since: 0, epoch: c2.records[0].epoch });
	assert.ok(c2.ofType("notice").some((n) => /cut off before it finished/.test(n.message)));

	await c2.call("continue_session");
	await waitFor("the chat to carry on", () => c2.settled() >= 1);
	assert.equal((await c2.call("state")).interrupted, false);
	assert.match(lastUser(model.requests[1]), /cut off when the host restarted/);
});
