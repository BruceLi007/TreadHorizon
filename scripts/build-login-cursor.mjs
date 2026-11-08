/**
 * 生成登录页「地图打标签」的自定义光标（2026-11-08，D-272）。
 *
 * 用户要求：鼠标移到地图范围内变成「打标签」的样式，点击落一个 Q 版标签。
 * 与 scripts/build-cursor.mjs（飞镖打点光标）同一套做法：用 sharp 把 32×32 SVG 转 PNG，
 * 因为部分浏览器（Chromium 系）对 SVG cursor 支持不稳定，PNG 最稳；
 * 热点设在标签尖端 (5, 28)，与 LoginBackdrop.css 里的 `cursor: url(...) 5 28` 对应。
 *
 * 用法：node scripts/build-login-cursor.mjs  → 输出 public/cursor-tag.png
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Q 版标签贴纸：圆角标签 + 挂孔 + 指向左下的尖角；琥珀工具色 + 深色描边，
// 在浅色地图 / 深色底图上都看得清（与项目「+ 添加足迹」飞镖光标同一视觉语言）。
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <g transform="rotate(-8 16 15)">
    <path d="M11 4.5 H24 Q27 4.5 27 7.5 V20 Q27 23 24 23 H14 L9.6 27.6 Q8.2 29 8 26.8 V23 Q7.6 22.8 7.6 22 V7.5 Q7.6 4.5 11 4.5 Z"
          fill="#f0b264" stroke="#1b1209" stroke-width="1.8" stroke-linejoin="round"/>
    <circle cx="12.4" cy="9.2" r="1.9" fill="#fff8ec" stroke="#1b1209" stroke-width="1"/>
    <path d="M13.6 16.6 L20.4 16.6 M13.6 19.4 L18.2 19.4" stroke="#7a4a12" stroke-width="1.6" stroke-linecap="round"/>
  </g>
</svg>`;

const out = path.join(root, 'public', 'cursor-tag.png');
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`written ${path.relative(root, out)} (32×32, hotspot 5 28)`);
