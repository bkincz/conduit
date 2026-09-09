import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../client/core'
import { defaults } from '../client/defaults'
import { defineEndpoint } from '../client/endpoint'
import { isConduitError } from '../primitives/errors'
import { createHooks } from '../react'
import { createMockServer } from '../testing'
import { deferredFetch, hangingFetch, jsonResponse, stubFetch } from './helpers'

const ok = (): Response => jsonResponse({ id: 1 })

afterEach(() => {
	cleanup()
})

describe('useRequest', () => {
	it('loads, then reports what it got', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest<{ id: number }>('/me'))

		await waitFor(() => expect(result.current.data).toEqual({ id: 1 }))

		expect(result.current.status).toBe('success')
		expect(result.current.isLoading).toBe(false)
		expect(result.current.isFetching).toBe(false)
	})

	it('reports loading while the answer is still outstanding', async () => {
		const deferred = deferredFetch()
		const api = defaults(createClient({ fetch: deferred.fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest<{ id: number }>('/me'))

		await waitFor(() => expect(result.current.isLoading).toBe(true))
		expect(result.current.data).toBeUndefined()

		deferred.resolve(jsonResponse({ id: 1 }))

		await waitFor(() => expect(result.current.isLoading).toBe(false))
		expect(result.current.data).toEqual({ id: 1 })
	})

	it('surfaces a failure as state rather than throwing at the component', async () => {
		const api = defaults(
			createClient({ fetch: () => Promise.resolve(jsonResponse({}, 500)) }),
			{
				retry: false,
			}
		)
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest('/me'))

		await waitFor(() => expect(result.current.error?.status).toBe(500))
		expect(result.current.status).toBe('error')
	})

	it('holds off while disabled', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		const { result, rerender } = renderHook(
			({ enabled }: { enabled: boolean }) => useRequest('/me', { enabled }),
			{ initialProps: { enabled: false } }
		)

		expect(stub.calls).toHaveLength(0)
		expect(result.current.status).toBe('idle')

		rerender({ enabled: true })

		await waitFor(() => expect(stub.calls).toHaveLength(1))
	})

	it('refetches when the key changes, not when the options object does', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttl: 0 } })
		const { useRequest } = createHooks(api)

		const { rerender } = renderHook(
			({ id }: { id: number }) => useRequest('/users/:id', { params: { id } }),
			{
				initialProps: { id: 1 },
			}
		)

		await waitFor(() => expect(stub.calls).toHaveLength(1))

		rerender({ id: 1 })
		rerender({ id: 1 })
		expect(stub.calls).toHaveLength(1)

		rerender({ id: 2 })
		await waitFor(() => expect(stub.calls).toHaveLength(2))
	})

	it('issues its request under the key it subscribed to', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useRequest } = createHooks(api)

		const observed: string[] = []
		const issued: (string | undefined)[] = []
		const observe = api.observe.bind(api)
		const request = api.request.bind(api)

		vi.spyOn(api, 'observe').mockImplementation(key => {
			observed.push(key)
			return observe(key)
		})
		vi.spyOn(api, 'request').mockImplementation((path, options) => {
			issued.push(options?.key)
			return request(path, options)
		})

		renderHook(() => useRequest('/me'))

		await waitFor(() => expect(issued).toHaveLength(1))

		expect(issued[0]).toBe(observed[0])
	})

	it('says so when the client names the same query two different things', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		let nonce = 0
		const api = defaults(
			createClient({
				fetch: stubFetch(ok).fetch,
				headers: () => ({ 'x-request-id': String(++nonce) }),
			})
		)
		const { useRequest } = createHooks(api)

		renderHook(() => useRequest('/me'))

		await waitFor(() => expect(warn).toHaveBeenCalled())
		expect(warn.mock.calls[0]?.[0]).toMatch(/derived two different keys/)
	})

	it('stays quiet for a header source that answers the same way twice', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const api = defaults(
			createClient({
				fetch: stubFetch(ok).fetch,
				headers: () => ({ authorization: 'Bearer steady' }),
			})
		)
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest<{ id: number }>('/me'))

		await waitFor(() => expect(result.current.data).toEqual({ id: 1 }))
		expect(warn).not.toHaveBeenCalled()
	})

	it('refetches on demand', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttl: 0 } })
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest('/me'))

		await waitFor(() => expect(stub.calls).toHaveLength(1))

		await act(async () => {
			await result.current.refetch()
		})

		expect(stub.calls).toHaveLength(2)
	})

	it('reads a cached answer and says it may be stale', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		await api.get('/me')

		const { result } = renderHook(() => useRequest('/me'))

		await waitFor(() => expect(result.current.data).toEqual({ id: 1 }))

		expect(stub.calls).toHaveLength(1)
		expect(result.current.isStale).toBe(true)
	})

	it('shares one request between two components rendering the same query', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttl: 0 } })
		const { useRequest } = createHooks(api)

		const first = renderHook(() => useRequest('/me'))
		const second = renderHook(() => useRequest('/me'))

		await waitFor(() => expect(first.result.current.data).toEqual({ id: 1 }))
		await waitFor(() => expect(second.result.current.data).toEqual({ id: 1 }))

		expect(stub.calls).toHaveLength(1)
	})

	it('cancels its own request on unmount without taking a sibling down', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttl: 0 } })
		const { useRequest } = createHooks(api)

		const leaving = renderHook(() => useRequest('/me'))
		const staying = renderHook(() => useRequest('/me'))

		leaving.unmount()

		await waitFor(() => expect(staying.result.current.data).toEqual({ id: 1 }))
		expect(staying.result.current.error).toBeUndefined()
	})

	it('treats a request that cannot yet be built as disabled, instead of throwing during render', () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useRequest } = createHooks(api)

		expect(() => renderHook(() => useRequest('/users/:id', {}))).not.toThrow()

		const { result } = renderHook(() => useRequest('/users/:id', {}))

		expect(result.current.status).toBe('idle')
		expect(result.current.error).toBeUndefined()
	})

	it('makes refetch a safe no-op while disabled', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest('/me', { enabled: false }))

		await act(async () => {
			await result.current.refetch()
		})

		expect(stub.calls).toHaveLength(0)
	})

	it('combines a caller signal with its own, instead of overwriting it', async () => {
		const hanging = hangingFetch()
		const api = defaults(createClient({ fetch: hanging.fetch }))
		const { useRequest } = createHooks(api)
		const controller = new AbortController()

		renderHook(() => useRequest('/me', { signal: controller.signal }))

		await waitFor(() => expect(hanging.calls).toHaveLength(1))

		act(() => {
			controller.abort()
		})

		await waitFor(() => expect(hanging.calls[0]?.init.signal?.aborted).toBe(true))
	})

	it('refetch forces a network refresh even when the entry is still fresh', async () => {
		let version = 1
		const stub = stubFetch(() => jsonResponse({ version: version++ }))
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest<{ version: number }>('/me'))

		await waitFor(() => expect(result.current.data).toEqual({ version: 1 }))

		await act(async () => {
			await result.current.refetch()
		})

		expect(stub.calls).toHaveLength(2)
		expect(result.current.data).toEqual({ version: 2 })
	})

	it('refetches a mounted query when its tag is invalidated', async () => {
		let version = 1
		const stub = stubFetch(() => jsonResponse({ version: version++ }))
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() =>
			useRequest<{ version: number }>('/me', { tags: ['me'] })
		)

		await waitFor(() => expect(result.current.data).toEqual({ version: 1 }))

		act(() => {
			api.invalidateTag('me')
		})

		await waitFor(() => expect(result.current.data).toEqual({ version: 2 }))
		expect(stub.calls).toHaveLength(2)
	})

	it('keeps the previous key’s data on screen while a new key loads, with keepPreviousData', async () => {
		const deferred = deferredFetch()
		const api = defaults(createClient({ fetch: deferred.fetch }))
		const { useRequest } = createHooks(api)

		const { result, rerender } = renderHook(
			({ id }: { id: number }) =>
				useRequest<{ id: number }>('/users/:id', {
					params: { id },
					keepPreviousData: true,
				}),
			{ initialProps: { id: 1 } }
		)

		deferred.resolve(jsonResponse({ id: 1 }))
		await waitFor(() => expect(result.current.data).toEqual({ id: 1 }))

		rerender({ id: 2 })

		expect(result.current.data).toEqual({ id: 1 })
		expect(result.current.isFetching).toBe(true)

		deferred.resolve(jsonResponse({ id: 2 }))
		await waitFor(() => expect(result.current.data).toEqual({ id: 2 }))
	})

	it('does not refetch on focus by default', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		renderHook(() => useRequest('/me'))
		await waitFor(() => expect(stub.calls).toHaveLength(1))

		act(() => {
			window.dispatchEvent(new Event('focus'))
		})

		expect(stub.calls).toHaveLength(1)
	})

	it('refetches on focus when opted in', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttl: 0 } })
		const { useRequest } = createHooks(api)

		renderHook(() => useRequest('/me', { refetchOnFocus: true }))
		await waitFor(() => expect(stub.calls).toHaveLength(1))

		act(() => {
			window.dispatchEvent(new Event('focus'))
		})

		await waitFor(() => expect(stub.calls).toHaveLength(2))
	})

	it('does not refetch on reconnect by default', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)

		renderHook(() => useRequest('/me'))
		await waitFor(() => expect(stub.calls).toHaveLength(1))

		act(() => {
			window.dispatchEvent(new Event('online'))
		})

		expect(stub.calls).toHaveLength(1)
	})

	it('refetches on reconnect when opted in', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }), { cache: { ttl: 0 } })
		const { useRequest } = createHooks(api)

		renderHook(() => useRequest('/me', { refetchOnReconnect: true }))
		await waitFor(() => expect(stub.calls).toHaveLength(1))

		act(() => {
			window.dispatchEvent(new Event('online'))
		})

		await waitFor(() => expect(stub.calls).toHaveLength(2))
	})
})

describe('useRequest with a defined endpoint', () => {
	it('runs it and keys it the same way client.call would', async () => {
		const stub = stubFetch(() => jsonResponse({ id: '7' }))
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { useRequest } = createHooks(api)
		const getUser = defineEndpoint<{ id: string }, { id: string }>({
			method: 'GET',
			path: '/users/:id',
		})

		const { result } = renderHook(() => useRequest(getUser, { id: '7' }))

		await waitFor(() => expect(result.current.data).toEqual({ id: '7' }))
	})

	it('treats an endpoint whose vars cannot yet fill its path as disabled', () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useRequest } = createHooks(api)
		const getUser = defineEndpoint<{ id: string }, { id: string }>({
			method: 'GET',
			path: '/users/:id',
		})

		expect(() => renderHook(() => useRequest(getUser, {} as { id: string }))).not.toThrow()

		const { result } = renderHook(() => useRequest(getUser, {} as { id: string }))

		expect(result.current.status).toBe('idle')
		expect(result.current.error).toBeUndefined()
	})
})

describe('useMutation', () => {
	it('runs, reports pending, then reports the result', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useMutation } = createHooks(api)

		const { result } = renderHook(() =>
			useMutation<{ id: number }, { name: string }>(variables =>
				api.post('/users', variables)
			)
		)

		expect(result.current.isPending).toBe(false)

		await act(async () => {
			await result.current.mutate({ name: 'Ada' })
		})

		expect(result.current.data).toEqual({ id: 1 })
		expect(result.current.isPending).toBe(false)
	})

	it('reports a failure as state instead of rejecting', async () => {
		const api = defaults(createClient({ fetch: () => Promise.resolve(jsonResponse({}, 422)) }))
		const { useMutation } = createHooks(api)

		const { result } = renderHook(() =>
			useMutation<unknown, void>(() => api.post('/users', {}))
		)

		await act(async () => {
			await expect(result.current.mutate()).resolves.toBeUndefined()
		})

		expect(isConduitError(result.current.error) && result.current.error.status).toBe(422)
	})

	it('resets', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useMutation } = createHooks(api)

		const { result } = renderHook(() =>
			useMutation<unknown, void>(() => api.post('/users', {}))
		)

		await act(async () => {
			await result.current.mutate()
		})

		act(() => {
			result.current.reset()
		})

		expect(result.current.data).toBeUndefined()
	})

	it('invalidates tags passed via options, for the function form', async () => {
		let version = 1
		const server = createMockServer()
		server.get('/me', () => ({ version: version++ }))
		server.post('/touch', {})

		const api = defaults(createClient({ fetch: server.fetch }))
		const { useRequest, useMutation } = createHooks(api)

		const query = renderHook(() => useRequest<{ version: number }>('/me', { tags: ['me'] }))
		await waitFor(() => expect(query.result.current.data).toEqual({ version: 1 }))

		const mutation = renderHook(() =>
			useMutation<unknown, void>(() => api.post('/touch', {}), { invalidates: ['me'] })
		)

		await act(async () => {
			await mutation.result.current.mutate()
		})

		await waitFor(() => expect(query.result.current.data).toEqual({ version: 2 }))
	})

	it('invalidates an endpoint’s own tags on success', async () => {
		let version = 1
		const server = createMockServer()
		server.get('/me', () => ({ version: version++ }))
		server.post('/touch', {})

		const api = defaults(createClient({ fetch: server.fetch }))
		const { useRequest, useMutation } = createHooks(api)

		const getMe = defineEndpoint<void, { version: number }>({
			method: 'GET',
			path: '/me',
			tags: ['me'],
		})
		const touchMe = defineEndpoint<void, unknown>({
			method: 'POST',
			path: '/touch',
			invalidates: ['me'],
		})

		const query = renderHook(() => useRequest(getMe, undefined))
		await waitFor(() => expect(query.result.current.data).toEqual({ version: 1 }))

		const mutation = renderHook(() => useMutation(touchMe))

		await act(async () => {
			await mutation.result.current.mutate(undefined)
		})

		await waitFor(() => expect(query.result.current.data).toEqual({ version: 2 }))
	})

	it('keeps a non-conduit error as-is, rather than casting it', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const { useMutation } = createHooks(api)
		const boom = { reason: 'not a ConduitError' }

		const { result } = renderHook(() => useMutation<unknown, void>(() => Promise.reject(boom)))

		await act(async () => {
			await result.current.mutate()
		})

		expect(result.current.error).toBe(boom)
	})
})

describe('usePrefetch', () => {
	it('warms the cache in the prefetch lane', async () => {
		const stub = stubFetch(ok)
		const api = defaults(createClient({ fetch: stub.fetch }))
		const { usePrefetch } = createHooks(api)
		const lanes: string[] = []

		api.events.on('request:start', event => lanes.push(event.request.lane))

		const { result } = renderHook(() => usePrefetch())

		act(() => {
			result.current('/me')
		})

		await waitFor(() => expect(stub.calls).toHaveLength(1))
		expect(lanes).toEqual(['prefetch'])

		await api.get('/me')
		expect(stub.calls).toHaveLength(1)
	})
})

describe('useSession', () => {
	it('follows the shared session', async () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }), {
			session: { adapter: { load: async () => ({ name: 'Ada' }) } },
		})
		const { useSession } = createHooks(api)

		const { result } = renderHook(() => useSession())

		expect(result.current.status).toBe('unknown')

		await act(async () => {
			await api.session.load()
		})

		expect(result.current.status).toBe('authenticated')
		expect(result.current.session).toEqual({ name: 'Ada' })
	})

	it('explains itself when the plugin is missing', () => {
		const api = defaults(createClient({ fetch: stubFetch(ok).fetch }))
		const hooks = createHooks(api) as unknown as { useSession(): unknown }
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})

		expect(() => renderHook(() => hooks.useSession())).toThrow(/needs the session plugin/)

		error.mockRestore()
	})
})

describe('useMutation with an endpoint and options', () => {
	it('invalidates the endpoint tags and the ones passed in', async () => {
		const server = createMockServer({ baseUrl: '/api' })
		server.get('/users', () => [{ id: 1 }])
		server.get('/teams', () => [{ id: 1 }])
		server.post('/users', () => ({ id: 2 }))
		const api = defaults(createClient({ baseUrl: '/api', fetch: server.fetch }))
		const { useRequest, useMutation } = createHooks(api)
		const create = defineEndpoint<{ name: string }, { id: number }>({
			method: 'POST',
			path: '/users',
			body: vars => vars,
			invalidates: ['users'],
		})

		const { result } = renderHook(() => ({
			users: useRequest<{ id: number }[]>('/users', { tags: ['users'] }),
			teams: useRequest<{ id: number }[]>('/teams', { tags: ['teams'] }),
			mutation: useMutation(create, { invalidates: ['teams'] }),
		}))
		await waitFor(() => expect(result.current.users.data).toBeDefined())
		await waitFor(() => expect(result.current.teams.data).toBeDefined())
		const before = server.calls.length

		await act(async () => {
			await result.current.mutation.mutate({ name: 'Ada' })
		})

		await waitFor(() => expect(server.calls.length).toBe(before + 3))
	})
})

describe('useRequest first render', () => {
	it('reports loading before the first fetch starts', () => {
		const deferred = deferredFetch()
		const api = defaults(createClient({ fetch: deferred.fetch }))
		const { useRequest } = createHooks(api)

		const { result } = renderHook(() => useRequest<{ id: number }>('/me'))

		expect(result.current.isLoading).toBe(true)
		deferred.resolve(jsonResponse({ id: 1 }))
	})
})
