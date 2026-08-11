import { describe, expect, it } from 'vitest'

import { ConduitError, ERROR_CODES, isConduitError, isErrorCode } from '../errors'

describe('ConduitError', () => {
	it('carries the failure mode and request identity', () => {
		const error = new ConduitError({
			code: 'HTTP_ERROR',
			message: 'Request failed with 404',
			method: 'GET',
			url: '/users/1',
			status: 404,
			body: { detail: 'not found' },
		})

		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe('ConduitError')
		expect(error.code).toBe('HTTP_ERROR')
		expect(error.method).toBe('GET')
		expect(error.url).toBe('/users/1')
		expect(error.status).toBe(404)
		expect(error.body).toEqual({ detail: 'not found' })
	})

	it('leaves optional fields undefined rather than absent', () => {
		const error = new ConduitError({ code: 'NETWORK', message: 'offline' })

		expect(error.status).toBeUndefined()
		expect(error.url).toBeUndefined()
		expect(error.body).toBeUndefined()
	})

	it('sets cause only when one was supplied', () => {
		const cause = new Error('underlying')
		const withCause = new ConduitError({ code: 'NETWORK', message: 'failed', cause })
		const withoutCause = new ConduitError({ code: 'NETWORK', message: 'failed' })

		expect(withCause.cause).toBe(cause)
		expect('cause' in withoutCause).toBe(false)
	})

	it('omits the body from its log projection', () => {
		const error = new ConduitError({
			code: 'HTTP_ERROR',
			message: 'nope',
			status: 403,
			body: { email: 'user@example.com' },
		})

		expect(error.toJSON()).toEqual({
			name: 'ConduitError',
			code: 'HTTP_ERROR',
			message: 'nope',
			method: undefined,
			url: undefined,
			status: 403,
		})
		expect(JSON.stringify(error)).not.toContain('user@example.com')
	})
})

describe('isConduitError', () => {
	it('accepts a conduit error', () => {
		expect(isConduitError(new ConduitError({ code: 'TIMEOUT', message: 'slow' }))).toBe(true)
	})

	it('rejects other values', () => {
		expect(isConduitError(new Error('plain'))).toBe(false)
		expect(isConduitError(null)).toBe(false)
		expect(isConduitError(undefined)).toBe(false)
		expect(isConduitError('ConduitError')).toBe(false)
	})

	it('accepts an error from another realm, where instanceof fails', () => {
		// Stands in for a second conduit copy loaded by another federated bundle:
		// same brand, different class identity.
		const foreign = Object.assign(new Error('from another bundle'), {
			conduitError: true as const,
			code: 'NETWORK' as const,
		})

		expect(foreign instanceof ConduitError).toBe(false)
		expect(isConduitError(foreign)).toBe(true)
	})
})

describe('isErrorCode', () => {
	it('matches on the discriminant', () => {
		const error = new ConduitError({ code: 'ABORTED', message: 'cancelled' })

		expect(isErrorCode(error, 'ABORTED')).toBe(true)
		expect(isErrorCode(error, 'TIMEOUT')).toBe(false)
		expect(isErrorCode(new Error('plain'), 'ABORTED')).toBe(false)
	})
})

describe('ERROR_CODES', () => {
	it('is unique and frozen at the type level', () => {
		expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
	})
})
