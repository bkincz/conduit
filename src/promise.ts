import { toConduitError } from './errors'
import type { ConduitPromise, ConduitResponse, SafeResult } from './types'

const swallow = (): void => {}

/*
 *   CONDUIT PROMISE
 ***************************************************************************************************/
/**
 * Wraps the pipeline's result in the three shapes a call site might want: the
 * decoded body by default, the full response, or a non-throwing result.
 *
 * This is a real promise with two methods attached, not a thenable imitation,
 * so `Promise.all`, `await` and `.finally` all behave normally.
 */
export function conduitPromise<T>(run: Promise<ConduitResponse<T>>): ConduitPromise<T> {
	const promise = run.then(response => response.data) as ConduitPromise<T>

	promise.response = (): Promise<ConduitResponse<T>> => run

	promise.safe = (): Promise<SafeResult<T>> =>
		run.then(
			(response): SafeResult<T> => ({ data: response.data, error: null }),
			(error: unknown): SafeResult<T> => ({ data: null, error: toConduitError(error) })
		)

	// A caller using only .safe() or .response() never attaches a handler to the
	// body promise, which would surface a handled failure as an unhandled
	// rejection. Attaching one here marks it handled; awaiting it still throws.
	promise.catch(swallow)

	return promise
}
