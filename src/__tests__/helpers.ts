import type { FetchLike } from '../types'

/*
 *   STUB FETCH
 ***************************************************************************************************/
export interface FetchCall {
	url: string
	init: RequestInit
}

export interface FetchStub {
	fetch: FetchLike
	calls: FetchCall[]
}

export function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchStub {
	const calls: FetchCall[] = []

	return {
		calls,
		fetch: (url, init) => {
			calls.push({ url, init })
			return Promise.resolve(handler({ url, init }))
		},
	}
}

/** A request that only settles when its signal aborts — stands in for a slow server. */
export function hangingFetch(): FetchStub {
	return stubFetch(
		({ init }) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener('abort', () => {
					const error = new Error('The operation was aborted.')
					error.name = 'AbortError'
					reject(error)
				})
			})
	)
}

export interface DeferredFetch {
	fetch: FetchLike
	calls: FetchCall[]
	/** Settles whichever request is currently outstanding. */
	resolve(response: Response): void
	reject(error: unknown): void
	/** Whether the underlying request was cancelled. */
	aborted(): boolean
}

/** A request the test settles by hand, so timing is explicit rather than raced. */
export function deferredFetch(): DeferredFetch {
	const calls: FetchCall[] = []
	let outstanding:
		{ resolve: (response: Response) => void; reject: (error: unknown) => void } | undefined

	return {
		calls,
		fetch: (url, init) => {
			calls.push({ url, init })

			return new Promise<Response>((resolve, reject) => {
				outstanding = { resolve, reject }

				init.signal?.addEventListener('abort', () => {
					const error = new Error('The operation was aborted.')
					error.name = 'AbortError'
					reject(error)
				})
			})
		},
		resolve: response => outstanding?.resolve(response),
		reject: error => outstanding?.reject(error),
		aborted: () => calls[0]?.init.signal?.aborted ?? false,
	}
}

/*
 *   RESPONSES
 ***************************************************************************************************/
export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

export function textResponse(body: string, contentType = 'text/plain'): Response {
	return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}
