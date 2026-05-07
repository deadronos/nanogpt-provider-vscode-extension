// @ts-check
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
	// Ignore compiled output
	{
		ignores: ['dist/**', 'node_modules/**'],
	},
	// All TypeScript files (src + test)
	{
		files: ['src/**/*.ts', 'test/**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
		},
		plugins: {
			'@stylistic': stylistic,
			'@typescript-eslint': tseslint.plugin,
		},
		rules: {
			// Core quality rules (derived from VS Code's base config)
			'curly': 'warn',
			'eqeqeq': 'warn',
			'prefer-const': ['warn', { destructuring: 'all' }],
			'no-debugger': 'warn',
			'no-duplicate-case': 'warn',
			'no-duplicate-imports': 'warn',
			'no-eval': 'warn',
			'no-extra-semi': 'warn',
			'no-new-wrappers': 'warn',
			'no-throw-literal': 'warn',
			'no-unsafe-finally': 'warn',
			'no-var': 'warn',
			'no-unused-expressions': ['warn', { allowTernary: true }],

			// Disable built-in semi in favour of stylistic
			'semi': 'off',
			'@stylistic/semi': 'warn',
			'@stylistic/member-delimiter-style': 'warn',

			// TypeScript naming + any rules (derived from VS Code's TS config)
			'@typescript-eslint/naming-convention': [
				'warn',
				{
					selector: 'class',
					format: ['PascalCase'],
				},
			],
			'@typescript-eslint/no-explicit-any': ['warn', { fixToUnknown: false }],
		},
	},
);
