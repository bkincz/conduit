import { ConduitError } from './errors'
import { createMethods, type Executor } from './methods'
import type { RequestMethods } from './types'

/*
 *   TYPES
 ***************************************************************************************************/
/**
 * A cancellation boundary with the client's full request surface.
 *
 * The point of scopes in a composed frontend is that the host owns them: it
 * hands one to a remote on mount and aborts it on unmount, so a remote that
 * crashes or forgets to clean up still cannot leak in-flight requests.
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
	let disposed = false

	const abort = (reason?: string): void => {
		if (controller.signal.aborted) {
			return
		}

		controller.abort(
			new ConduitError({
				code: 'ABORTED',
				message: reason ?? `Scope "${init.name}" was aborted.`,
				owner: init.name,
			})
		)
	}

	const scope: Scope = {
		...createMethods(init.makeExecutor(controller.signal, init.name)),
		name: init.name,
		signal: controller.signal,
		abort,
		dispose(): void {
			if (disposed) {
				return
			}

			disposed = true
			abort(`Scope "${init.name}" was disposed.`)
			init.onDispose(scope)
		},
	}

	return scope
}
