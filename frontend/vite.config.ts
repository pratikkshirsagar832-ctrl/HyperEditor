import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { mochaPlugins } from "@getmocha/vite-plugins";

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [...mochaPlugins(process.env as any), react(), cloudflare()],
  server: {
    allowedHosts: true,
    // Disable all timeouts for large file uploads
    proxy: {
      '/ffmpeg': {
        target: 'http://localhost:3333',
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        rewrite: (path) => path.replace(/^\/ffmpeg/, ''),
        configure: (proxy) => {
          proxy.on('error', (err) => {
            if (!(err.message || '').includes('ECONNRESET') && !(err.message || '').includes('ETIMEDOUT')) {
              console.error('Proxy error:', err.message);
            }
          });
        },
      },
      '/assets': {
        target: 'http://localhost:3333',
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
      '/health': {
        target: 'http://localhost:3333',
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
      '/session': {
        target: 'http://localhost:3333',
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            if (!(err.message || '').includes('ECONNRESET') && !(err.message || '').includes('ETIMEDOUT')) {
              console.error('Session proxy error:', err.message);
            }
          });
          // Disable all timeouts on proxy-to-backend connections for uploads
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setTimeout(0);
            proxyReq.setSocketKeepAlive(true);
            // Don't remove headers — let the body through naturally
          });
          // Suppress timeout errors on socket re-use
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.on('error', () => {});
          });
        },
      },
      '/api': {
        target: 'http://localhost:3333',
        changeOrigin: true,
        proxyTimeout: 0,
        timeout: 0,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            if (!(err.message || '').includes('ECONNRESET') && !(err.message || '').includes('ETIMEDOUT')) {
              console.error('API proxy error:', err.message);
            }
          });
        },
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router'],
          'vendor-remotion': ['remotion', '@remotion/player', '@remotion/bundler'],
          'vendor-three': ['three', '@react-three/fiber', '@react-three/drei'],
          'vendor-ui': ['lucide-react', 'zustand'],
        },
      },
    },
    sourcemap: false,
    minify: 'terser',
    terserOptions: {
      compress: { drop_console: false, drop_debugger: true },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
