import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: true,
    proxy: {
      // 本地开发时代理 Groovy 管理接口到后端，解决 CORS 问题
      '/api/groovy': {
        target: 'http://localhost:8025',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
