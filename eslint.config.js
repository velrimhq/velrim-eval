// @ts-check
/**
 * velrim-eval is a STANDALONE top-level dir (not a pnpm-workspace member) — it carries its own
 * minimal flat ESLint config so `eslint .` works without the repo's eslint-plugin-velrim.
 * This mirrors the standalone public repo velrim-eval splits into at launch.
 */
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'report/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
