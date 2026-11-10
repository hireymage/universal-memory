import tseslint from 'typescript-eslint';
export default tseslint.config(...tseslint.configs.recommended, {
  ignores: ['dist/', 'coverage/', 'work/', 'outputs/'],
  rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] }
});
