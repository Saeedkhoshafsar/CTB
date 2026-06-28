import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Dev mode: forward API calls (incl. session cookie) to the Fastify server.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // PLAN5 P3-T7 / issue C8: split heavy vendor libs out of the entry chunk
        // so the initial load is small and the big flow-canvas deps (@xyflow,
        // CodeMirror) only download when their lazy routes are visited.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xyflow') || id.includes('d3-')) return 'vendor-flow';
          if (id.includes('@codemirror') || id.includes('@lezer') || id.includes('codemirror')) {
            return 'vendor-codemirror';
          }
          if (id.includes('react-router') || id.includes('react-dom') || id.includes('/react/')) {
            return 'vendor-react';
          }
          return 'vendor';
        },
      },
    },
  },
});
