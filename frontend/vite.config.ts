import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// cloudflare() plugin removed — it routes requests through workerd which
// aborts large multipart uploads (body size limits). Not needed for self-hosted VPS.
// import { cloudflare } from "@cloudflare/vite-plugin";
import { mochaPlugins } from "@getmocha/vite-plugins";

const proxyConfig = {
  '/ffmpeg': {
    target: 'http://localhost:3333',
    changeOrigin: true,
    timeout: 0,
    proxyTimeout: 0,
    rewrite: (path: string) => path.replace(/^\/ffmpeg/, ''),
    configure: (proxy: any) => {
      proxy.on('error', (err: any) => {
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
    configure: (proxy: any) => {
      proxy.on('error', (err: any) => {
        if (!(err.message || '').includes('ECONNRESET') && !(err.message || '').includes('ETIMEDOUT')) {
          console.error('Session proxy error:', err.message);
        }
      });
      // Disable all timeouts on proxy-to-backend connections for uploads
      proxy.on('proxyReq', (proxyReq: any) => {
        proxyReq.setTimeout(0);
        proxyReq.setSocketKeepAlive(true);
        // Don't remove headers — let the body through naturally
      });
      // Suppress timeout errors on socket re-use
      proxy.on('proxyRes', (proxyRes: any) => {
        proxyRes.on('error', () => {});
      });
    },
  },
  '/api': {
    target: 'http://localhost:3333',
    changeOrigin: true,
    proxyTimeout: 0,
    timeout: 0,
    configure: (proxy: any) => {
      proxy.on('error', (err: any) => {
        if (!(err.message || '').includes('ECONNRESET') && !(err.message || '').includes('ETIMEDOUT')) {
          console.error('API proxy error:', err.message);
        }
      });
    },
  },
};

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [...mochaPlugins(process.env as any), react()],
  // Development server config
  server: {
    host: true, // Bind to 0.0.0.0 so VPS is accessible from network
    allowedHosts: true,
    // Disable all timeouts for large file uploads
    proxy: proxyConfig,
  },
  // Production preview server config
  preview: {
    host: true,
    allowedHosts: true,
    proxy: proxyConfig,
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
