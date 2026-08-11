import { defineConfig } from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		react: 'src/react.ts',
		devtools: 'src/devtools.ts',
		testing: 'src/testing.ts',
	},
	format: ['esm', 'cjs'],
	dts: true,
	// Entries share the core pipeline; splitting lets `/react` and `/devtools`
	// reference it instead of inlining a second copy per entry.
	splitting: true,
	sourcemap: true,
	clean: true,
	minify: 'terser',
	treeshake: 'recommended',
	external: ['react'],
	outDir: 'dist',
	target: 'es2022',
	// No __DEV__ define: esbuild only accepts literals or entity names there, and
	// hardcoding a mode would strip diagnostics for consumers building in dev.
	// src/dev.ts folds on the consumer's own NODE_ENV substitution instead.
	esbuildOptions(options) {
		// console.warn/error survive: diagnostics that fire without devtools
		// installed are the only signal a misconfigured client gives.
		options.drop = ['debugger']
		options.legalComments = 'none'
		options.mangleProps = /^_/
	},
	terserOptions: {
		compress: {
			drop_debugger: true,
			pure_funcs: ['console.log', 'console.info', 'console.debug'],
			passes: 2,
		},
		mangle: {
			properties: {
				regex: /^_/,
			},
		},
	},
})
