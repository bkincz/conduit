import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../core'
import { createRequest, withRequest } from '../request'
import { clearSharedClients, releaseSharedClient, sharedClient } from '../shared'
import { cache } from '../plugins/cache'
import { dedupe } from '../plugins/dedupe'
import { retry } from '../plugins/retry'
import type { ConduitRequest, Middleware } from '../types'
import { deferredFetch, hangingFetch, jsonResponse, stubFetch } from './helpers'

const ok = (): Response => jsonResponse({ id: 1 })

const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => {
	clearSharedClients()
	vi.restoreAllMocks()
	vi.useRealTimers()
})

/*
 *   IDENTITY
 ***************************************************************************************************/
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

		// Routing sits outside the cache, so the cache sees the rewritten request
		// — and must see a key that matches it.
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

/*
 *   PATHS
 ***************************************************************************************************/
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

/*
 *   FAILURES
 ***************************************************************************************************/
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

/*
 *   CACHE LIFETIME
 ***************************************************************************************************/
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

/*
 *   SHARED REGISTRY
 ***************************************************************************************************/
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

/*
 *   ABORT HANDLING
 ***************************************************************************************************/
describe('abort handling', () => {
	it('does not hand a new caller a flight that was already cancelled', async () => {
		const deferred = deferredFetch()
		const client = createClient({ fetch: deferred.fetch }).with(dedupe())

		const leaving = client.scope('remote:leaving')
		const abandoned = leaving.get('/session').safe()

		leaving.abort()
		expect((await abandoned).error?.code).toBe('ABORTED')

		// Same tick as the abort, before the rejection has unwound.
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

/*
 *   RETRY BUDGET
 ***************************************************************************************************/
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

/*
 *   REQUEST OPTIONS
 ***************************************************************************************************/
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

/*
 *   UNCHANGED GUARANTEES
 ***************************************************************************************************/
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

		const client = createClient({ fetch: hangingFetch().fetch }).with(
			(await import('../plugins/timeout')).timeout({ ms: 50 })
		)

		const pending = client.get('/slow').safe()
		await vi.advanceTimersByTimeAsync(50)

		expect((await pending).error?.code).toBe('TIMEOUT')
	})
})
