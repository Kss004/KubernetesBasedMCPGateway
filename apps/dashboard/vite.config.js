import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Fixed output names: the gateway serves exact paths only (/, /app.js, /style.css),
// no directory listing or URL-to-path join (apps/gateway/src/index.ts).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rolldownOptions: {
      output: {
        entryFileNames: 'app.js',
        assetFileNames: 'style.css',
        codeSplitting: false,
      },
    },
  },
  // `npm run dev -w apps/dashboard`: same-origin API via the local ingress.
  server: {
    proxy: {
      '/api': { target: 'http://app.localhost', changeOrigin: true },
    },
  },
});
