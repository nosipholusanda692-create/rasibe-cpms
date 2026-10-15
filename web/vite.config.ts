import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// DEV_HTTPS=true serves the dev site over HTTPS and proxies to the API over
// HTTPS, using the pair scripts/gen-dev-cert.ps1 writes (docs/TLS.md). Off by
// default, so plain `npm run dev` is unchanged.
const certDir = fileURLToPath(new URL('../server/certs/', import.meta.url));
const certFile = `${certDir}localhost-cert.pem`;
const keyFile = `${certDir}localhost-key.pem`;
const devHttps = process.env.DEV_HTTPS === 'true';

if (devHttps && !(existsSync(certFile) && existsSync(keyFile))) {
  throw new Error('DEV_HTTPS=true needs server/certs/localhost-cert.pem and -key.pem. Run scripts/gen-dev-cert.ps1 first.');
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    https: devHttps ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined,
    proxy: {
      // the API is same-origin in development, so the session cookie just works
      '/api': devHttps
        // secure: false because the development certificate signs itself
        ? { target: 'https://localhost:4000', changeOrigin: true, secure: false }
        : { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
