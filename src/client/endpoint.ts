import type { HttpMethod, Query, RequestOptions } from '../primitives/types'

/*
 *   STANDARD SCHEMA
 ***************************************************************************************************/
/**
 * The subset of the Standard Schema contract (https://standardschema.dev)
 * conduit needs. Duplicated rather than depended on, since conduit ships zero
 * dependencies, and any validator that implements the real spec satisfies this too.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
	readonly '~standard': {
		readonly version: 1
		readonly vendor: string
		validate(
			value: unknown
		):
			| { readonly value: Output }
			| { readonly issues: ReadonlyArray<{ readonly message: string }> }
			| Promise<
					| { readonly value: Output }
					| { readonly issues: ReadonlyArray<{ readonly message: string }> }
			  >
	}
}

/*
 *   ENDPOINT
 ***************************************************************************************************/
export interface EndpointDefinition<Vars = void, Result = unknown> {
	method: HttpMethod
	/** May contain `:name` placeholders, filled from `vars` by name. */
	path: string
	/** Validates and reshapes the decoded body. A plain function works too. */
	response?: StandardSchemaV1<unknown, Result> | ((data: unknown) => Result)
	query?: (vars: Vars) => Query
	/** Write methods only: JSON-encoded unless it is already a `BodyInit`. */
	body?: (vars: Vars) => unknown
	tags?: readonly string[] | ((vars: Vars) => readonly string[])
	invalidates?: readonly string[] | ((vars: Vars) => readonly string[])
	options?: Partial<RequestOptions>
}

/** Branded so a call site can tell an endpoint from a bare `RequestOptions` object. */
export type Endpoint<Vars = void, Result = unknown> = EndpointDefinition<Vars, Result> & {
	readonly kind: 'conduit.endpoint'
}

/**
 * Names a request once, so it can be called and keyed without repeating its
 * shape. `defineEndpoint` does no work beyond branding, so everything it
 * describes runs when `client.call()` reads it.
 *
 * ```ts
 * const getUser = defineEndpoint<{ id: string }, User>({
 * 	method: 'GET',
 * 	path: '/users/:id',
 * 	response: userSchema,
 * 	tags: ['users'],
 * })
 *
 * const user = await api.call(getUser, { id: '7' })
 * ```
 */
export function defineEndpoint<Vars = void, Result = unknown>(
	def: EndpointDefinition<Vars, Result>
): Endpoint<Vars, Result> {
	return { ...def, kind: 'conduit.endpoint' }
}

/*
 *   TAGS
 ***************************************************************************************************/
/** Endpoints accept a static list or a function of `vars` -- this will read either. */
export function resolveEndpointTags<Vars>(
	tags: readonly string[] | ((vars: Vars) => readonly string[]) | undefined,
	vars: Vars
): readonly string[] | undefined {
	if (tags === undefined) {
		return undefined
	}

	return typeof tags === 'function' ? tags(vars) : tags
}
