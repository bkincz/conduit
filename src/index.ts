/*
 *   CLIENT
 ***************************************************************************************************/
export { Client, createClient } from './client/core'
export { defaults } from './client/defaults'
export type { DefaultsConfig, DefaultsWithSession, DefaultStack } from './client/defaults'
export { createScope } from './client/scopes'
export type { Scope, ScopeInit } from './client/scopes'
export { createMethods, bodyOptions } from './client/methods'
export type { Executor } from './client/methods'
export {
	sharedClient,
	getSharedClient,
	releaseSharedClient,
	clearSharedClients,
} from './client/shared'
export type { SharedClientOptions, SharedMismatch, SharedMismatchKind } from './client/shared'

/*
 *   PLUGINS
 ***************************************************************************************************/
export { cache, CACHE_META } from './plugins/cache'
export type { CacheApi, CacheConfig } from './plugins/cache'
export { dedupe, DEDUPE_META } from './plugins/dedupe'
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
 *   HTTP
 ***************************************************************************************************/
export { compose } from './http/pipeline'
export { createRequest, withRequest } from './http/request'
export type { RequestRecordInit } from './http/request'
export { conduitPromise } from './http/promise'
export { createFetchTransport } from './http/transport'
export {
	deriveKey,
	deriveVariance,
	fingerprintHeaders,
	canonicalUrl,
	bodyFingerprint,
	fnv1a,
} from './http/keys'
export type { KeyInputs } from './http/keys'
export { buildUrl, joinUrl, appendQuery, applyPathParams, isAbsoluteUrl } from './http/url'
export { encodeBody } from './http/body'
export type { EncodedBody } from './http/body'
export { composeSignals } from './http/signals'
export type { ComposedSignal } from './http/signals'
export { toAbortError } from './http/abort'

/*
 *   PRIMITIVES
 ***************************************************************************************************/
export {
	ConduitError,
	ERROR_CODES,
	isConduitError,
	isErrorCode,
	toConduitError,
} from './primitives/errors'
export type { ConduitErrorCode, ConduitErrorInit, ConduitErrorJson } from './primitives/errors'
export { createEventBus, elapsed } from './primitives/events'
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
} from './primitives/events'
export { createStore } from './primitives/stores'
export type { ReadableStore, WritableStore } from './primitives/stores'
export { protect } from './primitives/freeze'
export { CONDUIT_VERSION } from './primitives/version'
export { IDEMPOTENT_METHODS } from './primitives/types'
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
} from './primitives/types'
