import { deriveKey } from './keys'
import type { ConduitRequest, RequestPatch } from './types'

/*
 *   CREATE
 ***************************************************************************************************/
export interface RequestRecordInit extends Omit<ConduitRequest, 'headers'> {
	/** Called at most once, the first time a middleware actually reads `headers`. */
	buildHeaders(): Headers
}

/**
 * Materialises the request record every middleware sees.
 *
 * `headers` stays a memoised getter because the outermost layers — cache,
 * dedupe — answer from `key` alone. Building a `Headers` instance for a request
 * that never reaches the network is pure waste on the hot path.
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
 * Returns a copy with the given fields replaced.
 *
 * Rewriting what the request *is* re-derives what it is *identified by*, unless
 * the patch names a key itself. A routing middleware that sent `/orders` to one
 * shard or another while both kept the key `GET /orders` would have the cache
 * answer the second shard with the first shard's data.
 *
 * Reading `headers` here materialises them, which is the right trade: a
 * middleware rewriting the request is on the network path anyway.
 */
export function withRequest(request: ConduitRequest, patch: RequestPatch): ConduitRequest {
	const next = { ...request, ...patch }

	if (
		patch.key === undefined &&
		(patch.url !== undefined ||
			patch.method !== undefined ||
			patch.body !== undefined ||
			patch.variance !== undefined)
	) {
		return { ...next, key: deriveKey(next) }
	}

	return next
}
