import { describe, expect, it } from 'vitest'

import { createClient } from '../client/core'
import { defaults } from '../client/defaults'
import { createMockServer, delay, json, networkError, status, text } from '../testing'

describe('createMockServer', () => {
	it('answers a plain value as JSON', async () => {
		const server = createMockServer()
		server.get('/me', { id: 1 })

		const api = createClient({ fetch: server.fetch })

		await expect(api.get('/me')).resolves.toEqual({ id: 1 })
	})

	it('captures path parameters', async () => {
		const server = createMockServer()
		server.get('/users/:id', request => ({ id: request.params['id'] }))

		const api = createClient({ fetch: server.fetch })

		await expect(api.get('/users/:id', { params: { id: 7 } })).resolves.toEqual({ id: '7' })
	})

	it('prefixes patterns with the base url, so routes read like paths', async () => {
		const server = createMockServer({ baseUrl: '/api' })
		server.get('/me', { id: 1 })

		const api = createClient({ baseUrl: '/api', fetch: server.fetch })

		await expect(api.get('/me')).resolves.toEqual({ id: 1 })
	})

	it('separates methods', async () => {
		const server = createMockServer()
		server.get('/things', { read: true })
		server.post('/things', status(201, { written: true }))

		const api = createClient({ fetch: server.fetch })

		await expect(api.get('/things')).resolves.toEqual({ read: true })
		await expect(api.post('/things', {})).resolves.toEqual({ written: true })
	})

	it('matches any method when asked', async () => {
		const server = createMockServer()
		server.any('/anything', { ok: true })

		const api = createClient({ fetch: server.fetch })

		await expect(api.get('/anything')).resolves.toEqual({ ok: true })
		await expect(api.delete('/anything')).resolves.toEqual({ ok: true })
	})

	it('supports wildcards and regular expressions', async () => {
		const server = createMockServer()
		server.get('/static/*', text('asset'))
		server.get(/^\/rx\/\d+$/, { matched: true })

		const api = createClient({ fetch: server.fetch })

		await expect(api.get('/static/img/logo.svg')).resolves.toBe('asset')
		await expect(api.get('/rx/42')).resolves.toEqual({ matched: true })
	})

	it('exposes the request body to a responder', async () => {
		const server = createMockServer()
		server.post('/echo', request => request.json())

		const api = createClient({ fetch: server.fetch })

		await expect(api.post('/echo', { name: 'Ada' })).resolves.toEqual({ name: 'Ada' })
	})

	it('exposes the query string', async () => {
		const server = createMockServer()
		server.get('/search', request => ({ q: request.query.get('q') }))

		const api = createClient({ fetch: server.fetch })

		await expect(api.get('/search', { query: { q: 'ada' } })).resolves.toEqual({ q: 'ada' })
	})

	it('retires a route after the given number of matches', async () => {
		const server = createMockServer()
		server.get('/flaky', status(503), { times: 1 })
		server.get('/flaky', { ok: true })

		const api = defaults(createClient({ fetch: server.fetch }), {
			cache: { ttl: 0 },
			retry: { baseDelay: 1, jitter: false },
		})

		await expect(api.get('/flaky')).resolves.toEqual({ ok: true })
	})

	it('throws a network failure rather than returning one', async () => {
		const server = createMockServer()
		server.get('/down', networkError())

		const api = createClient({ fetch: server.fetch })

		expect((await api.get('/down').safe()).error?.code).toBe('NETWORK')
	})

	it('answers late when asked to', async () => {
		const server = createMockServer()
		server.get('/slow', delay(5, { late: true }))

		const api = createClient({ fetch: server.fetch })

		await expect(api.get('/slow')).resolves.toEqual({ late: true })
	})

	it('records every request that arrived', async () => {
		const server = createMockServer()
		server.any('/*', { ok: true })

		const api = createClient({ fetch: server.fetch })

		await api.get('/a')
		await api.post('/b', { x: 1 })

		expect(server.calls.map(call => `${call.method} ${call.path}`)).toEqual([
			'GET /a',
			'POST /b',
		])
	})

	it('fails loudly at the unmatched request, naming what is registered', async () => {
		const server = createMockServer()
		server.get('/known', { ok: true })

		const api = createClient({ fetch: server.fetch })

		const { error } = await api.get('/unknown').safe()

		expect(error?.message).toMatch(/No route for GET \/unknown/)
		expect(error?.message).toMatch(/GET \/known/)
	})

	it('can answer unmatched requests with a 404 instead', async () => {
		const server = createMockServer({ onUnmatched: 'notFound' })

		const api = createClient({ fetch: server.fetch })

		expect((await api.get('/nothing').safe()).error?.status).toBe(404)
	})

	it('resets routes and calls', async () => {
		const server = createMockServer()
		server.get('/me', { id: 1 })

		const api = createClient({ fetch: server.fetch })
		await api.get('/me')

		server.reset()

		expect(server.calls).toHaveLength(0)
		expect((await api.get('/me').safe()).error?.message).toMatch(/No route/)
	})

	it('leaves the whole pipeline in play', async () => {
		const server = createMockServer()
		server.get('/me', { id: 1 })

		const api = defaults(createClient({ fetch: server.fetch }))

		await Promise.all([api.get('/me'), api.get('/me')])
		await api.get('/me')

		expect(server.calls).toHaveLength(1)
	})
})

describe('response builders', () => {
	it('sets a JSON content type unless told otherwise', async () => {
		expect(json({ a: 1 }).headers.get('content-type')).toBe('application/json')
		expect(
			json({ a: 1 }, { headers: { 'content-type': 'application/vnd.x' } }).headers.get(
				'content-type'
			)
		).toBe('application/vnd.x')
	})

	it('builds a bodiless failure', async () => {
		const response = status(404)

		expect(response.status).toBe(404)
		expect(await response.text()).toBe('')
	})
})
