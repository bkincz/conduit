import { toConduitError } from '../primitives/errors'
import type { ConduitPromise, ConduitResponse, SafeResult } from '../primitives/types'

const swallow = (): void => {}

/*
 *   CONDUIT PROMISE
 ***************************************************************************************************/
/**
 * The decoded body by default, the full response, or a non-throwing result. A
 * real promise with two methods attached, not a thenable imitation.
 */
export function conduitPromise<T>(run: Promise<ConduitResponse<T>>): ConduitPromise<T> {
	const promise = run.then(response => response.data) as ConduitPromise<T>

	promise.response = (): Promise<ConduitResponse<T>> => run

	promise.safe = (): Promise<SafeResult<T>> =>
		run.then(
			(response): SafeResult<T> => ({ data: response.data, error: null }),
			(error: unknown): SafeResult<T> => ({ data: null, error: toConduitError(error) })
		)

	promise.catch(swallow)

	return promise
}
