import type { FetchLike } from '../primitives/types'

/*
 *   PROGRESS
 ***************************************************************************************************/
export interface UploadProgressEvent {
	readonly loaded: number
	/** `undefined` when the server did not report a length, so a percentage cannot be shown. */
	readonly total: number | undefined
	readonly percent: number | undefined
}

export interface XhrFetchOptions {
	/** Fires as the request body is sent, which `fetch` has no way to report. */
	onProgress?: (event: UploadProgressEvent) => void
}

/*
 *   HEADERS
 ***************************************************************************************************/
function toProgressEvent(
	loaded: number,
	total: number,
	lengthComputable: boolean
): UploadProgressEvent {
	return {
		loaded,
		total: lengthComputable ? total : undefined,
		percent: lengthComputable && total > 0 ? Math.round((loaded / total) * 100) : undefined,
	}
}

function parseRawHeaders(raw: string): Headers {
	const headers = new Headers()

	for (const line of raw.trim().split(/\r?\n/)) {
		if (line === '') {
			continue
		}

		const split = line.indexOf(':')

		if (split === -1) {
			continue
		}

		headers.append(line.slice(0, split).trim(), line.slice(split + 1).trim())
	}

	return headers
}

/*
 *   FETCH
 ***************************************************************************************************/
export function createXhrFetch(options: XhrFetchOptions = {}): FetchLike {
	return (input, init) =>
		new Promise<Response>((resolve, reject) => {
			const signal = init.signal

			// Aborting an XHR that was never sent fires no event at all, so an
			// already-cancelled signal has to reject directly rather than wait
			// for one.
			if (signal !== undefined && signal !== null && signal.aborted) {
				reject(new DOMException('The operation was aborted.', 'AbortError'))
				return
			}

			const xhr = new XMLHttpRequest()

			xhr.open(init.method ?? 'GET', input, true)
			xhr.responseType = 'blob'

			if (init.credentials === 'include') {
				xhr.withCredentials = true
			}

			if (init.headers !== undefined) {
				new Headers(init.headers).forEach((value, name) => {
					xhr.setRequestHeader(name, value)
				})
			}

			if (options.onProgress !== undefined) {
				const onProgress = options.onProgress

				xhr.upload.addEventListener('progress', event => {
					onProgress(toProgressEvent(event.loaded, event.total, event.lengthComputable))
				})
			}

			xhr.addEventListener('load', () => {
				resolve(
					new Response(xhr.response as Blob, {
						status: xhr.status,
						statusText: xhr.statusText,
						headers: parseRawHeaders(xhr.getAllResponseHeaders()),
					})
				)
			})

			xhr.addEventListener('error', () => {
				reject(new TypeError('Failed to fetch'))
			})

			xhr.addEventListener('timeout', () => {
				reject(new DOMException('The upload timed out.', 'TimeoutError'))
			})

			xhr.addEventListener('abort', () => {
				reject(new DOMException('The operation was aborted.', 'AbortError'))
			})

			if (signal !== undefined && signal !== null) {
				signal.addEventListener('abort', () => xhr.abort(), { once: true })
			}

			xhr.send(init.body as XMLHttpRequestBodyInit | null | undefined)
		})
}
