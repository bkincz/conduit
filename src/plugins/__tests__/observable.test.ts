import { describe, expect, it } from 'vitest'

import { createClient } from '../../client/core'
import { jsonResponse, stubFetch } from '../../__tests__/helpers'
import { cache } from '../cache'
import { observable } from '../observable'
import { session } from '../session'

const ok = (): Response => jsonResponse({ id: 1 })
const tick = (): Promise<void> => new Promise(resolve => queueMicrotask(resolve))
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

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

	it('evicts unwatched state past the cap, once the grace period has passed', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(observable({ max: 2 }))

		await client.get('/a')
		await client.get('/b')
		await client.get('/c')

		// Not evicted yet. Eviction is deferred rather than run the instant
		// another key is created, so a render's not-yet-subscribed store survives.
		expect(client.observedKeys()).toBe(3)

		await flush()

		expect(client.observedKeys()).toBe(2)
	})

	it('never evicts state something is rendering from', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(observable({ max: 1 }))

		client.observe(client.keyFor('/pinned')).subscribe(() => {})

		await client.get('/pinned')
		await client.get('/a')
		await client.get('/b')
		await flush()

		expect(client.observe(client.keyFor('/pinned')).get().status).toBe('success')
		expect(client.observedKeys()).toBe(1)
	})

	it('does not evict a store created during a render before it has subscribed', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(observable({ max: 1 }))

		// Mimics two components rendering in the same pass, each creating its own
		// store via `observe()` before either has committed and subscribed.
		const rendered = client.observe(client.keyFor('/rendered'))
		client.observe(client.keyFor('/other'))

		// The grace period has not elapsed, so the freshly created store survives
		// even though it has no subscriber yet and the cap is already exceeded.
		expect(client.observedKeys()).toBe(2)

		const off = rendered.subscribe(() => {})

		await flush()

		// Now that it is subscribed and the sweep has run, "rendered" is the one
		// kept — "other" never subscribed and is what the cap actually meant to evict.
		expect(client.observedKeys()).toBe(1)
		expect(rendered.get().status).toBe('idle')

		off()
	})

	it('reaches a mounted store when a key is invalidated', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(observable())
			.with(cache())

		const key = client.keyFor('/me')

		await client.get('/me', { tags: ['users'] })
		const before = client.observe(key).get().invalidatedAt

		client.invalidateTag('users')

		expect(client.observe(key).get().invalidatedAt).toBeGreaterThan(before)
		expect(client.observe(key).get().data).toEqual({ id: 1 })
	})

	it('reaches a mounted store on a direct key invalidation too', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(observable())
			.with(cache())

		const key = client.keyFor('/me')

		await client.get('/me')
		const before = client.observe(key).get().invalidatedAt

		client.invalidate(key)

		expect(client.observe(key).get().invalidatedAt).toBeGreaterThan(before)
	})

	it('blanks every store and bumps them on an identity reset, rather than leaving them idle forever', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(observable())
			.with(session({ adapter: { load: async () => null } }))

		const key = client.keyFor('/me')

		await client.get('/me')

		const store = client.observe(key)
		const before = store.get().invalidatedAt

		expect(store.get()).toMatchObject({ status: 'success', data: { id: 1 } })

		client.session.clear()

		expect(store.get()).toMatchObject({ status: 'idle', data: undefined })
		expect(store.get().invalidatedAt).toBeGreaterThan(before)
	})

	it('bumps every store when the cache is cleared entirely', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(observable())
			.with(cache())

		await client.get('/a')
		await client.get('/b')

		const before = client.observe(client.keyFor('/a')).get().invalidatedAt

		client.clearCache()

		expect(client.observe(client.keyFor('/a')).get().invalidatedAt).toBeGreaterThan(before)
		expect(client.observe(client.keyFor('/b')).get().invalidatedAt).toBeGreaterThan(before)
	})

	it('reaches a mounted store when the cache is written to directly via setData', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(observable())
			.with(cache())

		const key = client.keyFor('/me')

		await client.get('/me')
		client.setData(key, { id: 42 })

		expect(client.observe(key).get()).toMatchObject({
			status: 'success',
			data: { id: 42 },
			from: 'cache',
		})
	})

	it('ignores setData for a key nothing is observing', () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(observable())
			.with(cache())

		expect(() => client.setData('GET /never-observed', { id: 1 })).not.toThrow()
	})

	it('tolerates unsubscribing twice', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(observable())

		const off = client.observe(client.keyFor('/me')).subscribe(() => {})

		expect(() => {
			off()
			off()
		}).not.toThrow()
	})

	it('tears down its listeners and state on destroy', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(observable())
			.with(cache())

		await client.get('/me')

		expect(() => client.destroy()).not.toThrow()
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
