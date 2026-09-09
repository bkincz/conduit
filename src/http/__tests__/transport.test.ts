import { describe, expect, it } from 'vitest'

import {
	consoleLogger,
	type ConduitRequest,
	type ResolvedClientConfig,
} from '../../primitives/types'
import { createFetchTransport } from '../transport'
import { createRequest } from '../request'
import { jsonResponse } from '../../__tests__/helpers'

function resolvedConfig(overrides: Partial<ResolvedClientConfig> = {}): ResolvedClientConfig {
	return {
		baseUrl: '',
		headers: undefined,
		credentials: undefined,
		vary: '*',
		owner: undefined,
		lane: 'default',
		parse: 'auto',
		fetch: () => Promise.resolve(jsonResponse({ ok: true })),
		mode: undefined,
		redirect: undefined,
		cache: undefined,
		keepalive: undefined,
		priority: undefined,
		referrerPolicy: undefined,
		integrity: undefined,
		origins: [],
		redact: [],
		logger: consoleLogger,
		...overrides,
	}
}

function request(overrides: Partial<ConduitRequest> = {}): ConduitRequest {
	return createRequest({
		url: '/x',
		method: 'GET',
		body: null,
		signal: new AbortController().signal,
		key: 'GET /x',
		variance: '',
		lane: 'default',
		owner: undefined,
		tags: [],
		parse: 'auto',
		credentials: undefined,
		mode: undefined,
		redirect: undefined,
		cache: undefined,
		keepalive: undefined,
		priority: undefined,
		referrerPolicy: undefined,
		integrity: undefined,
		meta: {},
		buildHeaders: () => new Headers(),
		...overrides,
	})
}

describe('createFetchTransport', () => {
	it('reads formData when parse resolves to it', async () => {
		const form = new FormData()
		form.set('a', '1')
		const response = new Response(form)
		const transport = createFetchTransport(
			resolvedConfig({ fetch: () => Promise.resolve(response) })
		)

		const result = await transport(request({ parse: 'formData' }))

		expect(result.data).toBeInstanceOf(FormData)
	})

	it('sets duplex: half only when the body is a stream', async () => {
		const seen: RequestInit[] = []
		const transport = createFetchTransport(
			resolvedConfig({
				fetch: (_url, init) => {
					seen.push(init)
					return Promise.resolve(jsonResponse({ ok: true }))
				},
			})
		)

		const stream = new ReadableStream()
		await transport(request({ body: stream }))

		expect(seen[0]?.duplex).toBe('half')
	})

	it('does not set duplex for an ordinary body', async () => {
		const seen: RequestInit[] = []
		const transport = createFetchTransport(
			resolvedConfig({
				fetch: (_url, init) => {
					seen.push(init)
					return Promise.resolve(jsonResponse({ ok: true }))
				},
			})
		)

		await transport(request({ body: 'hello' }))

		expect(seen[0]?.duplex).toBeUndefined()
	})

	it('passes every RequestInit field the request carries through to fetch', async () => {
		const seen: RequestInit[] = []
		const transport = createFetchTransport(
			resolvedConfig({
				fetch: (_url, init) => {
					seen.push(init)
					return Promise.resolve(jsonResponse({ ok: true }))
				},
			})
		)

		await transport(
			request({
				mode: 'cors',
				redirect: 'error',
				cache: 'no-store',
				keepalive: true,
				priority: 'high',
				referrerPolicy: 'no-referrer',
				integrity: 'sha256-abc',
			})
		)

		expect(seen[0]).toMatchObject({
			mode: 'cors',
			redirect: 'error',
			cache: 'no-store',
			keepalive: true,
			priority: 'high',
			referrerPolicy: 'no-referrer',
			integrity: 'sha256-abc',
		})
	})

	it('leaves those fields unset when the request does not carry them', async () => {
		const seen: RequestInit[] = []
		const transport = createFetchTransport(
			resolvedConfig({
				fetch: (_url, init) => {
					seen.push(init)
					return Promise.resolve(jsonResponse({ ok: true }))
				},
			})
		)

		await transport(request())

		expect(seen[0]).not.toHaveProperty('mode')
		expect(seen[0]).not.toHaveProperty('redirect')
		expect(seen[0]).not.toHaveProperty('cache')
		expect(seen[0]).not.toHaveProperty('keepalive')
		expect(seen[0]).not.toHaveProperty('priority')
		expect(seen[0]).not.toHaveProperty('referrerPolicy')
		expect(seen[0]).not.toHaveProperty('integrity')
	})

	it('reports a body that fails to decode while the signal is aborted as ABORTED, not PARSE', async () => {
		const controller = new AbortController()
		const badResponse = new Response(
			new ReadableStream({
				start(streamController) {
					streamController.error(new Error('stream broke'))
				},
			}),
			{ headers: { 'content-type': 'application/octet-stream' } }
		)

		const transport = createFetchTransport(
			resolvedConfig({
				fetch: () => {
					controller.abort()
					return Promise.resolve(badResponse)
				},
			})
		)

		await expect(
			transport(request({ signal: controller.signal, parse: 'arrayBuffer' }))
		).rejects.toMatchObject({ code: 'ABORTED' })
	})

	it('still reports a genuine decode failure as PARSE when nothing was aborted', async () => {
		const badResponse = new Response(
			new ReadableStream({
				start(streamController) {
					streamController.error(new Error('stream broke'))
				},
			}),
			{ headers: { 'content-type': 'application/octet-stream' } }
		)

		const transport = createFetchTransport(
			resolvedConfig({ fetch: () => Promise.resolve(badResponse) })
		)

		await expect(transport(request({ parse: 'arrayBuffer' }))).rejects.toMatchObject({
			code: 'PARSE',
		})
	})

	it('reports a rejection that is not even an Error as NETWORK', async () => {
		const transport = createFetchTransport(
			resolvedConfig({ fetch: () => Promise.reject('offline') })
		)

		await expect(transport(request())).rejects.toMatchObject({ code: 'NETWORK' })
	})

	it('swallows a decode failure on a tolerant (error) response, leaving the body undefined', async () => {
		const badResponse = new Response(
			new ReadableStream({
				start(streamController) {
					streamController.error(new Error('stream broke'))
				},
			}),
			{ status: 500, headers: { 'content-type': 'application/octet-stream' } }
		)

		const transport = createFetchTransport(
			resolvedConfig({ fetch: () => Promise.resolve(badResponse) })
		)

		await expect(transport(request({ parse: 'arrayBuffer' }))).rejects.toMatchObject({
			code: 'HTTP_ERROR',
			body: undefined,
		})
	})
})
