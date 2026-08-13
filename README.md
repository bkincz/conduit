# Conduit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A data-fetching client for micro frontends. One client is shared by every bundle on the page, so four remotes asking for the same thing make one request, read one cache, and share one session. Sharing goes through a global registry rather than any framework's provider, so it works the same whichever framework each bundle is built with, and whether they match or not.

## Install

```bash
pnpm add @bkincz/conduit
```

## Quick start

```ts
import { createClient, defaults } from '@bkincz/conduit'

export const api = defaults(createClient({ baseUrl: '/api' }), {
	cache: { ttl: 30_000, staleWhileRevalidate: true },
})

const user = await api.get<User>('/users/:id', { params: { id: 7 } })

await api.post('/users', { name: 'Ada' })
```

`defaults()` installs the standard stack in the order the layers need to be in. Reach for `.with()` only when you want something it cannot express.

```
observable → cache → dedupe → session → retry → queue → timeout → transport
```

## Requests

`get`, `head`, `delete`, `post`, `put`, `patch`, and `request` for anything else. Bodies that are not already a `BodyInit` are JSON encoded and the content type set to match.

```ts
const user = await api.get<User>('/users/7') // the decoded body
const { status, headers } = await api.get<User>('/users/7').response()
const { data, error } = await api.get<User>('/users/7').safe() // never throws
```

| Option        | Description                                                                  |
| ------------- | ---------------------------------------------------------------------------- |
| `params`      | Fills `:name` placeholders in the path                                       |
| `query`       | Query values, arrays repeat the key                                          |
| `body`        | JSON encoded unless it is already a `BodyInit`                               |
| `headers`     | Per request headers, merged over the client's                                |
| `signal`      | Your own `AbortSignal`                                                       |
| `key`         | Override the derived cache key                                               |
| `lane`        | `critical`, `default`, `prefetch`, or your own                               |
| `owner`       | Who issued it, surfaced in devtools and on errors                            |
| `tags`        | Group entries for `invalidateTag`                                            |
| `parse`       | `auto`, `json`, `text`, `blob`, `arrayBuffer`, `formData`, `none`            |
| `credentials` | Fetch credential mode                                                        |
| `meta`        | Plugin scratch space, such as `{ timeout: 60_000 }` or `{ cache: 'bypass' }` |

And on the client:

| Option        | Description                                                    |
| ------------- | -------------------------------------------------------------- |
| `baseUrl`     | Prefixed to relative paths, absolute urls bypass it            |
| `headers`     | An object, or a function read fresh on every request           |
| `vary`        | Which headers count toward request identity, defaults to `'*'` |
| `credentials` | Default credential mode                                        |
| `owner`       | Default owner for this bundle                                  |
| `lane`        | Default lane                                                   |
| `parse`       | Default decode mode                                            |
| `fetch`       | Swap the network implementation, for tests or instrumentation  |

## Errors

Everything rejects with a `ConduitError` carrying a `code`, plus `status`, `url`, `owner`, and the decoded `body` when there was one.

```ts
import { isErrorCode } from '@bkincz/conduit'

const { data, error } = await api.get<User>('/users/7').safe()

if (isErrorCode(error, 'TIMEOUT')) retryLater()
```

`HTTP_ERROR`, `NETWORK`, `TIMEOUT`, `ABORTED`, `PARSE`, `UNAUTHENTICATED`, `CONFIG`, `UNKNOWN`.

## Cancelling

A scope is a cancellation boundary with the full request surface. Hand one to a remote on mount and abort it on unmount, and nothing it started can outlive it.

```ts
const scope = api.scope('remote:profile')

scope.get('/settings')
scope.abort() // every request made through it stops
```

## Request identity

Entries are keyed on method, url, body, decode mode, and the headers `vary` selects. Headers count by default, because two remotes calling `/me` under different tokens must not share an entry.

```ts
createClient({ vary: '*' }) // default, every header
createClient({ vary: ['authorization'] }) // only what changes the response
createClient({ vary: [] }) // url alone
```

Narrow it if you send a header that is unique per request, like a trace id. Under `'*'` that gives every request its own key, so nothing hits the cache or shares a flight.

## Plugins

Each one is middleware that can also extend the client, and the extension shows up in the type. `api.invalidate()` does not compile until `cache()` is installed.

| Plugin       | Adds to the client                                       | What it does                                                                   |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `cache`      | `invalidate`, `invalidateTag`, `clearCache`, `cacheSize` | LRU with TTL, optional stale-while-revalidate, tag invalidation                |
| `dedupe`     | `inFlight`                                               | One request per key. Unmounting cancels your wait, not everyone else's         |
| `session`    | `session`                                                | One session for the page, single-flight recovery, behind an adapter            |
| `retry`      |                                                          | Backoff with jitter, honours `Retry-After`, idempotent methods only by default |
| `queue`      | `queueDepth`, `activeRequests`                           | Bounded concurrency with priority lanes                                        |
| `timeout`    |                                                          | Per client or per request, fails with code `TIMEOUT`                           |
| `observable` | `observe`, `observedKeys`                                | Per key state for framework bindings                                           |
| `contract`   |                                                          | Reports once when this bundle and the API disagree on version                  |

Any request can step around a layer:

```ts
api.get('/live', { meta: { cache: 'bypass', dedupe: 'bypass' } })
api.get('/slow', { meta: { timeout: 60_000 } })
api.get('/urgent', { meta: { queue: 'bypass' } })
```

Cached and shared bodies are frozen, since every reader holds the same object.

## Session

conduit owns the hard parts, the adapter owns whatever is specific to your backend. A cookie backend implements `load` and nothing else. A token backend adds `authorize` and `renew`.

```ts
const adapter: SessionAdapter<User> = {
	load: async ctx => (await ctx.request<{ user: User | null }>('/auth/session')).user,
	authorize: (request, user) =>
		user === null ? request : withRequest(request, { headers: bearer(user) }),
	renew: async ctx => (await ctx.request('/auth/refresh').safe()).error === null,
	expiresAt: user => user.exp * 1000,
}

const api = defaults(createClient({ baseUrl: '/api' }), { session: { adapter } })

api.session.get() // { status, session, error, updatedAt }
api.session.subscribe(state => render(state))
await api.session.load()
```

Four remotes hitting a 401 together produce one recovery, not four. When it cannot be recovered, everything in flight is aborted, cached responses are dropped, and `onUnauthenticated` fires once.

## One client across bundles

Each federated bundle gets its own module instance, so a client built in the host is invisible to a remote. A global registry fixes that.

```ts
export const api = sharedClient(
	'bkincz.api',
	() => defaults(createClient({ baseUrl: '/api' })),
	{ contract: 'v1', version: 1 } // warns when bundles disagree
)
```

The first caller builds it and everyone else gets that same instance. A later caller's factory never runs, which is what `contract` and `version` are there to warn you about.

Tearing one down means deregistering it too, or the next bundle to ask gets the dead one:

```ts
api.destroy()
releaseSharedClient('bkincz.api')
```

## React

```ts
// api.ts
export const api = sharedClient('bkincz.api', () =>
	defaults(createClient({ baseUrl: '/api' }), { session: { adapter } })
)

export const { useRequest, useMutation, usePrefetch, useSession } = createHooks(api)
```

```tsx
function Profile({ id }: { id: string }) {
	const { data, error, isLoading } = useRequest<User>('/users/:id', {
		params: { id },
		tags: ['users'],
	})

	if (isLoading) return <Spinner />
	if (error) return <ErrorCard code={error.code} />

	return <Card user={data!} />
}
```

| Field                     | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| `data`, `error`, `status` | The current state of this query                       |
| `isLoading`               | Nothing on screen yet and a request is in the air     |
| `isFetching`              | A request is in the air, with or without data showing |
| `isStale`                 | The last answer came from cache                       |
| `refetch()`               | Run it again                                          |
| `enabled: false`          | Hold off until a dependency is ready                  |

There is no provider. The hooks bind to a client at module scope, so every remote importing them shares it. Two components rendering the same query share one store and one request, and the second to mount renders what the first already fetched without a round trip. Unmounting cancels that component's interest only.

The hook re-subscribes when the key changes, not when the options object does, so a fresh `params` object every render costs nothing. `enabled` is how one query waits on another:

```tsx
function Invoices() {
	const { data: user } = useRequest<User>('/me')

	const { data: invoices, isFetching } = useRequest<Invoice[]>('/users/:id/invoices', {
		params: { id: user?.id ?? '' },
		enabled: user !== undefined,
	})

	return <List rows={invoices ?? []} busy={isFetching} />
}
```

`useMutation` takes the request to run rather than a path, so anything the client can do is fair game, including a scope, a lane, or two calls in one mutation. It returns `mutate`, `data`, `error`, `isPending`, and `reset`. `mutate` resolves to `undefined` on failure instead of rejecting, and the error lands in state.

```tsx
function NewUser() {
	const { mutate, isPending, error } = useMutation<User, { name: string }>(variables =>
		api.post<User>('/users', variables)
	)

	async function submit(name: string) {
		const created = await mutate({ name })

		if (created !== undefined) api.invalidateTag('users')
	}

	return <Form onSubmit={submit} busy={isPending} error={error?.message} />
}
```

`usePrefetch` returns a function that warms the cache in the prefetch lane, so the queue serves it behind anything on screen. The row is already there when the click lands:

```tsx
function UserRow({ id }: { id: string }) {
	const prefetch = usePrefetch()

	return <Row onMouseEnter={() => prefetch('/users/:id', { params: { id } })} />
}
```

`useSession` reads the page's one session, typed as your user rather than `unknown`:

```tsx
function Nav() {
	const { status, session } = useSession()

	if (status === 'unknown' || status === 'loading') return <Spinner />
	if (status === 'anonymous') return <SignIn />

	return <Avatar user={session!} />
}
```

Every remote calling `useSession` follows the same state, so a 401 in one signs the whole page out at once.

## Any other framework

Everything observable is a two-method store, so a binding is a few lines rather than a port. Svelte reads it as-is, Vue wraps it in `shallowRef`, Solid in `createStore`.

```ts
const store = api.observe<User>(api.keyFor('/users/1'))

store.get() // { status, data, error, from, fetching, updatedAt }
store.subscribe(render)
```

## Events and devtools

One shared client sees traffic from every remote on the page, which is what makes "who issued this" answerable. Cache, dedupe, retry, queue, session, and contract publish here too, and nothing is emitted while nothing is listening.

```ts
api.events.on('request:error', ({ request, error }) => {
	Sentry.addBreadcrumb({ category: 'conduit', message: `${request.owner} → ${error.code}` })
})
```

```ts
import { attachDevtools } from '@bkincz/conduit/devtools'

const devtools = attachDevtools(api)
devtools.store.subscribe(render) // entries, inFlight, counters, session
```

Devtools read that stream and nothing else. The handle also lands on `globalThis.__CONDUIT_DEVTOOLS__` for console poking, so pass `expose: false` to opt out.

## Testing

`@bkincz/conduit/testing` mocks at the transport, so cache, dedupe, retry, the queue, and session recovery all run for real.

```ts
import { createMockServer, status, networkError, delay } from '@bkincz/conduit/testing'

const server = createMockServer({ baseUrl: '/api' })

server.get('/users/:id', request => ({ id: request.params.id }))
server.post('/users', status(201, { id: 2 }))
server.get('/flaky', status(503), { times: 1 }) // fails once, then falls through
server.get('/slow', delay(500, { ok: true }))
server.get('/down', networkError())

const api = defaults(createClient({ baseUrl: '/api', fetch: server.fetch }))
```

Unmatched requests fail where they were made and name what is registered. `server.calls` has everything that arrived, and `server.reset()` clears routes and calls.

## License

MIT © Benjamin Kinczel
