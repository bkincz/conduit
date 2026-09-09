# Threat model

What conduit protects, what it deliberately does not, and what that asks of you.

## The setting

One client is shared by every bundle on a page. Bundles are built and deployed separately and
reach the client through a registry on `globalThis`, not through a framework provider. The
session plugin holds whatever credential your adapter gives it and attaches it to requests.

That shape has one consequence worth stating first: **every bundle on the page is trusted with
the whole client.** A bundle that can run script in the page can issue authenticated requests,
read every response through `events`, clear the session, or replace the shared client. conduit
does not try to stop that, because nothing in a browser can. The boundary is the integrity of
the bundles you load: immutable remote urls, a content security policy that names the origins
you deploy to, and a build pipeline you control. A federation tool such as
[spool](https://github.com/bkincz/spool) owns that side.

## What conduit protects

- **Credentials stay on the API origin.** A request to another origin is rejected before any
  plugin runs unless the origin is listed in `origins`, and a protocol-relative url is always
  rejected. The session plugin attaches credentials only to the API origin, or to
  `session({ origins })`. A server-supplied link handed to the client cannot carry your token
  elsewhere.
- **Credentials do not leak through the client's own surfaces.** `authorization`, `cookie` and
  `proxy-authorization` read as `[redacted]` on `.response()`, in every event, and in devtools.
  The plugin chain sees the real request; nothing outside it does. `redact` changes the list.
- **One user's data is not served to the next.** When the adapter's `identify` changes between
  loads, or the session flips between anonymous and authenticated, the cache, dedupe flights and
  observed stores are reset. Cache keys include the headers `vary` selects, so two callers with
  different credentials never share an entry by default.
- **A dead session fails closed.** After recovery fails for good, requests that need
  credentials reject with `UNAUTHENTICATED` without touching the network, in-flight requests
  are aborted, cached responses are dropped, and `onUnauthenticated` fires once. There is no
  refresh storm and no relaunch loop.
- **Errors carry less than they know.** `body` and `headers` on a `ConduitError` are readable but
  non-enumerable, so a logger that walks properties does not print them. Messages carry the url
  without its query string. `toJSON` omits both.
- **Path params cannot change the destination.** An empty param and a value that would turn the
  path into `//host` are rejected as `CONFIG`; params are read as own properties only.

## What conduit does not protect

- **Against a compromised bundle on the same page.** See above. `scope()` is a cancellation
  boundary, not a permission boundary.
- **The credential itself.** Where the token or cookie lives is the adapter's business. A token
  in memory is the recommended shape for an embedded frame; a cookie stays with the browser.
  conduit never writes either to storage.
- **Query strings you put secrets in.** They travel in the url, into history, referrers and
  server logs. conduit strips them from its own messages and devtools; it cannot strip them from
  the request.
- **Response bodies from your API.** They are cached, shared between callers and frozen. Anything
  a response contains is visible to every bundle on the page.
- **Server-side isolation.** The registry is process-global. On a server, one client per
  process means one cache and one session across requests. Build a client per request there.

## Defaults that matter

| Default                       | Why                                                                |
| ----------------------------- | ------------------------------------------------------------------ |
| `credentials: 'same-origin'`  | Fetch's own default; cross-site cookies need an explicit opt in    |
| `vary: '*'`                   | Every header counts toward identity, so no accidental sharing      |
| `redact` on                   | Nobody outside the plugin chain needs the credential               |
| devtools `expose` in dev only | A console handle to the client is a dev convenience, not a feature |
| foreign origins rejected      | The allowlist is short and explicit, or empty                      |

## Reporting

A security issue in conduit itself: open a private advisory on the GitHub repository rather
than a public issue.
