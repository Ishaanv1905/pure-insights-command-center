import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the React app runs on :5173 and proxies API + WebSocket calls
// to the Express server on :3000. Because the browser only ever talks to :5173,
// cookies "just work" and no CORS setup is needed.
const API_TARGET = process.env.API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET.replace(/^http/, 'ws'), ws: true },
    },
  },
});
