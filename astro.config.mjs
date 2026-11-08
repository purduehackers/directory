// @ts-check
import { globSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

// Include Bun conditional export files that @vercel/nft skips when tracing with Node conditions
const bunConditionalExportFiles = [
  ...globSync('./node_modules/@libsql/isomorphic-ws/web.*'),
  ...globSync('./node_modules/@vercel/oidc/node_modules/jose/dist/browser/**/*.js'),
];

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: vercel({
    isr: false,
    maxDuration: 30,
    includeFiles: bunConditionalExportFiles,
  }),
  vite: {
    plugins: [tailwindcss()],
  },
});
