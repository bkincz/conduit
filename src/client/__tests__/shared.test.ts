import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from '../core'
import { clearSharedClients, getSharedClient, sharedClient, type SharedMismatch } from '../shared'
import { CONDUIT_VERSION } from '../../primitives/version'
import { hangingFetch, jsonResponse, stubFetch } from '../../__tests__/helpers'

const ok = (): Response => jsonResponse({ ok: true })

afterEach(() => {
	clearSharedClients()
	vi.restoreAllMocks()
})

function seedRegistry(key: string, entry: Record<string, unknown>): void {
	const scope = globalThis as unknown as Record<string, Map<string, unknown>>
	scope['__conduitSharedClients']?.set(key, entry)
}

describe('sharedClient', () => {
	it('builds once and hands the same instance to every later caller', () => {
		const factory = vi.fn(() => createClient({ fetch: stubFetch(ok).fetch }))

		const first = sharedClient('api', factory)
		const second = sharedClient('api', factory)

		expect(second).toBe(first)
		expect(factory).toHaveBeenCalledOnce()
	})

	it('keeps separate keys separate', () => {
		const a = sharedClient('a', () => createClient({ fetch: stubFetch(ok).fetch }))
		const b = sharedClient('b', () => createClient({ fetch: stubFetch(ok).fetch }))

		expect(a).not.toBe(b)
	})

	it('shares state that matters — one client sees every remote', async () => {
		const stub = stubFetch(ok)
		const build = (): ReturnType<typeof createClient> => createClient({ fetch: stub.fetch })

		const host = sharedClient('api', build)
		const remote = sharedClient('api', build)

		const owners: Array<string | undefined> = []
		host.events.on('request:start', event => owners.push(event.request.owner))

		await remote.scope('remote:profile').get('/x')

		expect(owners).toEqual(['remote:profile'])
	})

	it('reads without creating', () => {
		expect(getSharedClient('api')).toBeUndefined()

		const client = sharedClient('api', () => createClient({ fetch: stubFetch(ok).fetch }))

		expect(getSharedClient('api')).toBe(client)
	})
})

describe('sharedClient mismatches', () => {
	it('stays quiet when the bundles agree', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const build = (): ReturnType<typeof createClient> =>
			createClient({ fetch: stubFetch(ok).fetch })

		sharedClient('api', build, { contract: 'v1', version: 1 })
		sharedClient('api', build, { contract: 'v1', version: 1 })

		expect(warn).not.toHaveBeenCalled()
	})

	it('warns when a bundle was built against a different API contract', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const build = (): ReturnType<typeof createClient> =>
			createClient({ fetch: stubFetch(ok).fetch })

		sharedClient('api', build, { contract: 'v1' })
		sharedClient('api', build, { contract: 'v2' })

		expect(warn).toHaveBeenCalledOnce()
		expect(String(warn.mock.calls[0]?.[0])).toMatch(/different version of the API/)
	})

	it('warns when a newer bundle expects a client it cannot swap', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const build = (): ReturnType<typeof createClient> =>
			createClient({ fetch: stubFetch(ok).fetch })

		sharedClient('api', build, { version: 1 })
		sharedClient('api', build, { version: 2 })

		expect(String(warn.mock.calls[0]?.[0])).toMatch(/existing client stays in use/)
	})

	it('warns when two bundles ship different copies of conduit', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const build = (): ReturnType<typeof createClient> =>
			createClient({ fetch: stubFetch(ok).fetch })

		const client = sharedClient('api', build)
		seedRegistry('api', {
			client,
			conduitVersion: '0.0.0-other',
			contract: undefined,
			version: undefined,
		})

		sharedClient('api', build)

		expect(String(warn.mock.calls[0]?.[0])).toContain('0.0.0-other')
		expect(String(warn.mock.calls[0]?.[0])).toContain(CONDUIT_VERSION)
	})

	it('routes mismatches to a handler instead of the console when given one', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const reports: SharedMismatch[] = []
		const build = (): ReturnType<typeof createClient> =>
			createClient({ fetch: stubFetch(ok).fetch })

		sharedClient('api', build, { contract: 'v1', version: 1 })
		sharedClient('api', build, {
			contract: 'v2',
			version: 2,
			onMismatch: report => reports.push(report),
		})

		expect(warn).not.toHaveBeenCalled()
		expect(reports.map(report => report.kind)).toEqual(['contract', 'client-version'])
		expect(reports[0]).toMatchObject({ key: 'api', existing: 'v1', joining: 'v2' })
	})
})

describe('owner attribution', () => {
	it('names the remote on a failed response', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({}, 500)).fetch })

		const { error } = await client.scope('remote:admin').get('/x').safe()

		expect(error?.owner).toBe('remote:admin')
	})

	it('names the remote on an abort', async () => {
		const client = createClient({ fetch: hangingFetch().fetch })
		const scope = client.scope('remote:admin')

		const pending = scope.get('/x').safe()
		scope.abort()

		expect((await pending).error?.owner).toBe('remote:admin')
	})

	it('falls back to the client owner when no scope is involved', async () => {
		const client = createClient({
			owner: 'shell',
			fetch: stubFetch(() => jsonResponse({}, 500)).fetch,
		})

		expect((await client.get('/x').safe()).error?.owner).toBe('shell')
	})

	it('includes the owner in the log projection', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({}, 500)).fetch })

		const { error } = await client.scope('remote:admin').get('/x').safe()

		expect(error?.toJSON()).toMatchObject({ owner: 'remote:admin', status: 500 })
	})
})
