import { toConduitError } from '../primitives/errors'
import type { ConduitPromise, ConduitResponse, SafeResult } from '../primitives/types'

const swallow = (): void => {}

/*
 *   CONDUIT PROMISE
 ***************************************************************************************************/
export function conduitPromise<T>(run: Promise<ConduitResponse<T>>): ConduitPromise<T> {
	const promise = run.then(response => response.data) as ConduitPromise<T>

	promise.response = (): Promise<ConduitResponse<T>> => {
		promise.catch(swallow)
		return run
	}

	promise.safe = (): Promise<SafeResult<T>> => {
		promise.catch(swallow)

		return run.then(
			(response): SafeResult<T> => ({ data: response.data, error: null }),
			(error: unknown): SafeResult<T> => ({ data: null, error: toConduitError(error) })
		)
	}

	return promise
}
