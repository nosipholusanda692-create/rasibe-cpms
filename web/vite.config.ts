import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // the API is same-origin in development, so the session cookie just works
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
