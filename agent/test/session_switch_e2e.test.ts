import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { all, connect, mockModel, startDaemon, usingMockModel, usingSettings, waitFor } from "./host_helpers.js";
import { tempDir } from "./helpers.js";

// Switching chats ends the active session, and with it whatever it was doing. While the agent works, that has to be
// meant; Continue only ever picks up a chat that stopped before it finished, and only once.

async function busyChat(t: TestContext) {
	// The first answer takes a while, so the chat is still working when the test switches.
	const model = await mockModel(t, [{ text: "slow answer", delayMs: 20_000 }]);
	const d = await startDaemon(t, {}, tempDir(t), all(usingMockModel(model.baseUrl), usingSettings({ retry: { enabled: false } })));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });
	await c.call("prompt", { text: "take your time" });
	await waitFor("the model to be asked", () => model.requests.length === 1);
	assert.equal((await c.call("state")).isStreaming, true);
	return { model, d, c };
}

const isBusy = (e: any) => e.code === "busy" && /still working/.test(e.message);

test("switching away from a chat that is working is refused unless the app says it is meant", async (t) => {
	const { c, d } = await busyChat(t);
	const before = await c.call("state");

	await assert.rejects(() => c.call("new_session", { cwd: d.workspace }), isBusy);
	await assert.rejects(() => c.call("open_session", { path: `${d.workspace}/elsewhere.jsonl` }), isBusy);
	await assert.rejects(() => c.call("fork_session", {}), isBusy);
	const still = await c.call("state");
	assert.equal(still.sessionFile, before.sessionFile);
	assert.equal(still.isStreaming, true, "nothing was stopped");

	// Opening the chat that is already open changes nothing.
	const same = await c.call("open_session", { path: before.sessionFile });
	assert.equal(same.sessionFile, before.sessionFile);
	assert.equal(same.isStreaming, true);

	// Meant: the run is stopped first, then the new chat opens.
	const after = await c.call("new_session", { cwd: d.workspace, force: true });
	assert.notEqual(after.sessionFile, before.sessionFile);
	assert.equal(after.isStreaming, false);
});

test("Continue does nothing for a chat that did not stop half way", async (t) => {
	const model = await mockModel(t, [{ text: "done" }]);
	const d = await startDaemon(t, {}, tempDir(t), all(usingMockModel(model.baseUrl), usingSettings({ retry: { enabled: false } })));
	const c = await connect(d.sock);
	await c.call("set_model", { provider: "mock", model: "mock-1" });

	// A new chat has nothing to continue.
	await c.call("continue_session");
	await c.call("prompt", { text: "hi" });
	await waitFor("the answer", () => c.settled() >= 1);
	assert.equal(model.requests.length, 1, "the first Continue sent nothing");

	// A finished chat has nothing to continue either.
	const s = await c.call("continue_session");
	assert.equal(s.isStreaming, false);
	assert.equal(model.requests.length, 1);
});

test("Continue is refused while the agent works", async (t) => {
	const { c, model } = await busyChat(t);
	await assert.rejects(() => c.call("continue_session"), (e: any) => e.code === "busy");
	assert.equal(model.requests.length, 1);
});
