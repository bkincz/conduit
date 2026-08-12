/*
 *   DEV FLAG
 ***************************************************************************************************/
/**
 * True outside production builds. Bundlers fold this to a constant, so every
 * `if (DEV)` block drops out of a production bundle. Guard diagnostics with it.
 */
export const DEV: boolean = typeof process !== 'undefined' && process.env.NODE_ENV !== 'production'
