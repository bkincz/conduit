import { afterEach, describe, expect, it } from 'vitest'

import { createClient } from '../core'
import { defaults } from '../defaults'
import { attachDevtools, getDevtools } from '../devtools'
import { createMockServer, status } from '../testing'

const tick = (): Promise<void> => new Promise(resolve => queueMicrotask(resolve))

let open: Array<{ stop(): void }> = []

afterEach(() => {
	for (const devtools of open) {
		devtools.stop()
	}

	open = []
})

function watch(client: Parameters<typeof attachDevtools>[0]): ReturnType<typeof attachDevtools> {
	const devtools = attachDevtools(client)
	open.push(devtools)

	return devtools
}

describe('devtools', () => {
	it('logs a request from start to finish', async () => {
		const server = createMockServer()
		server.get('/me', { id: 1 })

		const client = createClient({ fetch: server.fetch })
		const devtools = watch(client)

		await client.get('/me')
		await tick()

		const entry = devtools.store.get().entries[0]

		expect(entry).toMatchObject({ method: 'GET', url: '/me', state: 'success', status: 200 })
		expect(entry?.duration).toBeGreaterThanOrEqual(0)
		expect(devtools.store.get().inFlight).toBe(0)
	})

	it('records a failure with its code', async () => {
		const server = createMockServer()
		server.get('/gone', status(410, { detail: 'gone' }))

		const client = createClient({ fetch: server.fetch })
		const devtools = watch(client)

		await client.get('/gone').safe()
		await tick()

		expect(devtools.store.get().entries[0]).toMatchObject({
			state: 'error',
			status: 410,
			code: 'HTTP_ERROR',
		})
		expect(devtools.store.get().counters.failures).toBe(1)
	})

	it('says which remote issued what', async () => {
		const server = createMockServer()
		server.any('/*', { ok: true })

		const client = createClient({ fetch: server.fetch })
		const devtools = watch(client)

		await client.scope('remote:profile').get('/a')
		await client.scope('remote:teacher').get('/b')
		await tick()

		expect(devtools.store.get().entries.map(entry => entry.owner)).toEqual([
			'remote:teacher',
			'remote:profile',
		])
	})

	it('counts what the plugins are doing', async () => {
		const server = createMockServer()
		server.get('/me', { id: 1 })

		const client = defaults(createClient({ fetch: server.fetch }))
		const devtools = watch(client)

		await Promise.all([client.get('/me'), client.get('/me')])
		await client.get('/me')
		await tick()

		const counters = devtools.store.get().counters

		// Both concurrent reads miss: the cache sits outside dedupe, so neither
		// has stored anything by the time the other arrives. Dedupe is what
		// collapses them into one request below.
		expect(counters.cacheMisses).toBe(2)
		expect(counters.dedupeJoins).toBe(1)
		expect(counters.cacheHits).toBe(1)
		expect(server.calls).toHaveLength(1)
	})

	it('follows the session', async () => {
		const server = createMockServer()
		server.get('/me', { id: 1 })

		const client = defaults(createClient({ fetch: server.fetch }), {
			session: { adapter: { load: async () => ({ name: 'Ada' }) } },
		})
		const devtools = watch(client)

		await client.session.load()
		await tick()

		expect(devtools.store.get().session).toBe('authenticated')
		expect(devtools.store.get().sessionTerminal).toBe(false)
	})

	it('keeps the log bounded', async () => {
		const server = createMockServer()
		server.any('/*', { ok: true })

		const client = createClient({ fetch: server.fetch })
		const devtools = attachDevtools(client, { max: 3, expose: false })
		open.push(devtools)

		for (let index = 0; index < 6; index++) {
			await client.get(`/x${index}`)
		}

		await tick()

		expect(devtools.store.get().entries).toHaveLength(3)
	})

	it('notifies subscribers', async () => {
		const server = createMockServer()
		server.get('/me', { id: 1 })

		const client = createClient({ fetch: server.fetch })
		const devtools = watch(client)
		const seen: number[] = []

		devtools.store.subscribe(state => seen.push(state.counters.requests))

		await client.get('/me')
		await tick()

		expect(seen.at(-1)).toBe(1)
	})

	it('clears the log without losing the subscription', async () => {
		const server = createMockServer()
		server.any('/*', { ok: true })

		const client = createClient({ fetch: server.fetch })
		const devtools = watch(client)

		await client.get('/a')
		devtools.clear()

		expect(devtools.store.get().entries).toHaveLength(0)
		expect(devtools.store.get().counters.requests).toBe(0)

		await client.get('/b')
		await tick()

		expect(devtools.store.get().entries).toHaveLength(1)
	})

	it('stops watching, and takes the client back to silent', async () => {
		const server = createMockServer()
		server.any('/*', { ok: true })

		const client = createClient({ fetch: server.fetch })
		const devtools = attachDevtools(client, { expose: false })

		devtools.stop()

		await client.get('/a')
		await tick()

		expect(devtools.store.get().entries).toHaveLength(0)
		expect(client.events.active).toBe(false)
	})

	it('offers itself to the console, and cleans up after itself', async () => {
		const client = createClient({ fetch: createMockServer().fetch })

		expect(getDevtools()).toBeUndefined()

		const devtools = attachDevtools(client)
		expect(getDevtools()).toBe(devtools)

		devtools.stop()
		expect(getDevtools()).toBeUndefined()
	})

	it('stays off the global when asked', () => {
		const client = createClient({ fetch: createMockServer().fetch })
		const devtools = attachDevtools(client, { expose: false })
		open.push(devtools)

		expect(getDevtools()).toBeUndefined()
	})
})
