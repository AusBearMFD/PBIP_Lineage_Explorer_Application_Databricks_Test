import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  base: './',
  // Own fixed port so this copy never opens the original app (which uses 5173).
  server: { port: 5180, strictPort: true },
  build: {
    outDir: 'dist',
    sourcemap: true
  },
  resolve: {
    alias: {
      '@pbip-lineage/core': path.resolve(__dirname, 'packages/core/src'),
      '@pbip-lineage/core/': path.resolve(__dirname, 'packages/core/src/'),
    }
  }
});
