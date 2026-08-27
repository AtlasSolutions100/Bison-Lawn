import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error('PORT environment variable is required but was not provided.');
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// E2E_API_URL is the name the browser e2e harness sets; API_URL is what
// dev.mjs sets. Either points /api at a local API process.
const apiUrl = process.env.API_URL ?? process.env.E2E_API_URL;

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error('BASE_PATH environment variable is required but was not provided.');
}

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss({ optimize: false })],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
    // Cookie auth needs the API on the same origin as the app. Replit's
    // workspace router used to do this; now dev.mjs points API_URL at the local
    // API process, and the browser e2e suite points it at its own random port.
    ...(apiUrl
      ? { proxy: { '/api': { target: apiUrl, changeOrigin: false } } }
      : {}),
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
