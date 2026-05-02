// @ts-check
import tseslint from 'typescript-eslint';
import stylisticTs from '@stylistic/eslint-plugin-ts';

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
			'@stylistic/ts': stylisticTs,
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
			'@stylistic/ts/semi': 'warn',
			'@stylistic/ts/member-delimiter-style': 'warn',

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
