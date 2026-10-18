/**
 * Waiting out a model that is not answering. pi already retries a failed request a few times with short pauses. For a
 * job that runs for hours that is not enough: a provider that is rate limiting or down for twenty minutes would fail
 * the whole job. This is the longer second layer for runs nobody is watching: wait, with growing pauses, and ask the
 * agent to carry on, switching to another model on the way if one is configured.
 */

/** Errors worth waiting out: limits, overload, outages, the network. Not a bad key or a refused request. */
export const TRANSIENT_ERROR = /rate|limit|quota|overload|429|5\d\d|unavailable|insufficient|credit|exceeded|timeout|timed out|network|fetch failed|ECONN|EAI_AGAIN|socket hang up/i;

export const DEFAULT_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000];

/** `60000,120000` from the environment, or the default. */
export function backoffFromEnv(value: string | undefined): number[] {
	const parsed = (value ?? "")
		.split(",")
		.filter((s) => s.trim() !== "")
		.map((s) => Number(s.trim()))
		.filter((n) => Number.isFinite(n) && n >= 0);
	return parsed.length ? parsed : DEFAULT_BACKOFF_MS;
}

export const CONTINUE_AFTER_ERROR = "Carry on from where you left off. The previous request failed with a temporary error, not because of anything you did.";

export interface RetryOptions {
	prompt: (text: string) => Promise<void>;
	/** The error the last prompt ended with, if its request failed. */
	error: () => string | undefined;
	clearError: () => void;
	/** Pauses between attempts; the last one repeats. */
	backoffMs: number[];
	maxRetries: number;
	isAborted: () => boolean;
	/** Resolves after the time, or at once when aborted. */
	sleep: (ms: number) => Promise<void>;
	/** Runs before each wait, e.g. to switch to a fallback model. */
	onRetry?: (info: { attempt: number; waitMs: number; error: string }) => Promise<void> | void;
	isTransient?: (error: string) => boolean;
}

/** Runs a prompt; if it fails with a temporary error, waits and continues, up to maxRetries times. Returns how many retries it took. */
export async function promptWithRetry(text: string, o: RetryOptions): Promise<number> {
	const transient = o.isTransient ?? ((e: string) => TRANSIENT_ERROR.test(e));
	let attempt = 0;
	let next = text;
	for (;;) {
		o.clearError();
		await o.prompt(next);
		const error = o.error();
		if (!error || !transient(error) || o.isAborted() || attempt >= o.maxRetries) return attempt;
		const waitMs = o.backoffMs[Math.min(attempt, o.backoffMs.length - 1)] ?? 0;
		attempt++;
		await o.onRetry?.({ attempt, waitMs, error });
		await o.sleep(waitMs);
		if (o.isAborted()) return attempt;
		next = CONTINUE_AFTER_ERROR;
	}
}

/** A sleep that ends early when told to. */
export function cancellableSleep() {
	let wake: (() => void) | undefined;
	return {
		sleep: (ms: number) =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(done, ms);
				function done() {
					clearTimeout(timer);
					wake = undefined;
					resolve();
				}
				wake = done;
			}),
		cancel: () => wake?.(),
	};
}
