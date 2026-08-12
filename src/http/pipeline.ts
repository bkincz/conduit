import type { Middleware, Next } from '../primitives/types'

/*
 *   COMPOSE
 ***************************************************************************************************/
/** Folds middleware into a single function, outermost first. Run once per `.with()`. */
export function compose(middlewares: readonly Middleware[], terminal: Next): Next {
	if (middlewares.length === 0) {
		return terminal
	}

	return middlewares.reduceRight<Next>(
		(downstream, middleware) => request => middleware(request, downstream),
		terminal
	)
}
