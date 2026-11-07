#!/usr/bin/env node
/**
 * 生成地图标记的配色 SVG（2026-11-05，D-164 修订：十二色相环）。
 *
 * 背景：`<img>` 引用的静态 SVG 不能靠 CSS 改色，所以每种颜色一个文件。
 * 色值 / 顺序的**唯一来源**是 `src/lib/markerPalette.ts`（本脚本直接解析它，
 * 不要在脚本里再抄一份）；改了色板之后跑一次：
 *
 *   npm run build:markers      （= node scripts/build-marker-colors.mjs）
 *
 * 生成：
 * - `public/marker-color-<id>.svg`       —— 单点通用形状（去过 / 想去 / 秘密基地共用）
 * - `public/marker-home-<id>.svg`        —— 家（剪影屋 + 白门）；青色（teal）写回原来的
 *                                           `public/marker-home.svg`，保持默认文件不变
 *
 * 会先清掉旧的 `marker-color-*.svg` / `marker-home-*.svg` 再重建；不会动
 * `marker.svg`、`marker-wish.svg`、`marker-secret.svg`（三种图标的「默认色」文件）。
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PALETTE_TS = join(ROOT, 'src', 'lib', 'markerPalette.ts');
const PUBLIC = join(ROOT, 'public');

const ENTRY_RE =
  /\{\s*id:\s*'([a-z]+)',\s*label:\s*'([^']+)',\s*hex:\s*'(#[0-9a-fA-F]{6})'\s*\}/g;

const colors = [...readFileSync(PALETTE_TS, 'utf8').matchAll(ENTRY_RE)].map((m) => ({
  id: m[1],
  label: m[2],
  hex: m[3],
}));

if (colors.length !== 12) {
  console.error(`解析配色失败：期望 12 个颜色，实际 ${colors.length} 个（检查 ${PALETTE_TS}）`);
  process.exit(1);
}

/** 单点通用形状（2 个小尖头，底尖 50,100 = 地图坐标；D-151 起三种图标同形） */
const MARKER_POLY = '50,100 33.5,54 10,20 50,32 90,20 66.5,54';
/** 家：2 号极简剪影屋（D-161） */
const HOME_PATH = 'M50 10 90 48H78V82L50 100 22 82V48H10Z';
const HOME_DOOR = '<rect x="42" y="58" width="16" height="24" rx="4" fill="#ffffff"/>';

const svg = (comment, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">\n` +
  `  <!-- ${comment}（scripts/build-marker-colors.mjs 生成；改色值先改 src/lib/markerPalette.ts 再重跑） -->\n` +
  `  ${body}\n` +
  `</svg>\n`;

const markerSvg = (c) => svg(`单点通用 · ${c.label} ${c.hex}`, `<polygon points="${MARKER_POLY}" fill="${c.hex}"/>`);
const homeSvg = (c) =>
  svg(`家 · 2 号极简剪影屋 · ${c.label} ${c.hex}`, `<path d="${HOME_PATH}" fill="${c.hex}"/>\n  ${HOME_DOOR}`);

// 清掉旧的配色文件（默认色文件 marker.svg / marker-wish.svg / marker-secret.svg 保留）
for (const name of readdirSync(PUBLIC)) {
  if (/^marker-(color|home)-.+\.svg$/.test(name)) rmSync(join(PUBLIC, name));
}

let written = 0;
for (const c of colors) {
  writeFileSync(join(PUBLIC, `marker-color-${c.id}.svg`), markerSvg(c), 'utf8');
  written++;
  // 青色（teal）沿用最早的 public/marker-home.svg 作为「家」的默认图标文件
  const homeName = c.id === 'teal' ? 'marker-home.svg' : `marker-home-${c.id}.svg`;
  writeFileSync(join(PUBLIC, homeName), homeSvg(c), 'utf8');
  written++;
}

console.log(`已生成 ${written} 个配色 SVG（${colors.length} 色 × 单点 / 家），色板来源 ${PALETTE_TS}`);
