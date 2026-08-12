import type {
	ConduitPromise,
	HttpMethod,
	MethodOptions,
	RequestMethods,
	RequestOptions,
} from '../primitives/types'

/*
 *   EXECUTOR
 ***************************************************************************************************/
/** What a set of method helpers delegates to. The client and each scope supply their own. */
export type Executor = <T>(path: string, options: RequestOptions) => ConduitPromise<T>

/*
 *   OPTIONS
 ***************************************************************************************************/
/** Folds a positional body argument into options without ever setting `body: undefined`. */
export function bodyOptions(
	method: HttpMethod,
	body: unknown,
	options: MethodOptions | undefined
): RequestOptions {
	return body === undefined ? { ...options, method } : { ...options, method, body }
}

/*
 *   FACTORY
 ***************************************************************************************************/
/** Builds the shared verb surface, so a scope offers exactly what the client does. */
export function createMethods(execute: Executor): RequestMethods {
	return {
		request<T = unknown>(path: string, options?: RequestOptions): ConduitPromise<T> {
			return execute<T>(path, options ?? {})
		},
		get<T = unknown>(path: string, options?: MethodOptions): ConduitPromise<T> {
			return execute<T>(path, { ...options, method: 'GET' })
		},
		head<T = unknown>(path: string, options?: MethodOptions): ConduitPromise<T> {
			return execute<T>(path, { ...options, method: 'HEAD' })
		},
		delete<T = unknown>(path: string, options?: MethodOptions): ConduitPromise<T> {
			return execute<T>(path, { ...options, method: 'DELETE' })
		},
		post<T = unknown>(
			path: string,
			body?: unknown,
			options?: MethodOptions
		): ConduitPromise<T> {
			return execute<T>(path, bodyOptions('POST', body, options))
		},
		put<T = unknown>(path: string, body?: unknown, options?: MethodOptions): ConduitPromise<T> {
			return execute<T>(path, bodyOptions('PUT', body, options))
		},
		patch<T = unknown>(
			path: string,
			body?: unknown,
			options?: MethodOptions
		): ConduitPromise<T> {
			return execute<T>(path, bodyOptions('PATCH', body, options))
		},
	}
}
