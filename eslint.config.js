// ESLint flat config: recommended rules for Node.js ES modules.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', '.vercel/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
