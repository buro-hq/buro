import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import style, { codeFiles } from './tooling/eslint-style.mjs';

export default [
  ...style,
  {
    name: 'buro/correctness',
    files: codeFiles,
    languageOptions: { globals: globals.es2022 },
    rules: {
      ...js.configs.recommended.rules,
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-duplicate-imports': 'error',
      // AggregateError already retains its failures; adapter causes follow their own privacy contract.
      'preserve-caught-error': 'off',
    },
  },
  {
    name: 'buro/node',
    files: codeFiles,
    ignores: ['src/**'],
    languageOptions: { globals: globals.node },
  },
  {
    name: 'buro/typescript',
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      ...tseslint.configs.eslintRecommended.rules,
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'no-unused-vars': 'off',
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': 'error',
      '@typescript-eslint/no-duplicate-enum-values': 'error',
      '@typescript-eslint/no-misused-new': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    name: 'buro/promises',
    files: ['{src,modules,agent,daemon,cli,scripts}/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.server.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    name: 'buro/browser',
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    name: 'buro/react-hooks',
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
