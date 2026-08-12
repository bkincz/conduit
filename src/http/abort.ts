import { ConduitError, isConduitError } from '../primitives/errors'
import type { ConduitRequest } from '../primitives/types'

/*
 *   ABORT
 ***************************************************************************************************/
/**
 * Turns whatever cancelled a request into a `ConduitError`. A reason that is
 * already one is passed through, since it names who did it.
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
