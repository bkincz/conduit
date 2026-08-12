import { describe, expect, it } from 'vitest'

import { createClient } from '../../client/core'
import { jsonResponse, stubFetch, type FetchCall } from '../../__tests__/helpers'
import { queue } from '../queue'
import type { FetchLike } from '../../primitives/types'

interface GatedFetch {
	fetch: FetchLike
	calls: FetchCall[]
	release(index: number): void
	releaseAll(): void
}

function gatedFetch(): GatedFetch {
	const calls: FetchCall[] = []
	const gates: Array<() => void> = []

	return {
		calls,
		fetch: (url, init) => {
			calls.push({ url, init })

			return new Promise<Response>(resolve => {
				gates.push(() => resolve(jsonResponse({ url })))
			})
		},
		release: index => gates[index]?.(),
		releaseAll: () => {
			for (const gate of gates) {
				gate()
			}
		},
	}
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('queue', () => {
	it('holds requests past the concurrency limit', async () => {
		const gated = gatedFetch()
		const client = createClient({ fetch: gated.fetch }).with(queue({ concurrency: 2 }))

		const pending = [client.get('/a'), client.get('/b'), client.get('/c')]
		await settle()

		expect(gated.calls).toHaveLength(2)
		expect(client.queueDepth()).toBe(1)
		expect(client.activeRequests()).toBe(2)

		gated.releaseAll()
		await settle()
		gated.releaseAll()
		await Promise.all(pending)

		expect(gated.calls).toHaveLength(3)
	})

	it('empties out once everything settles', async () => {
		const gated = gatedFetch()
		const client = createClient({ fetch: gated.fetch }).with(queue({ concurrency: 1 }))

		const pending = [client.get('/a'), client.get('/b')]

		for (let round = 0; round < 3; round++) {
			gated.releaseAll()
			await settle()
		}

		await Promise.all(pending)

		expect(client.activeRequests()).toBe(0)
		expect(client.queueDepth()).toBe(0)
	})

	it('lets the host boot path overtake a remote prefetching', async () => {
		const gated = gatedFetch()
		const client = createClient({ fetch: gated.fetch }).with(queue({ concurrency: 1 }))

		const pending = [
			client.get('/occupier'),
			client.get('/prefetch-1', { lane: 'prefetch' }),
			client.get('/prefetch-2', { lane: 'prefetch' }),
			client.get('/boot', { lane: 'critical' }),
		]

		await settle()
		expect(gated.calls.map(call => call.url)).toEqual(['/occupier'])

		gated.release(0)
		await settle()

		expect(gated.calls.map(call => call.url)).toEqual(['/occupier', '/boot'])

		for (let round = 0; round < 4; round++) {
			gated.releaseAll()
			await settle()
		}

		await Promise.all(pending)
	})

	it('keeps one lane in the order it was asked', async () => {
		const gated = gatedFetch()
		const client = createClient({ fetch: gated.fetch }).with(queue({ concurrency: 1 }))

		const pending = [client.get('/1'), client.get('/2'), client.get('/3')]

		for (let round = 0; round < 4; round++) {
			gated.releaseAll()
			await settle()
		}

		await Promise.all(pending)

		expect(gated.calls.map(call => call.url)).toEqual(['/1', '/2', '/3'])
	})

	it('sorts an unconfigured lane last rather than refusing it', async () => {
		const gated = gatedFetch()
		const client = createClient({ fetch: gated.fetch }).with(queue({ concurrency: 1 }))

		const pending = [
			client.get('/occupier'),
			client.get('/custom', { lane: 'whatever' }),
			client.get('/normal'),
		]

		gated.release(0)
		await settle()

		expect(gated.calls.map(call => call.url)).toEqual(['/occupier', '/normal'])

		for (let round = 0; round < 4; round++) {
			gated.releaseAll()
			await settle()
		}

		await Promise.all(pending)
	})

	it('stops one lane from taking the whole pool', async () => {
		const gated = gatedFetch()
		const client = createClient({ fetch: gated.fetch }).with(
			queue({ concurrency: 4, limits: { prefetch: 1 } })
		)

		const pending = [
			client.get('/p1', { lane: 'prefetch' }),
			client.get('/p2', { lane: 'prefetch' }),
			client.get('/p3', { lane: 'prefetch' }),
			client.get('/normal'),
		]

		await settle()

		expect(gated.calls.map(call => call.url)).toEqual(['/p1', '/normal'])
		expect(client.queueDepth('prefetch')).toBe(2)

		for (let round = 0; round < 5; round++) {
			gated.releaseAll()
			await settle()
		}

		await Promise.all(pending)
	})

	it('drops a queued request when its caller cancels, without spending a slot', async () => {
		const gated = gatedFetch()
		const client = createClient({ fetch: gated.fetch }).with(queue({ concurrency: 1 }))

		const occupier = client.get('/occupier')
		const scope = client.scope('remote:leaving')
		const queued = scope.get('/queued').safe()

		await settle()
		expect(client.queueDepth()).toBe(1)

		scope.abort()

		expect((await queued).error?.code).toBe('ABORTED')
		expect(client.queueDepth()).toBe(0)

		gated.releaseAll()
		await occupier

		expect(gated.calls.map(call => call.url)).toEqual(['/occupier'])
	})

	it('refuses a request that was cancelled before it arrived', async () => {
		const controller = new AbortController()
		controller.abort()

		const stub = stubFetch(() => jsonResponse({ ok: true }))
		const client = createClient({ fetch: stub.fetch }).with(queue({ concurrency: 1 }))

		const { error } = await client.get('/x', { signal: controller.signal }).safe()

		expect(error?.code).toBe('ABORTED')
		expect(stub.calls).toHaveLength(0)
		expect(client.activeRequests()).toBe(0)
	})

	it('releases the slot when a request fails', async () => {
		const client = createClient({
			fetch: () => Promise.resolve(jsonResponse({}, 500)),
		}).with(queue({ concurrency: 1 }))

		await client.get('/a').safe()
		await client.get('/b').safe()

		expect(client.activeRequests()).toBe(0)
	})

	it('lets a request skip the queue entirely', async () => {
		const gated = gatedFetch()
		const client = createClient({ fetch: gated.fetch }).with(queue({ concurrency: 1 }))

		const pending = [
			client.get('/occupier'),
			client.get('/urgent', { meta: { queue: 'bypass' } }),
		]

		await settle()

		expect(gated.calls.map(call => call.url)).toEqual(['/occupier', '/urgent'])

		gated.releaseAll()
		await Promise.all(pending)
	})

	it('reports a request having to wait', async () => {
		const gated = gatedFetch()
		const client = createClient({ fetch: gated.fetch }).with(queue({ concurrency: 1 }))
		const waits: string[] = []

		client.events.on('queue:enqueue', event => waits.push(event.lane))

		const pending = [client.get('/a'), client.get('/b', { lane: 'prefetch' })]

		for (let round = 0; round < 3; round++) {
			gated.releaseAll()
			await settle()
		}

		await Promise.all(pending)

		expect(waits).toEqual(['prefetch'])
	})
})
