// ESLint (flat config) for the whole repository: server, feeder, scripts and client.
// Formatting is left to Prettier (eslint-config-prettier turns off style rules).

import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['**/node_modules/**', 'client/dist/**', 'server/data/**', 'coverage/**'] },

  js.configs.recommended,

  // Node code: server, feeder, scripts
  {
    files: ['server/**/*.js', 'feeder/**/*.js', 'scripts/**/*.js', '*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  // The Node version check must run on very old Node, so it stays in plain CommonJS-era syntax.
  { files: ['scripts/check-node.js'], languageOptions: { sourceType: 'script' }, rules: { 'no-var': 'off' } },

  // React client
  {
    files: ['client/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/prop-types': 'off', // plain JavaScript project without PropTypes
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  { files: ['client/vite.config.js'], languageOptions: { globals: globals.node } },

  prettier,
];
