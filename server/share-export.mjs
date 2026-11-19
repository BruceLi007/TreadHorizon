/**
 * 本地分享包导出（F-SHR-01 / 2026-11-14 D-416，P4）
 *
 * - 只在本地安装版可用（云端 multi 不提供「服务端导出」；分享包由用户在本地导出后上传）；
 * - 从 DB 读勾选的地点 / 到访 / 照片 → 原图生成 1280 长边 q75 WebP（HEIC 先解码）→ 写 zip；
 * - zip 结构与本项目导入端一致：manifest.json + media/p_<hash>.webp（不含视频）；
 * - 导出是后台任务（start → status 轮询），写到用户选定文件夹，不落浏览器下载（D-395 语义）；
 * - 坏图跳过并计数，绝不整包失败；失败删除半成品。
 *
 * 秘密基地不参与分享（2026-11-15 D-427，用户拍板）：选区里只要含秘密基地就整单拒绝，
 * 见 collectSelection()；不再有「输秘密基地密码就能分享」这条路。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG } from './config.mjs';
import { db, now } from './db.mjs';
import { getUserById } from './auth.mjs';
import { mediaBaseFor } from './media-root.mjs';
import { safeResolve } from './paths.mjs';
import { isHeicFile } from './heic.mjs';
import { haversineKm } from './stats.mjs';
import { writeZip, ZipError } from './zip.mjs';
import {
  HEIC_CONCURRENCY,
  JPEG_CONCURRENCY,
  makeCloudPreview,
  orderByCostDesc,
  persistPreviewNames,
} from './preview-cache.mjs';

export class ShareExportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ShareExportError';
    this.status = status;
  }
}
class Canceled extends Error {}

const JOB_TTL_MS = 10 * 60 * 1000;

const jobs = new Map(); // jobId -> job

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}`;
}
export const sha16 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

function pruneJobs() {
  const cut = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) {
    if (j.finishedAt && j.finishedAt < cut) jobs.delete(id);
  }
}

function fileSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

/** 唯一文件名（同分钟多次导出不覆盖）：tread-horizon-share-20261114-2210-12张.zip / -2 */
function uniqueZipPath(dir, count) {
  const base = `tread-horizon-share-${stamp()}-${count}张`;
  let p = join(dir, `${base}.zip`);
  let i = 2;
  while (existsSync(p)) {
    p = join(dir, `${base}-${i}.zip`);
    i += 1;
  }
  return p;
}

/**
 * 生成分享用的 1280 预览（2026-11-20 D-544）：优先用 1600 缓存，命中就不解原图。
 * 传 id / previewName 时会把缓存写回 thumbs 并返回缓存名（调用方批量持久化到 DB）。
 */
export async function makePreview(absPath, destPath, { id = null, previewName = null } = {}) {
  const r = await makeCloudPreview({ id, abs: absPath, previewName, dest: destPath });
  return { width: r.width, height: r.height, cacheName: r.cacheName };
}

function parseJsonArray(s) {
  if (Array.isArray(s)) return s;
  if (typeof s !== 'string' || !s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

/**
 * 校验并整理选区（同步 DB 读，不写盘）。
 * 返回 { places, visits, media, home, skipped }。
 */
function collectSelection(body, owner) {
  const placeIds = Array.isArray(body.placeIds)
    ? [...new Set(body.placeIds.filter((x) => typeof x === 'string' && x))]
    : [];
  const mediaIds = Array.isArray(body.mediaIds)
    ? [...new Set(body.mediaIds.filter((x) => typeof x === 'string' && x))]
    : [];
  if (!placeIds.length && !mediaIds.length) throw new ShareExportError('请先选择要分享的地点或照片');
  if (placeIds.length > 1000) throw new ShareExportError('最多选择 1000 个地点');

  const own = owner ? ' AND p.user_id = ?' : '';
  const ownMedia = owner ? ' AND m.user_id = ?' : '';

  const placeRows = placeIds.length
    ? db
        .prepare(
          `SELECT * FROM place p
            WHERE p.deleted_at IS NULL AND p.id IN (${placeIds.map(() => '?').join(',')})${own}`
        )
        .all(...placeIds, ...(owner ? [owner] : []))
    : [];
  const placeById = new Map(placeRows.map((p) => [p.id, p]));

  const mediaRows = mediaIds.length
    ? db
        .prepare(
          `SELECT m.*, v.place_id, v.date, v.note, v.title AS visit_title, v.companions,
                  v.deleted_at AS visit_deleted, p.deleted_at AS place_deleted
             FROM media m
             JOIN visit v ON v.id = m.visit_id
             JOIN place p ON p.id = v.place_id
            WHERE m.deleted_at IS NULL AND m.kind = 'photo'
              AND m.id IN (${mediaIds.map(() => '?').join(',')})${ownMedia}`
        )
        .all(...mediaIds, ...(owner ? [owner] : []))
    : [];
  const validMedia = mediaRows.filter((m) => !m.visit_deleted && !m.place_deleted);

  // 只保留「地点也在选区」的照片；其余计入 skipped
  const media = [];
  const skippedIds = [];
  for (const m of validMedia) {
    if (!placeById.has(m.place_id)) {
      skippedIds.push(m.id);
      continue;
    }
    media.push(m);
  }

  // 没选照片的已勾选地点（如「只勾了家」）也允许进 manifest（visits 为空）
  const places = placeIds.map((id) => placeById.get(id)).filter(Boolean);

  // 2026-11-15 D-427（用户拍板「秘密基地还是不参与分享吧，默认不允许分享」）：
  // 选区里只要含秘密基地就整单拒绝。前端已经把秘密基地的勾选框去掉，这里是绕过 UI 时的兜底。
  if (places.some((p) => Number(p.secret) === 1)) {
    throw new ShareExportError('秘密基地不参与分享，请取消勾选后重试');
  }

  const includedPlaceIds = new Set(places.map((p) => p.id));

  return {
    placeIds: places.map((p) => p.id),
    places,
    media,
    skipped: mediaIds.length - media.length,
    includedPlaceIds,
  };
}

export async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/** 启动一个导出任务（立即返回 jobId；实际导出在后台）
 *  2026-11-18 D-524：body.cloud === true 时不写用户目录，而是在临时目录生成 zip 后
 *  直接上传云端 `/api/shares/import`（本地「分享」默认走这条路）。
 */
export function startShareExport(body = {}, owner = null) {
  if (owner) throw new ShareExportError('云端版请在本地导出分享包后再上传', 403);
  const cloudMode = body.cloud === true;
  let dir;
  if (cloudMode) {
    dir = join(CONFIG.dataDir, 'tmp', `cloud-share-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
  } else {
    const dirRaw = String(body.dir || '').trim();
    if (!dirRaw) throw new ShareExportError('请选择导出文件夹');
    dir = resolve(dirRaw);
    try {
      if (!statSync(dir).isDirectory()) throw new Error('不是文件夹');
    } catch {
      throw new ShareExportError('导出文件夹不存在或不可访问');
    }
  }

  const sel = collectSelection(body, owner);
  const includeNotes = body.includeNotes !== false;
  const includeCompanions = body.includeCompanions !== false;
  const title = String(body.title || '').slice(0, 200);

  const jobId = randomUUID();
  const job = {
    jobId,
    state: 'running',
    dir,
    title,
    displayName: String(body.displayName || '').slice(0, 100),
    includeNotes,
    includeCompanions,
    total: sel.media.length,
    done: 0,
    skipped: sel.skipped,
    bytes: 0,
    /** 2026-11-19 D-543：上传阶段已发字节（直传云端时给前端算真实进度） */
    uploaded: 0,
    /** 云端账号的可用空间（拿不到为 null；打包后据此先拦一道） */
    limitBytes: null,
    usedBytes: null,
    savedPath: null,
    savedName: null,
    error: null,
    canceled: false,
    createdAt: now(),
    finishedAt: null,
    /** 2026-11-18 D-524：直传云端相关 */
    cloudMode,
    coverMediaId: typeof body.coverMediaId === 'string' ? body.coverMediaId : '',
    expiresIn: String(body.expiresIn || '24h'),
    phase: cloudMode ? 'pack' : 'export',
    cloudUrl: null,
    cloudId: null,
    sel,
  };
  jobs.set(jobId, job);
  pruneJobs();

  // 先检查磁盘余量（估算：每张 200 KB + 20 MB 余量；实际 1280/q75 中位 99 KB）
  // 直传模式写到系统临时目录，不做用户目录的空间检查（失败由写入兜底）
  if (!cloudMode) {
    try {
      const st = statfsSync(dir);
      const available = Number(st.bavail) * Number(st.bsize);
      const need = sel.media.length * 200 * 1024 + 20 * 1024 * 1024;
      if (Number.isFinite(available) && available < need) {
        job.state = 'error';
        job.error = `导出目录空间不足：约需 ${(need / 1024 ** 2).toFixed(0)} MB，当前可用 ${(
          available / 1024 ** 2
        ).toFixed(0)} MB`;
        job.finishedAt = now();
        return { jobId, total: job.total };
      }
    } catch {
      /* statfs 不可用就交给写入失败兜底 */
    }
  }

  // 后台执行，不阻塞 HTTP
  setImmediate(() => {
    void runExportJob(job);
  });
  return { jobId, total: job.total };
}

async function runExportJob(job) {
  const jobTmp = join(CONFIG.dataDir, 'tmp', `share-export-${job.jobId}`);
  mkdirSync(join(jobTmp, 'media'), { recursive: true });
  try {
    const owner = null; // 本地导出
    const mediaBase = resolve(mediaBaseFor(owner));
    const outMedia = [];
    const fileOf = new Map();

    /**
     * 2026-11-20 D-544：与同步共用预览缓存 + HEIC 优先调度。
     * 命中 1600 缓存就不再解原图；HEIC 先跑（并发更高），JPEG/PNG 后跑，避免慢尾巴。
     */
    const cacheUpdates = new Map();
    let cacheCreated = 0;
    const runOne = async (m) => {
      if (job.canceled) throw new Canceled('导出已取消');
      let abs = null;
      try {
        abs = safeResolve(mediaBase, m.rel_path);
      } catch {
        abs = null;
      }
      const file = `p_${sha16(m.id)}.webp`;
      const dest = join(jobTmp, 'media', file);
      try {
        if (!abs || !existsSync(abs)) throw new Error('文件不存在');
        const dim = await makePreview(abs, dest, { id: m.id, previewName: m.preview });
        if (dim.cacheName) cacheUpdates.set(m.id, dim.cacheName);
        if (dim.cacheCreated) cacheCreated += 1;
        outMedia.push({
          id: m.id,
          kind: 'photo',
          w: dim.width,
          h: dim.height,
          takenAt: Number(m.taken_at) || Number(m.created_at) || now(),
          file,
          bytes: fileSize(dest),
          _media: m,
        });
        fileOf.set(m.id, file);
      } catch {
        job.skipped += 1;
        try {
          unlinkSync(dest);
        } catch {
          /* ignore */
        }
      } finally {
        job.done += 1;
      }
    };
    const ordered = orderByCostDesc(job.sel.media, (m) => m.rel_path, (m) => m.bytes);
    const heicList = ordered.filter((m) => isHeicFile(m.rel_path));
    const otherList = ordered.filter((m) => !isHeicFile(m.rel_path));
    await pool(heicList, HEIC_CONCURRENCY, runOne);
    await pool(otherList, JPEG_CONCURRENCY, runOne);
    if (job.canceled) throw new Canceled('导出已取消');
    job.cached = persistPreviewNames(db, cacheUpdates, () => {
      /* 缓存指针写失败不影响分享包 */
    });
    job.cacheCreated = cacheCreated;

    // 按 place / visit 组装 manifest
    const placeRows = job.sel.places;
    const mediaById = new Map(outMedia.map((m) => [m.id, m]));
    const placeOut = [];
    let minDate = '';
    let maxDate = '';
    let photoCount = 0;
    let visitCount = 0;

    for (const p of placeRows) {
      const selected = outMedia
        .filter((m) => m._media.place_id === p.id)
        .sort((a, b) => {
          const da = a._media.date || '';
          const db2 = b._media.date || '';
          if (da !== db2) return da < db2 ? 1 : -1;
          return String(a.id).localeCompare(String(b.id));
        });
      const byVisit = new Map();
      for (const m of selected) {
        const vid = m._media.visit_id;
        if (!byVisit.has(vid)) {
          byVisit.set(vid, {
            id: vid,
            date: m._media.date || '',
            title: m._media.visit_title || '',
            note: m._media.note || '',
            companions: parseJsonArray(m._media.companions),
            media: [],
          });
        }
        byVisit.get(vid).media.push(m.id);
      }
      const visits = [...byVisit.values()]
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
        .map((v) => {
          const out = { id: v.id, date: v.date, media: v.media };
          if (job.includeNotes && v.note) out.note = v.note;
          if (job.includeCompanions && v.companions.length) out.companions = v.companions;
          if (v.title) out.title = v.title;
          return out;
        })
        .filter((v) => v.media.length > 0);
      const isHome = Number(p.home) === 1;
      if (!visits.length && !isHome) continue;

      visitCount += visits.length;
      photoCount += selected.length;
      for (const v of visits) {
        if (v.date) {
          if (!minDate || v.date < minDate) minDate = v.date;
          if (!maxDate || v.date > maxDate) maxDate = v.date;
        }
      }
      const dates = visits.map((v) => v.date).filter(Boolean).sort();
      const firstMedia = selected[0]?.id || null;
      const cover = p.cover_media_id && mediaById.has(p.cover_media_id) ? p.cover_media_id : firstMedia;
      const place = {
        id: p.id,
        name: p.name,
        kind: p.kind === 'wishlist' ? 'wishlist' : 'visited',
        lng: Number(p.lng),
        lat: Number(p.lat),
      };
      // D-427：秘密基地已不参与分享，manifest 里不再写 secret 标记
      if (p.province_code) place.provinceCode = p.province_code;
      if (p.province) place.provinceName = p.province;
      if (p.city) place.city = p.city;
      if (p.county) place.district = p.county;
      if (cover) place.coverId = cover;
      if (dates.length) place.lastDate = dates[dates.length - 1];
      place.visits = visits;
      placeOut.push(place);
    }

    // 家与离家距离（家在被勾选的地点里才写）
    const homeRow = placeOut.find((p) => {
      const src = placeRows.find((x) => x.id === p.id);
      return src && Number(src.home) === 1;
    });
    if (homeRow) {
      for (const p of placeOut) {
        p.home = p.id === homeRow.id;
        if (!p.home) {
          p.homeDistanceKm =
            Math.round(haversineKm(homeRow.lng, homeRow.lat, p.lng, p.lat) * 10) / 10;
        }
      }
    }

    if (!photoCount) throw new ShareExportError('选中的照片都无法读取，未生成分享包');

    const manifest = {
      format: 'tread-horizon-share',
      formatVersion: 1,
      appVersion: appVersion(),
      createdAt: now(),
      // D-424：导出不填标题（分享时在上传弹窗里填，可改）；不再回退成日期范围
      title: job.title || '',
      sharer: { displayName: displayNameOf(job, owner) },
      counts: { places: placeOut.length, visits: visitCount, photos: photoCount },
      places: placeOut,
      media: outMedia.map(({ _media, ...m }) => m),
    };
    if (minDate || maxDate) manifest.range = { from: minDate || maxDate, to: maxDate || minDate };
    // 2026-11-18 D-524：用户自己选的封面（选中媒体 id；云端导入时落 share.cover）
    if (job.coverMediaId && mediaById.has(job.coverMediaId)) {
      manifest.coverId = job.coverMediaId;
    }

    writeFileSync(join(jobTmp, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const manifestBytes = fileSize(join(jobTmp, 'manifest.json'));
    const zipTotal = manifestBytes + outMedia.reduce((n, m) => n + (Number(m.bytes) || 0), 0);

    /**
     * 2026-11-19 D-543：分享也按账号配额动态限额（照片不设限）。
     * 打包后、上传前先按「配额 − 已用」拦一道，避免几百 MB 传完才被云端拒；
     * 拿不到云端用量就不拦（云端导入时兜底）。
     */
    if (job.cloudMode) {
      const { cloudShareCapacity, quotaMessage } = await import('./cloud.mjs');
      const cap = await cloudShareCapacity();
      if (cap) {
        job.limitBytes = cap.available;
        job.usedBytes = cap.used;
        if (cap.available <= 0 || zipTotal > cap.available) {
          throw new ShareExportError(
            quotaMessage('share', cap.available <= 0 ? 0 : zipTotal, cap.usage)
          );
        }
      }
    }

    const entries = [{ name: 'manifest.json', data: readFileSync(join(jobTmp, 'manifest.json')) }];
    for (const m of manifest.media) {
      entries.push({ name: `media/${m.file}`, path: join(jobTmp, 'media', m.file), compress: false });
    }
    const finalPath = uniqueZipPath(job.dir, manifest.counts.photos);
    const partPath = finalPath + '.part';
    /** 2026-11-20 D-544：写 zip 单独一个阶段 + 字节进度（与同步一致） */
    job.phase = 'zip';
    job.zipTotal = zipTotal;
    job.zipDone = 0;
    try {
      await writeZip(partPath, entries, {
        shouldCancel: () => job.canceled,
        onProgress: ({ bytesDone }) => {
          job.zipDone = bytesDone;
        },
      });
      copyFileSync(partPath, finalPath);
    } finally {
      try {
        unlinkSync(partPath);
      } catch {
        /* ignore */
      }
    }
    job.zipDone = job.zipTotal;
    job.savedPath = finalPath;
    job.savedName = finalPath.split(/[\\/]/).pop();
    job.bytes = fileSize(finalPath);
    // 2026-11-18 D-524：直传模式 —— zip 生成后立刻传到云端，然后删掉本地临时文件
    if (job.cloudMode) {
      job.phase = 'upload';
      const { uploadSharePackage } = await import('./cloud.mjs');
      const r = await uploadSharePackage(
        finalPath,
        { expiresIn: job.expiresIn, title: job.title },
        job
      );
      job.cloudUrl = r?.url || null;
      job.cloudId = r?.id || null;
      job.savedPath = null;
      job.savedName = null;
      try {
        unlinkSync(finalPath);
      } catch {
        /* ignore */
      }
      try {
        rmSync(job.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    job.state = 'done';
  } catch (e) {
    if (e instanceof Canceled) {
      job.state = 'canceled';
      job.error = '导出已取消';
    } else {
      job.state = 'error';
      job.error = e instanceof ShareExportError ? e.message : e instanceof ZipError ? e.message : e?.message || String(e);
    }
    // 直传模式失败：临时目录 / 已打好的 zip 都清掉（分享重试就是重新选一次，不保留大文件）
    if (job.cloudMode) {
      try {
        rmSync(job.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    job.finishedAt = now();
    try {
      rmSync(jobTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function appVersion() {
  try {
    return JSON.parse(readFileSync(join(CONFIG.root, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

function displayNameOf(job, owner) {
  if (owner) {
    const u = getUserById(owner);
    return u?.display_name || u?.username || '';
  }
  return job.displayName || '';
}

export function getShareExportStatus(jobId) {
  const j = jobs.get(String(jobId || ''));
  if (!j) throw new ShareExportError('导出任务不存在或已过期', 404);
  return {
    jobId: j.jobId,
    state: j.state,
    phase: j.phase,
    total: j.total,
    done: j.done,
    skipped: j.skipped,
    bytes: j.bytes,
    /** 2026-11-19 D-543：直传云端时的上传字节进度 */
    uploaded: j.uploaded || 0,
    /** 2026-11-20 D-544：写 zip 阶段的字节进度 / 本次新建的预览缓存条数 */
    zipDone: j.zipDone || 0,
    zipTotal: j.zipTotal || 0,
    cached: j.cacheCreated || 0,
    limitBytes: j.limitBytes ?? null,
    usedBytes: j.usedBytes ?? null,
    savedPath: j.savedPath,
    savedName: j.savedName,
    cloudUrl: j.cloudUrl,
    cloudId: j.cloudId,
    error: j.error,
  };
}

export function cancelShareExport(jobId) {
  const j = jobs.get(String(jobId || ''));
  if (!j) return false;
  if (j.state === 'running') j.canceled = true;
  return true;
}

/**
 * 2026-11-15 D-431（用户要求「设置里加一个后台任务栏，把有持续时间的任务分类放进去」）：
 * 列出本地分享包导出任务，供 `/api/background-tasks` 汇总。
 * 只回公开字段（不含内部 `sel` 选区），按创建时间倒序。
 */
export function listShareExportJobs() {
  pruneJobs();
  const out = [];
  for (const j of jobs.values()) {
    out.push({
      jobId: j.jobId,
      state: j.state,
      phase: j.phase,
      total: j.total,
      done: j.done,
      skipped: j.skipped,
      bytes: j.bytes,
      uploaded: j.uploaded || 0,
      zipDone: j.zipDone || 0,
      zipTotal: j.zipTotal || 0,
      cached: j.cacheCreated || 0,
      savedPath: j.savedPath,
      savedName: j.savedName,
      error: j.error,
      canceled: j.canceled,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
    });
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}
