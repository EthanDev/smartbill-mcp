import { SmartBillRateLimit } from "./errors";

/**
 * V1 429 backoff ladder in seconds. V1 = 30 calls/10s then a HARD 10-minute block.
 * maxRetries 8 covers the FULL ladder so a real 10-minute block is actually waited out.
 */
export const RATE_LIMIT_BACKOFF = [5, 10, 20, 40, 80, 160, 300, 600] as const;
export const MAX_RETRIES = RATE_LIMIT_BACKOFF.length;

/** Sleep helper (accepts fractional seconds -> ms). */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
	/** Override the ladder (mainly for tests). */
	backoff?: readonly number[];
	maxRetries?: number;
	/** Inject for tests. */
	sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Run `fn`, retrying on a 429 per the penalty ladder. When the upstream returns a
 * `Retry-After` header we wait `max(Retry-After, ladder[i])`. If a 429 persists past
 * the final retry, throw a SmartBillRateLimit with an explicit ~10-min message.
 */
export async function withRateLimit<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
	const backoff = opts.backoff ?? RATE_LIMIT_BACKOFF;
	const maxRetries = opts.maxRetries ?? MAX_RETRIES;
	const sched = opts.sleepFn ?? sleep;

	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (!(error instanceof SmartBillRateLimit)) throw error;
			if (attempt >= maxRetries) {
				throw new SmartBillRateLimit(
					error.rawBody,
					error.retryAfter,
					`SmartBill rate-limit block (~10 min) — retry after ${Math.max(error.retryAfter ?? 0, backoff[backoff.length - 1] ?? 0)}s`,
				);
			}
			const ladderDelay = backoff[attempt] ?? backoff[backoff.length - 1] ?? 5;
			const waitMs = Math.max(error.retryAfter ?? 0, ladderDelay) * 1000;
			await sched(waitMs);
		}
	}
}

/**
 * Batch read-tool rate limiting: space V1 read calls >= `minSpacingMs` apart and
 * never exceed 25 V1 calls in a 10s window. `lastCallAt` tracks the previous call.
 */
export async function withReadThrottle<T>(fn: () => Promise<T>, lastCallAt: { time: number }): Promise<T> {
	const minSpacingMs = 1000;
	const now = Date.now();
	const wait = Math.max(0, lastCallAt.time + minSpacingMs - now);
	if (wait > 0) await sleep(wait);
	try {
		return await fn();
	} finally {
		lastCallAt.time = Date.now();
	}
}
