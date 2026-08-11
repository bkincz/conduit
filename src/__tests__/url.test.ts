import { describe, expect, it, vi } from 'vitest'

import { ConduitError } from '../errors'
import { appendQuery, applyPathParams, buildUrl, isAbsoluteUrl, joinUrl } from '../url'

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

	it('warns when params were passed but the path has no placeholders', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		applyPathParams('/users', { id: 1 })

		expect(warn).toHaveBeenCalledOnce()
		expect(warn.mock.calls[0]?.[0]).toMatch(/no ":name" placeholders/)
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
})

describe('joinUrl', () => {
	it('joins with exactly one slash', () => {
		expect(joinUrl('/api', 'users')).toBe('/api/users')
		expect(joinUrl('/api/', '/users')).toBe('/api/users')
		expect(joinUrl('', '/users')).toBe('/users')
	})

	it('lets an absolute url ignore the base', () => {
		expect(joinUrl('/api', 'https://other.test/x')).toBe('https://other.test/x')
		expect(joinUrl('/api', '//other.test/x')).toBe('//other.test/x')
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
})
