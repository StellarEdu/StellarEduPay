'use strict';

const js = require('@eslint/js');
const pluginN = require('eslint-plugin-n');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  pluginN.configs['flat/recommended'],
  {
    languageOptions: {
      ecmaVersion: 2021,
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'require-await': 'error',
      'no-console': 'error',
      'n/exports-style': 'off',
      'n/no-extraneous-require': 'error',
      'n/no-process-exit': 'off',
    },
  },
  {
    files: ['src/utils/logger.js'],
    rules: {
      'no-console': 'off',
    },
  },
];
