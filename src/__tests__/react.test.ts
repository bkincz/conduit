import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../client/core'
import { defaults } from '../client/defaults'
import { createHooks } from '../react'
import { deferredFetch, jsonResponse, stubFetch } from './helpers'

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

		expect(result.current.error?.status).toBe(422)
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
