import { describe, expect, it, vi } from 'vitest'

import { createClient } from '../core'
import { isConduitError } from '../errors'
import { withRequest } from '../request'
import type { ConduitRequest, ConduitResponse, Middleware, Plugin } from '../types'
import { hangingFetch, jsonResponse, stubFetch, textResponse } from './helpers'

const ok = (): Response => jsonResponse({ ok: true })

/** Counts `new Headers(...)` calls, so the lazy-headers claim is observable rather than asserted. */
function countHeaderConstruction(): { count(): number; restore(): void } {
	const Original = globalThis.Headers
	let built = 0

	globalThis.Headers = class extends Original {
		constructor(init?: HeadersInit) {
			super(init)
			built++
		}
	} as typeof Headers

	return {
		count: () => built,
		restore: () => {
			globalThis.Headers = Original
		},
	}
}

// Built once at module load, so a test counting Headers construction is not
// measuring its own stub.
const NO_HEADERS = new Headers()

const shortCircuit =
	(data: unknown): Middleware =>
	async request =>
		({
			status: 200,
			headers: NO_HEADERS,
			data,
			raw: undefined,
			from: 'cache',
			attempt: 1,
			request,
		}) satisfies ConduitResponse

/*
 *   REQUEST BUILDING
 ***************************************************************************************************/
describe('request building', () => {
	it('joins baseUrl, path params and query', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ baseUrl: '/api', fetch: stub.fetch })

		await client.get('/users/:id', { params: { id: 7 }, query: { expand: 'posts' } })

		expect(stub.calls[0]?.url).toBe('/api/users/7?expand=posts')
		expect(stub.calls[0]?.init.method).toBe('GET')
	})

	it('JSON-encodes an object body and declares the content type', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch })

		await client.post('/users', { name: 'Ada' })

		const init = stub.calls[0]?.init
		expect(init?.body).toBe('{"name":"Ada"}')
		expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
	})

	it('does not overwrite a content type the caller set', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch })

		await client.post('/x', { a: 1 }, { headers: { 'content-type': 'application/vnd.x+json' } })

		expect(new Headers(stub.calls[0]?.init.headers).get('content-type')).toBe(
			'application/vnd.x+json'
		)
	})

	it('reads a header function per request, so a changing tenant is picked up', async () => {
		const stub = stubFetch(ok)
		let tenant = 'a'
		const client = createClient({ fetch: stub.fetch, headers: () => ({ 'x-tenant': tenant }) })

		await client.get('/x')
		tenant = 'b'
		await client.get('/x')

		expect(new Headers(stub.calls[0]?.init.headers).get('x-tenant')).toBe('a')
		expect(new Headers(stub.calls[1]?.init.headers).get('x-tenant')).toBe('b')
	})

	it('derives a readable key and tags the owner', async () => {
		let seen: ConduitRequest | undefined
		const capture: Middleware = async (request, next) => {
			seen = request
			return next(request)
		}

		const client = createClient({
			baseUrl: '/api',
			owner: 'shell',
			fetch: stubFetch(ok).fetch,
		}).with({ name: 'capture', middleware: capture })

		await client.get('/users', { query: { b: 2, a: 1 } })

		expect(seen?.key).toBe('GET /api/users?a=1&b=2')
		expect(seen?.owner).toBe('shell')
		expect(seen?.lane).toBe('default')
	})
})

/*
 *   RESULT SHAPES
 ***************************************************************************************************/
describe('result shapes', () => {
	it('resolves to the decoded body by default', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({ id: 1 })).fetch })

		await expect(client.get<{ id: number }>('/x')).resolves.toEqual({ id: 1 })
	})

	it('exposes the full response through .response()', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({ id: 1 })).fetch })

		const response = await client.get('/x').response()

		expect(response.status).toBe(200)
		expect(response.from).toBe('network')
		expect(response.attempt).toBe(1)
		expect(response.request.method).toBe('GET')
	})

	it('returns failures as values through .safe()', async () => {
		const client = createClient({
			fetch: stubFetch(() => jsonResponse({ detail: 'nope' }, 404)).fetch,
		})

		const result = await client.get('/x').safe()

		expect(result.data).toBeNull()
		expect(result.error?.code).toBe('HTTP_ERROR')
		expect(result.error?.status).toBe(404)
		expect(result.error?.body).toEqual({ detail: 'nope' })
	})

	it('narrows to a non-null body when .safe() reports no error', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({ id: 1 })).fetch })

		const result = await client.get<{ id: number }>('/x').safe()

		if (result.error === null) {
			expect(result.data.id).toBe(1)
		} else {
			expect.unreachable('expected a successful result')
		}
	})
})

/*
 *   FAILURES
 ***************************************************************************************************/
describe('failures', () => {
	it('reports a rejected fetch as NETWORK, not as a response', async () => {
		const client = createClient({
			fetch: () => Promise.reject(new TypeError('Failed to fetch')),
		})

		const { error } = await client.get('/x').safe()

		expect(error?.code).toBe('NETWORK')
		expect(error?.status).toBeUndefined()
	})

	it('carries the decoded error body on an HTTP failure', async () => {
		const client = createClient({
			fetch: stubFetch(() => jsonResponse({ detail: 'gone' }, 410)).fetch,
		})

		await expect(client.get('/x')).rejects.toMatchObject({
			code: 'HTTP_ERROR',
			status: 410,
			body: { detail: 'gone' },
		})
	})

	it('normalises anything a plugin throws into a ConduitError', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with({
			name: 'rude',
			middleware: async () => {
				throw 'a bare string'
			},
		})

		const { error } = await client.get('/x').safe()

		expect(isConduitError(error)).toBe(true)
		expect(error?.code).toBe('UNKNOWN')
	})
})

/*
 *   DECODING
 ***************************************************************************************************/
describe('decoding', () => {
	it('reads an empty-body status as null', async () => {
		const client = createClient({
			fetch: () => Promise.resolve(new Response(null, { status: 204 })),
		})

		await expect(client.get('/x')).resolves.toBeNull()
	})

	it('reads a 200 with an empty JSON body as null rather than failing to parse', async () => {
		const client = createClient({
			fetch: () =>
				Promise.resolve(
					new Response('', { headers: { 'content-type': 'application/json' } })
				),
		})

		await expect(client.get('/x')).resolves.toBeNull()
	})

	it('reads text content as text', async () => {
		const client = createClient({ fetch: stubFetch(() => textResponse('hello')).fetch })

		await expect(client.get('/x')).resolves.toBe('hello')
	})

	it('honours an explicit parse mode over the content type', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({ a: 1 })).fetch })

		await expect(client.get('/x', { parse: 'text' })).resolves.toBe('{"a":1}')
	})

	it('reports an undecodable body as PARSE, distinct from a network failure', async () => {
		const client = createClient({
			fetch: () =>
				Promise.resolve(
					new Response('{oops', { headers: { 'content-type': 'application/json' } })
				),
		})

		const { error } = await client.get('/x').safe()

		expect(error?.code).toBe('PARSE')
	})
})

/*
 *   PIPELINE
 ***************************************************************************************************/
describe('pipeline', () => {
	it('lets a middleware rewrite the request', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with({
			name: 'rewrite',
			middleware: async (request, next) => next(withRequest(request, { url: '/rewritten' })),
		})

		await client.get('/original')

		expect(stub.calls[0]?.url).toBe('/rewritten')
	})

	it('never materialises Headers for a request that short-circuits', async () => {
		const headers = vi.fn(() => ({ 'x-tenant': 'a' }))
		const stub = stubFetch(ok)
		const built = countHeaderConstruction()

		try {
			const client = createClient({ fetch: stub.fetch, headers }).with({
				name: 'cacheish',
				middleware: shortCircuit({ cached: true }),
			})

			await expect(client.get('/x')).resolves.toEqual({ cached: true })

			expect(stub.calls).toHaveLength(0)
			// The header source is read once, because request identity depends on
			// it — but nothing builds the Headers instance the network would need.
			expect(headers).toHaveBeenCalledOnce()
			expect(built.count()).toBe(0)
		} finally {
			built.restore()
		}
	})

	it('builds headers exactly once when several layers read them', async () => {
		const headers = vi.fn(() => ({ 'x-tenant': 'a' }))
		const read: Middleware = async (request, next) => {
			request.headers.get('x-tenant')
			request.headers.get('x-tenant')
			return next(request)
		}

		const client = createClient({ fetch: stubFetch(ok).fetch, headers })
			.with({ name: 'first', middleware: read })
			.with({ name: 'second', middleware: read })

		await client.get('/x')

		expect(headers).toHaveBeenCalledOnce()
	})
})

/*
 *   PLUGINS
 ***************************************************************************************************/
describe('plugins', () => {
	it('merges an extension onto the client', async () => {
		const plugin: Plugin<{ ping(): string }> = {
			name: 'ping',
			onInit: () => ({ ping: () => 'pong' }),
		}

		const client = createClient({ fetch: stubFetch(ok).fetch }).with(plugin)

		expect(client.ping()).toBe('pong')
	})

	it('hands the plugin a working client context', async () => {
		const stub = stubFetch(ok)
		let fromPlugin: unknown

		const client = createClient({ baseUrl: '/api', fetch: stub.fetch }).with({
			name: 'selfcall',
			onInit: ctx => {
				fromPlugin = ctx.config.baseUrl
				return undefined
			},
		})

		expect(fromPlugin).toBe('/api')
		await expect(client.get('/x')).resolves.toEqual({ ok: true })
	})

	it('refuses a duplicate plugin name', () => {
		const plugin: Plugin = { name: 'dupe' }
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(plugin)

		expect(() => client.with(plugin)).toThrow(/already installed/)
	})

	it('refuses an extension that would shadow the client surface', () => {
		const plugin: Plugin<{ get(): string }> = {
			name: 'shadow',
			onInit: () => ({ get: () => 'nope' }),
		}

		expect(() => createClient({ fetch: stubFetch(ok).fetch }).with(plugin)).toThrow(
			/already exists on the client/
		)
	})
})

/*
 *   SCOPES
 ***************************************************************************************************/
describe('scopes', () => {
	it('tags requests with the scope name as owner', async () => {
		let seen: ConduitRequest | undefined
		const client = createClient({ fetch: stubFetch(ok).fetch }).with({
			name: 'capture',
			middleware: async (request, next) => {
				seen = request
				return next(request)
			},
		})

		await client.scope('remote:profile').get('/x')

		expect(seen?.owner).toBe('remote:profile')
	})

	it('aborts in-flight requests and says who cancelled them', async () => {
		const client = createClient({ fetch: hangingFetch().fetch })
		const scope = client.scope('remote:profile')

		const pending = scope.get('/x').safe()
		scope.abort()

		const { error } = await pending

		expect(error?.code).toBe('ABORTED')
		expect(error?.message).toMatch(/Scope "remote:profile" was aborted/)
	})

	it('leaves other scopes running', async () => {
		const client = createClient({ fetch: hangingFetch().fetch })
		const doomed = client.scope('a')
		const survivor = client.scope('b')

		const pending = doomed.get('/x').safe()
		doomed.abort()

		await pending

		expect(survivor.signal.aborted).toBe(false)
	})

	it('aborts on dispose and is safe to dispose twice', () => {
		const client = createClient({ fetch: hangingFetch().fetch })
		const scope = client.scope('a')

		scope.dispose()
		scope.dispose()

		expect(scope.signal.aborted).toBe(true)
	})

	it('cancels every scope at once through abortAll', async () => {
		const client = createClient({ fetch: hangingFetch().fetch })
		const first = client.scope('a')
		const second = client.scope('b')

		const pending = [first.get('/x').safe(), second.get('/y').safe()]
		client.abortAll('The session is gone.')

		const results = await Promise.all(pending)

		expect(results.map(result => result.error?.code)).toEqual(['ABORTED', 'ABORTED'])
		expect(results[0]?.error?.message).toBe('The session is gone.')
	})

	it('cancels scope-less requests through abortAll too', async () => {
		const client = createClient({ fetch: hangingFetch().fetch })

		const pending = client.get('/x').safe()
		client.abortAll()

		expect((await pending).error?.code).toBe('ABORTED')
	})
})

/*
 *   TEARDOWN
 ***************************************************************************************************/
describe('destroy', () => {
	it('tears plugins down in reverse install order', () => {
		const order: string[] = []
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with({ name: 'a', onDestroy: () => order.push('a') })
			.with({ name: 'b', onDestroy: () => order.push('b') })

		client.destroy()

		expect(order).toEqual(['b', 'a'])
	})

	it('rejects further requests instead of failing obscurely', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
		client.destroy()

		const { error } = await client.get('/x').safe()

		expect(error?.code).toBe('CONFIG')
		expect(error?.message).toMatch(/was destroyed/)
	})

	it('is idempotent', () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })

		client.destroy()
		expect(() => client.destroy()).not.toThrow()
	})
})
