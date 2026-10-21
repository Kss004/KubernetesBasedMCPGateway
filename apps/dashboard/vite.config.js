import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Fixed output names: the gateway serves exact paths only (/, /app.js, /style.css),
// no directory listing or URL-to-path join (apps/gateway/src/index.ts).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Never inline assets as data: URLs; the CSP (default-src 'self') would block them.
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        entryFileNames: 'app.js',
        // Fonts keep their own names under fonts/ (the gateway lists that dir at boot);
        // everything else is the single stylesheet.
        assetFileNames: (a) =>
          /\.woff2$/.test(a.names?.[0] ?? a.name ?? '') ? 'fonts/[name][extname]' : 'style.css',
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
