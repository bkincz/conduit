/*
 *   ENCODE
 ***************************************************************************************************/
export interface EncodedBody {
	readonly body: BodyInit | null
	/** Set only when conduit chose the encoding; a caller-supplied body keeps whatever it declares. */
	readonly contentType: string | undefined
}

const EMPTY: EncodedBody = { body: null, contentType: undefined }

function isBodyInit(value: unknown): value is BodyInit {
	return (
		(typeof Blob !== 'undefined' && value instanceof Blob) ||
		(typeof FormData !== 'undefined' && value instanceof FormData) ||
		(typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) ||
		(typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) ||
		(typeof ReadableStream !== 'undefined' && value instanceof ReadableStream) ||
		ArrayBuffer.isView(value)
	)
}

/**
 * Turns whatever a caller passed into something `fetch` accepts.
 *
 * Anything the platform already understands goes through untouched — pass a
 * `FormData` and conduit stays out of the way. Everything else is JSON, which
 * is the case worth making ergonomic.
 */
export function encodeBody(value: unknown): EncodedBody {
	if (value === undefined || value === null) {
		return EMPTY
	}

	if (typeof value === 'string') {
		return { body: value, contentType: undefined }
	}

	if (typeof value === 'object' && isBodyInit(value)) {
		return { body: value, contentType: undefined }
	}

	return { body: JSON.stringify(value), contentType: 'application/json' }
}
