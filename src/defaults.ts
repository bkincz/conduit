import type { Client } from './core'
import { cache, type CacheApi, type CacheConfig } from './plugins/cache'
import { dedupe, type DedupeApi, type DedupeConfig } from './plugins/dedupe'
import { observable, type ObservableApi, type ObservableConfig } from './plugins/observable'
import { queue, type QueueApi, type QueueConfig } from './plugins/queue'
import { retry, type RetryConfig } from './plugins/retry'
import { session, type SessionApi, type SessionConfig } from './plugins/session'
import { timeout, type TimeoutConfig } from './plugins/timeout'

/*
 *   CONFIG
 ***************************************************************************************************/
export interface DefaultsConfig {
	observable?: ObservableConfig
	cache?: CacheConfig
	dedupe?: DedupeConfig
	queue?: QueueConfig
	/** `false` leaves retry out. */
	retry?: RetryConfig | false
	/** `false` leaves the timeout out. */
	timeout?: TimeoutConfig | false
}

export interface DefaultsWithSession<S> extends DefaultsConfig {
	session: SessionConfig<S>
}

export type DefaultStack = Client & ObservableApi & CacheApi & DedupeApi & QueueApi

/*
 *   PRESET
 ***************************************************************************************************/
/**
 * Installs the standard stack, in the order the layers need to be in.
 *
 * ```
 * cache → dedupe → session → retry → queue → timeout → transport
 * ```
 *
 * Cache outermost, so a hit costs a map lookup and never builds headers or
 * composes a signal. Session inside it, so a served hit does not wait on
 * anything, but outside retry, so a recovery replays a request that has already
 * spent its own attempts. Queue inside retry, so a replay rejoins the queue
 * instead of jumping it. Timeout innermost, so its clock covers one network
 * attempt rather than a whole retry sequence.
 *
 * Getting that order wrong is subtle and expensive, which is the reason this
 * exists.
 *
 * Only `retry` and `timeout` can be left out. Cache, dedupe and queue each add
 * methods to the client, and a preset that sometimes returned them would be
 * lying in its own type — compose `.with()` calls by hand for a stack this
 * cannot express.
 *
 * ```ts
 * const api = defaults(createClient({ baseUrl: '/api' }), {
 * 	cache: { ttl: 30_000, staleWhileRevalidate: true },
 * 	session: { adapter: mySessionAdapter },
 * })
 * ```
 */
export function defaults<S>(
	client: Client,
	config: DefaultsWithSession<S>
): DefaultStack & SessionApi<S>
export function defaults(client: Client, config?: DefaultsConfig): DefaultStack
export function defaults(
	client: Client,
	config: DefaultsConfig & { session?: SessionConfig<unknown> } = {}
): DefaultStack {
	// Observable outermost, so per-key state moves even when a cache hit answers
	// without anything downstream running.
	let stack: Client = client
		.with(observable(config.observable))
		.with(cache(config.cache))
		.with(dedupe(config.dedupe))

	if (config.session !== undefined) {
		stack = stack.with(session(config.session))
	}

	if (config.retry !== false) {
		stack = stack.with(retry(config.retry))
	}

	stack = stack.with(queue(config.queue))

	if (config.timeout !== false) {
		stack = stack.with(timeout(config.timeout))
	}

	// The overloads describe what each branch produces; the implementation
	// signature cannot, because the shape depends on runtime config.
	return stack as DefaultStack
}
