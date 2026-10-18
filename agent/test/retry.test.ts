import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffFromEnv, cancellableSleep, CONTINUE_AFTER_ERROR, DEFAULT_BACKOFF_MS, promptWithRetry, type RetryOptions, TRANSIENT_ERROR } from "../src/retry.js";

function harness(errors: (string | undefined)[], over: Partial<RetryOptions> = {}) {
	const prompts: string[] = [];
	const waits: number[] = [];
	const retries: { attempt: number; waitMs: number; error: string }[] = [];
	let error: string | undefined;
	const o: RetryOptions = {
		prompt: async (text) => {
			prompts.push(text);
			error = errors[prompts.length - 1];
		},
		error: () => error,
		clearError: () => void (error = undefined),
		backoffMs: [10, 20, 30],
		maxRetries: 5,
		isAborted: () => false,
		sleep: async (ms) => void waits.push(ms),
		onRetry: (r) => void retries.push(r),
		...over,
	};
	return { o, prompts, waits, retries };
}

test("a prompt that works is run once", async () => {
	const h = harness([undefined]);
	assert.equal(await promptWithRetry("do it", h.o), 0);
	assert.deepEqual([h.prompts, h.waits], [["do it"], []]);
});

test("a temporary error is waited out: growing pauses, then asking the agent to carry on", async () => {
	const h = harness(["429 rate limit", "503 overloaded", undefined]);
	assert.equal(await promptWithRetry("do it", h.o), 2);
	assert.deepEqual(h.prompts, ["do it", CONTINUE_AFTER_ERROR, CONTINUE_AFTER_ERROR]);
	assert.deepEqual(h.waits, [10, 20]);
	assert.deepEqual(h.retries.map((r) => [r.attempt, r.waitMs, r.error]), [[1, 10, "429 rate limit"], [2, 20, "503 overloaded"]]);
});

test("the last pause repeats, and it gives up after maxRetries leaving the error for the caller", async () => {
	const h = harness(Array(10).fill("503 unavailable"), { maxRetries: 4 });
	assert.equal(await promptWithRetry("x", h.o), 4);
	assert.deepEqual(h.waits, [10, 20, 30, 30]);
	assert.equal(h.o.error(), "503 unavailable");
	assert.equal(h.prompts.length, 5);
});

test("an error that waiting will not fix is not retried", async () => {
	for (const e of ["401 invalid api key", "400 bad request: unknown field", "model not found"]) {
		const h = harness([e]);
		assert.equal(await promptWithRetry("x", h.o), 0, e);
		assert.deepEqual(h.waits, []);
	}
});

test("stopping the job ends the waiting", async () => {
	let aborted = false;
	const h = harness(["429"], { isAborted: () => aborted, sleep: async () => void (aborted = true) });
	assert.equal(await promptWithRetry("x", h.o), 1);
	assert.equal(h.prompts.length, 1, "it did not ask again after being stopped");
});

test("what counts as temporary", () => {
	for (const e of ["429 Too Many Requests", "rate_limit_exceeded", "Overloaded", "502 Bad Gateway", "fetch failed", "ECONNRESET", "You exceeded your current quota", "insufficient credits", "Request timed out", "503 Service Unavailable", "socket hang up"]) {
		assert.ok(TRANSIENT_ERROR.test(e), e);
	}
	for (const e of ["401 Unauthorized", "invalid x-api-key", "400 messages: text content blocks must be non-empty"]) {
		assert.ok(!TRANSIENT_ERROR.test(e), e);
	}
});

test("the pauses can come from the environment", () => {
	assert.deepEqual(backoffFromEnv("100, 200,300"), [100, 200, 300]);
	assert.deepEqual(backoffFromEnv("x,,-5"), DEFAULT_BACKOFF_MS);
	assert.deepEqual(backoffFromEnv(undefined), DEFAULT_BACKOFF_MS);
	assert.equal(DEFAULT_BACKOFF_MS.at(-1), 30 * 60_000);
});

test("a sleep can be cut short", async () => {
	const s = cancellableSleep();
	const t0 = Date.now();
	const waiting = s.sleep(5000);
	setTimeout(() => s.cancel(), 20);
	await waiting;
	assert.ok(Date.now() - t0 < 1000);
	s.cancel(); // nothing to cancel: harmless
	const short = Date.now();
	await s.sleep(15);
	assert.ok(Date.now() - short >= 10);
});
