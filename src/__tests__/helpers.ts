import type { FetchLike } from '../primitives/types'

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
	resolve(response: Response): void
	reject(error: unknown): void
	aborted(): boolean
}

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

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

export function textResponse(body: string, contentType = 'text/plain'): Response {
	return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}
