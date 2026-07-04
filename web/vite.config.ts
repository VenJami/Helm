import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No vite dev server: the Node server injects the auth token into the built
// index.html, so the app must be served from web/dist by server/index.mjs.
// Dev loop = `npm run watch` here + `npm run dev` in server/.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Split heavy vendor deps into their own chunks so the app shell stays
        // small and each big library caches independently. Ordered
        // most-specific-first; the first match wins.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/]@xterm[\\/]/.test(id)) return 'xterm';
          if (/[\\/]node_modules[\\/]gsap[\\/]/.test(id)) return 'gsap';
          if (/[\\/]node_modules[\\/](framer-motion|motion|motion-dom|motion-utils)[\\/]/.test(id)) return 'motion';
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
        },
      },
    },
  },
});
