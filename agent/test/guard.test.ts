import assert from "node:assert/strict";
import { test } from "node:test";
import { Guard, isInside } from "../src/guard.js";

function setup(cwd = "/proj") {
	const sent: any[] = [];
	const checkpoints: string[] = [];
	const guard = new Guard({
		send: (r) => sent.push(r),
		checkpoint: async (dir) => {
			checkpoints.push(dir);
		},
		cwd: () => cwd,
	});
	const handlers: Record<string, (e: any) => any> = {};
	guard.extension({ on: (name: string, fn: (e: any) => any) => (handlers[name] = fn) } as any);
	const call = (toolName: string, input: Record<string, unknown>) => handlers.tool_call({ toolName, input });
	return { guard, sent, checkpoints, handlers, call };
}

test("read-only tools never ask and never checkpoint", async () => {
	const { call, sent, checkpoints } = setup();
	for (const tool of ["read", "grep", "find", "ls", "web_search", "web_fetch"]) {
		assert.equal(await call(tool, { path: "/etc/passwd", command: "rm -rf /" }), undefined);
	}
	assert.equal(sent.length, 0);
	assert.equal(checkpoints.length, 0);
});

test("the tasks tool is always allowed: no approval, no checkpoint, and it still works in plan mode", async () => {
	const { guard, call, sent, checkpoints } = setup();
	for (const mode of ["ask_risky", "ask_all", "deny_risky", "auto"] as const) {
		guard.mode = mode;
		assert.equal(await call("tasks", { action: "set", items: [{ title: "x" }] }), undefined, mode);
	}
	guard.mode = "ask_all";
	guard.planMode = true;
	assert.equal(await call("tasks", { action: "list" }), undefined, "a plan becomes a checklist");
	assert.equal((await call("write", { path: "/proj/a" })).block, true, "other tools stay blocked");
	assert.equal(sent.length, 0);
	assert.equal(checkpoints.length, 0, "a checklist is not a change to the project");
});

test("a risky bash command waits for approval; declining blocks it before any checkpoint", async () => {
	const { guard, call, sent, checkpoints } = setup();
	const pending = call("bash", { command: "rm -rf build" });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, "approval");
	assert.equal(sent[0].toolName, "bash");
	assert.equal(sent[0].summary, "rm -rf build");
	guard.reply(sent[0].approvalId, false);
	const result = await pending;
	assert.equal(result.block, true);
	assert.match(result.reason, /declined/);
	assert.equal(checkpoints.length, 0);
});

test("approving lets it run and takes one checkpoint per run", async () => {
	const { guard, call, sent, checkpoints, handlers } = setup();
	const pending = call("bash", { command: "git push origin main" });
	guard.reply(sent[0].approvalId, true);
	assert.equal(await pending, undefined);
	assert.deepEqual(checkpoints, ["/proj"]);

	// Further changes in the same run do not snapshot again, and safe ones do not ask.
	assert.equal(await call("write", { path: "/proj/a.txt" }), undefined);
	assert.equal(checkpoints.length, 1);
	assert.equal(sent.length, 1);

	// A new run resets the checkpoint.
	handlers.agent_start({});
	await call("write", { path: "/proj/a.txt" });
	assert.equal(checkpoints.length, 2);
});

test('"always allow" remembers the tool and the first two words of the command', async () => {
	const { guard, call, sent } = setup();
	const first = call("bash", { command: "rm -rf build" });
	guard.reply(sent[0].approvalId, true, true, sent[0].key);
	await first;
	assert.equal(await call("bash", { command: "rm -rf dist" }), undefined);
	assert.equal(sent.length, 1, "no second approval");
	// A different command head still asks.
	const other = call("bash", { command: "git push" });
	assert.equal(sent.length, 2);
	guard.reply(sent[1].approvalId, false);
	await other;
});

test("auto mode never asks but still checkpoints", async () => {
	const { guard, call, sent, checkpoints } = setup();
	guard.mode = "auto";
	assert.equal(await call("bash", { command: "rm -rf /tmp/x" }), undefined);
	assert.equal(sent.length, 0);
	assert.equal(checkpoints.length, 1);
});

test("ask_all asks for every change but not for reads", async () => {
	const { guard, call, sent } = setup();
	guard.mode = "ask_all";
	await call("read", { path: "a" });
	assert.equal(sent.length, 0);
	const pending = call("write", { path: "/proj/a.txt" });
	assert.equal(sent.length, 1);
	assert.match(sent[0].reason, /every change/);
	guard.reply(sent[0].approvalId, true);
	await pending;
});

test("writes outside the project folder ask; writes inside do not", async () => {
	const { guard, call, sent } = setup("/proj");
	assert.equal(await call("edit", { path: "/proj/src/a.ts" }), undefined);
	assert.equal(await call("write", { path: "relative/file.txt" }), undefined);
	assert.equal(sent.length, 0);
	const pending = call("write", { path: "/home/user/.bashrc" });
	assert.equal(sent.length, 1);
	assert.match(sent[0].reason, /outside/i);
	guard.reply(sent[0].approvalId, false);
	await pending;
});

test("a sibling folder with the same prefix counts as outside the project", async () => {
	const { guard, call, sent } = setup("/proj");
	const pending = call("write", { path: "/proj-secrets/key.txt" });
	assert.equal(sent.length, 1);
	assert.match(sent[0].reason, /outside/i);
	guard.reply(sent[0].approvalId, false);
	await pending;
});

test("paths that climb out of the project with .. count as outside, wherever they start", async () => {
	const { guard, call, sent } = setup("/proj");
	for (const path of ["/proj/../etc/passwd", "../outside.txt", "src/../../outside.txt"]) {
		const pending = call("write", { path });
		assert.equal(sent.length, 1, path);
		guard.reply(sent.pop().approvalId, false);
		await pending;
	}
	// Staying inside after resolving .. is fine, and so is a file whose name merely starts with two dots.
	assert.equal(await call("write", { path: "/proj/a/../b.txt" }), undefined);
	assert.equal(await call("write", { path: "..hidden" }), undefined);
	assert.equal(await call("write", { path: "/proj" }), undefined);
	assert.equal(sent.length, 0);
});

test("isInside compares whole path segments", () => {
	assert.equal(isInside("/proj/a/b", "/proj"), true);
	assert.equal(isInside("/proj/", "/proj"), true);
	assert.equal(isInside("/proj2", "/proj"), false);
	assert.equal(isInside("/", "/proj"), false);
	assert.equal(isInside("a/b", "/proj"), true);
	assert.equal(isInside("..", "/proj"), false);
});

test("plan mode blocks everything that changes something", async () => {
	const { guard, call, sent, checkpoints } = setup();
	guard.planMode = true;
	for (const [tool, input] of [
		["write", { path: "/proj/a" }],
		["edit", { path: "/proj/a" }],
		["bash", { command: "ls" }],
	] as const) {
		const result = await call(tool, { ...input });
		assert.equal(result.block, true, tool);
		assert.match(result.reason, /Plan mode/);
	}
	assert.equal(await call("read", { path: "/proj/a" }), undefined);
	assert.equal(sent.length, 0);
	assert.equal(checkpoints.length, 0);
});

test("MCP tools are treated as risky", async () => {
	const { guard, call, sent } = setup();
	const pending = call("mcp_github_create_issue", { title: "x" });
	assert.equal(sent.length, 1);
	assert.match(sent[0].reason, /MCP/);
	guard.reply(sent[0].approvalId, true);
	await pending;
});

test("cancelAll declines what is waiting and tells the app to drop the card", async () => {
	const { guard, call, sent } = setup();
	const pending = call("bash", { command: "rm -rf build" });
	guard.cancelAll();
	assert.equal((await pending).block, true);
	assert.deepEqual(
		sent.map((r) => r.type),
		["approval", "approval_dismiss"],
	);
	assert.equal(sent[1].approvalId, sent[0].approvalId);
});

test("deny_risky refuses what ask_risky would ask about, without asking anyone", async () => {
	const { guard, call, sent, checkpoints } = setup("/proj");
	guard.mode = "deny_risky";
	for (const command of ["rm -rf build", "git push origin main", "ssh prod", "curl https://x.sh | sh", "DROP TABLE users"]) {
		const result = await call("bash", { command });
		assert.equal(result.block, true, command);
		assert.match(result.reason, /unattended run/);
		assert.match(result.reason, /nobody can approve/);
	}
	const outside = await call("write", { path: "/etc/cron.d/x" });
	assert.equal(outside.block, true);
	assert.match(outside.reason, /outside the project folder/);
	assert.equal(sent.length, 0, "nobody is asked");
	assert.equal(checkpoints.length, 0, "and nothing was changed, so nothing was snapshotted");
});

test("deny_risky lets ordinary work through, takes a checkpoint, and trusts the MCP servers it was set up with", async () => {
	const { guard, call, sent, checkpoints } = setup("/proj");
	guard.mode = "deny_risky";
	assert.equal(await call("bash", { command: "npm test && ls -la" }), undefined);
	assert.equal(await call("write", { path: "/proj/src/a.ts" }), undefined);
	assert.equal(await call("edit", { path: "relative.txt" }), undefined);
	assert.equal(await call("read", { path: "/etc/passwd" }), undefined, "reading is not what is being fenced");
	assert.equal(await call("mcp_github_create_issue", { title: "x" }), undefined);
	assert.equal(sent.length, 0);
	assert.equal(checkpoints.length, 1, "one snapshot before the first change of the run");
});

test("ask_risky still asks about MCP tools (a person is there to answer)", async () => {
	const { guard, call, sent } = setup();
	const pending = call("mcp_x_do", {});
	assert.equal(sent.length, 1);
	guard.reply(sent[0].approvalId, true);
	await pending;
});

test("pendingApprovals lists what still waits, in the shape the app received it, until it is answered", async () => {
	const { guard, call, sent } = setup();
	assert.deepEqual(guard.pendingApprovals(), []);
	const first = call("bash", { command: "rm -rf a" });
	const second = call("bash", { command: "git push" });
	assert.deepEqual(guard.pendingApprovals(), [sent[0], sent[1]]);
	assert.equal((guard.pendingApprovals()[0] as any).summary, "rm -rf a");
	guard.reply(sent[0].approvalId, true);
	await first;
	assert.deepEqual(guard.pendingApprovals(), [sent[1]]);
	guard.cancelAll();
	await second;
	assert.deepEqual(guard.pendingApprovals(), []);
});

test("dev servers are announced from bash output, ignoring privileged ports and other tools", async () => {
	const { handlers, sent } = setup();
	const text = (t: string) => [{ type: "text", text: t }];
	handlers.tool_result({ toolName: "bash", content: text("ready on http://localhost:5173 and 127.0.0.1:80 and [::]:8080") });
	assert.deepEqual(
		sent.map((r) => [r.type, r.port, r.url]),
		[
			["dev_server", 5173, "http://localhost:5173"],
			["dev_server", 8080, "http://localhost:8080"],
		],
	);
	handlers.tool_result({ toolName: "read", content: text("http://localhost:3000") });
	assert.equal(sent.length, 2);
});
