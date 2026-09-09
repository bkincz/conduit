import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../client/core'
import { createRequest, withRequest } from '../../http/request'
import { createEventBus } from '../../primitives/events'
import type { ClientContext, ConduitRequest, Next } from '../../primitives/types'
import { jsonResponse, stubFetch } from '../../__tests__/helpers'
import { cache } from '../cache'
import { session, type SessionAdapter } from '../session'

interface User {
	name: string
}

const ok = (): Response => jsonResponse({ ok: true })

function readOnlyAdapter(load: () => Promise<User | null>): SessionAdapter<User> {
	return { load }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

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
		expect(client.session.get().status).toBe('error')
		expect(client.session.get().error?.message).toBe('gateway down')
	})

	it('keeps the previous session when a reload fails for a non-auth reason', async () => {
		let fail = false
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: readOnlyAdapter(async () => {
					if (fail) {
						throw new Error('gateway down')
					}

					return { name: 'Ada' }
				}),
			})
		)

		await client.session.load()
		fail = true
		await expect(client.session.reload()).rejects.toThrow('gateway down')

		expect(client.session.get()).toMatchObject({
			status: 'error',
			session: { name: 'Ada' },
		})
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

	it('treats a renew that throws the same as one that resolves false', async () => {
		const onUnauthenticated = vi.fn()
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 401)),
		}).with(
			session({
				adapter: {
					load: async () => null,
					renew: async () => {
						throw new Error('boom')
					},
				},
				onUnauthenticated,
			})
		)

		expect((await client.get('/a').safe()).error?.status).toBe(401)
		expect(onUnauthenticated).toHaveBeenCalledOnce()
	})
})

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

/**
 * A minimal `ClientContext`, so the plugin's own origin scoping can be
 * exercised directly against its middleware, without a full client.
 */
function fakeContext(baseUrl: string): ClientContext {
	return {
		config: {
			baseUrl,
			headers: undefined,
			credentials: undefined,
			vary: '*',
			owner: undefined,
			lane: 'default',
			parse: 'auto',
			fetch: () => Promise.reject(new Error('not used in this test')),
			mode: undefined,
			redirect: undefined,
			cache: undefined,
			keepalive: undefined,
			priority: undefined,
			referrerPolicy: undefined,
			integrity: undefined,
			origins: [],
			redact: [],
			logger: { warn: () => {}, error: () => {} },
		},
		events: createEventBus(),
		request: () => {
			throw new Error('not used in this test')
		},
		dispatch: () => {
			throw new Error('not used in this test')
		},
		abortAll: () => {},
		resetIdentity: () => {},
		onResetIdentity: () => () => {},
	}
}

function fakeRequest(url: string): ConduitRequest {
	return createRequest({
		url,
		method: 'GET',
		body: null,
		signal: new AbortController().signal,
		key: `GET ${url}`,
		variance: '',
		lane: 'default',
		owner: undefined,
		tags: [],
		parse: 'auto',
		credentials: undefined,
		mode: undefined,
		redirect: undefined,
		cache: undefined,
		keepalive: undefined,
		priority: undefined,
		referrerPolicy: undefined,
		integrity: undefined,
		meta: {},
		buildHeaders: () => new Headers(),
	})
}

function tokenAdapter(origins?: readonly string[]): ReturnType<typeof session> {
	return session({
		...(origins !== undefined && { origins }),
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
}

const echo: Next = async request => ({
	status: 200,
	headers: new Headers(),
	data: {},
	raw: undefined,
	from: 'network',
	attempt: 1,
	request,
})

describe('origin guard', () => {
	it('does not authorize a request to a foreign origin', async () => {
		const plugin = tokenAdapter()
		const ext = plugin.onInit?.(fakeContext('https://api.example.com'))
		await ext?.session.load()

		let seen: ConduitRequest | undefined
		await plugin.middleware?.(fakeRequest('https://evil.example.com/steal'), async request => {
			seen = request
			return echo(request)
		})

		expect(seen?.headers.get('authorization')).toBeNull()
	})

	it('does not authorize a foreign origin end to end, even one the client itself is allowed to call', async () => {
		const stub = stubFetch(ok)
		const client = createClient({
			baseUrl: 'https://api.example.com',
			// The client may call this origin; session's own scope is narrower.
			origins: ['https://cdn.example.com'],
			fetch: stub.fetch,
		}).with(
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

		await client.session.load()
		await client.get('https://cdn.example.com/asset')

		expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBeNull()
	})

	it('still authorizes the client’s own absolute origin', async () => {
		const stub = stubFetch(ok)
		const client = createClient({
			baseUrl: 'https://api.example.com',
			fetch: stub.fetch,
		}).with(
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

		await client.session.load()
		await client.get('/me')

		expect(new Headers(stub.calls[0]?.init.headers).get('authorization')).toBe('Bearer Ada')
	})

	it('authorizes an origin explicitly listed', async () => {
		const plugin = tokenAdapter(['https://partner.example.com'])
		const ext = plugin.onInit?.(fakeContext('https://api.example.com'))
		await ext?.session.load()

		let seen: ConduitRequest | undefined
		await plugin.middleware?.(
			fakeRequest('https://partner.example.com/shared'),
			async request => {
				seen = request
				return echo(request)
			}
		)

		expect(seen?.headers.get('authorization')).toBe('Bearer Ada')
	})

	it('treats an unparseable url as having no distinguishable origin, so it stays in scope', async () => {
		const plugin = tokenAdapter()
		const ext = plugin.onInit?.(fakeContext('https://api.example.com'))
		await ext?.session.load()

		let seen: ConduitRequest | undefined
		await plugin.middleware?.(fakeRequest('https://'), async request => {
			seen = request
			return echo(request)
		})

		expect(seen?.headers.get('authorization')).toBe('Bearer Ada')
	})

	it('does not throw when the base url itself cannot be parsed as an origin', () => {
		const plugin = tokenAdapter()

		expect(() => plugin.onInit?.(fakeContext('https://'))).not.toThrow()
	})
})

describe('the reload timer', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('arms once at the hard expiry rather than sooner, already inside the leeway window', async () => {
		vi.useFakeTimers()

		const start = Date.now()
		const expiresAt = start + 30_000
		const load = vi.fn(async () => ({ name: 'Ada' }))

		createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: { load, expiresAt: () => expiresAt },
				refreshLeeway: 60_000,
			})
		)

		expect(load).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(0)
		expect(load).not.toHaveBeenCalled()
	})

	it('reloads once at the hard expiry and then stops, rather than looping every tick', async () => {
		vi.useFakeTimers()

		const start = Date.now()
		const expiresAt = start + 30_000
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: { load, expiresAt: () => expiresAt },
				refreshLeeway: 60_000,
			})
		)

		await client.session.load()
		expect(load).toHaveBeenCalledOnce()

		await vi.advanceTimersByTimeAsync(30_000)
		expect(load).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(1_000_000)
		expect(load).toHaveBeenCalledTimes(2)
	})

	it('arms at expiry minus leeway when that is still ahead', async () => {
		vi.useFakeTimers()

		const start = Date.now()
		const expiresAt = start + 120_000
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: { load, expiresAt: () => expiresAt },
				refreshLeeway: 60_000,
			})
		)

		await client.session.load()
		expect(load).toHaveBeenCalledOnce()

		await vi.advanceTimersByTimeAsync(59_000)
		expect(load).toHaveBeenCalledOnce()

		await vi.advanceTimersByTimeAsync(2_000)
		expect(load).toHaveBeenCalledTimes(2)
	})

	it('does not arm at all once expiry is already in the past', async () => {
		vi.useFakeTimers()

		const start = Date.now()
		const load = vi.fn(async () => ({ name: 'Ada' }))
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: { load, expiresAt: () => start - 5_000 },
			})
		)

		await client.session.load()

		expect(vi.getTimerCount()).toBe(0)

		await vi.advanceTimersByTimeAsync(1_000_000)
		expect(load).toHaveBeenCalledOnce()
	})
})

describe('identity', () => {
	it('resets identity-scoped state when the adapter reports a different user', async () => {
		let name = 'Ada'
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(cache())
			.with(
				session({ adapter: { load: async () => ({ name }), identify: user => user.name } })
			)

		await client.get('/shared')
		await client.session.load()

		expect(client.cacheSize()).toBe(1)

		name = 'Grace'
		await client.session.reload()

		expect(client.cacheSize()).toBe(0)
	})

	it('does not reset when the same identity reloads', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(cache())
			.with(
				session({
					adapter: { load: async () => ({ name: 'Ada' }), identify: user => user.name },
				})
			)

		await client.get('/shared')
		await client.session.load()
		await client.session.reload()

		expect(client.cacheSize()).toBe(1)
	})

	it('falls back to the authenticated/anonymous flip without identify', async () => {
		let signedIn = true
		const client = createClient({ fetch: stubFetch(ok).fetch })
			.with(cache())
			.with(session({ adapter: { load: async () => (signedIn ? { name: 'Ada' } : null) } }))

		await client.get('/shared')
		await client.session.load()
		await client.session.reload()

		expect(client.cacheSize()).toBe(1)

		signedIn = false
		await client.session.reload()

		expect(client.cacheSize()).toBe(0)
	})
})

describe('terminal failure', () => {
	it('reports a terminal 401 as UNAUTHENTICATED, distinct from the endpoint failure', async () => {
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 401)),
		}).with(session({ adapter: readOnlyAdapter(async () => null) }))

		const result = await client.get('/a').safe()

		expect(result.error?.code).toBe('HTTP_ERROR')
		expect(client.session.get().error?.code).toBe('UNAUTHENTICATED')
	})

	it('fails fast after a terminal 401 instead of hitting the network again', async () => {
		let calls = 0
		const client = createClient({
			fetch: () => {
				calls++
				return Promise.resolve(jsonResponse({}, 401))
			},
		}).with(session({ adapter: readOnlyAdapter(async () => null) }))

		const first = await client.get('/a').safe()
		expect(first.error?.status).toBe(401)
		expect(calls).toBe(1)

		const second = await client.get('/b').safe()
		expect(second.error?.code).toBe('UNAUTHENTICATED')
		expect(calls).toBe(1)
	})

	it('resumes once a later load or reload succeeds', async () => {
		let calls = 0
		let signedOut = true
		const client = createClient({
			fetch: () => {
				calls++
				return Promise.resolve(
					signedOut ? jsonResponse({}, 401) : jsonResponse({ ok: true })
				)
			},
		}).with(session({ adapter: { load: async () => (signedOut ? null : { name: 'Ada' }) } }))

		await client.get('/a').safe()
		expect((await client.get('/b').safe()).error?.code).toBe('UNAUTHENTICATED')
		expect(calls).toBe(1)

		signedOut = false
		await client.session.reload()

		await expect(client.get('/c')).resolves.toEqual({ ok: true })
		expect(calls).toBe(2)
	})

	it('calls onClear once terminal, and again on an explicit clear', async () => {
		const onClear = vi.fn()
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 401)),
		}).with(session({ adapter: { load: async () => null, onClear } }))

		await client.get('/a').safe()
		expect(onClear).toHaveBeenCalledOnce()

		client.session.clear()
		expect(onClear).toHaveBeenCalledTimes(2)
	})
})

describe('shared recovery flight', () => {
	it('lets an in-flight reload satisfy a concurrent renew instead of calling the adapter twice', async () => {
		let releaseLoad: ((value: { name: string } | null) => void) | undefined
		const load = vi.fn(
			() =>
				new Promise<{ name: string } | null>(resolve => {
					releaseLoad = resolve
				})
		)
		const renew = vi.fn(async () => true)

		let authorised = false
		const client = createClient({
			fetch: () =>
				Promise.resolve(authorised ? jsonResponse({ ok: true }) : jsonResponse({}, 401)),
		}).with(session({ adapter: { load, renew } }))

		const reloading = client.session.reload()
		const pending = client.get('/a').safe()

		await new Promise(resolve => setTimeout(resolve, 0))

		authorised = true
		releaseLoad?.({ name: 'Ada' })

		await reloading
		expect((await pending).error).toBeNull()
		expect(renew).not.toHaveBeenCalled()
	})

	it('does not race the leeway timer against an in-flight renew', async () => {
		vi.useFakeTimers()

		interface User {
			name: string
			exp: number
		}

		const load = vi.fn(async (): Promise<User> => ({ name: 'Ada', exp: Date.now() + 30_000 }))

		let releaseRenew: (() => void) | undefined
		const renew = vi.fn(
			() =>
				new Promise<boolean>(resolve => {
					releaseRenew = () => resolve(true)
				})
		)

		let authorised = false
		const client = createClient({
			fetch: () =>
				Promise.resolve(authorised ? jsonResponse({ ok: true }) : jsonResponse({}, 401)),
		}).with(
			session({
				adapter: { load, renew, expiresAt: user => user.exp },
				refreshLeeway: 60_000,
			})
		)

		await client.session.load()
		expect(load).toHaveBeenCalledOnce()

		const pending = client.get('/a').safe()
		await vi.advanceTimersByTimeAsync(0)

		await vi.advanceTimersByTimeAsync(30_000)
		expect(load).toHaveBeenCalledOnce()

		authorised = true
		releaseRenew?.()

		await pending
		expect(load).toHaveBeenCalledTimes(2)

		vi.useRealTimers()
	})
})

describe('teardown', () => {
	it('clears its timer and subscribers on destroy, without throwing', async () => {
		vi.useFakeTimers()

		const client = createClient({ fetch: stubFetch(ok).fetch }).with(
			session({
				adapter: {
					load: async () => ({ name: 'Ada', exp: Date.now() + 60_000 }),
					expiresAt: (user: { exp: number }) => user.exp,
				},
			})
		)

		await client.session.load()
		client.session.subscribe(() => {})

		expect(() => client.destroy()).not.toThrow()
		expect(vi.getTimerCount()).toBe(0)

		vi.useRealTimers()
	})
})
