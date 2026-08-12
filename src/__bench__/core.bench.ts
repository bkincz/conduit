import { bench, describe } from 'vitest'

import { createClient } from '../client/core'
import { deriveKey, deriveVariance } from '../http/keys'
import { compose } from '../http/pipeline'
import type { ConduitRequest, ConduitResponse, Middleware, Next } from '../primitives/types'

describe('deriveKey', () => {
	bench('no query', () => {
		deriveKey({ method: 'GET', url: '/api/users', body: null, variance: '' })
	})

	bench('sorted query', () => {
		deriveKey({
			method: 'GET',
			url: '/api/users?page=2&size=20&sort=name&expand=posts',
			body: null,
			variance: '',
		})
	})

	bench('with a hashed body', () => {
		deriveKey({
			method: 'POST',
			url: '/api/users',
			body: '{"name":"Ada","email":"ada@example.test"}',
			variance: '',
		})
	})
})

describe('deriveVariance', () => {
	bench('no headers', () => {
		deriveVariance(undefined, undefined, '*', undefined)
	})

	bench('client and request headers', () => {
		deriveVariance(
			{ 'x-tenant': 'acme', accept: 'application/json' },
			{ authorization: 'Bearer abc' },
			'*',
			'include'
		)
	})
})

const passthrough: Middleware = (request, next) => next(request)
const terminal: Next = async request =>
	({
		status: 200,
		headers: new Headers(),
		data: null,
		raw: undefined,
		from: 'network',
		attempt: 1,
		request,
	}) satisfies ConduitResponse

const request = { key: 'GET /x', meta: {} } as ConduitRequest

describe('dispatch', () => {
	const shallow = compose([passthrough], terminal)
	const deep = compose(
		Array.from({ length: 8 }, () => passthrough),
		terminal
	)

	bench('1 layer', async () => {
		await shallow(request)
	})

	bench('8 layers', async () => {
		await deep(request)
	})
})

const cacheHit: Middleware = async request => ({
	status: 200,
	headers: new Headers(),
	data: { id: 1 },
	raw: undefined,
	from: 'cache',
	attempt: 1,
	request,
})

const client = createClient({
	baseUrl: '/api',
	headers: () => ({ 'x-tenant': 'acme' }),
	fetch: () => Promise.reject(new Error('the benchmark should never reach the network')),
}).with({ name: 'cache-hit', middleware: cacheHit })

describe('client', () => {
	bench('short-circuited GET', async () => {
		await client.get('/users/:id', { params: { id: 7 }, query: { expand: 'posts' } })
	})
})

const watched = createClient({
	baseUrl: '/api',
	fetch: () => Promise.reject(new Error('the benchmark should never reach the network')),
}).with({ name: 'cache-hit', middleware: cacheHit })

watched.events.onAny(() => {})

describe('events', () => {
	bench('idle stream', async () => {
		await client.get('/users')
	})

	bench('one subscriber', async () => {
		await watched.get('/users')
	})
})
