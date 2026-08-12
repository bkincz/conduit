import { ConduitError } from '../primitives/errors'
import { createMethods, type Executor } from './methods'
import type { RequestMethods } from '../primitives/types'

/*
 *   TYPES
 ***************************************************************************************************/
/**
 * A cancellation boundary with the client's full request surface. Hand one to a
 * remote on mount and abort it on unmount, and nothing it started outlives it.
 */
export interface Scope extends RequestMethods {
	readonly name: string
	readonly signal: AbortSignal
	/** Cancels every request made through this scope. The scope cannot be reused afterwards. */
	abort(reason?: string): void
	/** Aborts, then detaches from the client. Safe to call twice. */
	dispose(): void
}

export interface ScopeInit {
	name: string
	makeExecutor(signal: AbortSignal, owner: string): Executor
	onDispose(scope: Scope): void
}

/*
 *   CREATE
 ***************************************************************************************************/
export function createScope(init: ScopeInit): Scope {
	const controller = new AbortController()
	let detached = false

	const detach = (): void => {
		if (detached) {
			return
		}

		detached = true
		init.onDispose(scope)
	}

	const abort = (reason?: string): void => {
		if (!controller.signal.aborted) {
			controller.abort(
				new ConduitError({
					code: 'ABORTED',
					message: reason ?? `Scope "${init.name}" was aborted.`,
					owner: init.name,
				})
			)
		}

		detach()
	}

	const scope: Scope = {
		...createMethods(init.makeExecutor(controller.signal, init.name)),
		name: init.name,
		signal: controller.signal,
		abort,
		dispose(): void {
			abort(`Scope "${init.name}" was disposed.`)
		},
	}

	return scope
}
