/*
 *   CODES
 ***************************************************************************************************/
/**
 * Closed set of failure modes. `code` is the discriminant, so a `switch` over it
 * narrows exhaustively and adding a code becomes a compile error at every call
 * site that claimed to handle them all.
 *
 * - `HTTP_ERROR` — the server answered, with a status the client treats as failure.
 * - `NETWORK` — the request never reached a server (DNS, offline, CORS, TLS).
 * - `TIMEOUT` — the request exceeded its own deadline.
 * - `ABORTED` — a caller, a scope, or a superseding request cancelled it.
 * - `PARSE` — a response arrived but its body could not be decoded as declared.
 * - `UNAUTHENTICATED` — the session is gone and cannot be recovered here.
 * - `CONFIG` — conduit was set up wrong; always a developer error, never a runtime one.
 * - `UNKNOWN` — something threw that conduit cannot classify, usually from inside a plugin.
 */
export const ERROR_CODES = [
	'HTTP_ERROR',
	'NETWORK',
	'TIMEOUT',
	'ABORTED',
	'PARSE',
	'UNAUTHENTICATED',
	'CONFIG',
	'UNKNOWN',
] as const

export type ConduitErrorCode = (typeof ERROR_CODES)[number]

/*
 *   TYPES
 ***************************************************************************************************/
export interface ConduitErrorInit {
	code: ConduitErrorCode
	message: string
	method?: string
	url?: string
	status?: number
	/** Which app or remote issued the request. Absent when conduit cannot attribute it. */
	owner?: string | undefined
	/** Response headers, when there was a response. Carries `Retry-After` and rate-limit hints. */
	headers?: Headers | undefined
	/** Decoded response body, when the failure came from a response conduit could read. */
	body?: unknown
	cause?: unknown
}

/** Log-safe projection. Omits `body`, which routinely carries user data. */
export interface ConduitErrorJson {
	name: string
	code: ConduitErrorCode
	message: string
	method: string | undefined
	url: string | undefined
	status: number | undefined
	owner: string | undefined
}

/*
 *   ERROR
 ***************************************************************************************************/
export class ConduitError extends Error {
	public override readonly name: string = 'ConduitError'

	/**
	 * Cross-realm brand. Under module federation two bundles can each carry their
	 * own conduit copy, which gives them separate class identities and makes
	 * `instanceof` return false for a perfectly valid error. Check the brand
	 * instead — see {@link isConduitError}.
	 */
	public readonly conduitError = true as const

	public readonly code: ConduitErrorCode
	public readonly method: string | undefined
	public readonly url: string | undefined
	public readonly status: number | undefined
	/**
	 * The app or remote that issued the request. Under module federation this is
	 * usually the first question asked about a failure, and the stack trace
	 * cannot answer it — every remote runs in the same one.
	 */
	public readonly owner: string | undefined
	/** Kept off {@link toJSON}, along with `body` — both can be large and can carry user data. */
	public readonly headers: Headers | undefined
	public readonly body: unknown

	constructor(init: ConduitErrorInit) {
		super(init.message)

		this.code = init.code
		this.method = init.method
		this.url = init.url
		this.status = init.status
		this.owner = init.owner
		this.headers = init.headers
		this.body = init.body

		if (init.cause !== undefined) {
			this.cause = init.cause
		}
	}

	public toJSON(): ConduitErrorJson {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			method: this.method,
			url: this.url,
			status: this.status,
			owner: this.owner,
		}
	}
}

/*
 *   GUARDS
 ***************************************************************************************************/
/** Brand check rather than `instanceof`, so it holds across federation boundaries. */
export function isConduitError(value: unknown): value is ConduitError {
	return typeof value === 'object' && value !== null && 'conduitError' in value
}

/** Narrows to a specific failure mode. `isConduitError(e) && e.code === 'TIMEOUT'` in one call. */
export function isErrorCode<C extends ConduitErrorCode>(
	value: unknown,
	code: C
): value is ConduitError & { code: C } {
	return isConduitError(value) && value.code === code
}

/*
 *   NORMALISE
 ***************************************************************************************************/
/**
 * Coerces anything thrown into a `ConduitError`, so a caller never has to guess
 * whether a rejection carries conduit's shape. Values that already do are
 * returned untouched.
 */
export function toConduitError(value: unknown): ConduitError {
	if (isConduitError(value)) {
		return value
	}

	const message = value instanceof Error ? value.message : String(value)
	return new ConduitError({ code: 'UNKNOWN', message, cause: value })
}
