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

`mode`, `redirect`, `cache`, `keepalive`, `priority`, `referrerPolicy` and `integrity` pass straight through to `fetch` too, per request or as a client default, wherever the platform accepts them.

And on the client:

| Option        | Description                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------- |
| `baseUrl`     | Prefixed to relative paths, absolute urls bypass it                                         |
| `headers`     | An object, or a function read fresh on every request                                        |
| `vary`        | Which headers count toward request identity, defaults to `'*'`                              |
| `credentials` | Default credential mode                                                                     |
| `owner`       | Default owner for this bundle                                                               |
| `lane`        | Default lane                                                                                |
| `parse`       | Default decode mode                                                                         |
| `fetch`       | Swap the network implementation, for tests or instrumentation                               |
| `origins`     | Extra origins this client may call besides its own, see [Foreign origins](#foreign-origins) |
| `redact`      | Header names hidden from events and `.response()`, see [Redaction](#redaction)              |
| `logger`      | Where conduit's own diagnostics go. Defaults to `console`                                   |

## Foreign origins

An absolute request has to resolve to `baseUrl`'s own origin, or the page's when `baseUrl` is relative, or it is rejected with `CONFIG` before any plugin runs. A protocol-relative url (`//host/…`) is always rejected, allowlisted or not, since it silently follows whatever scheme the page happens to be on.

```ts
createClient({ baseUrl: '/api', origins: ['https://cdn.example.com'] })

api.get('https://cdn.example.com/assets/logo.png') // fine, allowlisted
api.get('https://evil.example.com/x') // rejected: CONFIG
api.get('//evil.example.com/x') // rejected: CONFIG, always
```

## Errors

Everything rejects with a `ConduitError` carrying a `code`, plus `status`, `url`, `owner`, and the decoded `body` when there was one.

```ts
import { isErrorCode } from '@bkincz/conduit'

const { data, error } = await api.get<User>('/users/7').safe()

if (isErrorCode(error, 'TIMEOUT')) retryLater()
```

`HTTP_ERROR`, `NETWORK`, `TIMEOUT`, `ABORTED`, `PARSE`, `UNAUTHENTICATED`, `CONFIG`, `SCHEMA`, `UNKNOWN`.

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

## Typed endpoints

`defineEndpoint` names a request once, with its own path params, query, body, tags and response schema, so it can be called and keyed without repeating any of that.

```ts
import { defineEndpoint } from '@bkincz/conduit'

const getUser = defineEndpoint<{ id: string }, User>({
	method: 'GET',
	path: '/users/:id',
	response: userSchema, // any Standard Schema validator, or a plain function
	tags: vars => [`user:${vars.id}`],
})

const user = await api.call(getUser, { id: '7' })
api.invalidate(api.keyFor(getUser, { id: '7' }))
```

`vars` fills the path's `:name` placeholders by the same rules as `params`, and feeds `query` and `body` when the endpoint defines them. A failing `response` schema rejects with code `SCHEMA`, carrying its issues as `body`, instead of handing back a shape nothing downstream expects.

A request with `tags` is cached whatever its method, so an API that lists through `POST` still gets invalidation and refetch. Untagged writes are never cached.

## Uploads

`client.upload` posts a `FormData` or `Blob` with no default timeout, since a slow connection is not a hung one. Pass `onProgress` to route that one request through `XMLHttpRequest` instead of `fetch`, which has no event for upload progress; without it, `upload` still goes through `config.fetch` like everything else, mock servers included.

```ts
await api.upload('/avatars', file, {
	onProgress: ({ loaded, total, percent }) => setProgress(percent),
})
```

It runs through the same middleware stack as any other request, so session, retry and the queue still apply.

## Plugins

Each one is middleware that can also extend the client, and the extension shows up in the type. `api.invalidate()` does not compile until `cache()` is installed.

| Plugin       | Adds to the client                                     | What it does                                                                   |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `cache`      | `invalidate`, `invalidateTag`, `clearCache`, `setData` | LRU with TTL, optional stale-while-revalidate, tag invalidation                |
| `dedupe`     | `inFlight`                                             | One request per key. Unmounting cancels your wait, not everyone else's         |
| `session`    | `session`                                              | One session for the page, single-flight recovery, behind an adapter            |
| `retry`      |                                                        | Backoff with jitter, honours `Retry-After`, idempotent methods only by default |
| `queue`      | `queueDepth`, `activeRequests`                         | Bounded concurrency with priority lanes                                        |
| `timeout`    |                                                        | Per client or per request, fails with code `TIMEOUT`                           |
| `observable` | `observe`, `observedKeys`                              | Per key state for framework bindings                                           |
| `contract`   |                                                        | Reports once when this bundle and the API disagree on version                  |

Any request can step around a layer:

```ts
api.get('/live', { meta: { cache: 'bypass', dedupe: 'bypass' } })
api.get('/fresh', { meta: { cache: 'refresh' } }) // skip the read, keep the result
api.get('/slow', { meta: { timeout: 60_000 } })
api.get('/urgent', { meta: { queue: 'bypass' } })
```

Invalidating an entry, or a tag, reaches every mounted hook that shows it, which refetches. `setData` writes an entry and those hooks directly, and hands back the previous value for a rollback:

```ts
const previous = api.setData(api.keyFor('/users/7'), user => ({ ...user, name: 'Ada' }))
const { error } = await api.patch('/users/7', { name: 'Ada' }).safe()
if (error) api.setData(api.keyFor('/users/7'), previous)
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
	identify: user => user.id, // a different user drops the previous one's cache
	onClear: () => tokens.clear(), // whatever you hold outside conduit
}

const api = defaults(createClient({ baseUrl: '/api' }), { session: { adapter } })

api.session.get() // { status, session, error, updatedAt }
api.session.subscribe(state => render(state))
await api.session.load()
```

| Adapter method | Called                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| `load`         | To read the session, on first use and shortly before `expiresAt`                        |
| `authorize`    | On every request to the API origin, or to `session({ origins })`, never elsewhere       |
| `renew`        | Once per 401, however many requests hit it together                                     |
| `expiresAt`    | To schedule the next `load`                                                             |
| `identify`     | After every `load` and `renew`; a changed value resets cache, dedupe and observed state |
| `onClear`      | From `session.clear()` and when recovery fails for good                                 |

`status` is `unknown`, `loading`, `authenticated`, `anonymous`, or `error`. `error` means `load` failed for a reason other than authentication; the previous session is kept and `error` says why. Four remotes hitting a 401 together produce one recovery, not four. When it cannot be recovered, everything in flight is aborted, cached responses are dropped, `onUnauthenticated` fires once, the session's `error.code` is `UNAUTHENTICATED`, and requests that need credentials fail with that code until a later `load()` succeeds.

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

Under Vite, pass `hot` so a reload during development gets a fresh client instead of a destroyed one wedged in the registry:

```ts
export const api = sharedClient('bkincz.api', () => defaults(createClient({ baseUrl: '/api' })), {
	hot: import.meta.hot,
})
```

`hot.dispose` runs `destroy()` and `releaseSharedClient()` for you. Leave it out anywhere else and nothing changes.

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

| Field                     | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `data`, `error`, `status` | The current state of this query                               |
| `isLoading`               | Nothing on screen yet and a request is in the air             |
| `isFetching`              | A request is in the air, with or without data showing         |
| `isStale`                 | The last answer came from cache                               |
| `refetch()`               | Fetch again, past the cache, and store the answer             |
| `enabled: false`          | Hold off until a dependency is ready                          |
| `keepPreviousData`        | Keep showing the last answer while a new key loads            |
| `refetchOnFocus`          | Refetch when the tab regains focus. Off unless you turn it on |
| `refetchOnReconnect`      | Refetch when the browser comes back online. Off by default    |

There is no provider. The hooks bind to a client at module scope, so every remote importing them shares it. Two components rendering the same query share one store and one request, and the second to mount renders what the first already fetched without a round trip. Unmounting cancels that component's interest only. When an entry is invalidated, every hook showing it refetches.

The hook re-subscribes when the key changes, not when the options object does, so a fresh `params` object every render costs nothing. `enabled` is how one query waits on another, and a missing param simply leaves the hook idle:

```tsx
function Invoices() {
	const { data: user } = useRequest<User>('/me')

	const { data: invoices, isFetching } = useRequest<Invoice[]>('/users/:id/invoices', {
		params: user ? { id: user.id } : undefined,
		enabled: user !== undefined,
	})

	return <List rows={invoices ?? []} busy={isFetching} />
}
```

Endpoints work everywhere a path does: `useRequest(getUser, { id })` and `useMutation(updateUser)`, with the endpoint's `tags` and `invalidates` applied for you. `useMutation(updateUser, { invalidates: ['teams'] })` invalidates those on top of the endpoint's own.

`useMutation` takes the request to run rather than a path, so anything the client can do is fair game, including a scope, a lane, or two calls in one mutation. It returns `mutate`, `data`, `error`, `isPending`, and `reset`. `mutate` resolves to `undefined` on failure instead of rejecting, and the error lands in state as `unknown`, since a mutation runs your code. Name the tags it invalidates and the lists refresh on their own:

```tsx
function NewUser() {
	const { mutate, isPending, error } = useMutation<User, { name: string }>(
		variables => api.post<User>('/users', variables),
		{ invalidates: ['users'] }
	)

	const message = isConduitError(error) ? error.message : undefined

	return <Form onSubmit={name => mutate({ name })} busy={isPending} error={message} />
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
	if (status === 'error') return <Retry onClick={() => api.session.reload()} />

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

Devtools read that stream and nothing else, with query strings stripped from urls and keys. In a dev build the handle also lands on `globalThis.__CONDUIT_DEVTOOLS__` for console poking; pass `expose: false` to opt out, or `expose: true` to keep it in production.

## Redaction

The session plugin's `authorize` attaches real credentials to the request that runs, but nobody outside the plugin chain needs to see them. `config.redact` names the headers hidden from `.response()` and from every event, defaulting to `['authorization', 'cookie', 'proxy-authorization']`.

```ts
const response = await api.get('/me', { headers: { authorization: 'Bearer secret' } }).response()

response.request.headers.get('authorization') // '[redacted]'
```

Pass `redact: []` to turn it off, or your own list to widen or narrow it. `redactRequest` is exported for devtools or telemetry that wants the same treatment.

What conduit protects, what it leaves to you, and why every bundle on the page is trusted with the whole client is in [docs/threat-model.md](./docs/threat-model.md).

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

Testing the hooks while conduit is linked from a sibling checkout (`link:` or `pnpm link`) needs `resolve.dedupe: ['react', 'react-dom']` in the consumer's vite or vitest config, or React resolves twice and every hook call fails.

## License

MIT © Benjamin Kinczel
