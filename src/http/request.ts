import { deriveKey } from './keys'
import type { ConduitRequest, RequestPatch } from '../primitives/types'

/*
 *   CREATE
 ***************************************************************************************************/
export interface RequestRecordInit extends Omit<ConduitRequest, 'headers'> {
	/** Called at most once, the first time a middleware actually reads `headers`. */
	buildHeaders(): Headers
}

/**
 * Materialises the request record every middleware sees. `headers` is a
 * memoised getter, since cache and dedupe answer from `key` alone.
 */
export function createRequest(init: RequestRecordInit): ConduitRequest {
	let headers: Headers | undefined

	return {
		url: init.url,
		method: init.method,
		body: init.body,
		signal: init.signal,
		key: init.key,
		variance: init.variance,
		lane: init.lane,
		owner: init.owner,
		tags: init.tags,
		parse: init.parse,
		credentials: init.credentials,
		meta: init.meta,
		get headers(): Headers {
			headers ??= init.buildHeaders()
			return headers
		},
	}
}

/*
 *   PATCH
 ***************************************************************************************************/
/**
 * A copy with the given fields replaced. Rewriting what a request is re-derives
 * what it is identified by, unless the patch names a key itself.
 */
export function withRequest(request: ConduitRequest, patch: RequestPatch): ConduitRequest {
	const next = { ...request, ...patch }

	if (
		patch.key === undefined &&
		(patch.url !== undefined ||
			patch.method !== undefined ||
			patch.body !== undefined ||
			patch.variance !== undefined ||
			patch.parse !== undefined)
	) {
		return { ...next, key: deriveKey(next) }
	}

	return next
}
