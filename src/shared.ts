import { CONDUIT_VERSION } from './version'

/*
 *   TYPES
 ***************************************************************************************************/
export interface SharedClientOptions {
	/** The API contract this bundle was built against. Compared, never reconciled. */
	contract?: number | string
	/** This bundle's own expectation of the shared client's shape. */
	version?: number
	/** Routes disagreements somewhere other than the console — Sentry, devtools, a banner. */
	onMismatch?: (report: SharedMismatch) => void
}

export type SharedMismatchKind = 'conduit-version' | 'contract' | 'client-version'

export interface SharedMismatch {
	readonly key: string
	readonly kind: SharedMismatchKind
	readonly existing: string | number | undefined
	readonly joining: string | number | undefined
	readonly message: string
}

interface SharedEntry {
	client: unknown
	conduitVersion: string
	contract: number | string | undefined
	version: number | undefined
}

/*
 *   REGISTRY
 ***************************************************************************************************/
const REGISTRY_KEY = '__conduitSharedClients'

type SharedScope = typeof globalThis & {
	[REGISTRY_KEY]?: Map<string, SharedEntry>
}

function registry(): Map<string, SharedEntry> {
	const scope = globalThis as SharedScope
	scope[REGISTRY_KEY] ??= new Map()
	return scope[REGISTRY_KEY]
}

/*
 *   LIVENESS
 ***************************************************************************************************/
interface Destroyable {
	isDestroyed?: () => boolean
}

/**
 * Duck-typed rather than an `instanceof Client` check: two bundles can each ship
 * their own conduit copy, which gives them separate class identities — the same
 * reason {@link isConduitError} exists.
 */
function isSpent(client: unknown): boolean {
	const candidate = client as Destroyable | null

	return typeof candidate?.isDestroyed === 'function' && candidate.isDestroyed()
}

/*
 *   SHARED CLIENT
 ***************************************************************************************************/
/**
 * One client per key, for the whole page, whoever asks first.
 *
 * This is the point of conduit. Under module federation each bundle gets its
 * own module instance, so a client created in the host is invisible to a
 * remote — and React context cannot bridge them either. A global registry can:
 * the first caller builds the client, everyone else gets that same one, and the
 * cache, the in-flight table and the session are genuinely shared.
 *
 * The factory of a later caller is never invoked, so its configuration does not
 * apply. Pass `contract` and `version` to be told when bundles disagree instead
 * of finding out through a wrong response.
 *
 * ```ts
 * export const api = sharedClient(
 * 	'mmw.api',
 * 	() => createClient({ baseUrl: '/api' }).with(cache()),
 * 	{ contract: 'v1', version: 1 }
 * )
 * ```
 */
export function sharedClient<C>(
	key: string,
	factory: () => C,
	options: SharedClientOptions = {}
): C {
	const entries = registry()
	const existing = entries.get(key)

	if (existing !== undefined && !isSpent(existing.client)) {
		reconcile(key, existing, options)
		return existing.client as C
	}

	if (existing !== undefined) {
		// One bundle tearing down must not strand the rest of the page. Without
		// this the registry keeps handing out the destroyed instance and every
		// request from every remote fails, permanently, with no way back.
		console.warn(
			`[conduit] Shared client "${key}" had been destroyed, so a replacement was built. Whoever calls destroy() on a shared client should call releaseSharedClient("${key}") too.`
		)
	}

	const client = factory()

	entries.set(key, {
		client,
		conduitVersion: CONDUIT_VERSION,
		contract: options.contract,
		version: options.version,
	})

	return client
}

/** Reads a shared client without creating one. Returns `undefined` if nobody has registered it. */
export function getSharedClient<C>(key: string): C | undefined {
	return registry().get(key)?.client as C | undefined
}

/**
 * Deregisters one key, so the next `sharedClient` call builds a fresh instance.
 *
 * Pair it with `destroy()`: a client that is torn down but left registered is
 * handed to the next bundle that asks, and every request it makes fails.
 */
export function releaseSharedClient(key: string): boolean {
	return registry().delete(key)
}

/**
 * Empties the registry.
 *
 * For tests. Calling it in an app strands every bundle already holding the old
 * client while new callers build a second one, which is exactly the split
 * `sharedClient` exists to prevent.
 */
export function clearSharedClients(): void {
	registry().clear()
}

/*
 *   RECONCILE
 ***************************************************************************************************/
// Not DEV-guarded: these fire once per key, never per request, and a version
// skew between independently deployed bundles is a production problem that
// production is the only place to observe.
function reconcile(key: string, existing: SharedEntry, options: SharedClientOptions): void {
	const report = (
		kind: SharedMismatchKind,
		from: string | number | undefined,
		to: string | number | undefined,
		message: string
	): void => {
		const mismatch: SharedMismatch = { key, kind, existing: from, joining: to, message }

		if (options.onMismatch !== undefined) {
			options.onMismatch(mismatch)
			return
		}

		console.warn(`[conduit] ${message}`)
	}

	if (existing.conduitVersion !== CONDUIT_VERSION) {
		report(
			'conduit-version',
			existing.conduitVersion,
			CONDUIT_VERSION,
			`Shared client "${key}" was created by conduit ${existing.conduitVersion}, but this bundle ships conduit ${CONDUIT_VERSION}. They can disagree about cache and session shape. Align conduit versions across your apps, or share @bkincz/conduit as a singleton in your module federation config.`
		)
	}

	if (options.contract !== undefined && existing.contract !== options.contract) {
		report(
			'contract',
			existing.contract,
			options.contract,
			`Shared client "${key}" was created against API contract ${String(existing.contract)}, but this bundle was built against ${String(options.contract)}. One of your apps is deployed against a different version of the API.`
		)
	}

	// A client holds live connections, an in-flight table and a session; unlike
	// a state container it cannot be migrated underneath its users. Whoever
	// arrived first keeps it, and the newcomer is told rather than surprised.
	if (options.version !== undefined && existing.version !== options.version) {
		report(
			'client-version',
			existing.version,
			options.version,
			`Shared client "${key}" is version ${String(existing.version)}, but this bundle expects version ${options.version}. The existing client stays in use — it cannot be swapped while other apps hold references to it. Deploy these apps together.`
		)
	}
}
