import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import onlyWarn from 'eslint-plugin-only-warn'
import pluginReact from 'eslint-plugin-react'
import pluginReactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/** @type {import("eslint").Linter.Config[]} */
export default [
	js.configs.recommended,
	eslintConfigPrettier,
	...tseslint.configs.recommended,
	{
		rules: {
			'no-empty': ['warn', { allowEmptyCatch: true }],
			'@typescript-eslint/no-unused-vars': [
				'warn',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
					destructuredArrayIgnorePattern: '^_',
				},
			],
		},
	},
	// only-warn turns every rule into a warning; `--max-warnings 0` is what makes
	// the lint script fail, so a violation is still a red gate.
	{
		plugins: { onlyWarn },
	},
	pluginReact.configs.flat.recommended,
	{
		languageOptions: {
			...pluginReact.configs.flat.recommended.languageOptions,
			globals: {
				...globals.serviceworker,
				...globals.browser,
			},
		},
	},
	{
		plugins: { 'react-hooks': pluginReactHooks },
		settings: { react: { version: '18' } },
		rules: {
			...pluginReactHooks.configs.recommended.rules,
			'react/react-in-jsx-scope': 'off',
			'react/prop-types': 'off',
			'react-hooks/set-state-in-effect': 'off',
			'react-hooks/incompatible-library': 'off',
		},
	},
	{
		// Visual docs (HTML/MDX) + the docs bundler script are not app source we lint.
		ignores: ['dist/**', 'docs/**', 'scripts/**', 'coverage/**'],
	},
]
