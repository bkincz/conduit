import { describe, expect, it } from 'vitest'

import { createClient } from '../../core'
import { jsonResponse, stubFetch } from '../../__tests__/helpers'
import { cache } from '../cache'
import { observable } from '../observable'

const ok = (): Response => jsonResponse({ id: 1 })

const tick = (): Promise<void> => new Promise(resolve => queueMicrotask(resolve))

describe('observable', () => {
	it('starts idle for a key nothing has asked for', () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(observable())

		expect(client.observe('GET /nothing').get()).toMatchObject({
			status: 'idle',
			data: undefined,
			fetching: false,
		})
	})

	it('moves through loading to success', async () => {
		const client = createClient({ baseUrl: '/api', fetch: stubFetch(ok).fetch }).with(
			observable()
		)
		const store = client.observe<{ id: number }>(client.keyFor('/me'))
		const seen: string[] = []

		store.subscribe(state => seen.push(state.status))

		await client.get('/me')
		await tick()

		expect(store.get()).toMatchObject({ status: 'success', data: { id: 1 }, fetching: false })
		expect(seen).toContain('success')
	})

	it('records a failure without blanking what was already there', async () => {
		let calls = 0
		const client = createClient({
			fetch: () => {
				calls++
				return Promise.resolve(
					calls === 1 ? jsonResponse({ id: 1 }) : jsonResponse({}, 500)
				)
			},
		}).with(observable())

		const key = client.keyFor('/me')

		await client.get('/me')
		await client.get('/me').safe()

		expect(client.observe(key).get()).toMatchObject({
			status: 'error',
			data: { id: 1 },
			fetching: false,
		})
	})

	it('reports where the answer came from', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(observable())
			.with(cache())

		const key = client.keyFor('/me')

		await client.get('/me')
		expect(client.observe(key).get().from).toBe('network')

		await client.get('/me')
		expect(client.observe(key).get().from).toBe('cache')
	})

	it('shares one store per key, however many callers observe it', () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(observable())

		expect(client.observe('GET /me')).toBe(client.observe('GET /me'))
	})

	it('keeps separate keys separate', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(observable())

		await client.get('/a')

		expect(client.observe(client.keyFor('/a')).get().status).toBe('success')
		expect(client.observe(client.keyFor('/b')).get().status).toBe('idle')
	})

	it('evicts unwatched state past the cap', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(observable({ max: 2 }))

		await client.get('/a')
		await client.get('/b')
		await client.get('/c')

		expect(client.observedKeys()).toBe(2)
	})

	it('never evicts state something is rendering from', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(observable({ max: 1 }))

		client.observe(client.keyFor('/pinned')).subscribe(() => {})

		await client.get('/pinned')
		await client.get('/a')
		await client.get('/b')

		expect(client.observe(client.keyFor('/pinned')).get().status).toBe('success')
	})
})

describe('keyFor', () => {
	it('names the request a call would make', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ baseUrl: '/api', fetch: stub.fetch })

		const key = client.keyFor('/users/:id', { params: { id: 7 }, query: { expand: 'posts' } })

		expect(key).toBe('GET /api/users/7?expand=posts')
	})

	it('is what the cache stores under, so invalidation needs no hand-built strings', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ baseUrl: '/api', fetch: stub.fetch }).with(cache())

		await client.get('/users/:id', { params: { id: 7 } })

		expect(client.invalidate(client.keyFor('/users/:id', { params: { id: 7 } }))).toBe(true)
	})
})
