import { describe, expect, it } from 'vitest'

import { encodeBody } from '../body'

describe('encodeBody', () => {
	it('treats no body as no body', () => {
		expect(encodeBody(undefined)).toEqual({ body: null, contentType: undefined })
		expect(encodeBody(null)).toEqual({ body: null, contentType: undefined })
	})

	it('passes strings through without claiming a content type', () => {
		expect(encodeBody('raw')).toEqual({ body: 'raw', contentType: undefined })
	})

	it('leaves platform body types alone', () => {
		const form = new FormData()
		const params = new URLSearchParams('a=1')
		const blob = new Blob(['x'])
		const view = new Uint8Array([1, 2])

		expect(encodeBody(form).body).toBe(form)
		expect(encodeBody(params).body).toBe(params)
		expect(encodeBody(blob).body).toBe(blob)
		expect(encodeBody(view).body).toBe(view)
		expect(encodeBody(form).contentType).toBeUndefined()
	})

	it('JSON-encodes anything else and declares it', () => {
		expect(encodeBody({ a: 1 })).toEqual({ body: '{"a":1}', contentType: 'application/json' })
		expect(encodeBody([1, 2])).toEqual({ body: '[1,2]', contentType: 'application/json' })
		expect(encodeBody(42)).toEqual({ body: '42', contentType: 'application/json' })
	})
})
