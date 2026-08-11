import { ConduitError, isConduitError } from './errors'
import type { ConduitRequest } from './types'

/*
 *   ABORT
 ***************************************************************************************************/
/**
 * Turns whatever cancelled a request into a `ConduitError` that says who did it.
 *
 * A scope, a timeout and a superseding request all set a `ConduitError` as the
 * abort reason precisely so it survives to the caller — replacing it with a
 * generic "aborted" would throw away the only useful part. Anything else (a
 * caller's own `AbortController`, a `DOMException`) gets wrapped.
 */
export function toAbortError(request: ConduitRequest, cause?: unknown): ConduitError {
	const reason = request.signal.reason

	if (isConduitError(reason)) {
		return reason
	}

	return new ConduitError({
		code: 'ABORTED',
		message: `${request.method} ${request.url} was aborted.`,
		method: request.method,
		url: request.url,
		owner: request.owner,
		cause: cause ?? reason,
	})
}
