import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../client/core'
import { createEventBus } from '../primitives/events'
import type { Executor } from '../client/methods'
import { createRequest, withRequest } from '../http/request'
import { createScope } from '../client/scopes'
import { clearSharedClients, releaseSharedClient, sharedClient } from '../client/shared'
import { cache } from '../plugins/cache'
import { dedupe } from '../plugins/dedupe'
import { observable } from '../plugins/observable'
import { queue } from '../plugins/queue'
import { retry } from '../plugins/retry'
import { session } from '../plugins/session'
import { timeout } from '../plugins/timeout'
import type { ConduitRequest, FetchLike, Middleware } from '../primitives/types'
import { deferredFetch, hangingFetch, jsonResponse, stubFetch, textResponse } from './helpers'

const ok = (): Response => jsonResponse({ id: 1 })

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => {
	clearSharedClients()
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe('request identity', () => {
	it('does not let two remotes with different auth share a cache entry', async () => {
		const stub = stubFetch(() => jsonResponse({ user: 'whoever asked first' }))
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/me', { headers: { authorization: 'Bearer A' } })
		await client.get('/me', { headers: { authorization: 'Bearer B' } })

		expect(stub.calls).toHaveLength(2)
	})

	it('does not let two remotes with different auth share a flight', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(dedupe())

		await Promise.all([
			client.get('/me', { headers: { authorization: 'Bearer A' } }),
			client.get('/me', { headers: { authorization: 'Bearer B' } }),
		])

		expect(stub.calls).toHaveLength(2)
	})

	it('separates tenants coming from a client-level header function', async () => {
		const stub = stubFetch(ok)
		let tenant = 'acme'
		const client = createClient({
			fetch: stub.fetch,
			headers: () => ({ 'x-tenant': tenant }),
		}).with(cache())

		await client.get('/settings')
		tenant = 'globex'
		await client.get('/settings')

		expect(stub.calls).toHaveLength(2)
	})

	it('still shares when the headers match', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/me', { headers: { authorization: 'Bearer A' } })
		await client.get('/me', { headers: { authorization: 'Bearer A' } })

		expect(stub.calls).toHaveLength(1)
	})

	it('can be narrowed to the headers that actually matter', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch, vary: ['authorization'] }).with(cache())

		await client.get('/me', { headers: { 'x-request-id': '1' } })
		await client.get('/me', { headers: { 'x-request-id': '2' } })

		expect(stub.calls).toHaveLength(1)
	})

	it('separates credential modes', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/me', { credentials: 'include' })
		await client.get('/me', { credentials: 'omit' })

		expect(stub.calls).toHaveLength(2)
	})

	it('re-derives the key when a middleware rewrites the url', async () => {
		const stub = stubFetch(ok)
		let shard = 'a'

		const route: Middleware = async (request, next) =>
			next(withRequest(request, { url: `/shard-${shard}${request.url}` }))

		const client = createClient({ fetch: stub.fetch })
			.with({ name: 'route', middleware: route })
			.with(cache())

		await client.get('/orders')
		shard = 'b'
		await client.get('/orders')

		expect(stub.calls.map(call => call.url)).toEqual(['/shard-a/orders', '/shard-b/orders'])
	})

	it('leaves the key alone when a middleware sets one explicitly', () => {
		const request = createRequest({
			url: '/a',
			method: 'GET',
			body: null,
			signal: new AbortController().signal,
			key: 'original',
			variance: '',
			lane: 'default',
			owner: undefined,
			tags: [],
			parse: 'auto',
			credentials: undefined,
			meta: {},
			buildHeaders: () => new Headers(),
		})

		expect(withRequest(request, { url: '/b', key: 'chosen' }).key).toBe('chosen')
		expect(withRequest(request, { url: '/b' }).key).toBe('GET /b')
		expect(withRequest(request, { lane: 'critical' }).key).toBe('original')
	})

	it('treats a reordered multi-value query as a different request', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/search', { query: { sort: ['name', 'age'] } })
		await client.get('/search', { query: { sort: ['age', 'name'] } })

		expect(stub.calls).toHaveLength(2)
	})
})

describe('literal colons in paths', () => {
	it('sends a custom-method url rather than rejecting it', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch })

		await client.post('/v1/models/gemini-pro:generateContent', { prompt: 'hi' })

		expect(stub.calls[0]?.url).toBe('/v1/models/gemini-pro:generateContent')
	})

	it('ignores a colon inside a query string', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch })

		await client.get('/notes?q=label:urgent')

		expect(stub.calls[0]?.url).toBe('/notes?q=label:urgent')
	})

	it('ignores credentials in an authority', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch })

		await client.get('https://user:pass@host.test/x')

		expect(stub.calls[0]?.url).toBe('https://user:pass@host.test/x')
	})

	it('still substitutes a placeholder that starts a segment', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch })

		await client.get('/users/:id', { params: { id: 7 } })

		expect(stub.calls[0]?.url).toBe('/users/7')
	})

	it('escapes a literal segment that has to begin with a colon', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch })

		await client.get('/tags/::literal')

		expect(stub.calls[0]?.url).toBe('/tags/:literal')
	})
})

describe('failing responses', () => {
	it('reports the status even when the error body does not parse', async () => {
		const client = createClient({
			fetch: () =>
				Promise.resolve(
					new Response('<html>maintenance</html>', {
						status: 503,
						headers: { 'content-type': 'application/json' },
					})
				),
		})

		const { error } = await client.get('/x').safe()

		expect(error?.code).toBe('HTTP_ERROR')
		expect(error?.status).toBe(503)
		expect(error?.body).toBe('<html>maintenance</html>')
	})

	it('retries such a response, because it is a 503 and not a parse failure', async () => {
		let calls = 0
		const client = createClient({
			fetch: () => {
				calls++
				return Promise.resolve(
					calls === 1
						? new Response('<html>nope</html>', {
								status: 503,
								headers: { 'content-type': 'application/json' },
							})
						: jsonResponse({ ok: true })
				)
			},
		}).with(retry({ baseDelay: 1, jitter: false }))

		await expect(client.get('/x')).resolves.toEqual({ ok: true })
		expect(calls).toBe(2)
	})

	it('still reports a successful response that does not parse as PARSE', async () => {
		const client = createClient({
			fetch: () =>
				Promise.resolve(
					new Response('{oops', { headers: { 'content-type': 'application/json' } })
				),
		})

		expect((await client.get('/x').safe()).error?.code).toBe('PARSE')
	})
})

describe('cache lifetime', () => {
	it('finishes a background refresh even though the remote that triggered it unmounted', async () => {
		let version = 1
		const stub = stubFetch(() => jsonResponse({ version: version++ }))
		const client = createClient({ fetch: stub.fetch }).with(
			cache({ ttl: 0, staleWhileRevalidate: true })
		)

		await client.get('/me')

		const scope = client.scope('remote:profile')
		await scope.get('/me')
		scope.dispose()

		await flush()

		expect(await client.get('/me')).toEqual({ version: 2 })
	})

	it('does not store a response that was already in flight when the cache was invalidated', async () => {
		const deferred = deferredFetch()
		const client = createClient({ fetch: deferred.fetch }).with(cache())

		const pending = client.get('/todos')

		client.invalidate('GET /todos')
		deferred.resolve(jsonResponse({ items: ['stale'] }))
		await pending

		expect(client.cacheSize()).toBe(0)
	})

	it('keeps tags an earlier caller registered when a later one refetches without them', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache({ ttl: 0 }))

		await client.get('/users/1', { tags: ['user'] })
		await client.get('/users/1')

		expect(client.invalidateTag('user')).toBe(1)
	})
})

describe('shared registry', () => {
	it('rebuilds rather than handing out a destroyed client', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const build = (): ReturnType<typeof createClient> =>
			createClient({ fetch: stubFetch(ok).fetch })

		const first = sharedClient('api', build)
		first.destroy()

		const second = sharedClient('api', build)

		expect(second).not.toBe(first)
		await expect(second.get('/x')).resolves.toEqual({ id: 1 })
	})

	it('can be released explicitly', () => {
		const build = (): ReturnType<typeof createClient> =>
			createClient({ fetch: stubFetch(ok).fetch })

		const first = sharedClient('api', build)

		expect(releaseSharedClient('api')).toBe(true)
		expect(releaseSharedClient('api')).toBe(false)
		expect(sharedClient('api', build)).not.toBe(first)
	})
})

describe('abort handling', () => {
	it('does not hand a new caller a flight that was already cancelled', async () => {
		const deferred = deferredFetch()
		const client = createClient({ fetch: deferred.fetch }).with(dedupe())

		const leaving = client.scope('remote:leaving')
		const abandoned = leaving.get('/session').safe()

		leaving.abort()
		expect((await abandoned).error?.code).toBe('ABORTED')

		const arriving = client.get('/session')
		deferred.resolve(jsonResponse({ id: 1 }))

		await expect(arriving).resolves.toEqual({ id: 1 })
		expect(deferred.calls).toHaveLength(2)
	})

	it('never puts a request on the wire for a caller that already cancelled', async () => {
		const stub = stubFetch(ok)
		const controller = new AbortController()
		controller.abort()

		const client = createClient({ fetch: stub.fetch }).with(dedupe())

		const { error } = await client.get('/me', { signal: controller.signal }).safe()

		expect(error?.code).toBe('ABORTED')
		expect(stub.calls).toHaveLength(0)
	})

	it('freezes a body shared by several riders of one flight', async () => {
		const client = createClient({
			fetch: stubFetch(() => jsonResponse({ user: { name: 'Ada' } })).fetch,
		}).with(dedupe())

		const [first] = await Promise.all([
			client.get<{ user: { name: string } }>('/me'),
			client.get<{ user: { name: string } }>('/me'),
		])

		expect(() => {
			if (first !== undefined) {
				first.user.name = 'Grace'
			}
		}).toThrow(TypeError)
	})

	it('gives up on a backoff that was cancelled before it started', async () => {
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 503)),
		}).with(retry({ attempts: 5, baseDelay: 10_000, jitter: false }))

		const scope = client.scope('remote:profile')
		const pending = scope.get('/x').safe()

		scope.abort()

		expect((await pending).error?.code).toBe('ABORTED')
	})
})

describe('retry budget', () => {
	it('gives up rather than parking a caller for a Retry-After beyond maxDelay', async () => {
		let calls = 0
		const client = createClient({
			fetch: () => {
				calls++
				return Promise.resolve(
					new Response('', { status: 429, headers: { 'retry-after': '3600' } })
				)
			},
		}).with(retry({ attempts: 3, maxDelay: 5_000 }))

		const { error } = await client.get('/x').safe()

		expect(error?.status).toBe(429)
		expect(calls).toBe(1)
	})

	it('still honours a Retry-After within the ceiling', async () => {
		vi.useFakeTimers()

		let calls = 0
		const client = createClient({
			fetch: () => {
				calls++
				return Promise.resolve(
					calls === 1
						? new Response('', { status: 503, headers: { 'retry-after': '1' } })
						: jsonResponse({ ok: true })
				)
			},
		}).with(retry({ maxDelay: 5_000 }))

		const pending = client.get('/x')
		await vi.advanceTimersByTimeAsync(1000)

		await expect(pending).resolves.toEqual({ ok: true })
	})
})

describe('caller options', () => {
	it('does not write pipeline state back into the caller object', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(retry({ baseDelay: 1 }))
		const meta = { trace: 'abc' }

		await client.get('/x', { meta })

		expect(meta).toEqual({ trace: 'abc' })
	})

	it('accepts a frozen meta object', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(retry({ baseDelay: 1 }))

		await expect(client.get('/x', { meta: Object.freeze({ trace: 'abc' }) })).resolves.toEqual({
			id: 1,
		})
	})

	it('still passes meta through to the pipeline', async () => {
		let seen: ConduitRequest | undefined
		const client = createClient({ fetch: stubFetch(ok).fetch }).with({
			name: 'capture',
			middleware: async (request, next) => {
				seen = request
				return next(request)
			},
		})

		await client.get('/x', { meta: { trace: 'abc' } })

		expect(seen?.meta['trace']).toBe('abc')
	})
})

describe('guarantees that must survive the fixes', () => {
	it('still cancels the underlying request when the last participant leaves', async () => {
		const deferred = deferredFetch()
		const client = createClient({ fetch: deferred.fetch }).with(dedupe())

		const first = client.scope('a')
		const second = client.scope('b')
		const pending = [first.get('/me').safe(), second.get('/me').safe()]

		first.abort()
		expect(deferred.aborted()).toBe(false)

		second.abort()
		expect(deferred.aborted()).toBe(true)

		await Promise.all(pending)
	})

	it('still times out a slow request', async () => {
		vi.useFakeTimers()

		const client = createClient({ fetch: hangingFetch().fetch }).with(timeout({ ms: 50 }))

		const pending = client.get('/slow').safe()
		await vi.advanceTimersByTimeAsync(50)

		expect((await pending).error?.code).toBe('TIMEOUT')
	})
})

describe('signing out', () => {
	it('drops what was cached for whoever was signed in', async () => {
		const stub = stubFetch(() => jsonResponse({ user: 'A' }))
		const client = createClient({ fetch: stub.fetch })
			.with(cache())
			.with(session({ adapter: { load: async () => ({ name: 'A' }) } }))

		await client.get('/me')
		expect(client.cacheSize()).toBe(1)

		client.session.clear()

		expect(client.cacheSize()).toBe(0)

		await client.get('/me')
		expect(stub.calls).toHaveLength(2)
	})

	it('drops them when the session turns out to be gone as well', async () => {
		let status = 200
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({ user: 'A' }, status)),
		})
			.with(cache())
			.with(session({ adapter: { load: async () => ({ name: 'A' }) } }))

		await client.get('/me')
		status = 401
		await client.get('/orders').safe()

		expect(client.cacheSize()).toBe(0)
	})

	it('keeps the cache across a re-read that lands on the same session', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch })
			.with(cache())
			.with(session({ adapter: { load: async () => ({ name: 'A' }) } }))

		await client.session.load()
		await client.get('/me')
		await client.session.reload()

		expect(client.cacheSize()).toBe(1)
	})
})

describe('session lifecycle', () => {
	it('authorizes every request racing the first load, not just the first one', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(
			session({
				adapter: {
					load: async () => {
						await flush()
						return { name: 'Ada' }
					},
					authorize: (request, current) => {
						if (current === null) {
							return request
						}

						const headers = new Headers(request.headers)
						headers.set('authorization', `Bearer ${current.name}`)

						return withRequest(request, { headers })
					},
				},
			})
		)

		await Promise.all([client.get('/a'), client.get('/b')])

		expect(stub.calls.map(call => new Headers(call.init.headers).get('authorization'))).toEqual(
			['Bearer Ada', 'Bearer Ada']
		)
	})

	it('reads the session from the server rather than from the cache', async () => {
		let version = 0
		const stub = stubFetch(() => jsonResponse({ name: `v${++version}` }))
		const client = createClient({ fetch: stub.fetch })
			.with(cache())
			.with(dedupe())
			.with(
				session({
					adapter: { load: ctx => ctx.request<{ name: string }>('/auth/session') },
				})
			)

		await client.session.load()
		await client.session.reload()

		expect(stub.calls).toHaveLength(2)
		expect(client.session.get().session).toEqual({ name: 'v2' })
	})

	it('gives up when a renewed session is still rejected', async () => {
		const onUnauthenticated = vi.fn()
		const renew = vi.fn(async () => true)
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 401)),
		}).with(
			session({
				adapter: { load: async () => ({ name: 'Ada' }), renew },
				onUnauthenticated,
			})
		)

		const { error } = await client.get('/x').safe()

		expect(error?.status).toBe(401)
		expect(renew).toHaveBeenCalledOnce()
		expect(onUnauthenticated).toHaveBeenCalledOnce()
	})

	it('never asks setTimeout for a delay it cannot hold', async () => {
		const delays: number[] = []
		const real = globalThis.setTimeout

		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
			handler: () => void,
			ms?: number
		) => {
			delays.push(ms ?? 0)
			return real(handler, 0)
		}) as typeof setTimeout)

		const thirtyDays = 30 * 24 * 60 * 60 * 1000
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: {
					load: async () => ({ name: 'Ada' }),
					expiresAt: () => Date.now() + thirtyDays,
				},
			})
		)

		await client.session.load()

		expect(delays).not.toHaveLength(0)
		expect(Math.max(...delays)).toBeLessThanOrEqual(2_147_483_647)
	})

	it('does not let an enormous timeout fire straight away', async () => {
		const deferred = deferredFetch()
		const client = createClient({ fetch: deferred.fetch }).with(timeout({ ms: 5_000_000_000 }))

		const pending = client.get('/x')
		await new Promise(resolve => setTimeout(resolve, 5))
		deferred.resolve(jsonResponse({ ok: true }))

		await expect(pending).resolves.toEqual({ ok: true })
	})
})

describe('observable state', () => {
	it('does not turn one participant leaving into an error the others see', async () => {
		const deferred = deferredFetch()
		const client = createClient({ fetch: deferred.fetch }).with(observable()).with(dedupe())
		const key = client.keyFor('/todos')

		const staying = client.get('/todos')
		const leaving = client.scope('remote:leaving')
		const abandoned = leaving.get('/todos').safe()

		leaving.abort()
		expect((await abandoned).error?.code).toBe('ABORTED')

		expect(client.observe(key).get()).toMatchObject({ status: 'loading', fetching: true })

		deferred.resolve(jsonResponse({ items: [] }))
		await staying

		expect(client.observe(key).get()).toMatchObject({ status: 'success', fetching: false })
	})

	it('never hands back a store it evicted on the way out', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(observable({ max: 1 }))

		client.observe('GET /pinned').subscribe(() => {})

		const store = client.observe(client.keyFor('/fresh'))

		expect(client.observe(client.keyFor('/fresh'))).toBe(store)

		await client.get('/fresh')

		expect(store.get().status).toBe('success')
	})

	it('lets a background refresh reach the state a component renders from', async () => {
		let version = 0
		const client = createClient({
			fetch: stubFetch(() => jsonResponse({ version: ++version })).fetch,
		})
			.with(observable())
			.with(cache({ ttl: 0, staleWhileRevalidate: true }))

		const key = client.keyFor('/dashboard')

		await client.get('/dashboard')
		await client.get('/dashboard')
		await flush()

		expect(client.observe(key).get()).toMatchObject({
			data: { version: 2 },
			from: 'network',
		})
	})
})

describe('invalidation', () => {
	it('only suppresses the in-flight read it was aimed at', async () => {
		const outstanding = new Map<string, (response: Response) => void>()
		const fetch: FetchLike = url =>
			new Promise<Response>(resolve => {
				outstanding.set(url, resolve)
			})

		const client = createClient({ fetch }).with(cache())

		const todos = client.get('/todos')
		const users = client.get('/users')

		client.invalidate('GET /todos')

		outstanding.get('/todos')?.(jsonResponse({ items: [] }))
		outstanding.get('/users')?.(jsonResponse({ items: [] }))
		await Promise.all([todos, users])

		expect(client.cacheSize()).toBe(1)
	})

	it('still suppresses the read it was aimed at when a tag is invalidated', async () => {
		const deferred = deferredFetch()
		const client = createClient({ fetch: deferred.fetch }).with(cache())

		const pending = client.get('/todos', { tags: ['todo'] })

		client.invalidateTag('todo')
		deferred.resolve(jsonResponse({ items: ['stale'] }))
		await pending

		expect(client.cacheSize()).toBe(0)
	})
})

describe('decode mode and repeated headers', () => {
	it('does not let two decode modes share one entry', async () => {
		const stub = stubFetch(() => textResponse('plain'))
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/report', { parse: 'text' })
		await client.get('/report', { parse: 'blob' })

		expect(stub.calls).toHaveLength(2)
	})

	it('fingerprints a repeated header name the way the wire carries it', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(cache())

		await client.get('/data', {
			headers: [
				['x-tenant', 'acme'],
				['x-tenant', 'globex'],
			],
		})
		await client.get('/data', { headers: [['x-tenant', 'globex']] })

		expect(stub.calls).toHaveLength(2)
	})
})

describe('queue configuration', () => {
	it('refuses a ceiling that could never let a request run', () => {
		expect(() => queue({ limits: { prefetch: 0 } })).toThrow(/at least 1/)
		expect(() => queue({ concurrency: 0 })).toThrow(/at least 1/)
	})
})

describe('bookkeeping that would otherwise grow forever', () => {
	it('detaches an aborted scope, not only a disposed one', () => {
		const released: string[] = []
		const scope = createScope({
			name: 'remote:profile',
			makeExecutor: () => (() => undefined) as unknown as Executor,
			onDispose: spent => released.push(spent.name),
		})

		scope.abort()
		expect(released).toEqual(['remote:profile'])

		scope.dispose()
		expect(released).toEqual(['remote:profile'])
	})

	it('survives an unsubscribe that arrives after the bus was cleared', () => {
		const bus = createEventBus()
		const off = bus.on('request:start', () => {})

		bus.clear()
		off()

		const seen: string[] = []
		bus.on('request:start', event => seen.push(event.type))

		expect(bus.active).toBe(true)

		bus.emit('request:start', {
			type: 'request:start',
			request: createRequest({
				url: '/x',
				method: 'GET',
				body: null,
				signal: new AbortController().signal,
				key: 'GET /x',
				variance: '',
				lane: 'default',
				owner: undefined,
				tags: [],
				parse: 'auto',
				credentials: undefined,
				meta: {},
				buildHeaders: () => new Headers(),
			}),
			at: 0,
		})

		expect(seen).toEqual(['request:start'])
	})
})
