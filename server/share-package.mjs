/**
 * 分享包（F-SHR-01 / 2026-11-14 D-416）—— zip 解析 + manifest 校验 + 安全解压。
 *
 * 分享包结构（v1，无视频）：
 *   manifest.json
 *   media/p_<hash>.webp        （唯一允许的媒体类型：照片 1280 长边 q75）
 *
 * 本模块只做「包」这一层，不认识会话 / 配额 / HTTP：
 * - 条目白名单、路径穿越、条目数、解压总量、单文件 2 MB、WebP magic；
 * - manifest 逐字段校验并**重建**一份干净对象（不接受包内多余字段，避免泄露原始路径等）；
 * - 解压到调用方给的 stageDir（目录由调用方创建 / 清理；失败由调用方删）。
 *
 * 业务校验（密码 / 配额 / 落库）在 server/share.mjs。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPromise, validateFileName } from 'yauzl';
import { ZipError } from './zip.mjs';

/** 分享包可预期的错误（消息直接给用户看，路由层映射成 400） */
export class ShareError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ShareError';
    this.status = status;
  }
}

/** 单份分享 zip 上限 100 MB（与 SHARE-BRIEF §15 一致；测试可用 SHARE_MAX_BYTES 调小） */
export const MAX_SHARE_ZIP_BYTES = Number(process.env.SHARE_MAX_BYTES || 100 * 1024 ** 2);
/** 包内条目上限（防 zip bomb） */
export const MAX_SHARE_ENTRIES = Number(process.env.SHARE_MAX_ENTRIES || 5000);
/** 解压后总大小上限 500 MB */
export const MAX_SHARE_UNCOMPRESSED_BYTES = Number(
  process.env.SHARE_MAX_UNCOMPRESSED_BYTES || 500 * 1024 ** 2
);
/** manifest.json 上限（正常几 MB，留足余量） */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** 单张照片上限 2 MB */
export const MAX_SHARE_FILE_BYTES = 2 * 1024 * 1024;
/** 一份分享最多 2000 张照片 */
export const MAX_SHARE_MEDIA = 2000;
/** 照片文件名：p_ + 3~40 位小写字母/数字/下划线 + .webp */
const MEDIA_FILE_RE = /^p_[a-z0-9_]{3,40}\.webp$/;
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function str(v, max, field) {
  if (typeof v !== 'string') throw new ShareError(`manifest 字段 ${field} 必须是字符串`);
  if (v.length > max) throw new ShareError(`manifest 字段 ${field} 过长（最多 ${max} 字符）`);
  return v;
}

function optStr(v, max, field) {
  if (v == null || v === '') return '';
  return str(v, max, field);
}

function num(v, field, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ShareError(`manifest 字段 ${field} 不是有效数字`);
  }
  return n;
}

function optDate(v, field) {
  if (v == null || v === '') return '';
  if (typeof v !== 'string' || !DATE_RE.test(v)) {
    throw new ShareError(`manifest 字段 ${field} 必须是 YYYY-MM-DD`);
  }
  return v;
}

/** WebP magic：RIFF....WEBP */
export function isWebpBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  );
}

/**
 * 校验并重建 manifest（只保留白名单字段；`secret` 保留给内部判断，公开响应前必须剔除）。
 * 返回 { manifest, hasSecret, mediaCount, visitCount, placeCount }。
 */
export function normalizeManifest(raw) {
  if (!isObj(raw)) throw new ShareError('分享包缺少有效的 manifest.json');
  if (raw.format !== 'tread-horizon-share') {
    throw new ShareError('不是 Tread Horizon 分享包（format 不匹配）');
  }
  if (Number(raw.formatVersion) !== 1) {
    throw new ShareError(`不支持的分享包版本：${raw.formatVersion}`);
  }
  const createdAt = num(raw.createdAt, 'createdAt', { min: 0 });
  const appVersion = typeof raw.appVersion === 'string' ? raw.appVersion.slice(0, 30) : '';
  const title = typeof raw.title === 'string' ? raw.title.slice(0, 200) : '';
  const sharerName =
    isObj(raw.sharer) && typeof raw.sharer.displayName === 'string'
      ? raw.sharer.displayName.slice(0, 100)
      : '';

  const range =
    isObj(raw.range) && raw.range.from && raw.range.to
      ? { from: optDate(raw.range.from, 'range.from'), to: optDate(raw.range.to, 'range.to') }
      : undefined;

  // ── media ──
  const mediaRaw = Array.isArray(raw.media) ? raw.media : null;
  if (!mediaRaw) throw new ShareError('manifest 缺少 media 数组');
  if (mediaRaw.length > MAX_SHARE_MEDIA) {
    throw new ShareError(`一份分享最多 ${MAX_SHARE_MEDIA} 张照片`);
  }
  const media = [];
  const mediaById = new Map();
  const fileSet = new Set();
  for (const [i, m] of mediaRaw.entries()) {
    if (!isObj(m)) throw new ShareError(`media[${i}] 不是对象`);
    const id = str(m.id, 120, `media[${i}].id`);
    if (!ID_RE.test(id)) throw new ShareError(`media[${i}].id 不合法`);
    if (mediaById.has(id)) throw new ShareError(`manifest 里有重复的照片 id：${id}`);
    if (m.kind !== 'photo') {
      throw new ShareError('分享包只能包含照片（v1 不支持视频）');
    }
    const file = str(m.file, 80, `media[${i}].file`);
    if (!MEDIA_FILE_RE.test(file)) throw new ShareError(`照片文件名不合法：${file}`);
    if (fileSet.has(file)) throw new ShareError(`manifest 里有重复的照片文件：${file}`);
    const bytes = num(m.bytes, `media[${i}].bytes`, { min: 1, max: MAX_SHARE_FILE_BYTES });
    const w = num(m.w, `media[${i}].w`, { min: 0, max: 100000 });
    const h = num(m.h, `media[${i}].h`, { min: 0, max: 100000 });
    const takenAt = num(m.takenAt, `media[${i}].takenAt`, { min: 0 });
    fileSet.add(file);
    const item = { id, kind: 'photo', w, h, takenAt, file, bytes };
    media.push(item);
    mediaById.set(id, item);
  }

  // ── places ──
  const placesRaw = Array.isArray(raw.places) ? raw.places : null;
  if (!placesRaw) throw new ShareError('manifest 缺少 places 数组');
  if (placesRaw.length > 1000) throw new ShareError('一份分享最多 1000 个地点');
  const placeIds = new Set();
  const visitIds = new Set();
  const referenced = new Set();
  let homeCount = 0;
  let hasSecret = false;
  const places = [];

  for (const [i, p] of placesRaw.entries()) {
    if (!isObj(p)) throw new ShareError(`places[${i}] 不是对象`);
    const id = str(p.id, 120, `places[${i}].id`);
    if (!ID_RE.test(id)) throw new ShareError(`places[${i}].id 不合法`);
    if (placeIds.has(id)) throw new ShareError(`manifest 里有重复的地点 id：${id}`);
    placeIds.add(id);
    const name = str(p.name, 200, `places[${i}].name`);
    if (!name.trim()) throw new ShareError('地点名称不能为空');
    const kind = p.kind === 'wishlist' ? 'wishlist' : 'visited';
    const lng = num(p.lng, `places[${i}].lng`, { min: -180, max: 180 });
    const lat = num(p.lat, `places[${i}].lat`, { min: -90, max: 90 });
    const secret = p.secret === true;
    if (secret) hasSecret = true;
    const home = p.home === true;
    if (home) homeCount += 1;
    if (homeCount > 1) throw new ShareError('manifest 里最多只能有一个「家」');

    let homeDistanceKm;
    if (p.homeDistanceKm != null) {
      homeDistanceKm = Math.round(num(p.homeDistanceKm, `places[${i}].homeDistanceKm`, { min: 0, max: 20000 }) * 10) / 10;
    }

    const coverId = typeof p.coverId === 'string' && mediaById.has(p.coverId) ? p.coverId : null;
    const lastDate = optDate(p.lastDate, `places[${i}].lastDate`);

    const visitsRaw = Array.isArray(p.visits) ? p.visits : [];
    if (visitsRaw.length > 1000) throw new ShareError('单个地点的到访过多');
    const visits = [];
    for (const [j, v] of visitsRaw.entries()) {
      if (!isObj(v)) throw new ShareError(`places[${i}].visits[${j}] 不是对象`);
      const vid = str(v.id, 120, `places[${i}].visits[${j}].id`);
      if (!ID_RE.test(vid)) throw new ShareError(`places[${i}].visits[${j}].id 不合法`);
      if (visitIds.has(vid)) throw new ShareError(`manifest 里有重复的到访 id：${vid}`);
      visitIds.add(vid);
      const date = optDate(v.date, `places[${i}].visits[${j}].date`);
      if (!date) throw new ShareError('到访日期不能为空');
      const vTitle = typeof v.title === 'string' ? v.title.slice(0, 200) : '';
      const note = typeof v.note === 'string' ? v.note.slice(0, 20000) : '';
      const companions = Array.isArray(v.companions)
        ? v.companions
            .filter((c) => typeof c === 'string' && c.trim())
            .slice(0, 50)
            .map((c) => c.slice(0, 100))
        : [];
      const mediaIds = Array.isArray(v.media) ? v.media : [];
      if (mediaIds.length > MAX_SHARE_MEDIA) throw new ShareError('单次到访的照片过多');
      const ids = [];
      for (const mid of mediaIds) {
        if (typeof mid !== 'string' || !mediaById.has(mid)) {
          throw new ShareError(`到访引用了不存在的照片：${String(mid)}`);
        }
        if (!referenced.has(mid)) referenced.add(mid);
        ids.push(mid);
      }
      if (!ids.length) continue; // 没有选中照片的到访不导出
      const visit = { id: vid, date, media: ids };
      if (vTitle) visit.title = vTitle;
      if (note) visit.note = note;
      if (companions.length) visit.companions = companions;
      visits.push(visit);
    }

    const place = {
      id,
      name,
      kind,
      lng,
      lat,
    };
    if (secret) place.secret = true;
    if (home) place.home = true;
    if (homeDistanceKm != null) place.homeDistanceKm = homeDistanceKm;
    const provinceCode = optStr(p.provinceCode, 20, `places[${i}].provinceCode`);
    const provinceName = optStr(p.provinceName, 100, `places[${i}].provinceName`);
    const city = optStr(p.city, 100, `places[${i}].city`);
    const district = optStr(p.district, 100, `places[${i}].district`);
    if (provinceCode) place.provinceCode = provinceCode;
    if (provinceName) place.provinceName = provinceName;
    if (city) place.city = city;
    if (district) place.district = district;
    if (coverId) place.coverId = coverId;
    if (lastDate) place.lastDate = lastDate;
    place.visits = visits;
    places.push(place);
  }

  // 文件被引用 / 引用存在：不允许「有文件没人用」或「有引用没文件」
  for (const m of media) {
    if (!referenced.has(m.id)) throw new ShareError(`manifest 里有未被任何到访引用的照片：${m.id}`);
  }

  // 含家时：每个地点都要有距离（家本身可为 0 / 省略）；不含家时不允许出现距离
  if (homeCount === 1) {
    for (const p of places) {
      if (!p.home && p.homeDistanceKm == null) {
        throw new ShareError(`含「家」的分享必须给每个地点写离家距离（缺少：${p.name}）`);
      }
    }
  } else {
    for (const p of places) {
      if (p.homeDistanceKm != null) {
        throw new ShareError('未勾选「家」的分享不能包含离家距离');
      }
    }
  }

  const photos = media.length;
  const visits = places.reduce((n, p) => n + p.visits.length, 0);
  const counts = { places: places.length, visits, photos };
  if (isObj(raw.counts)) {
    if (
      Number(raw.counts.places) !== counts.places ||
      Number(raw.counts.visits) !== counts.visits ||
      Number(raw.counts.photos) !== counts.photos
    ) {
      throw new ShareError('manifest 的 counts 与实际内容不一致');
    }
  }

  const manifest = {
    format: 'tread-horizon-share',
    formatVersion: 1,
    appVersion,
    createdAt,
    title,
    sharer: { displayName: sharerName },
    counts,
    places,
    media,
  };
  if (range) manifest.range = range;
  return { manifest, hasSecret, mediaCount: photos, visitCount: visits, placeCount: places.length };
}

async function readEntryBuffer(zipfile, entry, maxBytes, label) {
  const stream = await zipfile.openReadStreamPromise(entry);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw new ShareError(`${label} 解压后过大`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 校验 + 解压分享包到 stageDir（会创建 stageDir/media）。
 * 成功后 stageDir 里有 manifest.json（规范化后的）与 media/*.webp；
 * 失败抛 ShareError / ZipError，调用方负责删 stageDir / zip。
 *
 * @returns {{ manifest, hasSecret, bytes, mediaCount, visitCount, placeCount, entries }}
 */
export async function stageSharePackage(zipPath, stageDir) {
  mkdirSync(join(stageDir, 'media'), { recursive: true });
  let manifestRaw = null;
  const mediaBuffers = new Map();
  let entries = 0;
  let total = 0;

  let zipfile;
  try {
    zipfile = await openPromise(zipPath, { lazyEntries: true });
  } catch (e) {
    throw new ShareError('无法解析分享 zip（文件可能损坏或不是 zip）');
  }
  try {
    for await (const entry of zipfile.eachEntry()) {
      const name = String(entry.fileName ?? '');
      if (name.endsWith('/')) throw new ShareError(`分享包不能包含目录条目：${name}`);
      const invalid = validateFileName(name);
      if (invalid) throw new ShareError(`分享包内含非法路径：${name}（${invalid}）`);
      if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
        throw new ShareError(`分享包内含非法路径：${name}`);
      }
      const segs = name.split('/');
      if (segs.some((s) => !s || s === '.' || s === '..')) {
        throw new ShareError(`分享包内含非法路径：${name}`);
      }
      entries += 1;
      if (entries > MAX_SHARE_ENTRIES) {
        throw new ShareError(`分享包文件条目过多（最多 ${MAX_SHARE_ENTRIES} 个）`);
      }
      const size = Number(entry.uncompressedSize) || 0;
      total += size;
      if (total > MAX_SHARE_UNCOMPRESSED_BYTES) {
        throw new ShareError('分享包解压后总大小超过上限（500 MB）');
      }

      if (name === 'manifest.json') {
        if (manifestRaw) throw new ShareError('分享包里有重复的 manifest.json');
        if (size > MAX_MANIFEST_BYTES) throw new ShareError('manifest.json 过大');
        const buf = await readEntryBuffer(zipfile, entry, MAX_MANIFEST_BYTES, 'manifest.json');
        try {
          manifestRaw = JSON.parse(buf.toString('utf8'));
        } catch {
          throw new ShareError('manifest.json 不是合法 JSON');
        }
        continue;
      }

      if (name.startsWith('media/')) {
        const file = name.slice('media/'.length);
        if (file.includes('/') || !MEDIA_FILE_RE.test(file)) {
          throw new ShareError(`分享包只能包含 media/p_*.webp：${name}`);
        }
        if (mediaBuffers.has(file)) throw new ShareError(`分享包里有重复的照片：${file}`);
        if (size > MAX_SHARE_FILE_BYTES) throw new ShareError(`照片超过 2 MB：${file}`);
        const buf = await readEntryBuffer(zipfile, entry, MAX_SHARE_FILE_BYTES, file);
        if (!isWebpBuffer(buf)) throw new ShareError(`照片不是 WebP（或用错扩展名）：${file}`);
        mediaBuffers.set(file, buf);
        continue;
      }

      throw new ShareError(`分享包只能包含 manifest.json 与 media/p_*.webp：${name}`);
    }
  } catch (e) {
    if (e instanceof ShareError) throw e;
    if (e instanceof ZipError) throw new ShareError(e.message);
    throw new ShareError('无法读取分享 zip：' + (e?.message || e));
  } finally {
    try {
      await zipfile.close();
    } catch {
      /* ignore */
    }
  }

  if (!manifestRaw) throw new ShareError('分享包缺少 manifest.json');
  const normalized = normalizeManifest(manifestRaw);
  const { manifest } = normalized;

  const expected = new Set(manifest.media.map((m) => m.file));
  for (const file of mediaBuffers.keys()) {
    if (!expected.has(file)) throw new ShareError(`分享包有未在 manifest 中声明的照片：${file}`);
  }
  for (const m of manifest.media) {
    const buf = mediaBuffers.get(m.file);
    if (!buf) throw new ShareError(`分享包缺少照片文件：${m.file}`);
    if (buf.length !== m.bytes) {
      throw new ShareError(`照片大小与 manifest 不一致：${m.file}（${buf.length} ≠ ${m.bytes}）`);
    }
    writeFileSync(join(stageDir, 'media', m.file), buf);
  }
  writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return {
    manifest,
    hasSecret: normalized.hasSecret,
    bytes: total,
    mediaCount: normalized.mediaCount,
    visitCount: normalized.visitCount,
    placeCount: normalized.placeCount,
    entries,
  };
}
