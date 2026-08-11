import { describe, expect, it, vi } from 'vitest'

import { createClient } from '../core'
import { defaults } from '../defaults'
import { jsonResponse, stubFetch } from './helpers'

const ok = (): Response => jsonResponse({ id: 1 })

describe('defaults', () => {
	it('installs the stack in the documented order', () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))

		// Reaching these at all proves each plugin's extension was merged.
		expect(api.cacheSize()).toBe(0)
		expect(api.inFlight()).toBe(0)
		expect(api.activeRequests()).toBe(0)
	})

	it('caches, so a second read costs nothing', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))

		await api.get('/me')
		await api.get('/me')

		expect(stub.calls).toHaveLength(1)
	})

	it('dedupes concurrent reads', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))

		await Promise.all([api.get('/me'), api.get('/me')])

		expect(stub.calls).toHaveLength(1)
	})

	it('retries a failing read', async () => {
		let calls = 0
		const api = defaults(
			createClient({
				fetch: () => {
					calls++
					return Promise.resolve(
						calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: true })
					)
				},
			}),
			{ retry: { baseDelay: 1, jitter: false } }
		)

		await expect(api.get('/x')).resolves.toEqual({ ok: true })
		expect(calls).toBe(2)
	})

	it('leaves retry out when asked', async () => {
		let calls = 0
		const api = defaults(
			createClient({
				fetch: () => {
					calls++
					return Promise.resolve(jsonResponse({}, 503))
				},
			}),
			{ retry: false }
		)

		await api.get('/x').safe()

		expect(calls).toBe(1)
	})

	it('adds the session in the middle of the stack, not on the end', async () => {
		const onUnauthenticated = vi.fn()
		const api = defaults(
			createClient({ fetch: () => Promise.resolve(jsonResponse({}, 401)) }),
			{
				session: { adapter: { load: async () => null }, onUnauthenticated },
				retry: { baseDelay: 1 },
			}
		)

		await api.get('/x').safe()

		expect(api.session.get().status).toBe('anonymous')
		expect(onUnauthenticated).toHaveBeenCalledOnce()
	})

	it('serves a cache hit without waiting on the session', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), {
			session: { adapter: { load, authorize: request => request } },
		})

		await api.get('/me')
		await api.get('/me')

		// Cache sits outside session, so the second read never reaches it.
		expect(stub.calls).toHaveLength(1)
		expect(load).toHaveBeenCalledOnce()
	})
})
