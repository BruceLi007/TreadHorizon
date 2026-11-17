/**
 * 字号分级守门（D-508）
 *
 *   node scripts/font-scale-check.mjs
 *
 * 规则：所有 `font-size` 只能取 6 个 token（--fs-display / h1 / h2 / body / meta / caption），
 * 或 viewport / 容器查询的 clamp(...)。不允许再出现裸的 `calc(Npx * var(--fs-scale))`
 * —— 那是 2026-11 之前 511 处字号漂移的来源。
 *
 * 例外（字号当图标尺寸用，不是文字）：
 *   .folder-drop-icon / .tile-add-plus / .tile .play / .share-video-badge
 * 例外（品牌字标，按设计固定缩放）：
 *   .login-brand-name
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const ALLOW_RAW = [
  '.folder-drop-icon',
  '.tile-add-plus',
  '.tile .play',
  '.share-video-badge',
  // 欢迎页地图上的迷你地名卡（插画内文字，按图形尺寸固定，不跟用户字号）
  '.lb-pin-card-prov',
  // 欢迎页夜晚小场景里的音符 / 睡眠 z（插画内文字，随图形缩放，不跟用户字号）
  '.lb-note',
  '.lb-moon-zzz',
];

const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.css')) files.push(p);
  }
})(join(ROOT, 'src'));

const problems = [];
for (const f of files) {
  const css = readFileSync(f, 'utf8');
  const masked = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(masked))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    const body = m[2];
    if (ALLOW_RAW.some((s) => sel.includes(s))) continue;
    for (const d of body.matchAll(/font-size:\s*([^;]+)/g)) {
      const value = d[1].trim();
      if (/^var\(--fs-(display|h1|h2|body|meta|caption)\)/.test(value)) continue;
      if (/^clamp\(/.test(value) || /^min\(var\(--fs-/.test(value)) continue; // 自适应字号（viewport / 容器查询）
      if (/^(inherit|0|0\.\d+em)$/.test(value)) continue;
      problems.push(`${relative(ROOT, f).replace(/\\/g, '/')} :: ${sel.slice(0, 60)} :: ${value}`);
    }
  }
}

if (problems.length) {
  console.error(`❌ 有 ${problems.length} 处字号没走 token：`);
  problems.forEach((p) => console.error('  -', p));
  process.exit(1);
}
console.log('✅ 字号分级检查通过：所有 font-size 都走 --fs-* token（或极值 clamp）');
