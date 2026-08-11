/*
 *   DEV FLAG
 ***************************************************************************************************/
/**
 * True outside production builds.
 *
 * Bundlers replace `process.env.NODE_ENV` with a string literal, after which
 * this whole expression constant-folds — so every `if (DEV)` block, and
 * anything it references, drops out of a production bundle. Guard invariants
 * and diagnostics with it rather than shipping them to users.
 *
 * The `typeof` check keeps it safe in a raw browser module, where `process`
 * does not exist and an unguarded read would throw.
 */
export const DEV: boolean = typeof process !== 'undefined' && process.env.NODE_ENV !== 'production'
