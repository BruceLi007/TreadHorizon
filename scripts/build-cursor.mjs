/**
 * 生成「+ 添加足迹」地图点选模式的自定义光标（D-93）。
 *
 * 用户要求「光标换成统一的飞镖样式」：把 public/marker.svg 的琥珀飞镖缩成
 * 32×32 PNG，尖端作为热点。用 PNG 而不是 SVG 光标，是因为部分浏览器
 * （尤其 Chromium 系）对 SVG cursor 的支持不稳定，PNG 最稳。
 *
 * 形状：与 marker.svg 同形（D-151 起为 2 个小尖头，尖端在 (50,100)），
 * 整体上移 3 个单位给描边留空间；深色描边保证在浅色底图和深色底图上都看得清。
 *
 * 用法：node scripts/build-cursor.mjs  → 输出 public/cursor-dart.png
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 100 100">
  <polygon points="50,97 33.5,51 10,17 50,29 90,17 66.5,51"
           fill="#e8a15a" stroke="#1b1209" stroke-width="5" stroke-linejoin="round"/>
</svg>`;

const out = path.join(root, 'public', 'cursor-dart.png');
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`written ${path.relative(root, out)} (32×32, hotspot 16 31)`);
