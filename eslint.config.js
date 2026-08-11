import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
	globalIgnores(['**/dist', '**/node_modules', '**/coverage']),
	{
		files: ['src/**/*.{ts,tsx}'],
		extends: [js.configs.recommended, tseslint.configs.recommended],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			globals: { ...globals.browser, process: 'readonly' },
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'@typescript-eslint/no-explicit-any': 'error',
			// Inline rather than separate, so type imports never collide with
			// no-duplicate-imports, which does not know they are erased.
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{ fixStyle: 'inline-type-imports' },
			],
			'prefer-const': 'error',
			'no-var': 'error',
			eqeqeq: ['error', 'always'],
			'no-duplicate-imports': 'error',
			'prefer-template': 'error',
		},
	},
	{
		files: ['src/**/*.{test,spec,bench}.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
])
