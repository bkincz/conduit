# Changelog

## 2.0.0

The session and cache release. Credentials stay on the API origin, a user
swap never serves the previous user's data, and what a hook shows follows what
the cache knows. Existing consumers should read the breaking list; most apps
change nothing but an adapter gains two optional methods worth adding.

### Breaking

- Requests to another origin are rejected with `CONFIG` unless the origin is
  listed in `origins`. Protocol-relative urls (`//host`) are always rejected.
  The session plugin also attaches credentials only on the API origin, or
  the origins passed to `session({ origins })`.
- An empty or whitespace path param rejects with `CONFIG` instead of
  producing `/users//invoices`. Params are read as own properties only.
- `.response()` and every `request:*` event see `authorization`, `cookie` and
  `proxy-authorization` as `[redacted]`. `redact` on the client changes the
  list; `[]` turns it off. The plugin chain still sees the real request.
- `ConduitError.body` and `.headers` are non-enumerable. They are still
  readable; they no longer appear in spreads, `console.table` or loggers that
  walk own properties. Error messages carry the url without its query string.
- Session `status` gained `'error'`: a load that fails for a reason other than
  authentication keeps the previous session and sets `error`, instead of
  collapsing to `unknown` with no session. A terminal failure sets the
  session's `error.code` to `UNAUTHENTICATED`, and requests that need
  credentials fail fast with it until a later `load()` succeeds.
- `useMutation` reports `error` as `unknown`. A mutation runs your code, which
  can throw anything; narrow with `isConduitError`.
- Cancelled requests each get their own error with their own `url`, `method`
  and `owner`, instead of sharing one object. A timeout stays `TIMEOUT`.
- The shared client registry key is `Symbol.for('conduit.sharedClients')`.
- Bodies that cannot be encoded (functions, symbols, bigint, cycles) reject
  with `CONFIG` instead of a raw `TypeError` or `UNKNOWN`.

### Fixed

- The proactive session reload no longer loops. Inside the leeway window it
  arms once at the hard expiry; past expiry it waits for the next 401.
- A session that changes subject without passing through anonymous resets the
  cache, dedupe and observable state. Adapters declare `identify(session)`.
- `invalidate`, `invalidateTag`, `clearCache` and an identity reset reach
  mounted `useRequest` hooks, which refetch. A reset no longer leaves a hook
  showing nothing with `isLoading` false.
- `refetch()` fetches. It bypasses the cache read and stores the result.
- A request with `tags` is cached whatever its method, so a `POST` that lists
  can be invalidated and refetched. Before, `invalidates` on such an endpoint
  silently reached nothing.
- `useMutation(endpoint, { invalidates })` applies both the endpoint's tags
  and the ones passed in; the option used to be ignored for endpoints.
- An endpoint whose path has no `:name` placeholders no longer hands its vars
  to `params`, which warned on every call.
- `useRequest` reports `isLoading` on its very first render when a fetch is
  about to start, not one tick later.
- `DEV` is true in bundled dev builds. It read `typeof process`, which
  bundlers never define, so deep-freezing of shared bodies and every dev
  warning were off in the browser.
- `useRequest` never throws during render when a param is missing or
  `enabled` is false; it reports idle state. A caller's `signal` is combined
  with the hook's own instead of overwritten.
- A body read aborted mid-stream reports `ABORTED`, not `PARSE`.
- `ReadableStream` bodies send `duplex: 'half'`, as fetch requires.
- Subscribing the same listener twice and unsubscribing once no longer leaves
  the event bus active forever.
- Observable stores created during a render are no longer evicted before the
  component subscribes.
- `getSharedClient` skips a destroyed client, like `sharedClient` does.
- A fire-and-forget request failure surfaces as an unhandled rejection
  instead of vanishing. `.safe()` and `.response()` stay silent.
- Query strings go before the fragment. A missing `content-type` with a body
  decodes as `blob` under `parse: 'auto'`.
- Retry ignores an empty `Retry-After`, never replays a consumed stream, and
  puts `retryAfter` (ms) on the final error when the header was present.
- The mock server clones a `Response` responder per match, so
  `status(201, {...})` works more than once.
- Devtools default `expose` to dev builds only and strip query strings from
  urls and keys.

### Added

- `defineEndpoint({ method, path, response, query, body, tags, invalidates })`
  with `client.call(endpoint, vars)` and `client.keyFor(endpoint, vars)`.
  `response` takes a Standard Schema (zod, valibot, arktype) or a function;
  a failing schema rejects with the new `SCHEMA` code.
- `useRequest(endpoint, vars, options)` and `useMutation(endpoint, options)`.
  A successful mutation invalidates the endpoint's tags, or those passed as
  `invalidates`, for the function form too.
- `client.upload(path, body, { onProgress })`, over `XMLHttpRequest` when
  progress is wanted and the normal pipeline otherwise.
- `meta.cache: 'refresh'` and `api.setData(key, data | updater)`, which writes
  cache and mounted stores and returns the previous value for rollback.
- `keepPreviousData`, `refetchOnFocus` and `refetchOnReconnect` on
  `useRequest`, all off by default.
- Session adapter `identify(session)` and `onClear()`; `session({ origins })`.
- `origins`, `redact` and `logger` on the client; `mode`, `redirect`, `cache`,
  `keepalive`, `priority`, `referrerPolicy` and `integrity` pass through to
  fetch from the client or a request.
- `sharedClient(key, factory, { hot: import.meta.hot })` releases the client
  on hot module replacement so adapter edits take effect without a reload.
- Size budgets moved with the surface: core 6.5 KB, core with the common
  plugins 10 KB, full 12.5 KB, React bindings 2.5 KB (brotli).
- `pnpm run check:api` compiles a consumer fixture against the built typings,
  so a class turning into a type or a dropped export fails `verify`.
- `docs/threat-model.md` states what conduit protects, what it leaves to the
  page, and why every bundle on the page is trusted with the whole client.

## 1.0.0

First release.
