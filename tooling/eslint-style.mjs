import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';
import { multilineCallObject } from './eslint-rules/multiline-call-object.mjs';

/** Source code has one formatting owner; generated state and historical sources stay excluded. */
export const codeFiles = [
  '{src,modules,agent,daemon,cli,scripts,tests,tooling}/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
  '*.{js,mjs,cjs,ts}',
];

/** Shared exclusions for formatting and correctness checks. */
export const ignoredFiles = [
  '**/node_modules/**',
  'dist/**',
  '.buro/**',
  '.codex/**',
  '.firecrawl/**',
  'artifacts/**',
  'archive/**',
  'docs/archive/**',
  'output/**',
  'public/**',
];

const style = stylistic.configs.customize({
  indent: 2,
  quotes: 'single',
  semi: true,
  jsx: true,
  arrowParens: true,
  braceStyle: '1tbs',
});

/** Layout-only configuration, also consumed by the full linter. */
export default [
  { ignores: ignoredFiles },
  {
    ...style,
    name: 'buro/source-style',
    files: codeFiles,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      ...style.plugins,
      '@typescript-eslint': tseslint.plugin,
      'buro': { rules: { 'multiline-call-object': multilineCallObject } },
    },
    rules: {
      ...style.rules,
      // Splitting inline JSX text can remove significant spaces between expressions.
      '@stylistic/jsx-one-expression-per-line': 'off',
      'one-var': ['error', 'never'],
      'arrow-body-style': ['error', 'as-needed'],
      '@stylistic/linebreak-style': ['error', 'unix'],
      '@stylistic/nonblock-statement-body-position': ['error', 'below'],
      '@stylistic/operator-linebreak': ['error', 'after', { overrides: { '?': 'before', ':': 'before', '|': 'before', '&': 'before' } }],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'if', next: '*' },
      ],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports', disallowTypeAnnotations: false },
      ],
      'buro/multiline-call-object': 'error',
    },
  },
];
