import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// No vite dev server: the Node server injects the auth token into the built
// index.html, so the app must be served from web/dist by server/index.mjs.
// Dev loop = `npm run watch` here + `npm run dev` in server/.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
});
