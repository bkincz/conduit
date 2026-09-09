import { stripQuery } from './url'
import { ConduitError, isConduitError } from '../primitives/errors'
import type { ConduitRequest } from '../primitives/types'

/*
 *   ABORT
 ***************************************************************************************************/
export function toAbortError(request: ConduitRequest, cause?: unknown): ConduitError {
	const reason = request.signal.reason

	if (isConduitError(reason)) {
		return new ConduitError({
			code: reason.code,
			message: reason.message,
			method: request.method,
			url: request.url,
			owner: request.owner,
			cause: cause ?? reason,
		})
	}

	return new ConduitError({
		code: 'ABORTED',
		message: `${request.method} ${stripQuery(request.url)} was aborted.`,
		method: request.method,
		url: request.url,
		owner: request.owner,
		cause: cause ?? reason,
	})
}
