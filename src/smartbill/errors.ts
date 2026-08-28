/**
 * Typed SmartBill errors. Every non-2xx and every `code != 0` API response is
 * surfaced as a typed error so the MCP layer (and Hermes skill) can react to
 * specific failure classes instead of a generic failure string.
 */

export class SmartBillError extends Error {
	constructor(
		public readonly status: number,
		public readonly rawBody: string,
		public readonly errorText?: string,
	) {
		super(errorText || `SmartBill API error (${status})`);
		this.name = "SmartBillError";
	}
}

/** 401 — invalid email/token. */
export class SmartBillAuthError extends SmartBillError {
	constructor(rawBody: string, errorText?: string) {
		super(401, rawBody, errorText || "SmartBill authentication failed (invalid email or token)");
		this.name = "SmartBillAuthError";
	}
}

/** 429 — rate-limit block. `retryAfter` (seconds) is used when present. */
export class SmartBillRateLimit extends SmartBillError {
	constructor(
		rawBody: string,
		public readonly retryAfter?: number,
		errorText?: string,
	) {
		super(429, rawBody, errorText || "SmartBill rate-limit block");
		this.name = "SmartBillRateLimit";
	}
}

/** 400 / 406 — validation error, or an API-level `code != 0`. */
export class SmartBillValidation extends SmartBillError {
	constructor(status: number, rawBody: string, errorText?: string) {
		super(status, rawBody, errorText || "SmartBill validation error");
		this.name = "SmartBillValidation";
	}
}

/** 5xx — server error, or a non-JSON body (e.g. HTML error page). */
export class SmartBillServerError extends SmartBillError {
	constructor(status: number, rawBody: string, errorText?: string) {
		super(status, rawBody, errorText || `SmartBill server error (${status})`);
		this.name = "SmartBillServerError";
	}
}

/**
 * Map an HTTP status to a typed error. `retryAfterHeader` only applies to 429.
 * If the body is non-JSON/HTML, surfaces a SmartBillServerError.
 */
export function smbErrorFromResponse(status: number, rawBody: string, retryAfterHeader?: string): SmartBillError {
	const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;
	// Try to pull `{ code, message }` for errorText.
	let errorText: string | undefined;
	try {
		const parsed = JSON.parse(rawBody) as { code?: number; message?: string; errorText?: string };
		errorText = parsed.message || parsed.errorText;
	} catch {
		errorText = rawBody.slice(0, 300);
	}

	if (status === 401) return new SmartBillAuthError(rawBody, errorText);
	if (status === 429) return new SmartBillRateLimit(rawBody, Number.isFinite(retryAfter) ? retryAfter : undefined, errorText);
	if (status >= 400 && status < 500) return new SmartBillValidation(status, rawBody, errorText);
	return new SmartBillServerError(status, rawBody, errorText);
}

/** Narrow a parsed JSON body to an object, or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
