import type { EventBus } from '../primitives/events'
import { protect } from '../primitives/freeze'
import { withRequest } from '../http/request'
import type {
	ClientContext,
	ConduitRequest,
	ConduitResponse,
	Middleware,
	Next,
	Plugin,
	ResponseSource,
} from '../primitives/types'

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
	 * Drops one entry and suppresses any read of that key already in flight.
	 * `false` means nothing was stored, not that the in-flight read survives.
	 */
	invalidate(key: string): boolean
	/** Drops every entry carrying a tag. Returns how many went. */
	invalidateTag(tag: string): number
	clearCache(): void
	cacheSize(): number
}

const CACHEABLE: ReadonlySet<string> = new Set(['GET', 'HEAD'])

const byMethod = (request: ConduitRequest): boolean => CACHEABLE.has(request.method)

/** Skips the cache entirely: `client.get('/x', { meta: { cache: 'bypass' } })`. */
export const CACHE_META = 'cache'

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

/** A read in flight, and whether an invalidation has overtaken it. */
interface PendingRead {
	readonly key: string
	readonly tags: readonly string[]
	suppressed: boolean
}

/**
 * Tags accumulate rather than being replaced. Several callers populate one key
 * and only some know its tags, so last-write-wins would unhook the entry from
 * `invalidateTag` without saying so.
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
 * A response cache shared by every bundle, so a remote that mounts second reads
 * what the first already fetched. A hit costs a map lookup and nothing else.
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
	 * A read that started before an invalidation must not store what it fetched.
	 * Tracked per read rather than by a shared counter, which would also discard
	 * every unrelated response in flight at the time.
	 */
	const inFlight = new Set<PendingRead>()

	const lifetime = new AbortController()
	let events: EventBus | undefined
	let context: ClientContext | undefined

	const begin = (request: ConduitRequest): PendingRead => {
		const pending: PendingRead = { key: request.key, tags: request.tags, suppressed: false }
		inFlight.add(pending)

		return pending
	}

	const suppress = (matches: (pending: PendingRead) => boolean): void => {
		for (const pending of inFlight) {
			if (matches(pending)) {
				pending.suppressed = true
			}
		}
	}

	const announce = (target: string, removed: number): number => {
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

		entries.delete(key)
		entries.set(key, entry)

		return entry
	}

	const write = (
		request: ConduitRequest,
		response: ConduitResponse,
		pending: PendingRead
	): void => {
		if (pending.suppressed) {
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

	const storable = (response: ConduitResponse): boolean => {
		const control = response.headers.get('cache-control')

		return control === null || !/no-store|no-cache/i.test(control)
	}

	const refresh = (request: ConduitRequest, next: Next): boolean => {
		if (revalidating.has(request.key)) {
			return false
		}

		revalidating.add(request.key)

		const detached = withRequest(request, {
			signal: lifetime.signal,
			meta: { ...request.meta, [CACHE_META]: 'bypass' },
		})

		const pending = begin(detached)
		const dispatch = context?.dispatch ?? next

		dispatch(detached)
			.then(response => {
				if (storable(response)) {
					write(detached, response, pending)
				}
			})
			.catch(() => {})
			.finally(() => {
				inFlight.delete(pending)
				revalidating.delete(request.key)
			})

		return true
	}

	const middleware: Middleware = async (request, next) => {
		if (request.meta[CACHE_META] === 'bypass' || !shouldCache(request)) {
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
		}

		if (events?.active === true) {
			events.emit('cache:miss', {
				type: 'cache:miss',
				key: request.key,
				owner: request.owner,
				at: now,
			})
		}

		const pending = begin(request)

		try {
			const response = await next(request)

			if (storable(response)) {
				write(request, response, pending)
			}

			return response
		} finally {
			inFlight.delete(pending)
		}
	}

	let release: (() => void) | undefined

	return {
		name: 'cache',
		middleware,
		onInit: ctx => {
			events = ctx.events
			context = ctx

			release = ctx.onResetIdentity(() => {
				const removed = entries.size
				entries.clear()
				suppress(() => true)
				announce('*', removed)
			})

			return {
				invalidate: (key: string): boolean => {
					suppress(pending => pending.key === key)

					return announce(key, entries.delete(key) ? 1 : 0) > 0
				},

				invalidateTag: (tag: string): number => {
					let removed = 0

					for (const [key, entry] of entries) {
						if (entry.tags.includes(tag)) {
							entries.delete(key)
							removed++
						}
					}

					suppress(pending => pending.tags.includes(tag))

					return announce(`tag:${tag}`, removed)
				},

				clearCache: (): void => {
					const removed = entries.size
					entries.clear()
					suppress(() => true)
					announce('*', removed)
				},

				cacheSize: (): number => entries.size,
			}
		},
		onDestroy: () => {
			release?.()
			release = undefined
			lifetime.abort()
			entries.clear()
			revalidating.clear()
			inFlight.clear()
		},
	}
}
