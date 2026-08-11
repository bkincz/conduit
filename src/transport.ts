import { toAbortError } from './abort'
import { ConduitError, isConduitError } from './errors'
import type {
	ConduitRequest,
	ConduitResponse,
	Next,
	ParseMode,
	ResolvedClientConfig,
} from './types'

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
 * Reads the body.
 *
 * `tolerant` is for error responses, where the body is supporting evidence
 * rather than the result. A gateway that returns 503 with an HTML page under a
 * JSON content type is routine, and reporting that as a parse failure would
 * throw away the status the caller actually needs.
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
				// A 200 with an empty body is common enough that treating it as a
				// parse failure would be hostile.
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
	// An abort reason set by a scope, a timeout or a supersede is already a
	// ConduitError explaining who cancelled and why; passing it through beats
	// replacing it with a generic "aborted".
	if (request.signal.aborted && isConduitError(request.signal.reason)) {
		return request.signal.reason
	}

	// A custom transport that threw a ConduitError has already classified the
	// failure — a mock server saying "no route matched", say. Rewriting that as a
	// network error would bury the one message that explains what went wrong.
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

		// Status first. What the server said outranks whether its body parsed:
		// a caller branching on 503, and the retry plugin deciding whether to
		// replay, both need the status more than they need the payload.
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
