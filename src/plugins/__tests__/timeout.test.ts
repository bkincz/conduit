import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../core'
import { hangingFetch, jsonResponse, stubFetch } from '../../__tests__/helpers'
import { timeout } from '../timeout'

const ok = (): Response => jsonResponse({ ok: true })

afterEach(() => {
	vi.useRealTimers()
})

describe('timeout', () => {
	it('cancels a request that overruns, and says why', async () => {
		vi.useFakeTimers()

		const client = createClient({ fetch: hangingFetch().fetch }).with(timeout({ ms: 100 }))
		const pending = client.get('/slow').safe()

		await vi.advanceTimersByTimeAsync(100)

		const { error } = await pending

		expect(error?.code).toBe('TIMEOUT')
		expect(error?.message).toMatch(/exceeded its 100ms timeout/)
	})

	it('leaves a request that finishes in time alone', async () => {
		vi.useFakeTimers()

		const client = createClient({ fetch: stubFetch(ok).fetch }).with(timeout({ ms: 100 }))

		await expect(client.get('/fast')).resolves.toEqual({ ok: true })

		// Nothing should be waiting to fire against a request that already settled.
		expect(vi.getTimerCount()).toBe(0)
	})

	it('takes a per-request override', async () => {
		vi.useFakeTimers()

		const client = createClient({ fetch: hangingFetch().fetch }).with(timeout({ ms: 10_000 }))
		const pending = client.get('/slow', { meta: { timeout: 50 } }).safe()

		await vi.advanceTimersByTimeAsync(50)

		expect((await pending).error?.code).toBe('TIMEOUT')
	})

	it('is disabled by a non-positive duration', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(timeout({ ms: 0 }))

		await expect(client.get('/x')).resolves.toEqual({ ok: true })
	})

	it('attributes the timeout to the remote that issued it', async () => {
		vi.useFakeTimers()

		const client = createClient({ fetch: hangingFetch().fetch }).with(timeout({ ms: 20 }))
		const pending = client.scope('remote:admin').get('/slow').safe()

		await vi.advanceTimersByTimeAsync(20)

		expect((await pending).error?.owner).toBe('remote:admin')
	})

	it('lets an outright abort win over the timeout', async () => {
		const client = createClient({ fetch: hangingFetch().fetch }).with(timeout({ ms: 10_000 }))
		const scope = client.scope('remote:profile')

		const pending = scope.get('/slow').safe()
		scope.abort()

		expect((await pending).error?.code).toBe('ABORTED')
	})
})
