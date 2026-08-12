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
