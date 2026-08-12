import { CONDUIT_VERSION } from '../primitives/version'

/*
 *   TYPES
 ***************************************************************************************************/
export interface SharedClientOptions {
	/** The API contract this bundle was built against. Compared, never reconciled. */
	contract?: number | string
	/** This bundle's own expectation of the shared client's shape. */
	version?: number
	/** Routes disagreements somewhere other than the console. */
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

/** Duck-typed, since two bundles shipping their own copy have separate class identities. */
function isSpent(client: unknown): boolean {
	const candidate = client as Destroyable | null

	return typeof candidate?.isDestroyed === 'function' && candidate.isDestroyed()
}

/*
 *   SHARED CLIENT
 ***************************************************************************************************/
/**
 * One client per key for the whole page, built by whoever asks first. A later
 * caller's factory never runs, so pass `contract` and `version` to be told when
 * bundles disagree rather than finding out through a wrong response.
 *
 * ```ts
 * export const api = sharedClient(
 * 	'acme.api',
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

/** Deregisters one key. Pair it with `destroy()`, or the next bundle gets the dead client. */
export function releaseSharedClient(key: string): boolean {
	return registry().delete(key)
}

/** Empties the registry. For tests: in an app it strands whoever already holds a client. */
export function clearSharedClients(): void {
	registry().clear()
}

/*
 *   RECONCILE
 ***************************************************************************************************/
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

	if (options.version !== undefined && existing.version !== options.version) {
		report(
			'client-version',
			existing.version,
			options.version,
			`Shared client "${key}" is version ${String(existing.version)}, but this bundle expects version ${options.version}. The existing client stays in use — it cannot be swapped while other apps hold references to it. Deploy these apps together.`
		)
	}
}
