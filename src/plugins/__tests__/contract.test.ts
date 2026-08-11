import { describe, expect, it, vi } from 'vitest'

import { createClient } from '../../core'
import { stubFetch } from '../../__tests__/helpers'
import { contract, type ContractMismatch } from '../contract'

const versioned = (version: string | null): Response =>
	new Response('{"ok":true}', {
		headers:
			version === null
				? { 'content-type': 'application/json' }
				: { 'content-type': 'application/json', 'x-api-version': version },
	})

describe('contract', () => {
	it('says nothing when the versions agree', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const client = createClient({ fetch: stubFetch(() => versioned('v1')).fetch }).with(
			contract({ expected: 'v1' })
		)

		await client.get('/x')

		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	it('says nothing when the server does not report a version', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const client = createClient({ fetch: stubFetch(() => versioned(null)).fetch }).with(
			contract({ expected: 'v1' })
		)

		await client.get('/x')

		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	it('reports a skew between bundle and backend', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const client = createClient({ fetch: stubFetch(() => versioned('v2')).fetch }).with(
			contract({ expected: 'v1' })
		)

		await client.get('/x')

		expect(String(warn.mock.calls[0]?.[0])).toMatch(/built against API v1.*answered as v2/)
		warn.mockRestore()
	})

	it('reports once per server version, not once per request', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const client = createClient({ fetch: stubFetch(() => versioned('v2')).fetch }).with(
			contract({ expected: 'v1' })
		)

		await client.get('/a')
		await client.get('/b')
		await client.get('/c')

		expect(warn).toHaveBeenCalledOnce()
		warn.mockRestore()
	})

	it('reports again when the backend moves to a third version', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		let version = 'v2'
		const client = createClient({ fetch: stubFetch(() => versioned(version)).fetch }).with(
			contract({ expected: 'v1' })
		)

		await client.get('/a')
		version = 'v3'
		await client.get('/b')

		expect(warn).toHaveBeenCalledTimes(2)
		warn.mockRestore()
	})

	it('routes the report to a handler instead of the console', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const reports: ContractMismatch[] = []
		const client = createClient({
			baseUrl: '/api',
			fetch: stubFetch(() => versioned('v2')).fetch,
		}).with(contract({ expected: 1, onMismatch: report => reports.push(report) }))

		await client.get('/x')

		expect(warn).not.toHaveBeenCalled()
		expect(reports[0]).toEqual({ expected: '1', actual: 'v2', url: '/api/x' })
		warn.mockRestore()
	})

	it('reports on the event stream too', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const client = createClient({ fetch: stubFetch(() => versioned('v2')).fetch }).with(
			contract({ expected: 'v1' })
		)
		const seen: Array<{ expected: string; actual: string }> = []

		client.events.on('contract:mismatch', event =>
			seen.push({ expected: event.expected, actual: event.actual })
		)

		await client.get('/x')

		expect(seen).toEqual([{ expected: 'v1', actual: 'v2' }])
		vi.restoreAllMocks()
	})

	it('reads a custom header', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const client = createClient({
			fetch: stubFetch(
				() =>
					new Response('{}', {
						headers: { 'content-type': 'application/json', 'api-revision': '9' },
					})
			).fetch,
		}).with(contract({ expected: '8', header: 'api-revision' }))

		await client.get('/x')

		expect(warn).toHaveBeenCalledOnce()
		warn.mockRestore()
	})
})
