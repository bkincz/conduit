import { describe, expect, it } from 'vitest'

import {
	bodyFingerprint,
	canonicalUrl,
	deriveKey,
	deriveVariance,
	fingerprintHeaders,
	fnv1a,
} from '../keys'
import type { HttpMethod } from '../../primitives/types'

const key = (
	method: HttpMethod,
	url: string,
	body: BodyInit | null = null,
	variance = ''
): string => deriveKey({ method, url, body, variance })

describe('fnv1a', () => {
	it('is stable and differs for different input', () => {
		expect(fnv1a('abc')).toBe(fnv1a('abc'))
		expect(fnv1a('abc')).not.toBe(fnv1a('abd'))
	})

	it('handles the empty string', () => {
		expect(typeof fnv1a('')).toBe('string')
	})
})

describe('canonicalUrl', () => {
	it('sorts query parameters so ordering does not split the cache', () => {
		expect(canonicalUrl('/x?b=2&a=1')).toBe(canonicalUrl('/x?a=1&b=2'))
		expect(canonicalUrl('/x?b=2&a=1')).toBe('/x?a=1&b=2')
	})

	it('keeps a url without a query untouched', () => {
		expect(canonicalUrl('/x')).toBe('/x')
	})

	it('drops a trailing question mark', () => {
		expect(canonicalUrl('/x?')).toBe('/x')
	})

	it('keeps the caller order of a repeated key, which the server may read as meaningful', () => {
		expect(canonicalUrl('/x?sort=name&sort=age')).toBe('/x?sort=name&sort=age')
		expect(canonicalUrl('/x?sort=age&sort=name')).toBe('/x?sort=age&sort=name')
	})

	it('still sorts a repeated key relative to other keys', () => {
		expect(canonicalUrl('/x?z=1&tag=b&tag=a')).toBe('/x?tag=b&tag=a&z=1')
	})
})

describe('bodyFingerprint', () => {
	it('is empty for no body', () => {
		expect(bodyFingerprint(null)).toBe('')
	})

	it('hashes text-like bodies by value', () => {
		expect(bodyFingerprint('{"a":1}')).toBe(bodyFingerprint('{"a":1}'))
		expect(bodyFingerprint('{"a":1}')).not.toBe(bodyFingerprint('{"a":2}'))
	})

	it('hashes URLSearchParams by value', () => {
		expect(bodyFingerprint(new URLSearchParams('a=1'))).toBe(
			bodyFingerprint(new URLSearchParams('a=1'))
		)
	})

	it('gives unreadable bodies a per-instance identity, so two are never treated as equal', () => {
		const first = new FormData()
		const second = new FormData()

		expect(bodyFingerprint(first)).toBe(bodyFingerprint(first))
		expect(bodyFingerprint(first)).not.toBe(bodyFingerprint(second))
	})
})

describe('fingerprintHeaders', () => {
	it('is empty when there are no headers', () => {
		expect(fingerprintHeaders(undefined, undefined, '*')).toBe('')
	})

	it('distinguishes different values of the same header', () => {
		expect(fingerprintHeaders({ authorization: 'a' }, undefined, '*')).not.toBe(
			fingerprintHeaders({ authorization: 'b' }, undefined, '*')
		)
	})

	it('ignores header order and casing', () => {
		expect(fingerprintHeaders({ A: '1', b: '2' }, undefined, '*')).toBe(
			fingerprintHeaders({ B: '2', a: '1' }, undefined, '*')
		)
	})

	it('reads every HeadersInit shape the same way', () => {
		const expected = fingerprintHeaders({ 'x-tenant': 'acme' }, undefined, '*')

		expect(fingerprintHeaders([['x-tenant', 'acme']], undefined, '*')).toBe(expected)
		expect(fingerprintHeaders(new Headers({ 'x-tenant': 'acme' }), undefined, '*')).toBe(
			expected
		)
	})

	it('lets request headers override client headers, as the merge does', () => {
		expect(fingerprintHeaders({ 'x-tenant': 'a' }, { 'x-tenant': 'b' }, '*')).toBe(
			fingerprintHeaders(undefined, { 'x-tenant': 'b' }, '*')
		)
	})

	it('narrows to the named headers', () => {
		expect(fingerprintHeaders({ 'x-trace': '1' }, undefined, ['authorization'])).toBe('')
		expect(fingerprintHeaders({ 'x-trace': '1' }, undefined, [])).toBe('')
		expect(fingerprintHeaders({ authorization: 'a' }, undefined, ['Authorization'])).not.toBe(
			''
		)
	})
})

describe('deriveVariance', () => {
	it('is empty when nothing varies', () => {
		expect(deriveVariance(undefined, undefined, '*', undefined)).toBe('')
	})

	it('separates credential modes, which decide whether a cookie rides along', () => {
		expect(deriveVariance(undefined, undefined, '*', 'include')).not.toBe(
			deriveVariance(undefined, undefined, '*', 'omit')
		)
	})
})

describe('deriveKey', () => {
	it('stays readable', () => {
		expect(key('GET', '/users?b=2&a=1')).toBe('GET /users?a=1&b=2')
	})

	it('separates methods', () => {
		expect(key('GET', '/users')).not.toBe(key('HEAD', '/users'))
	})

	it('includes the body when there is one', () => {
		const withBody = key('POST', '/users', '{"a":1}')

		expect(withBody).not.toBe(key('POST', '/users', null))
		expect(withBody).not.toBe(key('POST', '/users', '{"a":2}'))
		expect(withBody).toBe(key('POST', '/users', '{"a":1}'))
	})

	it('separates requests that differ only by variance', () => {
		const a = deriveVariance({ authorization: 'Bearer A' }, undefined, '*', undefined)
		const b = deriveVariance({ authorization: 'Bearer B' }, undefined, '*', undefined)

		expect(key('GET', '/me', null, a)).not.toBe(key('GET', '/me', null, b))
	})
})
