import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // The API serves this app from /m/ so the staff web client can own /
  // (docs/DEPLOY.md). `npm run dev` stays at the root of port 5174.
  base: command === 'build' ? '/m/' : '/',
  server: {
    port: 5174,
    host: true,            // reachable from a phone on the same network
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        // The API refuses a write whose Origin is neither its own nor
        // CORS_ORIGIN. In development this client sits on another port, so the
        // proxy presents the API's own origin. In production the client is
        // served from the same origin as the API and this does not apply.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('origin', 'http://localhost:4000');
          });
        },
      },
    },
  },
}));
