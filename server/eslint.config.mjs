// ESLint (flat config) — correctness rules only; formatting is Prettier's job.
// The JSDoc typecheck (npm run typecheck) covers types; this catches the
// suspicious-pattern class (unused vars, unreachable code, bad comparisons).
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
  },
];
