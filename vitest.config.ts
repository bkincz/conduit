import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: false,
		environment: 'happy-dom',
		include: ['src/**/*.{test,spec}.ts'],
		benchmark: {
			include: ['src/**/*.bench.ts'],
		},
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			include: ['src/**/*.ts'],
			exclude: [
				'src/**/__tests__/**',
				'src/**/*.d.ts',
				// Entry barrels are re-exports; covering them proves nothing.
				'src/index.ts',
				'src/react.ts',
				'src/devtools.ts',
				'src/testing.ts',
			],
			thresholds: {
				statements: 90,
				branches: 90,
				functions: 90,
				lines: 90,
			},
		},
	},
})
