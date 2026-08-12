import { describe, expect, it } from 'vitest'

import { composeManually, composeSignals } from '../signals'

function trackListeners(signal: AbortSignal): ReadonlySet<unknown> {
	const attached = new Set<unknown>()
	const add = signal.addEventListener.bind(signal)
	const remove = signal.removeEventListener.bind(signal)

	signal.addEventListener = ((...args: Parameters<typeof add>) => {
		attached.add(args[1])
		return add(...args)
	}) as typeof add

	signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
		attached.delete(args[1])
		return remove(...args)
	}) as typeof remove

	return attached
}

describe('composeSignals', () => {
	it('produces a never-aborting signal when given none', () => {
		const composed = composeSignals([undefined, undefined])

		expect(composed.signal.aborted).toBe(false)
		expect(() => composed.release()).not.toThrow()
	})

	it('passes a lone signal straight through', () => {
		const controller = new AbortController()

		expect(composeSignals([controller.signal, undefined]).signal).toBe(controller.signal)
	})

	it('aborts when any source aborts, carrying its reason', () => {
		const first = new AbortController()
		const second = new AbortController()
		const composed = composeSignals([first.signal, second.signal])

		second.abort('second went first')

		expect(composed.signal.aborted).toBe(true)
		expect(composed.signal.reason).toBe('second went first')
	})

	it('is already aborted when a source was aborted before composing', () => {
		const spent = new AbortController()
		spent.abort('gone')

		const composed = composeSignals([spent.signal, new AbortController().signal])

		expect(composed.signal.aborted).toBe(true)
		expect(composed.signal.reason).toBe('gone')
	})
})

describe('composeManually', () => {
	it('aborts with the reason of whichever source went first', () => {
		const first = new AbortController()
		const second = new AbortController()
		const composed = composeManually([first.signal, second.signal])

		expect(composed.signal.aborted).toBe(false)
		first.abort('manual')

		expect(composed.signal.aborted).toBe(true)
		expect(composed.signal.reason).toBe('manual')
	})

	it('short-circuits on an already-aborted source', () => {
		const spent = new AbortController()
		spent.abort('gone')

		expect(composeManually([spent.signal, new AbortController().signal]).signal.aborted).toBe(
			true
		)
	})

	it('detaches listeners on release, so a long-lived scope signal does not accumulate them', () => {
		const scope = new AbortController()
		const attached = trackListeners(scope.signal)

		for (let index = 0; index < 10; index++) {
			composeManually([scope.signal, new AbortController().signal]).release()
		}

		expect(attached.size).toBe(0)
	})

	it('detaches every source once one of them fires', () => {
		const first = new AbortController()
		const second = new AbortController()
		const onFirst = trackListeners(first.signal)
		const onSecond = trackListeners(second.signal)

		composeManually([first.signal, second.signal])

		expect(onFirst.size).toBe(1)
		expect(onSecond.size).toBe(1)

		first.abort('done')

		expect(onFirst.size).toBe(0)
		expect(onSecond.size).toBe(0)
	})
})
