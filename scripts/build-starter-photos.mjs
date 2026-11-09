#!/usr/bin/env node
/**
 * 生成「首次初始化 34 个省会足迹」用的 34 张示例照片（PNG）。
 *
 * 背景：新用户首次初始化数据时，要为 34 个省级行政区各生成一条到访足迹，
 * 每条足迹带一张卡通贴照片。照片造型直接复用云端登录页
 * `src/ui/LoginProvinceStickers.tsx` 里 34 个省/自治区的景点贴纸
 * （PROVINCE_STICKERS + StickerIcon），输出为 640×480 PNG，
 * 固定文件名 server/starter-photos/<key>.png，供服务端种子逻辑引用。
 *
 * 技术路线：
 *  1. 用仓库内的 tsc 单文件编译 TSX 到 .tmp/starter-gen/（避免引入打包器依赖）；
 *     TS 7 是原生编译器，必须加 --ignoreConfig 才不读取 tsconfig 项目上下文；
 *     Windows + Node 20.12+ 不允许 spawnSync 直接启动 .cmd（会 EINVAL），
 *     所以优先用 `node node_modules/typescript/bin/tsc`，缺失时才回退到 tsc.cmd + shell。
 *  2. 动态 import 编译产物，拿到 PROVINCE_STICKERS / StickerIcon；
 *  3. 用 react-dom/server 的 renderToStaticMarkup 拼 SVG（不用 JSX 写 .mjs），
 *     再用 sharp 转 PNG。
 *  4. 结束时清理 .tmp/starter-gen（脚本可重复运行，每次重新编译）。
 *
 * 构图（34 张统一）：
 *  - 640×480 米白底 + 极浅省色角落色块 + 轻暗角；
 *  - 居中白色圆环（r=168、白描边 26）内填该省粉彩底色，圆下方一层很淡的投影；
 *  - 圆内是深墨线稿景点图标（局部坐标 ±9 → scale(13)）；
 *  - 四周少量白色小云朵 / 圆点 / 四角星，按序号做微小偏移；
 *  - 不绘制任何文字，避免服务器缺字体导致乱码。
 *
 * 用法：node scripts/build-starter-photos.mjs
 * 输出：server/starter-photos/{beijing,...,macau}.png（34 个，顺序同 PROVINCE_STICKERS）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TSX_FILE = path.join(ROOT, 'src', 'ui', 'LoginProvinceStickers.tsx');
const TMP_DIR = path.join(ROOT, '.tmp', 'starter-gen');
const OUT_DIR = path.join(ROOT, 'server', 'starter-photos');
const MIN_BYTES = 5 * 1024;

const W = 640;
const H = 480;
const CX = W / 2; // 320
const CY = H / 2; // 240
const RING_R = 168; // 粉彩圆半径
const RING_STROKE = 26; // 白色描边
const ICON_SCALE = 13; // 图标局部坐标 ±9 → ±117

/** 输出文件顺序：与 PROVINCE_STICKERS 顺序一一对应（34 个省级行政区） */
const KEYS = [
  'beijing', 'tianjin', 'hebei', 'shanxi', 'neimenggu', 'liaoning', 'jilin',
  'heilongjiang', 'shanghai', 'jiangsu', 'zhejiang', 'anhui', 'fujian',
  'jiangxi', 'shandong', 'henan', 'hubei', 'hunan', 'guangdong', 'guangxi',
  'hainan', 'chongqing', 'sichuan', 'guizhou', 'yunnan', 'xizang', 'shaanxi',
  'gansu', 'qinghai', 'ningxia', 'xinjiang', 'taiwan', 'hongkong', 'macau',
];

/**
 * 省级行政区全称（与 PROVINCE_STICKERS[i].province 逐字一致）→ 输出文件名。
 * 用「按名字查表」而不是「按下标硬编码」，这样即便将来 PROVINCE_STICKERS
 * 内部顺序调整，文件名也不会错位；末尾会校验 34 个 key 全部产出。
 */
const PROVINCE_KEY = {
  北京市: 'beijing',
  天津市: 'tianjin',
  河北省: 'hebei',
  山西省: 'shanxi',
  内蒙古自治区: 'neimenggu',
  辽宁省: 'liaoning',
  吉林省: 'jilin',
  黑龙江省: 'heilongjiang',
  上海市: 'shanghai',
  江苏省: 'jiangsu',
  浙江省: 'zhejiang',
  安徽省: 'anhui',
  福建省: 'fujian',
  江西省: 'jiangxi',
  山东省: 'shandong',
  河南省: 'henan',
  湖北省: 'hubei',
  湖南省: 'hunan',
  广东省: 'guangdong',
  广西壮族自治区: 'guangxi',
  海南省: 'hainan',
  重庆市: 'chongqing',
  四川省: 'sichuan',
  贵州省: 'guizhou',
  云南省: 'yunnan',
  西藏自治区: 'xizang',
  陕西省: 'shaanxi',
  甘肃省: 'gansu',
  青海省: 'qinghai',
  宁夏回族自治区: 'ningxia',
  新疆维吾尔自治区: 'xinjiang',
  台湾省: 'taiwan',
  香港特别行政区: 'hongkong',
  澳门特别行政区: 'macau',
};

const INK = '#33423a'; // 与贴纸图标一致的深墨色（用于淡化/投影）

/* ───────────────────────── 颜色工具 ───────────────────────── */

function parseHex(value) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
  if (!m) throw new Error(`无法解析颜色: ${value}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

/** 线性混色：t=0 取 a，t=1 取 b */
function mix(a, b, t) {
  const A = parseHex(a);
  const B = parseHex(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}

const lighten = (hex, t) => mix(hex, '#ffffff', t);
const darken = (hex, t) => mix(hex, INK, t);

/** 确定性伪随机（同一省份每次生成结果一致，便于重复运行与 diff） */
function pseudo(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function jitter(index, salt, amp = 5) {
  return (pseudo(index * 7.13 + salt * 13.7) - 0.5) * 2 * amp;
}

/* ───────────────────────── 图形小零件 ───────────────────────── */

/** 白色小云朵：3 个圆 + 一条圆角底边 */
function cloud(cx, cy, scale, opacity, seed) {
  return h(
    'g',
    {
      transform: `translate(${cx} ${cy}) scale(${scale}) rotate(${jitter(seed, 1, 2).toFixed(2)})`,
      fill: '#ffffff',
      fillOpacity: opacity,
    },
    h('circle', { cx: -22, cy: 0, r: 16 }),
    h('circle', { cx: 0, cy: -11, r: 22 }),
    h('circle', { cx: 24, cy: 0, r: 15 }),
    h('rect', { x: -30, y: 1, width: 61, height: 16, rx: 8 }),
  );
}

/** 四角星（内凹曲线的 sparkle） */
function star(cx, cy, r, opacity, fill, seed) {
  const q = r * 0.18;
  const d = `M0 ${-r} Q${q} ${-q} ${r} 0 Q${q} ${q} 0 ${r} Q${-q} ${q} ${-r} 0 Q${-q} ${-q} 0 ${-r} Z`;
  return h('path', {
    transform: `translate(${cx} ${cy}) rotate(${jitter(seed, 2, 14).toFixed(1)})`,
    d,
    fill,
    fillOpacity: opacity,
  });
}

function dot(cx, cy, r, opacity, fill) {
  return h('circle', { cx, cy, r, fill, fillOpacity: opacity });
}

/**
 * 固定装饰布局（34 张共用，只做 ±5px 的确定性微偏移）。
 * 全部位于圆环（外径 181）之外，不遮挡贴纸主体。
 */
const DECOR = [
  { kind: 'cloud', x: 86, y: 92, scale: 1.05, opacity: 0.9 },
  { kind: 'cloud', x: 556, y: 396, scale: 0.8, opacity: 0.82 },
  { kind: 'star', x: 128, y: 372, r: 11, opacity: 0.95, tint: 0 },
  { kind: 'star', x: 508, y: 118, r: 13, opacity: 0.9, tint: 0 },
  { kind: 'star', x: 536, y: 306, r: 8, opacity: 0.8, tint: 0 },
  { kind: 'star', x: 104, y: 212, r: 7, opacity: 0.72, tint: 0 },
  { kind: 'dot', x: 172, y: 74, r: 4.5, opacity: 0.8, tint: 0 },
  { kind: 'dot', x: 466, y: 68, r: 3.5, opacity: 0.7, tint: 0 },
  { kind: 'dot', x: 250, y: 440, r: 5, opacity: 0.7, tint: 0 },
  { kind: 'dot', x: 428, y: 446, r: 4, opacity: 0.62, tint: 0 },
  { kind: 'dot', x: 578, y: 232, r: 6, opacity: 0.6, tint: 0 },
  { kind: 'dot', x: 62, y: 300, r: 5, opacity: 0.55, tint: 0 },
  { kind: 'dot', x: 196, y: 408, r: 7, opacity: 0.5, tint: 0.2 },
  { kind: 'dot', x: 462, y: 402, r: 8, opacity: 0.45, tint: 0.25 },
  { kind: 'dot', x: 566, y: 150, r: 9, opacity: 0.4, tint: 0.3 },
  { kind: 'dot', x: 92, y: 388, r: 10, opacity: 0.34, tint: 0.35 },
];

/* ───────────────────────── 单张照片 SVG ───────────────────────── */

/**
 * 生成一张 640×480 的示例照片 SVG（React 元素树）。
 * @param {{province: string, icon: string, color: string}} def PROVINCE_STICKERS 中的一条
 * @param {(props: {kind: string}) => import('react').ReactElement | null} StickerIcon
 * @param {number} index 在 PROVINCE_STICKERS 中的序号（用于确定性微偏移）
 */
function buildSvg(def, StickerIcon, index) {
  const tint = def.color;
  const tintDeep = darken(tint, 0.1);

  const defs = h(
    'defs',
    null,
    h(
      'linearGradient',
      { id: 'bg', x1: '0', y1: '0', x2: '0.35', y2: '1' },
      h('stop', { offset: '0%', stopColor: '#fdfaf3' }),
      h('stop', { offset: '100%', stopColor: '#f5eddd' }),
    ),
    h(
      'radialGradient',
      { id: 'vignette', cx: '50%', cy: '48%', r: '74%' },
      h('stop', { offset: '60%', stopColor: INK, stopOpacity: 0 }),
      h('stop', { offset: '100%', stopColor: INK, stopOpacity: 0.075 }),
    ),
  );

  const background = [
    h('rect', { key: 'base', width: W, height: H, fill: 'url(#bg)' }),
    // 极浅省色角落色块：让每张照片底色略有省份辨识度，但不抢主体
    h('circle', { key: 'blob-a', cx: 70, cy: 62, r: 122, fill: lighten(tint, 0.5), fillOpacity: 0.55 }),
    h('circle', { key: 'blob-b', cx: 600, cy: 430, r: 154, fill: lighten(tint, 0.58), fillOpacity: 0.5 }),
    h('circle', { key: 'blob-c', cx: 598, cy: 42, r: 80, fill: lighten(tint, 0.7), fillOpacity: 0.45 }),
    h('circle', { key: 'blob-d', cx: 44, cy: 420, r: 96, fill: lighten(tint, 0.66), fillOpacity: 0.4 }),
    h('rect', { key: 'vignette', width: W, height: H, fill: 'url(#vignette)' }),
  ];

  // 圆下很淡的投影（三层叠加出柔和边缘，不依赖 SVG 模糊滤镜）
  const shadow = h(
    'g',
    { key: 'shadow' },
    h('ellipse', { cx: CX, cy: CY + 172, rx: 156, ry: 26, fill: INK, fillOpacity: 0.045 }),
    h('ellipse', { cx: CX, cy: CY + 185, rx: 124, ry: 17, fill: INK, fillOpacity: 0.045 }),
    h('ellipse', { cx: CX, cy: CY + 195, rx: 88, ry: 11, fill: INK, fillOpacity: 0.04 }),
  );

  const ring = h(
    'g',
    { key: 'sticker' },
    // 白色外圈 + 粉彩圆底
    h('circle', {
      cx: CX,
      cy: CY,
      r: RING_R,
      fill: tint,
      stroke: '#ffffff',
      strokeWidth: RING_STROKE,
    }),
    // 极淡更深的色环，让粉彩圆与白边之间有层次
    h('circle', {
      cx: CX,
      cy: CY,
      r: RING_R - RING_STROKE / 2 - 1,
      fill: 'none',
      stroke: tintDeep,
      strokeWidth: 2,
      strokeOpacity: 0.35,
    }),
    // 外缘细轮廓，避免白边与米白底糊在一起
    h('circle', {
      cx: CX,
      cy: CY,
      r: RING_R + RING_STROKE / 2,
      fill: 'none',
      stroke: '#e7dfcf',
      strokeWidth: 1.6,
      strokeOpacity: 0.9,
    }),
    // 左上高光
    h('ellipse', {
      cx: CX - 42,
      cy: CY - 64,
      rx: 78,
      ry: 52,
      fill: '#ffffff',
      fillOpacity: 0.18,
      transform: `rotate(-22 ${CX - 42} ${CY - 64})`,
    }),
    // 贴纸内的轻台面，给图标一点落脚的阴影感
    h('ellipse', {
      cx: CX,
      cy: CY + 108,
      rx: 114,
      ry: 19,
      fill: '#ffffff',
      fillOpacity: 0.2,
    }),
  );

  // 深墨线稿景点图标（局部坐标 ±9 → scale(13) 后约 ±117，稳在粉彩圆内）
  const icon = h(
    'g',
    { key: 'icon', transform: `translate(${CX} ${CY}) scale(${ICON_SCALE})` },
    h(StickerIcon, { kind: def.icon }),
  );

  const decorations = DECOR.map((d, i) => {
    const x = d.x + jitter(index, i + 10, 5);
    const y = d.y + jitter(index, i + 40, 5);
    const fill = d.tint === undefined || d.tint === 0 ? '#ffffff' : lighten(tint, d.tint);
    if (d.kind === 'cloud') {
      return h('g', { key: `decor-${i}` }, cloud(x, y, d.scale, d.opacity, index + i));
    }
    if (d.kind === 'star') {
      return h('g', { key: `decor-${i}` }, star(x, y, d.r, d.opacity, fill, index + i));
    }
    return h('g', { key: `decor-${i}` }, dot(x, y, d.r, d.opacity, fill));
  });

  return h(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      width: W,
      height: H,
      viewBox: `0 0 ${W} ${H}`,
    },
    defs,
    background,
    shadow,
    ring,
    icon,
    decorations,
  );
}

/* ───────────────────────── tsc 编译 ───────────────────────── */

function compileTsx() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tscArgs = [
    TSX_FILE,
    '--ignoreConfig', // TS 7 原生编译器：不读 tsconfig 项目上下文（否则报 TS5112）
    '--jsx', 'react-jsx',
    '--module', 'esnext',
    '--target', 'es2022',
    '--moduleResolution', 'bundler',
    '--skipLibCheck',
    '--outDir', TMP_DIR,
  ];

  const localTsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  let command;
  let args;
  let options;

  if (fs.existsSync(localTsc)) {
    // 首选：用当前 node 直接执行 tsc 入口（Windows 上 spawnSync 不能直接启动 .cmd）
    command = process.execPath;
    args = [localTsc, ...tscArgs];
    options = { cwd: ROOT, stdio: 'inherit' };
  } else {
    // 兜底：node_modules/.bin/tsc(.cmd)，Windows 需要 shell 才能启动 .cmd
    const bin = path.join(
      ROOT,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
    );
    if (!fs.existsSync(bin)) {
      throw new Error('找不到 tsc（node_modules 依赖未安装？请先 npm install）');
    }
    command = bin;
    args = tscArgs;
    options = { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' };
  }

  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tsc 编译失败（exit=${result.status}）`);
  }

  const jsFile = path.join(TMP_DIR, 'LoginProvinceStickers.js');
  if (!fs.existsSync(jsFile)) {
    throw new Error(`tsc 产物不存在: ${jsFile}`);
  }
  return jsFile;
}

/* ───────────────────────── 主流程 ───────────────────────── */

function fmtKb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  if (!fs.existsSync(TSX_FILE)) {
    throw new Error(`数据源不存在: ${TSX_FILE}`);
  }

  const jsFile = compileTsx();
  const mod = await import(pathToFileURL(jsFile).href);
  const { PROVINCE_STICKERS, StickerIcon } = mod;

  if (!Array.isArray(PROVINCE_STICKERS)) {
    throw new Error('编译产物未导出 PROVINCE_STICKERS');
  }
  if (typeof StickerIcon !== 'function') {
    throw new Error('编译产物未导出 StickerIcon');
  }
  if (PROVINCE_STICKERS.length !== KEYS.length) {
    throw new Error(
      `省份数量不符：PROVINCE_STICKERS=${PROVINCE_STICKERS.length}，期望 ${KEYS.length}`,
    );
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`生成 34 张示例照片 → ${path.relative(ROOT, OUT_DIR)}`);
  const rows = [];
  for (let i = 0; i < PROVINCE_STICKERS.length; i += 1) {
    const def = PROVINCE_STICKERS[i];
    const key = PROVINCE_KEY[def.province];
    if (!key) {
      throw new Error(`未知省级行政区（PROVINCE_KEY 未覆盖）: ${def.province}`);
    }
    const markup = renderToStaticMarkup(buildSvg(def, StickerIcon, i));
    const dest = path.join(OUT_DIR, `${key}.png`);
    await sharp(Buffer.from(markup, 'utf8'))
      .png({ compressionLevel: 9, quality: 92 })
      .toFile(dest);

    const meta = await sharp(dest).metadata();
    const size = fs.statSync(dest).size;
    if (meta.width !== W || meta.height !== H) {
      throw new Error(`${key}.png 尺寸异常: ${meta.width}x${meta.height}（期望 ${W}x${H}）`);
    }
    if (size < MIN_BYTES) {
      throw new Error(`${key}.png 体积异常: ${fmtKb(size)}（期望 > 5 KB）`);
    }
    rows.push({ key, size });
    console.log(`  ${key.padEnd(11)} ${W}x${H}  ${fmtKb(size).padStart(9)}  icon=${def.icon}`);
  }

  // 校验 34 个 key 全部产出、无多余/缺失
  const produced = new Set(rows.map((row) => row.key));
  const missing = KEYS.filter((key) => !produced.has(key));
  const unexpected = [...produced].filter((key) => !KEYS.includes(key));
  if (missing.length > 0) throw new Error(`缺少输出: ${missing.join(', ')}`);
  if (unexpected.length > 0) throw new Error(`多余输出: ${unexpected.join(', ')}`);

  const totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
  console.log(
    `\n完成：${rows.length} 张 PNG，总体积 ${fmtKb(totalBytes)}，` +
      `平均 ${fmtKb(totalBytes / rows.length)}（全部 ${W}x${H}，均 > 5 KB）`,
  );
  console.log(`输出目录: ${OUT_DIR}`);
}

try {
  await main();
} finally {
  // 清理 tsc 中间产物；下次运行会重新编译，脚本可重复执行
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}
