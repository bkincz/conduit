import { toAbortError } from './abort'
import { ConduitError, isConduitError } from '../primitives/errors'
import type {
	ConduitRequest,
	ConduitResponse,
	Next,
	ParseMode,
	ResolvedClientConfig,
} from '../primitives/types'

/*
 *   DECODE
 ***************************************************************************************************/
const EMPTY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304])

function resolveMode(response: Response, mode: ParseMode): Exclude<ParseMode, 'auto'> {
	if (mode !== 'auto') {
		return mode
	}

	if (EMPTY_STATUSES.has(response.status)) {
		return 'none'
	}

	const contentType = response.headers.get('content-type') ?? ''

	if (contentType.includes('json')) {
		return 'json'
	}

	if (contentType.startsWith('text/') || contentType.includes('xml')) {
		return 'text'
	}

	return contentType === '' ? 'text' : 'blob'
}

/**
 * Reads the body. `tolerant` is for error responses, where a 503 carrying an
 * HTML page under a JSON content type must not become a parse failure and lose
 * the status.
 */
async function decode(
	response: Response,
	request: ConduitRequest,
	tolerant: boolean
): Promise<unknown> {
	const mode = resolveMode(response, request.parse)

	if (mode === 'none') {
		return null
	}

	try {
		switch (mode) {
			case 'json': {
				const text = await response.text()

				if (text === '') {
					return null
				}

				try {
					return JSON.parse(text) as unknown
				} catch (cause) {
					if (tolerant) {
						return text
					}

					throw cause
				}
			}
			case 'text':
				return await response.text()
			case 'blob':
				return await response.blob()
			case 'arrayBuffer':
				return await response.arrayBuffer()
			case 'formData':
				return await response.formData()
		}
	} catch (cause) {
		if (tolerant) {
			return undefined
		}

		throw new ConduitError({
			code: 'PARSE',
			message: `${request.method} ${request.url} returned a body that could not be read as ${mode}.`,
			method: request.method,
			url: request.url,
			owner: request.owner,
			status: response.status,
			cause,
		})
	}
}

/*
 *   FAILURE MAPPING
 ***************************************************************************************************/
function transportError(cause: unknown, request: ConduitRequest): ConduitError {
	if (request.signal.aborted && isConduitError(request.signal.reason)) {
		return request.signal.reason
	}

	if (isConduitError(cause)) {
		return cause
	}

	const name = cause instanceof Error ? cause.name : ''

	if (name === 'TimeoutError') {
		return new ConduitError({
			code: 'TIMEOUT',
			message: `${request.method} ${request.url} timed out.`,
			method: request.method,
			url: request.url,
			owner: request.owner,
			cause,
		})
	}

	if (name === 'AbortError' || request.signal.aborted) {
		return toAbortError(request, cause)
	}

	return new ConduitError({
		code: 'NETWORK',
		message: `${request.method} ${request.url} never reached a server. The network, DNS, CORS or TLS is at fault, not the response.`,
		method: request.method,
		url: request.url,
		owner: request.owner,
		cause,
	})
}

/*
 *   TRANSPORT
 ***************************************************************************************************/
/** The terminal handler: everything inside the onion ends here, at the network. */
export function createFetchTransport(config: ResolvedClientConfig): Next {
	return async (request: ConduitRequest): Promise<ConduitResponse> => {
		const init: RequestInit = {
			method: request.method,
			headers: request.headers,
			signal: request.signal,
		}

		if (request.body !== null) {
			init.body = request.body
		}

		if (request.credentials !== undefined) {
			init.credentials = request.credentials
		}

		let response: Response

		try {
			response = await config.fetch(request.url, init)
		} catch (cause) {
			throw transportError(cause, request)
		}

		if (!response.ok) {
			throw new ConduitError({
				code: 'HTTP_ERROR',
				message:
					`${request.method} ${request.url} failed with ${response.status} ${response.statusText}`.trimEnd(),
				method: request.method,
				url: request.url,
				owner: request.owner,
				status: response.status,
				headers: response.headers,
				body: await decode(response, request, true),
			})
		}

		const data = await decode(response, request, false)
		const attempt = request.meta['attempt']

		return {
			status: response.status,
			headers: response.headers,
			data,
			raw: response,
			from: 'network',
			attempt: typeof attempt === 'number' ? attempt : 1,
			request,
		}
	}
}
