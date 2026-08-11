import { describe, expect, it, vi } from 'vitest'

import { createClient } from '../core'
import { createEventBus, type ConduitEvent, type RequestSettleEvent } from '../events'
import { jsonResponse, stubFetch } from './helpers'

const ok = (): Response => jsonResponse({ ok: true })

const destroyEvent = { type: 'client:destroy', at: 0 } as const

/*
 *   BUS
 ***************************************************************************************************/
describe('event bus', () => {
	it('is inactive until something subscribes, and again once it leaves', () => {
		const bus = createEventBus()

		expect(bus.active).toBe(false)

		const off = bus.on('client:destroy', () => {})
		expect(bus.active).toBe(true)

		off()
		expect(bus.active).toBe(false)
	})

	it('counts an unsubscribe once, however many times it is called', () => {
		const bus = createEventBus()

		const first = bus.on('client:destroy', () => {})
		bus.on('client:destroy', () => {})

		first()
		first()
		first()

		expect(bus.active).toBe(true)
	})

	it('delivers to typed listeners and to onAny', () => {
		const bus = createEventBus()
		const typed = vi.fn()
		const any = vi.fn()

		bus.on('client:destroy', typed)
		bus.onAny(any)
		bus.emit('client:destroy', destroyEvent)

		expect(typed).toHaveBeenCalledWith(destroyEvent)
		expect(any).toHaveBeenCalledWith(destroyEvent)
	})

	it('does not deliver an event to listeners of another type', () => {
		const bus = createEventBus()
		const other = vi.fn()

		bus.on('request:start', other)
		bus.emit('client:destroy', destroyEvent)

		expect(other).not.toHaveBeenCalled()
	})

	it('keeps going when a listener throws, and says so', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const bus = createEventBus()
		const after = vi.fn()

		bus.on('client:destroy', () => {
			throw new Error('subscriber broke')
		})
		bus.on('client:destroy', after)

		expect(() => bus.emit('client:destroy', destroyEvent)).not.toThrow()
		expect(after).toHaveBeenCalledOnce()
		expect(error).toHaveBeenCalledOnce()

		error.mockRestore()
	})

	it('honours an unsubscribe made during dispatch', () => {
		const bus = createEventBus()
		const second = vi.fn()

		bus.on('client:destroy', () => {
			offSecond()
		})

		const offSecond = bus.on('client:destroy', second)

		bus.emit('client:destroy', destroyEvent)

		expect(second).not.toHaveBeenCalled()
	})

	it('does not deliver the current event to a listener added during dispatch', () => {
		const bus = createEventBus()
		const late = vi.fn()

		bus.on('client:destroy', () => {
			bus.on('client:destroy', late)
		})

		bus.emit('client:destroy', destroyEvent)

		expect(late).not.toHaveBeenCalled()
	})

	it('drops everything on clear', () => {
		const bus = createEventBus()
		const listener = vi.fn()

		bus.on('client:destroy', listener)
		bus.onAny(listener)
		bus.clear()
		bus.emit('client:destroy', destroyEvent)

		expect(bus.active).toBe(false)
		expect(listener).not.toHaveBeenCalled()
	})
})

/*
 *   CLIENT INSTRUMENTATION
 ***************************************************************************************************/
describe('client events', () => {
	it('reports a request starting and settling', async () => {
		const client = createClient({ baseUrl: '/api', fetch: stubFetch(ok).fetch })
		const seen: ConduitEvent[] = []

		client.events.onAny(event => seen.push(event))

		await client.get('/users')

		expect(seen.map(event => event.type)).toEqual(['request:start', 'request:settle'])

		const settle = seen[1] as RequestSettleEvent
		expect(settle.request.key).toBe('GET /api/users')
		expect(settle.response.status).toBe(200)
		expect(settle.duration).toBeGreaterThanOrEqual(0)
	})

	it('reports a failure instead of a settle', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({}, 500)).fetch })
		const seen: string[] = []

		client.events.onAny(event => seen.push(event.type))

		await client.get('/x').safe()

		expect(seen).toEqual(['request:start', 'request:error'])
	})

	it('attributes an event to the remote that issued it', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
		let owner: string | undefined

		client.events.on('request:start', event => {
			owner = event.request.owner
		})

		await client.scope('remote:teacher').get('/x')

		expect(owner).toBe('remote:teacher')
	})

	it('stops delivering once unsubscribed', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
		const listener = vi.fn()

		const off = client.events.onAny(listener)
		off()

		await client.get('/x')

		expect(listener).not.toHaveBeenCalled()
		expect(client.events.active).toBe(false)
	})

	it('announces its own teardown, then goes quiet', () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
		const seen: string[] = []

		client.events.onAny(event => seen.push(event.type))
		client.destroy()

		expect(seen).toEqual(['client:destroy'])
		expect(client.events.active).toBe(false)
	})

	it('lets a plugin publish onto the same stream', async () => {
		const seen: string[] = []

		const client = createClient({ fetch: stubFetch(ok).fetch }).with({
			name: 'echo',
			onInit: ctx => {
				ctx.events.on('request:settle', event => {
					seen.push(`${event.request.method} ${event.response.status}`)
				})
				return undefined
			},
		})

		await client.get('/x')

		expect(seen).toEqual(['GET 200'])
	})
})
