import { describe, expect, it, vi } from 'vitest'

import { ConduitError } from '../../primitives/errors'
import { appendQuery, applyPathParams, buildUrl, isAbsoluteUrl, joinUrl, stripQuery } from '../url'

describe('applyPathParams', () => {
	it('substitutes and encodes placeholders', () => {
		expect(applyPathParams('/users/:id/posts/:slug', { id: 7, slug: 'a b/c' })).toBe(
			'/users/7/posts/a%20b%2Fc'
		)
	})

	it('leaves a path without placeholders alone', () => {
		expect(applyPathParams('/users', undefined)).toBe('/users')
	})

	it('fails loudly when a value is missing rather than requesting a literal placeholder', () => {
		expect(() => applyPathParams('/users/:id', {})).toThrow(ConduitError)
		expect(() => applyPathParams('/users/:id', {})).toThrow(/needs a value for ":id"/)
	})

	it('rejects an empty value rather than collapsing the segment', () => {
		expect(() => applyPathParams('/users/:id', { id: '' })).toThrow(/empty value for ":id"/)
	})

	it('rejects a whitespace-only value the same way', () => {
		expect(() => applyPathParams('/users/:id', { id: '   ' })).toThrow(/empty value for ":id"/)
	})

	it('does not resolve a name through Object.prototype instead of failing', () => {
		expect(() => applyPathParams('/users/:constructor', {})).toThrow(
			/needs a value for ":constructor"/
		)
	})

	it('warns when params were passed but the path has no placeholders', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		applyPathParams('/users', { id: 1 })

		expect(warn).toHaveBeenCalledOnce()
		expect(warn.mock.calls[0]?.[0]).toMatch(/no ":name" placeholders/)
		warn.mockRestore()
	})

	it('routes its warning through a supplied logger instead of the console', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const logger = { warn: vi.fn(), error: vi.fn() }

		applyPathParams('/users', { id: 1 }, logger)

		expect(logger.warn).toHaveBeenCalledOnce()
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})
})

describe('appendQuery', () => {
	it('drops undefined and null instead of stringifying them', () => {
		expect(appendQuery('/x', { a: 1, b: undefined, c: null, d: false })).toBe('/x?a=1&d=false')
	})

	it('repeats the key for arrays', () => {
		expect(appendQuery('/x', { tag: ['a', 'b'] })).toBe('/x?tag=a&tag=b')
	})

	it('joins onto an existing query string', () => {
		expect(appendQuery('/x?page=1', { size: 20 })).toBe('/x?page=1&size=20')
	})

	it('returns the url untouched when nothing survives', () => {
		expect(appendQuery('/x', {})).toBe('/x')
		expect(appendQuery('/x', { a: undefined })).toBe('/x')
		expect(appendQuery('/x', undefined)).toBe('/x')
	})

	it('inserts the query before the fragment rather than after it', () => {
		expect(appendQuery('/x#section', { a: 1 })).toBe('/x?a=1#section')
	})

	it('extends an existing query and keeps the fragment last', () => {
		expect(appendQuery('/x?page=1#section', { size: 20 })).toBe('/x?page=1&size=20#section')
	})
})

describe('stripQuery', () => {
	it('drops the query string', () => {
		expect(stripQuery('/x?token=secret')).toBe('/x')
	})

	it('leaves a url with no query alone', () => {
		expect(stripQuery('/x')).toBe('/x')
	})
})

describe('joinUrl', () => {
	it('joins with exactly one slash', () => {
		expect(joinUrl('/api', 'users')).toBe('/api/users')
		expect(joinUrl('/api/', '/users')).toBe('/api/users')
		expect(joinUrl('', '/users')).toBe('/users')
	})

	it('lets an absolute url on the page origin ignore the base', () => {
		expect(joinUrl('/api', 'http://localhost:3000/x')).toBe('http://localhost:3000/x')
	})

	it('lets an absolute url on the base url origin ignore the base', () => {
		expect(joinUrl('https://api.test/v1', 'https://api.test/x')).toBe('https://api.test/x')
	})

	it('rejects an absolute url on a foreign origin', () => {
		expect(() => joinUrl('/api', 'https://other.test/x')).toThrow(ConduitError)
		expect(() => joinUrl('/api', 'https://other.test/x')).toThrow(/leaves the origins/)
	})

	it('allows a foreign origin once it is on the allowlist', () => {
		expect(joinUrl('/api', 'https://other.test/x', ['https://other.test'])).toBe(
			'https://other.test/x'
		)
	})

	it('rejects an absolute url whose origin cannot even be parsed', () => {
		expect(() => joinUrl('/api', 'http://[invalid')).toThrow(ConduitError)
		expect(() => joinUrl('/api', 'http://[invalid')).toThrow(/leaves the origins/)
	})

	it('always rejects a protocol-relative url, allowlist or not', () => {
		expect(() => joinUrl('/api', '//other.test/x')).toThrow(ConduitError)
		expect(() => joinUrl('/api', '//other.test/x')).toThrow(/protocol-relative/)
		expect(() => joinUrl('/api', '//other.test/x', ['https://other.test'])).toThrow(
			/protocol-relative/
		)
	})

	it('strips the query from the rejection message but keeps it on the error url', () => {
		try {
			joinUrl('/api', 'https://other.test/x?token=secret')
			expect.unreachable('expected a rejection')
		} catch (error) {
			expect(error).toBeInstanceOf(ConduitError)
			const conduitError = error as ConduitError
			expect(conduitError.message).not.toContain('token=secret')
			expect(conduitError.url).toBe('https://other.test/x?token=secret')
		}
	})
})

describe('isAbsoluteUrl', () => {
	it('recognises schemes and protocol-relative urls', () => {
		expect(isAbsoluteUrl('https://x.test')).toBe(true)
		expect(isAbsoluteUrl('//x.test')).toBe(true)
		expect(isAbsoluteUrl('/x')).toBe(false)
		expect(isAbsoluteUrl('x')).toBe(false)
	})
})

describe('buildUrl', () => {
	it('applies params, joins and appends query in order', () => {
		expect(buildUrl('/api', '/users/:id', { id: 3 }, { expand: 'posts' })).toBe(
			'/api/users/3?expand=posts'
		)
	})

	it('rejects a foreign origin before the query is even considered', () => {
		expect(() => buildUrl('/api', 'https://other.test/x', undefined, { a: 1 })).toThrow(
			ConduitError
		)
	})

	it('honours the allowlist passed through from the client', () => {
		expect(
			buildUrl('/api', 'https://other.test/x', undefined, undefined, ['https://other.test'])
		).toBe('https://other.test/x')
	})
})
