import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // 注意：不能 changeOrigin（会把 Host 改写成 127.0.0.1:4000）——
      // 多用户模式的 CSRF 校验比较 Origin 与 Host，dev 下必须保留 localhost:5173。
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      // 2026-11-14 D-416：分享只读页是独立入口（dist/share.html），不进主应用路由
      input: {
        main: resolve(rootDir, 'index.html'),
        share: resolve(rootDir, 'share.html'),
      },
    },
  },
});
