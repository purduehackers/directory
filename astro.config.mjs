// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: vercel({
    isr: false,
    maxDuration: 30,
  }),
  vite: {
    plugins: [tailwindcss()],
  },
});
