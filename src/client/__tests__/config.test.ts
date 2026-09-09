import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createClient, redactRequest, DEFAULT_REDACTED_HEADERS } from '../core'
import { timeout, TIMEOUT_META } from '../../plugins/timeout'
import type { ConduitRequest } from '../../primitives/types'
import { hangingFetch, jsonResponse, stubFetch } from '../../__tests__/helpers'

const ok = (): Response => jsonResponse({ ok: true })

describe('origins', () => {
	it('rejects a request to a foreign origin before any plugin runs', async () => {
		const seen: string[] = []
		const client = createClient({ fetch: stubFetch(ok).fetch }).with({
			name: 'watch',
			middleware: async (request, next) => {
				seen.push(request.url)
				return next(request)
			},
		})

		const { error } = await client.get('https://evil.test/x').safe()

		expect(error?.code).toBe('CONFIG')
		expect(seen).toEqual([])
	})

	it('allows a foreign origin once it is on the allowlist', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch, origins: ['https://cdn.test'] })

		await client.get('https://cdn.test/x')

		expect(stub.calls[0]?.url).toBe('https://cdn.test/x')
	})

	it('always rejects a protocol-relative url', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch, origins: ['https://cdn.test'] })

		const { error } = await client.get('//cdn.test/x').safe()

		expect(error?.code).toBe('CONFIG')
	})
})

describe('redact', () => {
	it('hides authorization, cookie and proxy-authorization by default', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
		let seenHeader: string | null = null

		client.events.on('request:settle', event => {
			seenHeader = event.request.headers.get('authorization')
		})

		const response = await client
			.get('/x', { headers: { authorization: 'Bearer secret' } })
			.response()

		expect(seenHeader).toBe('[redacted]')
		expect(response.request.headers.get('authorization')).toBe('[redacted]')
	})

	it('leaves the real request visible to the plugin chain', async () => {
		let sawRealHeader: string | null = null
		const client = createClient({ fetch: stubFetch(ok).fetch }).with({
			name: 'inspect',
			middleware: async (request, next) => {
				sawRealHeader = request.headers.get('authorization')
				return next(request)
			},
		})

		await client.get('/x', { headers: { authorization: 'Bearer secret' } })

		expect(sawRealHeader).toBe('Bearer secret')
	})

	it('uses the same object for request:start and request:settle, so a listener can correlate them', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch })
		let started: unknown
		let settled: unknown

		client.events.on('request:start', event => {
			started = event.request
		})
		client.events.on('request:settle', event => {
			settled = event.request
		})

		await client.get('/x')

		expect(settled).toBe(started)
	})

	it('can be widened or narrowed by config.redact', async () => {
		const client = createClient({
			fetch: stubFetch(ok).fetch,
			redact: ['x-api-key'],
		})

		const response = await client
			.get('/x', { headers: { authorization: 'Bearer secret', 'x-api-key': 'abc' } })
			.response()

		expect(response.request.headers.get('authorization')).toBe('Bearer secret')
		expect(response.request.headers.get('x-api-key')).toBe('[redacted]')
	})

	it('turns redaction off entirely with an empty list', async () => {
		const client = createClient({ fetch: stubFetch(ok).fetch, redact: [] })

		const response = await client
			.get('/x', { headers: { authorization: 'Bearer secret' } })
			.response()

		expect(response.request.headers.get('authorization')).toBe('Bearer secret')
	})

	it('never materialises headers on the redacted copy unless something reads them', () => {
		const Original = globalThis.Headers
		let built = 0

		globalThis.Headers = class extends Original {
			constructor(init?: HeadersInit) {
				super(init)
				built++
			}
		} as typeof Headers

		try {
			const request: ConduitRequest = {
				url: '/x',
				method: 'GET',
				get headers(): Headers {
					built++
					return new Headers({ authorization: 'Bearer secret' })
				},
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
			}

			built = 0
			redactRequest(request, DEFAULT_REDACTED_HEADERS)

			expect(built).toBe(0)
		} finally {
			globalThis.Headers = Original
		}
	})

	it('exports the default redacted header list', () => {
		expect(DEFAULT_REDACTED_HEADERS).toEqual(['authorization', 'cookie', 'proxy-authorization'])
	})
})

describe('logger', () => {
	it('routes a DEV path-params warning through config.logger instead of the console', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const logger = { warn: vi.fn(), error: vi.fn() }
		const client = createClient({ fetch: stubFetch(ok).fetch, logger })

		await client.get('/x', { params: { unused: '1' } })

		expect(logger.warn).toHaveBeenCalledOnce()
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})

	it('routes a plugin teardown failure through config.logger', () => {
		const logger = { warn: vi.fn(), error: vi.fn() }
		const client = createClient({ fetch: stubFetch(ok).fetch, logger }).with({
			name: 'flaky',
			onInit: ctx => {
				ctx.onResetIdentity(() => {
					throw new Error('boom')
				})
				return { triggerReset: () => ctx.resetIdentity() }
			},
		})

		client.triggerReset()

		expect(logger.error).toHaveBeenCalledOnce()
		expect(logger.error.mock.calls[0]?.[0]).toMatch(/A plugin threw while dropping its state/)
	})
})

describe('RequestInit passthrough', () => {
	it('applies client-level defaults to every request', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch, mode: 'cors', keepalive: true })

		await client.get('/x')

		expect(stub.calls[0]?.init).toMatchObject({ mode: 'cors', keepalive: true })
	})

	it('lets a per-request value override the client default', async () => {
		const stub = stubFetch(ok)
		const client = createClient({ fetch: stub.fetch, cache: 'default' })

		await client.get('/x', { cache: 'no-store' })

		expect(stub.calls[0]?.init).toMatchObject({ cache: 'no-store' })
	})
})

describe('client.upload', () => {
	it('sends the body through config.fetch and decodes the response, when no progress is asked for', async () => {
		const stub = stubFetch(() => jsonResponse({ id: 1 }))
		const client = createClient({ fetch: stub.fetch })
		const form = new FormData()

		await expect(client.upload('/files', form)).resolves.toEqual({ id: 1 })

		expect(stub.calls[0]?.init.method).toBe('POST')
		expect(stub.calls[0]?.init.body).toBe(form)
	})

	it('carries no default timeout even when the client installs one', async () => {
		vi.useFakeTimers()

		try {
			const client = createClient({ fetch: hangingFetch().fetch }).with(timeout({ ms: 10 }))

			let settled = false
			client
				.upload('/files', new Blob(['x']))
				.safe()
				.then(() => {
					settled = true
				})

			await vi.advanceTimersByTimeAsync(10_000)

			expect(settled).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it('still honours a caller-supplied timeout override', async () => {
		vi.useFakeTimers()

		try {
			const client = createClient({ fetch: hangingFetch().fetch }).with(timeout({ ms: 10 }))

			const pending = client
				.upload('/files', new Blob(['x']), { meta: { [TIMEOUT_META]: 5 } })
				.safe()

			await vi.advanceTimersByTimeAsync(5)

			expect((await pending).error?.code).toBe('TIMEOUT')
		} finally {
			vi.useRealTimers()
		}
	})

	it('still runs through the installed middleware stack', async () => {
		const seen: string[] = []
		const client = createClient({ fetch: stubFetch(ok).fetch }).with({
			name: 'watch',
			middleware: async (request, next) => {
				seen.push(request.method)
				return next(request)
			},
		})

		await client.upload('/files', new Blob(['x']))

		expect(seen).toEqual(['POST'])
	})

	describe('with onProgress', () => {
		class FakeXhr extends EventTarget {
			static instances: FakeXhr[] = []
			readonly upload = new EventTarget()
			status = 200
			statusText = 'OK'
			response: unknown = new Blob(['{"ok":true}'])
			responseType = ''
			withCredentials = false

			constructor() {
				super()
				FakeXhr.instances.push(this)
			}

			open(): void {}
			setRequestHeader(): void {}
			getAllResponseHeaders(): string {
				return 'content-type: application/json\r\n'
			}

			send(): void {
				queueMicrotask(() => this.dispatchEvent(new Event('load')))
			}
		}

		let originalXhr: typeof XMLHttpRequest

		beforeEach(() => {
			FakeXhr.instances = []
			originalXhr = globalThis.XMLHttpRequest
			globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
		})

		afterEach(() => {
			globalThis.XMLHttpRequest = originalXhr
		})

		it('routes through XMLHttpRequest instead of config.fetch, and reports progress', async () => {
			const stub = stubFetch(ok)
			const client = createClient({ fetch: stub.fetch })
			const onProgress = vi.fn()

			const pending = client.upload('/files', new Blob(['x']), { onProgress })

			FakeXhr.instances[0]?.upload.dispatchEvent(
				Object.assign(new Event('progress'), {
					loaded: 1,
					total: 2,
					lengthComputable: true,
				})
			)

			await expect(pending).resolves.toEqual({ ok: true })

			expect(onProgress).toHaveBeenCalledWith({ loaded: 1, total: 2, percent: 50 })
			expect(stub.calls).toHaveLength(0)
		})
	})
})
