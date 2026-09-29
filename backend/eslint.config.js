import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Monetary amounts must be exact. Stellar amounts are 7-decimal fixed-point
    // values (int64 stroops); doing float arithmetic on them introduces rounding
    // error. Use the helpers in utils/stellarAmount.js instead of parseFloat/toFixed.
    files: ['src/**/*.js'],
    ignores: ['src/utils/stellarAmount.js', 'src/**/__tests__/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'parseFloat',
          message:
            'Do not parse money with parseFloat. Use utils/stellarAmount.js (toStroops/fromStroops) for exact 7-decimal amounts.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Number',
          property: 'parseFloat',
          message:
            'Do not parse money with Number.parseFloat. Use utils/stellarAmount.js (toStroops/fromStroops) for exact 7-decimal amounts.',
        },
        {
          object: 'Number',
          property: 'parseInt',
          message:
            'Do not parse money with Number.parseInt. Use utils/stellarAmount.js (toStroops/fromStroops) for exact 7-decimal amounts.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='toFixed']",
          message:
            'Do not round money with toFixed. Store amounts as integer stroops and use utils/stellarAmount.js for conversion.',
        },
      ],
    },
  },
];
