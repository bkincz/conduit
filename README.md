# @bkincz/conduit

A data-fetching client for micro frontends. One client, shared by every bundle on the page,
whatever loaded them.

> Status: pre-release, unpublished. Everything below works.
> See [docs/plan.md](./docs/plan.md).

## Why

Composed frontends break the assumption every mainstream client makes. React context does not
cross a federation boundary, so a provider mounted by the host is invisible to a remote. Remotes
mount and unmount on their own schedule. Four remotes talking to one backend means four caches,
four session lookups, and four copies of the same in-flight request.

conduit targets that shape directly:

- **One client across bundles** — held on `globalThis`, not in a provider.
- **Shared cache and single-flight** — a remote that mounts second pays nothing.
- **One session recovery**, not one per remote — the failure that corrupts rotating-token backends.
- **Abort scopes** tied to remote lifecycle, so unmounting cancels cleanly.
- **Priority lanes**, so a chatty remote cannot starve the host's boot path.
- **Contract guard**, because remotes deploy independently against one backend.

Zero runtime dependencies. Framework-agnostic core, with optional React bindings.

## Install

```sh
pnpm add @bkincz/conduit
```

## Use

```ts
import { createClient } from '@bkincz/conduit'

const api = createClient({
	baseUrl: '/api',
	headers: () => ({ 'x-tenant': currentTenant() }), // read per request, not frozen at construction
})

// Resolves to the decoded body.
const user = await api.get<User>('/users/:id', { params: { id: 7 } })

// Or the whole response, or a result you do not have to catch.
const { status } = await api.get<User>('/users/7').response()
const { data, error } = await api.get<User>('/users/7').safe()

await api.post('/users', { name: 'Ada' }) // JSON-encoded, content type set
```

Cancellation is owned by whoever mounts the remote, not by the remote itself:

```ts
const scope = api.scope('remote:profile')

scope.get('/settings')
scope.abort() // on unmount — every request made through it stops
```

## Plugins

Most setups want the standard stack, in the order the layers need to be in:

```ts
const api = defaults(createClient({ baseUrl: '/api' }), {
	cache: { ttl: 30_000, staleWhileRevalidate: true },
	session: { adapter: mySessionAdapter },
})
```

```
cache → dedupe → session → retry → queue → timeout → transport
```

Order is load-bearing and outermost-first. Cache first, so a hit costs a map lookup and never
builds headers or composes a signal. Session inside it but outside retry, so a served hit waits on
nothing while a recovery replays a request that has already spent its attempts. Queue inside retry,
so a replay rejoins the queue instead of jumping it. Timeout innermost, so its clock covers one
network attempt rather than a whole retry sequence.

Getting that order wrong is subtle and expensive, which is why `defaults()` exists. Compose
`.with()` by hand when you need something it cannot express.

**`cache`** — LRU with TTL, optional stale-while-revalidate, and tag invalidation
(`api.invalidateTag('user')`). Cached data is frozen: it is handed to every reader by reference, so
a mutation would corrupt what another remote already holds.

**`dedupe`** — one request per key, however many callers ask. Cancellation is reference-counted, so
a remote unmounting mid-flight cancels its own wait without taking the response away from the
remote still on screen.

**`retry`** — exponential backoff with full jitter, honours `Retry-After`, idempotent-only by
default, and stops waiting out a backoff the moment the request is cancelled.

**`timeout`** — per-client or per-request (`{ meta: { timeout: 60_000 } }`). Fails with code
`TIMEOUT`, not a generic abort.

**`queue`** — bounded concurrency with priority lanes (`critical`, `default`, `prefetch`) and
optional per-lane ceilings. A composed frontend has no single owner of request volume; without a
scheduler the host's boot path queues behind a remote's speculative prefetching, down in the
browser's connection pool where nothing can reorder it.

**`session`** — one session for every bundle on the page, behind an adapter so conduit knows
nothing about your auth provider:

```ts
const adapter: SessionAdapter<User> = {
	load: async ctx => (await ctx.request<{ user: User | null }>('/auth/session')).user,
}
```

A cookie backend implements `load` and nothing else. A token backend adds `authorize` and `renew`.
Recovery is single-flight and the terminal handoff runs exactly once — the failure this exists to
prevent is four remotes hitting 401 together, four concurrent recoveries, and a backend that
rotates refresh tokens signing the user out for having too many panels open. Without `renew`,
unauthenticated is terminal: everything in flight is aborted, then `onUnauthenticated` fires once.

**`contract`** — remotes deploy on their own schedule against one backend. Compares a response
header against what this bundle was built for, and reports once per server version.

## Request identity

Cache entries and deduped flights are keyed on method, URL, body, **headers and credential mode**.
Headers count by default because one client is shared across bundles: two remotes calling `/me`
under different tokens must not collide, and that collision would be a cross-account leak rather
than a cache miss.

```ts
createClient({ vary: '*' }) // default — every header
createClient({ vary: ['authorization'] }) // only what changes the response
createClient({ vary: [] }) // URL alone
```

Narrow it if you attach a header that is unique per request, such as a trace id — under `'*'` that
makes every key unique, so nothing ever hits the cache or shares a flight.

## One client across bundles

Under module federation each bundle gets its own module instance, so a client built in the host is
invisible to a remote — and context cannot bridge them. A global registry can:

```ts
export const api = sharedClient(
	'mmw.api',
	() => createClient({ baseUrl: '/api' }),
	{ contract: 'v1', version: 1 } // warns when bundles disagree
)
```

The first caller builds it; everyone else gets that same instance, so the cache, the in-flight table
and the session are genuinely shared. A later caller's factory never runs — which is why `contract`
and `version` exist, to tell you about a skew rather than let you find it through a wrong response.

If you tear a shared client down, deregister it too, or the next bundle to ask gets the dead one:

```ts
client.destroy()
releaseSharedClient('mmw.api')
```

## React

```ts
// api.ts
export const api = sharedClient('mmw.api', () =>
	defaults(createClient({ baseUrl: '/api' }), { session: { adapter } })
)
export const { useRequest, useMutation, usePrefetch, useSession } = createHooks(api)
```

```tsx
function Profile({ id }: { id: string }) {
	const { data, error, isLoading } = useRequest<User>('/users/:id', { params: { id } })

	if (isLoading) return <Spinner />
	if (error) return <Error code={error.code} />

	return <Card user={data!} />
}
```

No provider — the hooks are bound to a client at module scope instead. A `QueryClientProvider`
mounted by the host would be invisible to a remote, so the pattern would look right and quietly
give every remote its own cache. Binding at module scope means each remote shares the client the
same way it shares everything else. The session type flows through, so `useSession()` returns your
user type without a cast.

Unmounting cancels that component's interest, not everyone's: dedupe counts participants, so a
sibling rendering the same query keeps the underlying request alive.

For other frameworks, everything observable is a two-method store:

```ts
interface ReadableStore<T> {
	get(): T
	subscribe(listener: (value: T) => void): () => void
}

api.observe<User>(api.keyFor('/users/1')) // → ReadableStore<QueryState<User>>
```

Notifications are batched onto a microtask, so one request settling is one render across every
remote watching it rather than three.

## Observing

One shared client sees traffic from every remote on the page, which is what makes "who issued this"
answerable:

```ts
api.events.on('request:error', ({ request, error }) => {
	Sentry.addBreadcrumb({ category: 'conduit', message: `${request.owner} → ${error.code}` })
})
```

Errors carry `owner` directly too, since under federation every remote shares one stack trace.
Nothing subscribes by default, and emission is skipped entirely when nothing does.

Plugins are middleware that can also extend the client, and the extension shows up in the type:

```ts
const client = createClient({ baseUrl: '/api' }).with({
	name: 'log',
	middleware: async (request, next) => {
		const response = await next(request)
		console.log(request.key, response.status)
		return response
	},
})
```

## Testing

`@bkincz/conduit/testing` mocks at the transport, so everything above it — cache, dedupe, retry,
the queue, session recovery — runs for real. A mock installed higher up would be testing the mock.

```ts
import { createMockServer, status, networkError } from '@bkincz/conduit/testing'

const server = createMockServer({ baseUrl: '/api' })

server.get('/users/:id', request => ({ id: request.params.id }))
server.post('/users', status(201, { id: 2 }))
server.get('/flaky', status(503), { times: 1 }) // fails once, then falls through
server.get('/down', networkError())

const api = defaults(createClient({ baseUrl: '/api', fetch: server.fetch }))
```

An unmatched request fails at the request, naming what _is_ registered — a silent 404 would surface
as an assertion failure somewhere else entirely.

## Devtools

`@bkincz/conduit/devtools` reads the event stream and nothing else, so it needs no cooperation from
the plugins and cannot reach a production bundle by accident.

```ts
import { attachDevtools } from '@bkincz/conduit/devtools'

const devtools = attachDevtools(api)
devtools.store.subscribe(render) // entries, inFlight, counters, session
```

Because the client is shared, this sees traffic from every remote on the page at once, attributed
by owner — the view a composed frontend has no other way to get. It also hangs itself on
`globalThis.__CONDUIT_DEVTOOLS__` for console poking; pass `expose: false` to opt out.

## License

MIT © Benjamin Kinczel
