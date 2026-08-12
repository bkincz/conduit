import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../../client/core'
import { hangingFetch, jsonResponse, stubFetch } from '../../__tests__/helpers'
import { retry, type RetryInfo } from '../retry'

function flaky(
	failures: number,
	status = 503
): { fetch: ReturnType<typeof stubFetch>['fetch']; count: () => number } {
	let calls = 0
	const stub = stubFetch(() => {
		calls++
		return calls <= failures
			? jsonResponse({ detail: 'later' }, status)
			: jsonResponse({ ok: true })
	})

	return { fetch: stub.fetch, count: () => calls }
}

const fast = { baseDelay: 1, jitter: false } as const

afterEach(() => {
	vi.useRealTimers()
})

describe('retry', () => {
	it('replays a failing request until it succeeds', async () => {
		const server = flaky(2)
		const client = createClient({ fetch: server.fetch }).with(retry(fast))

		await expect(client.get('/x')).resolves.toEqual({ ok: true })
		expect(server.count()).toBe(3)
	})

	it('gives up after the attempt budget and reports the last failure', async () => {
		const server = flaky(5)
		const client = createClient({ fetch: server.fetch }).with(retry({ ...fast, attempts: 3 }))

		const { error } = await client.get('/x').safe()

		expect(error?.status).toBe(503)
		expect(server.count()).toBe(3)
	})

	it('counts the attempt on the response', async () => {
		const server = flaky(1)
		const client = createClient({ fetch: server.fetch }).with(retry(fast))

		expect((await client.get('/x').response()).attempt).toBe(2)
	})

	it('retries a network failure', async () => {
		let calls = 0
		const client = createClient({
			fetch: () => {
				calls++
				return calls === 1
					? Promise.reject(new TypeError('Failed to fetch'))
					: Promise.resolve(jsonResponse({ ok: true }))
			},
		}).with(retry(fast))

		await expect(client.get('/x')).resolves.toEqual({ ok: true })
	})

	it('leaves a client error alone — it will fail the same way next time', async () => {
		const server = flaky(5, 400)
		const client = createClient({ fetch: server.fetch }).with(retry(fast))

		await client.get('/x').safe()

		expect(server.count()).toBe(1)
	})

	it('refuses to replay a write by default', async () => {
		const server = flaky(5)
		const client = createClient({ fetch: server.fetch }).with(retry(fast))

		await client.post('/x', { a: 1 }).safe()

		expect(server.count()).toBe(1)
	})

	it('will replay a write when told the endpoint is safe', async () => {
		const server = flaky(1)
		const client = createClient({ fetch: server.fetch }).with(
			retry({ ...fast, idempotentOnly: false })
		)

		await expect(client.post('/x', { a: 1 })).resolves.toEqual({ ok: true })
		expect(server.count()).toBe(2)
	})

	it('does not fight a cancellation', async () => {
		const client = createClient({ fetch: hangingFetch().fetch }).with(retry(fast))
		const scope = client.scope('remote:profile')

		const pending = scope.get('/x').safe()
		scope.abort()

		expect((await pending).error?.code).toBe('ABORTED')
	})

	it('stops waiting out a backoff once the request is cancelled', async () => {
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 503)),
		}).with(retry({ attempts: 5, baseDelay: 10_000, jitter: false }))

		const scope = client.scope('remote:profile')
		const pending = scope.get('/x').safe()

		await new Promise(resolve => setTimeout(resolve, 0))
		scope.abort()

		expect((await pending).error?.code).toBe('ABORTED')
	})

	it('honours Retry-After in seconds over its own backoff', async () => {
		vi.useFakeTimers()

		let calls = 0
		const delays: number[] = []
		const client = createClient({
			fetch: () => {
				calls++
				return Promise.resolve(
					calls === 1
						? new Response('', { status: 503, headers: { 'retry-after': '2' } })
						: jsonResponse({ ok: true })
				)
			},
		}).with(
			retry({
				baseDelay: 60_000,
				jitter: false,
				onRetry: (info: RetryInfo) => delays.push(info.delay),
			})
		)

		const pending = client.get('/x')
		await vi.advanceTimersByTimeAsync(2000)

		await expect(pending).resolves.toEqual({ ok: true })
		expect(delays).toEqual([2000])
	})

	it('backs off exponentially when the server gives no instruction', async () => {
		const delays: number[] = []
		const server = flaky(2)
		const client = createClient({ fetch: server.fetch }).with(
			retry({ baseDelay: 1, jitter: false, onRetry: info => delays.push(info.delay) })
		)

		await client.get('/x')

		expect(delays).toEqual([1, 2])
	})

	it('caps the backoff', async () => {
		const delays: number[] = []
		const server = flaky(2)
		const client = createClient({ fetch: server.fetch }).with(
			retry({
				baseDelay: 100,
				maxDelay: 1,
				jitter: false,
				onRetry: info => delays.push(info.delay),
			})
		)

		await client.get('/x')

		expect(delays).toEqual([1, 1])
	})

	it('takes a caller-supplied decision', async () => {
		const server = flaky(1, 400)
		const client = createClient({ fetch: server.fetch }).with(
			retry({ ...fast, shouldRetry: error => error.status === 400 })
		)

		await expect(client.get('/x')).resolves.toEqual({ ok: true })
		expect(server.count()).toBe(2)
	})

	it('reports each attempt on the event stream', async () => {
		const server = flaky(2)
		const client = createClient({ fetch: server.fetch }).with(retry(fast))
		const attempts: number[] = []

		client.events.on('retry:attempt', event => attempts.push(event.attempt))

		await client.get('/x')

		expect(attempts).toEqual([1, 2])
	})
})
