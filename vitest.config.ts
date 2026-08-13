/*
 *   IMPORTS
 ***************************************************************************************************/
import { defineConfig } from 'vitest/config'

/*
 *   VITEST CONFIG
 ***************************************************************************************************/
export default defineConfig({
	test: {
		globals: false,
		environment: 'happy-dom',
		include: ['src/**/*.{test,spec}.ts'],
		clearMocks: true,
		restoreMocks: true,
		benchmark: {
			include: ['src/**/*.bench.ts'],
		},
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html', 'lcov'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/__tests__/**', 'src/__bench__/**', 'src/**/*.d.ts', 'src/index.ts'],
			thresholds: {
				statements: 90,
				branches: 90,
				functions: 90,
				lines: 90,
			},
		},
	},
})
