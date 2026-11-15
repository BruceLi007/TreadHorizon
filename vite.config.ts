import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * 2026-11-15 D-433（用户：「4000 必须冲突吗？能改吗」）：
 * dev 的 `/api` 代理原来写死 `127.0.0.1:4000`，和安装版默认端口撞车（两个都想用 4000，
 * 先起的那个赢，浏览器就会打开错的库）。现在改成跟着 `.env.local` 的 `PORT` 走：
 * - `.env.local` 里写 `PORT=4001` → dev 的 API 起在 4001，代理也指向 4001；
 * - 不写 → 仍旧 4000（行为不变）。
 * 安装版继续用 4000，两边可以同时开，互不抢占。
 */
export default defineConfig(({ mode }) => {
  // 第三个参数传 '' 才能读到不带 VITE_ 前缀的变量（PORT 就是这种）
  const env = loadEnv(mode, rootDir, '');
  const apiPort = String(env.PORT || process.env.PORT || '4000').trim();
  const apiTarget = `http://127.0.0.1:${apiPort}`;

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        // 注意：不能 changeOrigin（会把 Host 改写成 127.0.0.1:<apiPort>）——
        // 多用户模式的 CSRF 校验比较 Origin 与 Host，dev 下必须保留 localhost:5173。
        '/api': { target: apiTarget, changeOrigin: false },
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
  };
});
