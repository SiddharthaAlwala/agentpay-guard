// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'infra/k6/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'apps/guard/**/*.ts',
      'apps/proxy/**/*.ts',
      'packages/**/*.ts',
      'apps/demo-agent/**/*.ts',
      'scripts/**/*.mjs',
      '*.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },
  {
    // CLIs and demo scripts print to stdout on purpose.
    files: [
      'scripts/**',
      'apps/demo-agent/**',
      'apps/guard/src/migrate.ts',
      'apps/guard/src/demo/seed.ts',
      'apps/proxy/src/cli.ts',
      'apps/proxy/src/migrate.ts',
      'apps/proxy/bench/**',
    ],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
