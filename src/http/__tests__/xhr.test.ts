import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createXhrFetch, type UploadProgressEvent } from '../xhr'

/*
 *   FAKE XHR
 ***************************************************************************************************/
class FakeXhr extends EventTarget {
	static instances: FakeXhr[] = []

	readonly upload = new EventTarget()
	status = 0
	statusText = ''
	response: unknown = null
	responseType = ''
	withCredentials = false
	openArgs: [string, string, boolean] | undefined
	sentBody: unknown
	requestHeaders: Record<string, string> = {}
	aborted = false
	rawHeaders = ''

	constructor() {
		super()
		FakeXhr.instances.push(this)
	}

	open(method: string, url: string, async: boolean): void {
		this.openArgs = [method, url, async]
	}

	setRequestHeader(name: string, value: string): void {
		this.requestHeaders[name] = value
	}

	getAllResponseHeaders(): string {
		return this.rawHeaders
	}

	send(body?: unknown): void {
		this.sentBody = body
	}

	abort(): void {
		this.aborted = true
		this.dispatchEvent(new Event('abort'))
	}

	respond(status: number, body: unknown, rawHeaders = ''): void {
		this.status = status
		this.statusText = status === 200 ? 'OK' : 'Error'
		this.response = body
		this.rawHeaders = rawHeaders
		this.dispatchEvent(new Event('load'))
	}

	fail(): void {
		this.dispatchEvent(new Event('error'))
	}

	timeoutOut(): void {
		this.dispatchEvent(new Event('timeout'))
	}

	progress(loaded: number, total: number, lengthComputable = true): void {
		this.upload.dispatchEvent(
			Object.assign(new Event('progress'), { loaded, total, lengthComputable })
		)
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

describe('createXhrFetch', () => {
	it('opens with the method and url, then sends the body', async () => {
		const fetch = createXhrFetch()
		const form = new FormData()

		const pending = fetch('/upload', { method: 'POST', headers: {}, body: form })
		const xhr = FakeXhr.instances[0]

		expect(xhr?.openArgs).toEqual(['POST', '/upload', true])
		expect(xhr?.sentBody).toBe(form)

		xhr?.respond(200, new Blob(['ok']))
		await pending
	})

	it('defaults to GET when no method is given', async () => {
		const fetch = createXhrFetch()
		const pending = fetch('/x', { headers: {} })

		FakeXhr.instances[0]?.respond(200, new Blob())
		await pending

		expect(FakeXhr.instances[0]?.openArgs?.[0]).toBe('GET')
	})

	it('sets every header from init.headers', async () => {
		const fetch = createXhrFetch()
		const pending = fetch('/x', { headers: { 'x-tenant': 'acme' } })

		expect(FakeXhr.instances[0]?.requestHeaders['x-tenant']).toBe('acme')

		FakeXhr.instances[0]?.respond(200, new Blob())
		await pending
	})

	it('turns credentials: include into withCredentials', async () => {
		const fetch = createXhrFetch()
		const pending = fetch('/x', { headers: {}, credentials: 'include' })

		expect(FakeXhr.instances[0]?.withCredentials).toBe(true)

		FakeXhr.instances[0]?.respond(200, new Blob())
		await pending
	})

	it('leaves withCredentials alone for any other credentials mode', async () => {
		const fetch = createXhrFetch()
		const pending = fetch('/x', { headers: {}, credentials: 'omit' })

		expect(FakeXhr.instances[0]?.withCredentials).toBe(false)

		FakeXhr.instances[0]?.respond(200, new Blob())
		await pending
	})

	it('resolves with a Response carrying the status and parsed headers', async () => {
		const fetch = createXhrFetch()
		const pending = fetch('/x', { headers: {} })

		FakeXhr.instances[0]?.respond(
			201,
			new Blob(['{"id":1}']),
			'content-type: application/json\r\nx-request-id: abc\r\n'
		)

		const response = await pending

		expect(response.status).toBe(201)
		expect(response.headers.get('content-type')).toBe('application/json')
		expect(response.headers.get('x-request-id')).toBe('abc')
	})

	it('ignores a malformed header line with no colon', async () => {
		const fetch = createXhrFetch()
		const pending = fetch('/x', { headers: {} })

		FakeXhr.instances[0]?.respond(
			200,
			new Blob(),
			'not-a-header-line\r\ncontent-type: text/plain\r\n'
		)

		const response = await pending

		expect(response.headers.get('content-type')).toBe('text/plain')
	})

	it('reports upload progress as it happens', async () => {
		const onProgress = vi.fn<(event: UploadProgressEvent) => void>()
		const fetch = createXhrFetch({ onProgress })
		const pending = fetch('/x', { headers: {} })

		FakeXhr.instances[0]?.progress(50, 200)
		FakeXhr.instances[0]?.respond(200, new Blob())
		await pending

		expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: 200, percent: 25 })
	})

	it('reports total and percent as undefined when the length is not computable', async () => {
		const onProgress = vi.fn<(event: UploadProgressEvent) => void>()
		const fetch = createXhrFetch({ onProgress })
		const pending = fetch('/x', { headers: {} })

		FakeXhr.instances[0]?.progress(50, 0, false)
		FakeXhr.instances[0]?.respond(200, new Blob())
		await pending

		expect(onProgress).toHaveBeenCalledWith({
			loaded: 50,
			total: undefined,
			percent: undefined,
		})
	})

	it('rejects on a network error', async () => {
		const fetch = createXhrFetch()
		const pending = fetch('/x', { headers: {} })

		FakeXhr.instances[0]?.fail()

		await expect(pending).rejects.toThrow('Failed to fetch')
	})

	it('rejects with a named TimeoutError on timeout', async () => {
		const fetch = createXhrFetch()
		const pending = fetch('/x', { headers: {} })

		FakeXhr.instances[0]?.timeoutOut()

		await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
	})

	it('aborts the underlying xhr when the signal aborts, and rejects', async () => {
		const controller = new AbortController()
		const fetch = createXhrFetch()
		const pending = fetch('/x', { headers: {}, signal: controller.signal })

		controller.abort()

		expect(FakeXhr.instances[0]?.aborted).toBe(true)
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
	})

	it('rejects immediately for a signal that was already aborted, without opening the xhr', async () => {
		const controller = new AbortController()
		controller.abort()

		const fetch = createXhrFetch()
		const pending = fetch('/x', { headers: {}, signal: controller.signal })

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
		expect(FakeXhr.instances).toHaveLength(0)
	})
})
