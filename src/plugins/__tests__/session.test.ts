import { describe, expect, it, vi } from 'vitest'

import { createClient } from '../../core'
import { withRequest } from '../../request'
import { jsonResponse, stubFetch } from '../../__tests__/helpers'
import { session, type SessionAdapter } from '../session'

interface User {
	name: string
}

const ok = (): Response => jsonResponse({ ok: true })

/** A cookie-style adapter: it reads a session and owns nothing else. */
function readOnlyAdapter(load: () => Promise<User | null>): SessionAdapter<User> {
	return { load }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/*
 *   LOADING
 ***************************************************************************************************/
describe('session loading', () => {
	it('starts out knowing nothing, rather than guessing', () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: readOnlyAdapter(async () => ({ name: 'Ada' })) })
		)

		expect(client.session.get().status).toBe('unknown')
	})

	it('loads once for however many callers ask at once', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: readOnlyAdapter(load) })
		)

		const results = await Promise.all([
			client.session.load(),
			client.session.load(),
			client.session.load(),
		])

		expect(load).toHaveBeenCalledOnce()
		expect(results).toEqual([{ name: 'Ada' }, { name: 'Ada' }, { name: 'Ada' }])
		expect(client.session.get().status).toBe('authenticated')
	})

	it('answers from what it already knows', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: readOnlyAdapter(load) })
		)

		await client.session.load()
		await client.session.load()

		expect(load).toHaveBeenCalledOnce()
	})

	it('re-reads on demand', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: readOnlyAdapter(load) })
		)

		await client.session.load()
		await client.session.reload()

		expect(load).toHaveBeenCalledTimes(2)
	})

	it('treats a null session as signed out, not as a failure', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: readOnlyAdapter(async () => null) })
		)

		await client.session.load()

		expect(client.session.get()).toMatchObject({
			status: 'anonymous',
			session: null,
			error: null,
		})
	})

	it('keeps a load failure separate from being signed out', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: readOnlyAdapter(() => Promise.reject(new Error('gateway down'))),
			})
		)

		await expect(client.session.load()).rejects.toThrow('gateway down')
		expect(client.session.get().status).toBe('unknown')
		expect(client.session.get().error?.message).toBe('gateway down')
	})

	it('loads eagerly when asked', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))

		createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: readOnlyAdapter(load), eager: true })
		)

		await settle()

		expect(load).toHaveBeenCalledOnce()
	})

	it('notifies subscribers and stops when they leave', async () => {
		const seen: string[] = []
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: readOnlyAdapter(async () => ({ name: 'Ada' })) })
		)

		const off = client.session.subscribe(state => seen.push(state.status))

		await client.session.load()
		off()
		client.session.clear()

		expect(seen).toEqual(['loading', 'authenticated'])
	})

	it('reads the session through the pipeline without recursing into itself', async () => {
		const stub = stubFetch(() => jsonResponse({ name: 'Ada' }))
		const client = createClient({ baseUrl: '/api', fetch: stub.fetch }).with(
			session({
				adapter: {
					load: async ctx => ctx.request<User>('/auth/session'),
				},
			})
		)

		await expect(client.session.load()).resolves.toEqual({ name: 'Ada' })
		expect(stub.calls).toHaveLength(1)
	})
})

/*
 *   TERMINAL
 ***************************************************************************************************/
describe('unrecoverable sessions', () => {
	it('hands over once, however many requests fail together', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 401)),
		}).with(session({ adapter: readOnlyAdapter(async () => null), onUnauthenticated }))

		await Promise.all([
			client.get('/a').safe(),
			client.get('/b').safe(),
			client.get('/c').safe(),
		])

		expect(onUnauthenticated).toHaveBeenCalledOnce()
		expect(client.session.get().status).toBe('anonymous')
	})

	it('cancels everything else in flight rather than letting it fail one by one', async () => {
		const client = createClient({
			fetch: (url, init) => {
				if (url === '/dead') {
					return Promise.resolve(jsonResponse({}, 401))
				}

				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener('abort', () => {
						const error = new Error('The operation was aborted.')
						error.name = 'AbortError'
						reject(error)
					})
				})
			},
		}).with(session({ adapter: readOnlyAdapter(async () => null) }))

		const hanging = client.get('/hanging').safe()
		await client.get('/dead').safe()

		expect((await hanging).error?.code).toBe('ABORTED')
	})

	it('leaves an ordinary failure alone', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 500)),
		}).with(session({ adapter: readOnlyAdapter(async () => null), onUnauthenticated }))

		expect((await client.get('/a').safe()).error?.status).toBe(500)
		expect(onUnauthenticated).not.toHaveBeenCalled()
	})

	it('does not treat a 403 as a dead session by default', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 403)),
		}).with(session({ adapter: readOnlyAdapter(async () => null), onUnauthenticated }))

		await client.get('/a').safe()

		// A 403 is usually "you may not", not "who are you" — signing the user out
		// for one would be worse than the failure itself.
		expect(onUnauthenticated).not.toHaveBeenCalled()
	})

	it('takes the adapter at its word on what counts', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 419)),
		}).with(
			session({
				adapter: {
					load: async () => null,
					isUnauthenticated: error => error.status === 419,
				},
				onUnauthenticated,
			})
		)

		await client.get('/a').safe()

		expect(onUnauthenticated).toHaveBeenCalledOnce()
	})
})

/*
 *   RECOVERY
 ***************************************************************************************************/
describe('recoverable sessions', () => {
	it('recovers once and replays what failed', async () => {
		let authorised = false
		let calls = 0
		const renew = vi.fn(async () => {
			authorised = true
			return true
		})

		const client = createClient({
			fetch: () => {
				calls++
				return Promise.resolve(
					authorised ? jsonResponse({ ok: true }) : jsonResponse({}, 401)
				)
			},
		}).with(session({ adapter: { load: async () => ({ name: 'Ada' }), renew } }))

		await expect(client.get('/a')).resolves.toEqual({ ok: true })
		expect(calls).toBe(2)
	})

	it('recovers once for a whole wave of failures', async () => {
		let authorised = false
		const renew = vi.fn(async () => {
			await settle()
			authorised = true
			return true
		})

		const client = createClient({
			fetch: () =>
				Promise.resolve(authorised ? jsonResponse({ ok: true }) : jsonResponse({}, 401)),
		}).with(session({ adapter: { load: async () => ({ name: 'Ada' }), renew } }))

		const results = await Promise.all([
			client.get('/a').safe(),
			client.get('/b').safe(),
			client.get('/c').safe(),
		])

		// The failure that rotating-token backends punish: four remotes, four
		// concurrent recoveries, three of them invalidated.
		expect(renew).toHaveBeenCalledOnce()
		expect(results.every(result => result.error === null)).toBe(true)
	})

	it('gives up when recovery fails', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 401)),
		}).with(
			session({
				adapter: { load: async () => null, renew: async () => false },
				onUnauthenticated,
			})
		)

		expect((await client.get('/a').safe()).error?.status).toBe(401)
		expect(onUnauthenticated).toHaveBeenCalledOnce()
	})

	it('does not replay forever when the replay fails too', async () => {
		let calls = 0
		const client = createClient({
			fetch: () => {
				calls++
				return Promise.resolve(jsonResponse({}, 401))
			},
		}).with(session({ adapter: { load: async () => null, renew: async () => true } }))

		await client.get('/a').safe()

		expect(calls).toBe(2)
	})
})

/*
 *   AUTHORIZE
 ***************************************************************************************************/
describe('authorized requests', () => {
	it('attaches credentials and waits for the session to be known first', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(
			session({
				adapter: {
					load: async () => ({ name: 'Ada' }),
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

		await client.get('/a')

		expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBe('Bearer Ada')
	})

	it('does not make a cookie-style adapter wait on anything', async () => {
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: readOnlyAdapter(load) })
		)

		await client.get('/a')

		expect(load).not.toHaveBeenCalled()
	})
})

/*
 *   EVENTS
 ***************************************************************************************************/
describe('session events', () => {
	it('reports each transition', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({ adapter: readOnlyAdapter(async () => ({ name: 'Ada' })) })
		)
		const seen: string[] = []

		client.events.on('session:change', event => seen.push(event.status))

		await client.session.load()

		expect(seen).toEqual(['loading', 'authenticated'])
	})
})
