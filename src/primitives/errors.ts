/*
 *   CODES
 ***************************************************************************************************/
/**
 * Closed set of failure modes, discriminating `ConduitError`.
 *
 * - `HTTP_ERROR`: the server answered with a failing status.
 * - `NETWORK`: the request never reached a server (DNS, offline, CORS, TLS).
 * - `TIMEOUT`: the request exceeded its own deadline.
 * - `ABORTED`: a caller, a scope, or a superseding request cancelled it.
 * - `PARSE`: a body arrived but could not be decoded as declared.
 * - `UNAUTHENTICATED`: the session is gone and cannot be recovered.
 * - `CONFIG`: conduit was set up wrong. Always a developer error.
 * - `UNKNOWN`: something threw that conduit cannot classify.
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

	/** Cross-realm brand. Two bundles carrying their own copy break `instanceof`. */
	public readonly conduitError = true as const

	public readonly code: ConduitErrorCode
	public readonly method: string | undefined
	public readonly url: string | undefined
	public readonly status: number | undefined
	/** The app or remote that issued the request, which the shared stack trace cannot say. */
	public readonly owner: string | undefined
	/** Kept off {@link ConduitError.toJSON}, with `body`. Both can carry user data. */
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
/** Coerces anything thrown into a `ConduitError`. Values that already are one pass through. */
export function toConduitError(value: unknown): ConduitError {
	if (isConduitError(value)) {
		return value
	}

	const message = value instanceof Error ? value.message : String(value)
	return new ConduitError({ code: 'UNKNOWN', message, cause: value })
}
