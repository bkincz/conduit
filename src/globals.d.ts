/**
 * Present in Node and substituted by every major bundler; absent in a raw
 * browser module. Declared minimally, rather than pulling in Node's whole type
 * surface, so conduit can fold dev-only code out of production builds.
 */
declare const process: { env: { NODE_ENV?: string } } | undefined
