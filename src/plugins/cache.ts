import type { EventBus } from '../events'
import { protect } from '../freeze'
import { withRequest } from '../request'
import type {
	ConduitRequest,
	ConduitResponse,
	Middleware,
	Next,
	Plugin,
	ResponseSource,
} from '../types'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface CacheConfig {
	/** How long a stored response counts as fresh. Defaults to 30 seconds. */
	ttl?: number
	/**
	 * How long past `ttl` a stale response may still be served while a refresh
	 * runs behind it. `true` means indefinitely, `false` (the default) not at all.
	 */
	staleWhileRevalidate?: boolean | number
	/** Entry cap. Defaults to 200. The oldest read is evicted first. */
	max?: number
	/** Which requests are cacheable. Defaults to `GET` and `HEAD`. */
	shouldCache?: (request: ConduitRequest) => boolean
}

export interface CacheApi {
	/**
	 * Drops one entry by key, and suppresses any read of it already in flight.
	 * Returns whether a stored entry was removed — `false` still means an
	 * in-flight response for that key will not be stored.
	 */
	invalidate(key: string): boolean
	/** Drops every entry carrying a tag. Returns how many went. */
	invalidateTag(tag: string): number
	clearCache(): void
	cacheSize(): number
}

const CACHEABLE: ReadonlySet<string> = new Set(['GET', 'HEAD'])

const byMethod = (request: ConduitRequest): boolean => CACHEABLE.has(request.method)

/*
 *   ENTRY
 ***************************************************************************************************/
interface Entry {
	status: number
	headers: Headers
	data: unknown
	tags: readonly string[]
	freshUntil: number
	staleUntil: number
}

/**
 * Tags accumulate rather than being replaced.
 *
 * One key can be populated by several callers, and only some of them may know
 * it belongs to a tag group. If the last writer won, an untagged refetch would
 * silently unhook the entry from `invalidateTag` and the next invalidation
 * would quietly miss it. Over-invalidating is the safe direction.
 */
function mergeTags(
	previous: readonly string[] | undefined,
	next: readonly string[]
): readonly string[] {
	if (previous === undefined || previous.length === 0) {
		return next
	}

	if (next.length === 0) {
		return previous
	}

	const merged = new Set(previous)

	for (const tag of next) {
		merged.add(tag)
	}

	return merged.size === previous.length ? previous : [...merged]
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * A shared response cache.
 *
 * Outermost in the default stack, so a hit costs a map lookup and nothing else
 * — no headers built, no signals composed, no network. Because one client is
 * shared across bundles, a remote that mounts second reads what the first
 * already fetched.
 */
export function cache(config: CacheConfig = {}): Plugin<CacheApi> {
	const ttl = config.ttl ?? 30_000
	const max = config.max ?? 200
	const shouldCache = config.shouldCache ?? byMethod
	const staleWindow =
		config.staleWhileRevalidate === true
			? Number.POSITIVE_INFINITY
			: config.staleWhileRevalidate === false || config.staleWhileRevalidate === undefined
				? 0
				: config.staleWhileRevalidate

	const entries = new Map<string, Entry>()
	const revalidating = new Set<string>()

	/**
	 * Bumped by every invalidation. A read that started before the bump must not
	 * store what it fetched: it was answered by the server before the write that
	 * prompted the invalidation, so storing it would reinstate exactly the stale
	 * value the caller just asked to be rid of.
	 */
	let epoch = 0

	// Background refreshes outlive the caller that triggered them, so they run on
	// the plugin's own lifetime rather than that caller's signal.
	const lifetime = new AbortController()
	let events: EventBus | undefined

	const announce = (target: string, removed: number): number => {
		epoch++

		if (removed > 0 && events?.active === true) {
			events.emit('cache:invalidate', {
				type: 'cache:invalidate',
				target,
				removed,
				at: Date.now(),
			})
		}

		return removed
	}

	const read = (key: string): Entry | undefined => {
		const entry = entries.get(key)

		if (entry === undefined) {
			return undefined
		}

		// Re-insert to move it to the back: Map iterates in insertion order, which
		// makes the first key the least recently used without a second structure.
		entries.delete(key)
		entries.set(key, entry)

		return entry
	}

	const write = (request: ConduitRequest, response: ConduitResponse, since: number): void => {
		if (epoch !== since) {
			return
		}

		const now = Date.now()

		protect(response.data)

		entries.set(request.key, {
			status: response.status,
			headers: response.headers,
			data: response.data,
			tags: mergeTags(entries.get(request.key)?.tags, request.tags),
			freshUntil: now + ttl,
			staleUntil: now + ttl + staleWindow,
		})

		if (entries.size > max) {
			const oldest = entries.keys().next().value

			if (oldest !== undefined) {
				entries.delete(oldest)
			}
		}
	}

	const serve = (
		entry: Entry,
		request: ConduitRequest,
		from: ResponseSource
	): ConduitResponse => ({
		status: entry.status,
		headers: entry.headers,
		data: entry.data,
		raw: undefined,
		from,
		attempt: 1,
		request,
	})

	// A server saying "do not store this" outranks our own ttl.
	const storable = (response: ConduitResponse): boolean => {
		const control = response.headers.get('cache-control')

		return control === null || !/no-store|no-cache/i.test(control)
	}

	const refresh = (request: ConduitRequest, next: Next): boolean => {
		if (revalidating.has(request.key)) {
			return false
		}

		revalidating.add(request.key)

		const since = epoch
		// Detached from the triggering caller. Otherwise the remote that happened
		// to read the stale value kills the refresh when it unmounts, and with an
		// unbounded stale window the entry is pinned stale for every other remote
		// on the page — forever.
		const detached = withRequest(request, { signal: lifetime.signal })

		next(detached)
			.then(response => {
				if (storable(response)) {
					write(detached, response, since)
				}
			})
			// A failed background refresh is not the caller's problem: they already
			// have the stale value, and the next miss will surface the failure.
			.catch(() => {})
			.finally(() => {
				revalidating.delete(request.key)
			})

		return true
	}

	const middleware: Middleware = async (request, next) => {
		if (!shouldCache(request)) {
			return next(request)
		}

		const entry = read(request.key)
		const now = Date.now()

		if (entry !== undefined) {
			if (now < entry.freshUntil) {
				if (events?.active === true) {
					events.emit('cache:hit', {
						type: 'cache:hit',
						key: request.key,
						owner: request.owner,
						at: now,
					})
				}

				return serve(entry, request, 'cache')
			}

			if (now < entry.staleUntil) {
				const started = refresh(request, next)

				if (events?.active === true) {
					events.emit('cache:stale', {
						type: 'cache:stale',
						key: request.key,
						owner: request.owner,
						revalidating: started,
						at: now,
					})
				}

				return serve(entry, request, 'cache')
			}

			// Left in place rather than deleted: it is past its stale window so it
			// can never be served, but it still carries the tags this key was
			// registered under, and `write` folds them into the replacement.
		}

		if (events?.active === true) {
			events.emit('cache:miss', {
				type: 'cache:miss',
				key: request.key,
				owner: request.owner,
				at: now,
			})
		}

		const since = epoch
		const response = await next(request)

		if (storable(response)) {
			write(request, response, since)
		}

		return response
	}

	return {
		name: 'cache',
		middleware,
		onInit: ctx => {
			events = ctx.events

			return {
				invalidate: (key: string): boolean =>
					announce(key, entries.delete(key) ? 1 : 0) > 0,

				invalidateTag: (tag: string): number => {
					let removed = 0

					for (const [key, entry] of entries) {
						if (entry.tags.includes(tag)) {
							entries.delete(key)
							removed++
						}
					}

					return announce(`tag:${tag}`, removed)
				},

				clearCache: (): void => {
					const removed = entries.size
					entries.clear()
					announce('*', removed)
				},

				cacheSize: (): number => entries.size,
			}
		},
		onDestroy: () => {
			lifetime.abort()
			entries.clear()
			revalidating.clear()
		},
	}
}
