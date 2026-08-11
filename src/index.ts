/*
 *   CLIENT
 ***************************************************************************************************/
export { Client, createClient } from './core'
export { createScope } from './scopes'
export type { Scope, ScopeInit } from './scopes'

/*
 *   FEDERATION
 ***************************************************************************************************/
export { sharedClient, getSharedClient, releaseSharedClient, clearSharedClients } from './shared'
export type { SharedClientOptions, SharedMismatch, SharedMismatchKind } from './shared'

/*
 *   PLUGINS
 ***************************************************************************************************/
export { cache } from './plugins/cache'
export type { CacheApi, CacheConfig } from './plugins/cache'
export { dedupe } from './plugins/dedupe'
export type { DedupeApi, DedupeConfig } from './plugins/dedupe'
export { retry } from './plugins/retry'
export type { RetryConfig, RetryInfo } from './plugins/retry'
export { timeout, TIMEOUT_META } from './plugins/timeout'
export type { TimeoutConfig } from './plugins/timeout'
export { queue, QUEUE_META } from './plugins/queue'
export type { QueueApi, QueueConfig } from './plugins/queue'
export { session, SESSION_META } from './plugins/session'
export type {
	AdapterContext,
	SessionAdapter,
	SessionApi,
	SessionConfig,
	SessionHandle,
	SessionState,
	SessionStatus,
} from './plugins/session'
export { contract } from './plugins/contract'
export type { ContractConfig, ContractMismatch } from './plugins/contract'
export { observable } from './plugins/observable'
export type { ObservableApi, ObservableConfig, QueryState, QueryStatus } from './plugins/observable'

/*
 *   STORES
 ***************************************************************************************************/
export { createStore } from './stores'
export type { ReadableStore, WritableStore } from './stores'

/*
 *   PRESET
 ***************************************************************************************************/
export { defaults } from './defaults'
export type { DefaultsConfig, DefaultsWithSession, DefaultStack } from './defaults'

/*
 *   EVENTS
 ***************************************************************************************************/
export { createEventBus, elapsed } from './events'
export type {
	CacheHitEvent,
	CacheInvalidateEvent,
	CacheMissEvent,
	CacheStaleEvent,
	ClientDestroyEvent,
	ConduitEvent,
	ConduitEventMap,
	ConduitEventType,
	ContractMismatchEvent,
	DedupeJoinEvent,
	EventBus,
	QueueEnqueueEvent,
	RequestErrorEvent,
	RequestSettleEvent,
	RequestStartEvent,
	RetryAttemptEvent,
	SessionChangeEvent,
	Unsubscribe,
} from './events'

/*
 *   ERRORS
 ***************************************************************************************************/
export { ConduitError, ERROR_CODES, isConduitError, isErrorCode, toConduitError } from './errors'
export type { ConduitErrorCode, ConduitErrorInit, ConduitErrorJson } from './errors'

/*
 *   PIPELINE
 ***************************************************************************************************/
export { compose } from './pipeline'
export { createRequest, withRequest } from './request'
export type { RequestRecordInit } from './request'
export { conduitPromise } from './promise'
export { createFetchTransport } from './transport'

/*
 *   BUILDING BLOCKS
 ***************************************************************************************************/
// Exported because a plugin author needs the same primitives the core uses —
// a cache plugin that derived keys differently would silently miss every hit.
export { buildUrl, joinUrl, appendQuery, applyPathParams, isAbsoluteUrl } from './url'
export {
	deriveKey,
	deriveVariance,
	fingerprintHeaders,
	canonicalUrl,
	bodyFingerprint,
	fnv1a,
} from './keys'
export type { KeyInputs } from './keys'
export { protect } from './freeze'
export { composeSignals } from './signals'
export type { ComposedSignal } from './signals'
export { toAbortError } from './abort'
export { encodeBody } from './body'
export type { EncodedBody } from './body'
export { createMethods, bodyOptions } from './methods'
export type { Executor } from './methods'

/*
 *   TYPES
 ***************************************************************************************************/
export { IDEMPOTENT_METHODS } from './types'
export type {
	ClientConfig,
	ClientContext,
	ConduitPromise,
	ConduitRequest,
	ConduitResponse,
	EmptyExtension,
	FetchLike,
	HttpMethod,
	Lane,
	LiteralUnion,
	MethodOptions,
	Middleware,
	Next,
	ParseMode,
	PathParams,
	Plugin,
	Query,
	QueryValue,
	RequestMethods,
	RequestOptions,
	RequestPatch,
	ResolvedClientConfig,
	ResponseSource,
	SafeResult,
	Vary,
} from './types'

/*
 *   VERSION
 ***************************************************************************************************/
export { CONDUIT_VERSION } from './version'

/*
 *   PENDING
 ***************************************************************************************************/
// Phase 6 — /devtools and /testing entries
