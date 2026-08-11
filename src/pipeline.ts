import type { Middleware, Next } from './types'

/*
 *   COMPOSE
 ***************************************************************************************************/
/**
 * Folds middleware into a single function, outermost first.
 *
 * Run once per `.with()` rather than per request: a client that lives for the
 * whole session would otherwise rebuild the same closure chain on every call.
 */
export function compose(middlewares: readonly Middleware[], terminal: Next): Next {
	if (middlewares.length === 0) {
		return terminal
	}

	return middlewares.reduceRight<Next>(
		(downstream, middleware) => request => middleware(request, downstream),
		terminal
	)
}
