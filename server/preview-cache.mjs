/**
 * 预览缓存（2026-11-20 D-544）
 *
 * 背景：同步 / 分享都要把照片缩到 1280 长边。以前每条路径都直接从**原图**解码
 * （用户库 3342 张 = 14.6 GB，其中 1110 张 HEIC 走 heic-convert 的 WASM 解码），
 * 打包 31 分钟、且队列尾部 HEIC 占比 90%+ 时吞吐断崖。
 *
 * 这里把「原图 → 1600 长边 webp q82」缓存到 thumbs/<id>_p.webp：
 * - 命中缓存：只解 1600 小图再缩 1280（快）；
 * - 未命中：从原图生成 1600 并写盘，再由它缩 1280（第一次多一次编码，之后都省）；
 * - 兼容：DB `media.preview` 为空时按 `<id>_p.webp` 约定回退（历史按需看图生成的那些也能用）。
 *
 * HEIC 解码是单线程 WASM：同步/分享按「HEIC 优先、体积从大到小」排序 + 更高并发，
 * 避免最后只剩 HEIC 拖出长尾。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { CONFIG } from './config.mjs';
import { decodeHeicToJpeg, isHeicFile } from './heic.mjs';

export const PREVIEW_MAX = 1280;
export const PREVIEW_QUALITY = 75;
/** 缓存尺寸（与「按需看图」的 ensurePreview 一致：1600 长边 q82） */
export const CACHE_MAX = 1600;
export const CACHE_QUALITY = 82;
export const CACHE_SUFFIX = '_p.webp';

const CPU =
  typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : Math.max(1, os.cpus()?.length || 1);
/** HEIC 是单线程 WASM：多开几个（默认 4；可用 PREVIEW_HEIC_CONCURRENCY 覆盖，上限 6） */
export const HEIC_CONCURRENCY = Math.max(
  2,
  Math.min(6, Number(process.env.PREVIEW_HEIC_CONCURRENCY || 0) || Math.max(2, Math.min(4, Math.floor(CPU / 4))))
);
/** JPEG / PNG 走 libvips 自带线程，2 个足够，再多会和 libvips 抢核 */
export const JPEG_CONCURRENCY = Math.max(1, Number(process.env.PREVIEW_JPEG_CONCURRENCY || 2));

export const cacheNameFor = (id) => `${id}${CACHE_SUFFIX}`;

async function decodeSource(abs) {
  if (isHeicFile(abs)) {
    const jpeg = await decodeHeicToJpeg(abs);
    return sharp(jpeg, { failOn: 'none' });
  }
  return sharp(abs, { failOn: 'none' });
}

/** 找已有 1600 预览：先按 DB 记录的名字，再按 `<id>_p.webp` 约定（2026-11-20 D-544） */
export function findCachedPreview({ id, previewName, thumbDir = CONFIG.thumbDir }) {
  if (previewName) {
    const p = join(thumbDir, previewName);
    if (existsSync(p)) return { path: p, name: previewName };
  }
  if (id) {
    const name = cacheNameFor(id);
    const p = join(thumbDir, name);
    if (existsSync(p)) return { path: p, name };
  }
  return null;
}

/**
 * 确保 1600 预览存在（命中即返回；未命中从原图生成）。
 * 生成失败返回 null：调用方回退到「直接解原图」，不影响打包结果。
 * @returns {Promise<null | {path:string, name:string, created:boolean}>}
 */
export async function ensureCachedPreview({ id, abs, previewName, thumbDir = CONFIG.thumbDir }) {
  const hit = findCachedPreview({ id, previewName, thumbDir });
  if (hit) return { ...hit, created: false };
  if (!id || !abs) return null;
  const name = cacheNameFor(id);
  const out = join(thumbDir, name);
  try {
    mkdirSync(thumbDir, { recursive: true });
    const img = await decodeSource(abs);
    await img
      .rotate()
      .resize({ width: CACHE_MAX, height: CACHE_MAX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: CACHE_QUALITY })
      .toFile(out);
    return { path: out, name, created: true };
  } catch {
    return null;
  }
}

/**
 * 生成云端用的 1280 长边预览（同步 / 分享共用）。
 * 优先用 1600 缓存；缓存生成失败时退回直接解原图。
 * @returns {Promise<{width:number,height:number,cacheName:string|null,cacheCreated:boolean}>}
 */
export async function makeCloudPreview({ id, abs, previewName, dest, thumbDir = CONFIG.thumbDir }) {
  const cache = await ensureCachedPreview({ id, abs, previewName, thumbDir });
  const src = cache ? cache.path : abs;
  const img = await decodeSource(src);
  const info = await img
    .rotate()
    .resize({ width: PREVIEW_MAX, height: PREVIEW_MAX, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: PREVIEW_QUALITY })
    .toFile(dest);
  return {
    width: info.width || 0,
    height: info.height || 0,
    cacheName: cache ? cache.name : null,
    cacheCreated: cache ? cache.created : false,
  };
}

/**
 * 排序：HEIC 优先，其次按体积从大到小（最长处理时间优先，避免慢尾巴）。
 * @param {any[]} items
 * @param {(it:any)=>string} getPath
 * @param {(it:any)=>number} getBytes
 */
export function orderByCostDesc(items, getPath, getBytes = () => 0) {
  return [...items].sort((a, b) => {
    const ah = isHeicFile(getPath(a)) ? 1 : 0;
    const bh = isHeicFile(getPath(b)) ? 1 : 0;
    if (ah !== bh) return bh - ah;
    return (Number(getBytes(b)) || 0) - (Number(getBytes(a)) || 0);
  });
}

/** 并发收尾：把新建的缓存名字批量写回 media.preview（失败只丢缓存指针，不影响打包） */
export function persistPreviewNames(db, updates, warn = () => {}) {
  if (!db || !updates || !updates.size) return 0;
  const stmt = db.prepare('UPDATE media SET preview = ? WHERE id = ?');
  let n = 0;
  try {
    db.exec('BEGIN');
    for (const [id, name] of updates) {
      stmt.run(name, id);
      n += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    warn('写入预览缓存指针失败（不影响本次打包）：' + (e?.message || e));
    return 0;
  }
  return n;
}
