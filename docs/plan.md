# conduit — design plan

## Thesis

A data-fetching client for micro frontends. Every mainstream client assumes one application, one
module graph, one React tree. Composed frontends have none of those: context does not cross a
federation boundary, remotes mount and unmount independently, and N remotes against one backend
means N caches, N session lookups, and N copies of the same in-flight request.

conduit is built for that shape — one client on `globalThis`, shared by every bundle on the page,
regardless of who loaded them.

## Constraints

- Zero runtime dependencies.
- Framework-agnostic core; bindings are optional, separate entries.
- No provider, no context.
- Backend-agnostic — no knowledge of any auth provider, API style, or server framework.
- Tree-shakeable: apps pay only for plugins they install.

## Core model

Middleware onion over a request record, not flat hooks — cache and dedupe must both _wrap_ and
_short-circuit_.

```ts
type Middleware = (req: ConduitRequest, next: Next) => Promise<ConduitResponse>

interface Plugin<Ext extends object = EmptyExtension> {
	name: string
	middleware?: Middleware
	onInit?(ctx: ClientContext): Ext | void
	onDestroy?(): void
}
```

`.with()` chains and accretes types onto the client, so `client.invalidate()` only type-checks once
`cache()` is installed.

```ts
interface ConduitRequest {
	url: string
	method: string
	headers: Headers
	body?: BodyInit | null
	signal?: AbortSignal
	key: string // derived, overridable
	lane: string // scheduling priority
	owner?: string // which app or remote issued this
	tags?: string[] // invalidation grouping
	meta: Record<string, unknown> // plugin scratch space
}

interface ConduitResponse<T = unknown> {
	status: number
	headers: Headers
	data: T
	raw: Response
	from: 'network' | 'cache' | 'dedupe' | 'mock'
	attempt: number
}
```

**Parse before cache, deliberately.** Body decoding happens in a terminal step, so middleware sees
`data` and the cache stores plain values. No `Response.clone()`, no consumed-stream bugs, no
retained streams.

Failures throw `ConduitError` with a closed `code` union so `catch` narrows exhaustively. A
`.safe()` variant returns `{ data, error }` for call sites that prefer no try/catch. Throwing is the
default because a failure crossing a boundary you do not own must not be silently ignorable.

Keys derive from `method + url + sorted query (+ body hash for non-GET)`, FNV-1a, overridable.

## Federation layer

The part that makes this conduit and not a fetch wrapper.

| Feature                            | Problem it solves                                                                                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharedClient(key, factory, opts)` | One instance across bundles, on `globalThis`. Works under Module Federation, import maps, single-spa, or hand-rolled composition — it only needs a shared global. Warns when two bundles carry different conduit versions. |
| Shared cache                       | Remote A fetches `/me`; remote B mounts later and pays nothing.                                                                                                                                                            |
| Single-flight                      | One in-flight request per key no matter how many remotes want it — including one session recovery, not one per remote.                                                                                                     |
| Abort scopes                       | `client.scope('remote:profile')`, `scope.abort()` on unmount. Signals compose via `AbortSignal.any([scope, caller, timeout])`. The host owns the scope, so a crashed remote still cleans up.                               |
| Supersede                          | Re-requesting a live key aborts the prior one. Typeahead, filters, rapid navigation.                                                                                                                                       |
| Lanes                              | `critical                                                                                                                                                                                                                  | default | prefetch` with bounded concurrency. A chatty remote cannot starve the host's boot path. |
| Owner tagging                      | Every request records its issuing app, so devtools and error reporting can answer "which remote did this".                                                                                                                 |
| Contract guard                     | Remotes deploy independently against one backend. The client declares an expected contract; a plugin compares a configurable response header and warns once.                                                               |
| Prefetch                           | Hosts know the next route before the remote's chunk resolves. Warms cache in the prefetch lane.                                                                                                                            |
| Cross-realm error brand            | Two conduit copies give errors separate class identities, so `instanceof` lies. `isConduitError` checks a brand instead.                                                                                                   |

## Plugins

`dedupe` · `cache` (LRU + TTL + stale-while-revalidate + tag invalidation) · `retry` (exponential
with jitter, idempotent-only by default, honours `Retry-After`) · `timeout` · `queue` (lanes,
concurrency) · `session` · `contract` · `devtools` · `mock` · `broadcast` (cross-tab invalidation) ·
`progress` (upload/download).

Default order, shipped as `defaults()`:

```
cache → dedupe → session → retry → queue → timeout → transport
```

Cache outermost so hits cost nothing. Queue inside retry so retries re-queue rather than stampede.

### session

Provider-agnostic by construction. conduit owns single-flight, sharing, expiry-driven revalidation
and terminal-unauthenticated handling; an adapter owns everything backend-specific.

```ts
interface SessionAdapter<S = unknown> {
	load(ctx: AdapterContext): Promise<S | null>
	isUnauthenticated?(res: ConduitResponse): boolean // default 401/403
	authorize?(req: ConduitRequest, session: S | null): ConduitRequest | void
	expiresAt?(session: S): number | undefined
	renew?(ctx: AdapterContext): Promise<boolean>
}
```

Cookie-session backends implement `load` and nothing else. Token backends add `authorize` and
`renew`. When `renew` is absent, unauthenticated is **terminal**: emit once, abort everything in
flight across all remotes, hand control to the app.

## Framework bindings

The core exposes an observable store:

```ts
interface ReadableStore<T> {
	get(): T
	subscribe(listener: (value: T) => void): () => void
}

client.observe(key) // → ReadableStore<{ status, data, error, isStale, updatedAt }>
```

`/react` is `useSyncExternalStore` over it — `useRequest`, `useMutation`, `usePrefetch`,
`useSession`. Vue/Svelte/Solid adapters become ~20 lines each, added on demand.

## Observability

A typed event stream — `request:start`, `request:settle`, `cache:hit`, `queue:enqueue`,
`session:change`. `devtools` consumes it; so can a host's Sentry or OTel wiring, without conduit
depending on either.

## Priorities

### Type safety

- `endpoint()` infers path params from a template literal type: `'GET /users/:id'` requires
  `{ id }`. No unchecked casts anywhere in the happy path.
- Runtime truth through a Standard Schema seam (a types-only spec, so still zero dependencies).
  Response types are _derived from the validator_, not asserted over it.
- `isolatedDeclarations: true` — inferred types cannot leak into the published surface.
- `ConduitError.code` is a discriminated union.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `no-explicit-any` at error.

### Performance

- Middleware composed once at `.with()`, never per request.
- Cache-hit path returns before allocating `Headers`.
- LRU on `Map` insertion order — O(1), no linked list, no dependency.
- FNV-1a keys over a canonical string.
- Lane scheduler is array buckets, not a sorted priority queue.
- Store notifications batched on a microtask: one settle is one render across all remotes, not N.
- Cache hands out frozen data; no clone per read. Immutability is a documented contract.
- A folded `DEV` constant drops invariants and diagnostics from production bundles.
- `vitest bench` and `size-limit` both gate CI. Budgets: core ≤4.5 KB, index with common plugins
  ≤9 KB, full bundle ≤12 KB, react ≤2 KB. (Core was estimated at 4 KB before the code existed;
  it landed at 4.11 KB once header-aware request identity was in, and the budget moved to match.)

### DX

- `defaults()` preset — one line to a sane stack, still fully decomposable.
- Diagnostics written as full sentences that name the fix.
- TSDoc on every public symbol.
- Event stream lands in phase 2, before devtools, so behaviour is inspectable early.
- `.safe()` alongside the throwing API.

## Phases

| Phase | Content                                                                                   |
| ----- | ----------------------------------------------------------------------------------------- |
| 0     | Scaffold — configs, CI, entries, size budgets, error type                                 |
| 1     | Core — request/response types, keys, pipeline, fetch transport, scopes, abort composition |
| 2     | Federation — `sharedClient`, owner tagging, event stream                                  |
| 3     | Plugins A — dedupe, cache, timeout, retry                                                 |
| 4     | Plugins B — queue/lanes, session, contract                                                |
| 5     | Stores + `/react`                                                                         |
| 6     | `/devtools` + `/testing`                                                                  |
| 7     | Docs, README, publish                                                                     |

Usable after phase 1. Better than raw fetch after 3. Differentiated for micro frontends after 4.

## Decided

- **Cache persistence** — memory only in v1. Storage-backed caching invites a staleness class better
  handled at the state layer.
- **Suspense** — deferred past v1; the store contract admits it without a breaking change.
- **Target** — ES2022, with a small `AbortSignal.any` fallback.

## First consumer

An existing micro frontend (Vite + Module Federation host with three remotes) against a legacy
backend reached through a dev proxy, with sessions established by a separate application on another
origin. That case exercises shared cache, scopes, lanes and terminal-unauthenticated — but none of
it belongs in the package; it is validation, not design input.
