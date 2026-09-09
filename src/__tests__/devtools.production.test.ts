import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../client/core'
import { createMockServer } from '../testing'

vi.mock('../primitives/dev', () => ({ DEV: false }))

afterEach(() => {
	vi.resetModules()
})

describe('devtools outside development', () => {
	it('does not expose itself by default in a production build', async () => {
		const { attachDevtools, getDevtools } = await import('../devtools')

		const client = createClient({ fetch: createMockServer().fetch })
		const devtools = attachDevtools(client)

		expect(getDevtools()).toBeUndefined()

		devtools.stop()
	})

	it('still exposes itself when asked explicitly', async () => {
		const { attachDevtools, getDevtools } = await import('../devtools')

		const client = createClient({ fetch: createMockServer().fetch })
		const devtools = attachDevtools(client, { expose: true })

		expect(getDevtools()).toBe(devtools)

		devtools.stop()
	})
})
