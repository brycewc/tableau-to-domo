import js from '@eslint/js';
import globals from 'globals';

export default [
	{ ignores: ['node_modules/', 't2d-work/', 'test/fixtures/', '.venv/', 'tmp/', 'logs/'] },
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			globals: { ...globals.node }
		},
		rules: {
			'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
		}
	}
];
