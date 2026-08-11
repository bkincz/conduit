import { describe, expect, it } from 'vitest'

import { createClient } from '../../core'
import { deferredFetch, jsonResponse, stubFetch } from '../../__tests__/helpers'
import { dedupe } from '../dedupe'

const ok = (): Response => jsonResponse({ id: 1 })

describe('dedupe', () => {
	it('collapses concurrent identical requests into one', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(dedupe())

		const results = await Promise.all([client.get('/me'), client.get('/me'), client.get('/me')])

		expect(stub.calls).toHaveLength(1)
		expect(results).toEqual([{ id: 1 }, { id: 1 }, { id: 1 }])
	})

	it('marks the riders, not the originator', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(dedupe())

		const [first, second] = await Promise.all([
			client.get('/me').response(),
			client.get('/me').response(),
		])

		expect(first?.from).toBe('network')
		expect(second?.from).toBe('dedupe')
	})

	it('does not collapse requests that are not concurrent', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(dedupe())

		await client.get('/me')
		await client.get('/me')

		expect(stub.calls).toHaveLength(2)
	})

	it('keeps different keys apart', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(dedupe())

		await Promise.all([client.get('/me'), client.get('/others')])

		expect(stub.calls).toHaveLength(2)
	})

	it('never shares a write', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(dedupe())

		await Promise.all([client.post('/things', { a: 1 }), client.post('/things', { a: 1 })])

		expect(stub.calls).toHaveLength(2)
	})

	it('shares a failure with everyone waiting on it', async () => {
		const client = createClient({
			fetch: stubFetch(() => jsonResponse({ detail: 'no' }, 500)).fetch,
		}).with(dedupe())

		const [first, second] = await Promise.all([
			client.get('/me').safe(),
			client.get('/me').safe(),
		])

		expect(first?.error?.status).toBe(500)
		expect(second?.error?.status).toBe(500)
	})

	it('reports how many flights are open', async () => {
		const deferred = deferredFetch()
		const client = createClient({ fetch: deferred.fetch }).with(dedupe())

		const pending = Promise.all([client.get('/me'), client.get('/me')])
		expect(client.inFlight()).toBe(1)

		deferred.resolve(jsonResponse({ id: 1 }))
		await pending

		expect(client.inFlight()).toBe(0)
	})

	/*
	 * The reason dedupe is reference-counted rather than a shared promise: a
	 * remote unmounting mid-flight must not take the response away from the
	 * remote still on screen.
	 */
	it('lets one participant leave without cancelling the others', async () => {
		const deferred = deferredFetch()
		const client = createClient({ fetch: deferred.fetch }).with(dedupe())

		const leaver = client.scope('remote:leaving')
		const stayer = client.scope('remote:staying')

		const abandoned = leaver.get('/me').safe()
		const kept = stayer.get('/me').safe()

		leaver.abort()

		expect((await abandoned).error?.code).toBe('ABORTED')
		expect(deferred.aborted()).toBe(false)

		deferred.resolve(jsonResponse({ id: 1 }))

		expect((await kept).data).toEqual({ id: 1 })
	})

	it('cancels the underlying request once the last participant leaves', async () => {
		const deferred = deferredFetch()
		const client = createClient({ fetch: deferred.fetch }).with(dedupe())

		const first = client.scope('a')
		const second = client.scope('b')

		const pending = [first.get('/me').safe(), second.get('/me').safe()]

		first.abort()
		expect(deferred.aborted()).toBe(false)

		second.abort()
		expect(deferred.aborted()).toBe(true)

		const results = await Promise.all(pending)
		expect(results.map(result => result.error?.code)).toEqual(['ABORTED', 'ABORTED'])
	})

	it('rejects immediately for a signal that was already aborted', async () => {
		const controller = new AbortController()
		controller.abort()

		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(dedupe())

		const { error } = await client.get('/me', { signal: controller.signal }).safe()

		expect(error?.code).toBe('ABORTED')
	})

	it('reports a join on the event stream', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch }).with(dedupe())
		const joins: Array<string | undefined> = []

		client.events.on('dedupe:join', event => joins.push(event.owner))

		await Promise.all([client.get('/me'), client.scope('remote:teacher').get('/me')])

		expect(joins).toEqual(['remote:teacher'])
	})

	it('honours a custom sharing rule', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch }).with(
			dedupe({ shouldDedupe: request => request.method === 'POST' })
		)

		await Promise.all([client.post('/things', { a: 1 }), client.post('/things', { a: 1 })])

		expect(stub.calls).toHaveLength(1)
	})
})
