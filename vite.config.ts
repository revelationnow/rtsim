import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// SINGLE_FILE=1 inlines everything into one HTML file that runs straight from disk.
const single = process.env.SINGLE_FILE === '1';

export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  plugins: [react(), tailwindcss(), ...(single ? [viteSingleFile()] : [])],
  worker: { format: 'es' },
  define: { __SINGLE_FILE__: JSON.stringify(single) },
  build: { outDir: single ? 'dist-single' : 'dist', chunkSizeWarningLimit: 2000 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
