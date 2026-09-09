import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 *   DEV FLAG
 ***************************************************************************************************/
describe('DEV', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.resetModules()
	})

	it('is true when NODE_ENV is not production', async () => {
		vi.stubGlobal('process', { env: { NODE_ENV: 'development' } })

		const { DEV } = await import('../dev')

		expect(DEV).toBe(true)
	})

	it('is false when NODE_ENV is production', async () => {
		vi.stubGlobal('process', { env: { NODE_ENV: 'production' } })

		const { DEV } = await import('../dev')

		expect(DEV).toBe(false)
	})

	it('is true when NODE_ENV is unset', async () => {
		vi.stubGlobal('process', { env: {} })

		const { DEV } = await import('../dev')

		expect(DEV).toBe(true)
	})

	it('falls back to false when reading process throws, rather than a typeof guard', async () => {
		vi.stubGlobal('process', undefined)

		const { DEV } = await import('../dev')

		expect(DEV).toBe(false)
	})
})
