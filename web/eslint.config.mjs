// ESLint (flat config) — correctness rules only; formatting is Prettier's job.
// tsc --strict already runs in CI, so this focuses on what tsc can't see:
// suspicious patterns (recommended sets) and React hook mistakes.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // animate-ui/ is vendor code copied VERBATIM (owner decision, see ROADMAP
  // "Animated icons") — don't lint what we deliberately don't rewrite.
  { ignores: ['dist/', 'src/components/animate-ui/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
