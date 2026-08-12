import { describe, expect, it } from 'vitest'

import { createClient } from '../core'
import { CONDUIT_VERSION } from '../../primitives/version'
import { IDEMPOTENT_METHODS } from '../../primitives/types'
import { hangingFetch, jsonResponse, stubFetch } from '../../__tests__/helpers'

const ok = (): Response => jsonResponse({ ok: true })

describe('client verbs', () => {
	it('sends the method each helper names', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch })

		await client.get('/x')
		await client.head('/x')
		await client.delete('/x')
		await client.post('/x', { a: 1 })
		await client.put('/x', { a: 1 })
		await client.patch('/x', { a: 1 })
		await client.request('/x', { method: 'OPTIONS' })

		expect(stub.calls.map(call => call.init.method)).toEqual([
			'GET',
			'HEAD',
			'DELETE',
			'POST',
			'PUT',
			'PATCH',
			'OPTIONS',
		])
	})

	it('omits a body when a write helper is called without one', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch })

		await client.post('/x')

		expect(stub.calls[0]?.init.body).toBeUndefined()
	})
})

describe('scope verbs', () => {
	it('offers the same surface as the client', async () => {
		const stub = stubFetch(ok)
		const scope = createClient({ fetch: stub.fetch }).scope('remote')

		await scope.get('/x')
		await scope.head('/x')
		await scope.delete('/x')
		await scope.post('/x', { a: 1 })
		await scope.put('/x', { a: 1 })
		await scope.patch('/x', { a: 1 })
		await scope.request('/x', { method: 'OPTIONS' })

		expect(stub.calls.map(call => call.init.method)).toEqual([
			'GET',
			'HEAD',
			'DELETE',
			'POST',
			'PUT',
			'PATCH',
			'OPTIONS',
		])
	})

	it('ignores a second abort', () => {
		const scope = createClient({ fetch: stubFetch(ok).fetch }).scope('remote')

		scope.abort('first')
		scope.abort('second')

		expect((scope.signal.reason as Error).message).toBe('first')
	})
})

describe('transport details', () => {
	it('forwards credentials', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch, credentials: 'include' })

		await client.get('/x')

		expect(stub.calls[0]?.init.credentials).toBe('include')
	})

	it('lets a request override the client credentials', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch, credentials: 'include' })

		await client.get('/x', { credentials: 'omit' })

		expect(stub.calls[0]?.init.credentials).toBe('omit')
	})

	it('reports a TimeoutError distinctly from an abort', async () => {
		const client = createClient({
			fetch: () => {
				const error = new Error('timed out')
				error.name = 'TimeoutError'
				return Promise.reject(error)
			},
		})

		const { error } = await client.get('/x').safe()

		expect(error?.code).toBe('TIMEOUT')
	})

	it('decodes to a blob when asked', async () => {
		const client = createClient({ fetch: stubFetch(() => new Response('bytes')).fetch })

		await expect(client.get('/x', { parse: 'blob' })).resolves.toBeInstanceOf(Blob)
	})

	it('decodes to an ArrayBuffer when asked', async () => {
		const client = createClient({ fetch: stubFetch(() => new Response('bytes')).fetch })

		await expect(client.get('/x', { parse: 'arrayBuffer' })).resolves.toBeInstanceOf(
			ArrayBuffer
		)
	})

	it('skips decoding entirely for parse: none', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({ a: 1 })).fetch })

		await expect(client.get('/x', { parse: 'none' })).resolves.toBeNull()
	})

	it('falls back to a blob for an unrecognised content type', async () => {
		const client = createClient({
			fetch: stubFetch(
				() =>
					new Response('bytes', {
						headers: { 'content-type': 'application/octet-stream' },
					})
			).fetch,
		})

		await expect(client.get('/x')).resolves.toBeInstanceOf(Blob)
	})

	it('reads a body with no content type as text', async () => {
		const client = createClient({ fetch: stubFetch(() => new Response('plain')).fetch })

		await expect(client.get('/x')).resolves.toBe('plain')
	})

	it('carries an attempt number set upstream by a retry', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })

		const response = await client.get('/x', { meta: { attempt: 3 } }).response()

		expect(response.attempt).toBe(3)
	})
})

describe('plugin context', () => {
	it('lets a plugin issue its own requests through the pipeline', async () => {
		const stub = stubFetch(ok)
		let issued: Promise<unknown> | undefined

		createClient({ baseUrl: '/api', fetch: stub.fetch }).with({
			name: 'prefetch',
			onInit: ctx => {
				issued = ctx.request('/warm')
				return undefined
			},
		})

		await issued

		expect(stub.calls[0]?.url).toBe('/api/warm')
	})

	it('exposes the resolved defaults', () => {
		const client = createClient({ baseUrl: '/api', fetch: stubFetch(ok).fetch })

		expect(client.config.baseUrl).toBe('/api')
		expect(client.config.lane).toBe('default')
		expect(client.config.parse).toBe('auto')
		expect(client.config.owner).toBeUndefined()
	})
})

describe('abort sources', () => {
	it('reports a caller-supplied abort without inventing a scope', async () => {
		const controller = new AbortController()
		const client = createClient({ fetch: hangingFetch().fetch })

		const pending = client.get('/x', { signal: controller.signal }).safe()
		controller.abort()

		const { error } = await pending

		expect(error?.code).toBe('ABORTED')
		expect(error?.message).toMatch(/was aborted/)
	})

	it('wraps a thrown Error as UNKNOWN while keeping its message', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with({
			name: 'thrower',
			middleware: async () => {
				throw new Error('plugin broke')
			},
		})

		const { error } = await client.get('/x').safe()

		expect(error?.code).toBe('UNKNOWN')
		expect(error?.message).toBe('plugin broke')
	})
})

describe('constants', () => {
	it('treats replayable methods as idempotent and write methods as not', () => {
		expect(IDEMPOTENT_METHODS.has('GET')).toBe(true)
		expect(IDEMPOTENT_METHODS.has('PUT')).toBe(true)
		expect(IDEMPOTENT_METHODS.has('DELETE')).toBe(true)
		expect(IDEMPOTENT_METHODS.has('POST')).toBe(false)
		expect(IDEMPOTENT_METHODS.has('PATCH')).toBe(false)
	})

	it('reports the build version', () => {
		expect(CONDUIT_VERSION).toMatch(/^\d+\.\d+\.\d+/)
	})
})
