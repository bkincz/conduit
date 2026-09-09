/*
 *   PUBLIC API
 ***************************************************************************************************/
import {
	ConduitError,
	createClient,
	defaults,
	defineEndpoint,
	isConduitError,
	isErrorCode,
	sharedClient,
	session,
	withRequest,
	type ConduitErrorCode,
	type Endpoint,
	type SessionAdapter,
	type StandardSchemaV1,
} from '@bkincz/conduit'
import { createHooks } from '@bkincz/conduit/react'
import { attachDevtools } from '@bkincz/conduit/devtools'
import { createMockServer, status } from '@bkincz/conduit/testing'

interface User {
	id: string
	name: string
}

/*
 *   ERRORS ARE VALUES
 ***************************************************************************************************/
const error = new ConduitError({ code: 'HTTP_ERROR', message: 'nope', status: 401 })
const code: ConduitErrorCode = error.code
const retryAfter: number | undefined = error.retryAfter
const narrowed: boolean = isConduitError(error) && isErrorCode(error, 'UNAUTHENTICATED')

/*
 *   CLIENT OPTIONS
 ***************************************************************************************************/
const adapter: SessionAdapter<User> = {
	load: async ctx => (await ctx.request<{ user: User | null }>('/auth/session')).user,
	authorize: (request, user) =>
		user === null
			? request
			: withRequest(request, { headers: new Headers({ authorization: user.id }) }),
	renew: async () => true,
	expiresAt: () => Date.now() + 60_000,
	identify: user => user.id,
	onClear: () => undefined,
}

const api = sharedClient(
	'public-api.test',
	() =>
		defaults(
			createClient({
				baseUrl: '/api',
				origins: ['https://cdn.example.com'],
				redact: ['authorization'],
				logger: console,
				credentials: 'same-origin',
				keepalive: true,
			}),
			{ cache: { ttl: 1_000 }, session: { adapter, origins: ['https://api.example.com'] } }
		),
	{ contract: 'v1', version: 1 }
)

const stateStatus = api.session.get().status
const isErrorState: boolean = stateStatus === 'error'

/*
 *   ENDPOINTS AND SCHEMAS
 ***************************************************************************************************/
const userSchema: StandardSchemaV1<unknown, User> = {
	'~standard': {
		version: 1,
		vendor: 'public-api',
		validate: value => ({ value: value as User }),
	},
}

const getUser: Endpoint<{ id: string }, User> = defineEndpoint({
	method: 'GET',
	path: '/users/:id',
	response: userSchema,
	tags: vars => [`user:${vars.id}`],
})

const updateUser = defineEndpoint<{ id: string; name: string }, User>({
	method: 'PATCH',
	path: '/users/:id',
	body: vars => ({ name: vars.name }),
	invalidates: vars => [`user:${vars.id}`],
})

async function endpoints(): Promise<void> {
	const user: User = await api.call(getUser, { id: '7' })
	const key: string = api.keyFor(getUser, { id: '7' })
	api.invalidate(key)
	api.setData<User>(key, current => ({ ...(current ?? user), name: 'Ada' }))
	await api.get('/fresh', { meta: { cache: 'refresh' } })
	await api.upload('/avatars', new Blob(), { onProgress: event => event.percent })
}

/*
 *   REACT
 ***************************************************************************************************/
const hooks = createHooks(api)

function component(id: string) {
	const query = hooks.useRequest(
		getUser,
		{ id },
		{ keepPreviousData: true, refetchOnFocus: true }
	)
	const fresh: boolean = !query.isStale
	const mutation = hooks.useMutation(updateUser)
	const fallback = hooks.useMutation<User, { name: string }>(
		vars => api.post<User>('/users', vars),
		{
			invalidates: ['users'],
		}
	)
	const message: string | undefined = isConduitError(mutation.error)
		? mutation.error.message
		: undefined
	const session = hooks.useSession()
	return { fresh, message, fallback, status: session.status }
}

/*
 *   TOOLING ENTRIES
 ***************************************************************************************************/
const devtools = attachDevtools(api, { expose: false })
const server = createMockServer({ baseUrl: '/api' })
server.post('/users', status(201, { id: '2', name: 'Ada' }))

export { code, retryAfter, narrowed, isErrorState, endpoints, component, devtools, server }
