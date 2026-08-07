// @ts-check
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

module.exports = [
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: './tsconfig.json', sourceType: 'script' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      // Money must never be a float. TECHNICAL_DESIGN §6.1 rule 1.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat is banned — money is bigint in minor units (see src/money).',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='round']",
          message: 'Math.round on money is banned — use divRound from src/money/currency.',
        },
      ],
    },
  },
];
