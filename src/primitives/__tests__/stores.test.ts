import { describe, expect, it, vi } from 'vitest'

import { createStore } from '../stores'

const tick = (): Promise<void> => new Promise(resolve => queueMicrotask(resolve))

describe('createStore', () => {
	it('reads back what was written, immediately', () => {
		const store = createStore(1)

		store.set(2)

		expect(store.get()).toBe(2)
	})

	it('notifies subscribers', async () => {
		const store = createStore(1)
		const listener = vi.fn()

		store.subscribe(listener)
		store.set(2)
		await tick()

		expect(listener).toHaveBeenCalledWith(2)
	})

	it('collapses several writes in a tick into one notification', async () => {
		const store = createStore(0)
		const listener = vi.fn()

		store.subscribe(listener)

		store.set(1)
		store.set(2)
		store.set(3)
		await tick()

		expect(listener).toHaveBeenCalledOnce()
		expect(listener).toHaveBeenCalledWith(3)
	})

	it('says nothing when the value did not change', async () => {
		const value = { a: 1 }
		const store = createStore(value)
		const listener = vi.fn()

		store.subscribe(listener)
		store.set(value)
		await tick()

		expect(listener).not.toHaveBeenCalled()
	})

	it('updates from the current value', async () => {
		const store = createStore({ count: 1 })

		store.update(current => ({ count: current.count + 1 }))

		expect(store.get()).toEqual({ count: 2 })
	})

	it('stops notifying an unsubscribed listener', async () => {
		const store = createStore(1)
		const listener = vi.fn()

		const off = store.subscribe(listener)
		off()
		store.set(2)
		await tick()

		expect(listener).not.toHaveBeenCalled()
	})

	it('honours an unsubscribe made between the write and the notification', async () => {
		const store = createStore(1)
		const listener = vi.fn()

		const off = store.subscribe(listener)
		store.set(2)
		off()
		await tick()

		expect(listener).not.toHaveBeenCalled()
	})

	it('counts its listeners, so an owner can drop what nobody watches', () => {
		const store = createStore(1)

		expect(store.listeners).toBe(0)

		const off = store.subscribe(() => {})
		expect(store.listeners).toBe(1)

		off()
		expect(store.listeners).toBe(0)
	})
})
