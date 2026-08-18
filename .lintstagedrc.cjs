module.exports = {
  'apps/web/**/*.{ts,tsx,js,jsx,mjs,cjs}': [
    'prettier --write',
    'pnpm --filter @ai-werewolf/web lint:fix',
    () => 'pnpm --filter @ai-werewolf/web check',
  ],
  'apps/api/**/*.{ts,js,mjs,cjs}': [
    'prettier --write',
    'pnpm --filter @ai-werewolf/api lint:fix',
    () => 'pnpm --filter @ai-werewolf/api check',
  ],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};
