import { describe, expect, it, vi } from 'vitest'

import { createClient } from '../core'
import { defineEndpoint, resolveEndpointTags, type StandardSchemaV1 } from '../endpoint'
import { jsonResponse, stubFetch } from '../../__tests__/helpers'

interface User {
	id: string
	name: string
}

function passingSchema<T>(): StandardSchemaV1<unknown, T> {
	return {
		'~standard': {
			version: 1,
			vendor: 'test',
			validate: value => ({ value: value as T }),
		},
	}
}

function failingSchema(message: string): StandardSchemaV1<unknown, never> {
	return {
		'~standard': {
			version: 1,
			vendor: 'test',
			validate: () => ({ issues: [{ message }] }),
		},
	}
}

describe('defineEndpoint', () => {
	it('brands the definition without altering it', () => {
		const endpoint = defineEndpoint<{ id: string }, User>({
			method: 'GET',
			path: '/users/:id',
		})

		expect(endpoint.kind).toBe('conduit.endpoint')
		expect(endpoint.method).toBe('GET')
		expect(endpoint.path).toBe('/users/:id')
	})
})

describe('resolveEndpointTags', () => {
	it('passes undefined through', () => {
		expect(resolveEndpointTags(undefined, { id: '1' })).toBeUndefined()
	})

	it('returns a static list as-is', () => {
		expect(resolveEndpointTags(['users'], { id: '1' })).toEqual(['users'])
	})

	it('calls a function with vars', () => {
		expect(resolveEndpointTags(vars => [`user:${vars.id}`], { id: '7' })).toEqual(['user:7'])
	})
})

describe('client.call', () => {
	it('fills path params from vars', async () => {
		const stub = stubFetch(() => jsonResponse({ id: '7', name: 'Ada' }))
		const client = createClient({ baseUrl: '/api', fetch: stub.fetch })

		const getUser = defineEndpoint<{ id: string }, User>({
			method: 'GET',
			path: '/users/:id',
		})

		const user = await client.call(getUser, { id: '7' })

		expect(stub.calls[0]?.url).toBe('/api/users/7')
		expect(user).toEqual({ id: '7', name: 'Ada' })
	})

	it('builds the query and body from vars', async () => {
		const stub = stubFetch(() => jsonResponse({ ok: true }))
		const client = createClient({ fetch: stub.fetch })

		const createUser = defineEndpoint<{ name: string }, { ok: boolean }>({
			method: 'POST',
			path: '/users',
			query: vars => ({ notify: vars.name !== '' }),
			body: vars => ({ name: vars.name }),
		})

		await client.call(createUser, { name: 'Grace' })

		expect(stub.calls[0]?.url).toBe('/users?notify=true')
		expect(stub.calls[0]?.init.body).toBe('{"name":"Grace"}')
		expect(stub.calls[0]?.init.method).toBe('POST')
	})

	it('resolves a tags function against vars', async () => {
		const client = createClient({
			fetch: stubFetch(() => jsonResponse({ ok: true })).fetch,
		}).with({
			name: 'capture',
			middleware: async (request, next) => next(request),
		})

		const getUser = defineEndpoint<{ id: string }, unknown>({
			method: 'GET',
			path: '/users/:id',
			tags: vars => [`user:${vars.id}`],
		})

		const response = await client.call(getUser, { id: '3' }).response()

		expect(response.request.tags).toEqual(['user:3'])
	})

	it('runs a plain function against the decoded body', async () => {
		const client = createClient({
			fetch: stubFetch(() => jsonResponse({ id: '1', name: 'Ada' })).fetch,
		})

		const getUser = defineEndpoint<void, string>({
			method: 'GET',
			path: '/me',
			response: (data): string => (data as User).name,
		})

		await expect(client.call(getUser, undefined)).resolves.toBe('Ada')
	})

	it('runs a StandardSchemaV1 validator and returns its value', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({ id: '1' })).fetch })

		const getUser = defineEndpoint<void, { id: string }>({
			method: 'GET',
			path: '/me',
			response: passingSchema<{ id: string }>(),
		})

		await expect(client.call(getUser, undefined)).resolves.toEqual({ id: '1' })
	})

	it('rejects with SCHEMA and the issues as body when validation fails', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({ id: '1' })).fetch })

		const getUser = defineEndpoint<void, { id: string }>({
			method: 'GET',
			path: '/me',
			response: failingSchema('id must be a number'),
		})

		const { error } = await client.call(getUser, undefined).safe()

		expect(error?.code).toBe('SCHEMA')
		expect(error?.body).toEqual([{ message: 'id must be a number' }])
	})

	it('lets explicit call options override the endpoint defaults', async () => {
		const stub = stubFetch(() => jsonResponse({ ok: true }))
		const client = createClient({ fetch: stub.fetch })

		const getThing = defineEndpoint<void, unknown>({
			method: 'GET',
			path: '/thing',
			options: { owner: 'endpoint-default' },
		})

		await client.call(getThing, undefined, { owner: 'caller' })

		expect(stub.calls[0]?.init).toBeDefined()

		const response = await client.call(getThing, undefined, { owner: 'caller' }).response()
		expect(response.request.owner).toBe('caller')
	})

	it('falls back to the endpoint default owner when the caller does not override it', async () => {
		const client = createClient({ fetch: stubFetch(() => jsonResponse({ ok: true })).fetch })

		const getThing = defineEndpoint<void, unknown>({
			method: 'GET',
			path: '/thing',
			options: { owner: 'endpoint-default' },
		})

		const response = await client.call(getThing, undefined).response()

		expect(response.request.owner).toBe('endpoint-default')
	})
})

describe('client.keyFor with an endpoint', () => {
	it('matches the key an equivalent plain request would derive', () => {
		const client = createClient({ baseUrl: '/api' })

		const getUser = defineEndpoint<{ id: string }, User>({
			method: 'GET',
			path: '/users/:id',
		})

		expect(client.keyFor(getUser, { id: '7' })).toBe(
			client.keyFor('/users/:id', { method: 'GET', params: { id: '7' } })
		)
	})
})

describe('client.call with a body endpoint', () => {
	it('does not treat vars as path params when the path has no placeholders', async () => {
		const stub = stubFetch(() => jsonResponse({ ok: true }))
		const warn = vi.fn()
		const client = createClient({ fetch: stub.fetch, logger: { warn, error: vi.fn() } })
		const list = defineEndpoint<{ page: number }, { ok: boolean }>({
			method: 'POST',
			path: '/items/list',
			body: vars => vars,
		})

		await client.call(list, { page: 2 })

		expect(warn).not.toHaveBeenCalled()
		expect(stub.calls[0]?.url).toContain('/items/list')
	})
})
