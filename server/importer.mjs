/**
 * 素材库扫描 / 导入计划（F-IMP-01 / F-IMP-02，只读）
 *
 * 目录即数据：末级文件夹 `YYYY-MM-DD_地点名` = 一次到访。
 *  - 标准结构：<mediaRoot>/<省>/<市>/<区县>/<日期_地点名>/...
 *  - 旧结构（年/日期_地点名）和平铺日期文件夹也认
 *  - 省/市/区县只当「消歧提示」，不是解析依据；缺级用「未标注」
 *
 * 这里只做三件事：解析目录名 → 收集文件 → 生成「导入计划」（含判重）。
 * 全程只读：不写数据库、不动素材库文件、不生成缩略图。
 * 真正写库在 F-IMP-03（POST /api/scan/import），会复用这里的计划。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
// 2026-11-11 D-388：数据库里的 rel_path 一律 POSIX `/`，比较前统一走 normalizeRel
import { normalizeRel } from './paths.mjs';

export const PHOTO_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif',
]);
export const VIDEO_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv',
]);

/** 系统/临时文件，不当作媒体，也不算「未归类」（只计数） */
const IGNORE_FILE = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
const IGNORE_DIR = new Set([
  'system volume information', '$recycle.bin', '@eadir', '#recycle', 'node_modules',
]);
const INBOX_NAMES = new Set(['_inbox', '未归类']);

const DATE_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})_(.+)$/;

const isMediaExt = (ext) => PHOTO_EXT.has(ext) || VIDEO_EXT.has(ext);
const extOf = (name) => extname(name).toLowerCase();
const isIgnoredName = (name) => name.startsWith('.') || IGNORE_FILE.has(name.toLowerCase());
const isIgnoredDir = (name) => name.startsWith('.') || IGNORE_DIR.has(name.toLowerCase());
const isInbox = (name) => INBOX_NAMES.has(name.toLowerCase());

/**
 * 数据库里的 rel_path 一律 POSIX `/`（2026-11-11 D-388）；本地模式历史值是 Windows `\`。
 * 比较前统一成正斜杠（并折叠重复斜杠 / 去掉首尾 `/`），两边都用它做 key。
 */
export const normPath = normalizeRel;

/** sha256 前 16 位（和上传时用的算法一致，F-MED-07） */
export function hashFile16(absPath) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(absPath)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex').slice(0, 16)))
      .on('error', reject);
  });
}

function validDate(y, m, d) {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/** 本地时区的 YYYY-MM-DD（文件夹修改时间兜底用，避免 UTC 跨日） */
export function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 解析末级日期文件夹名。
 * 返回 { ok:true, date, name } 或 { ok:false, reason }
 *  - `2024-10-02_杭州`       → ok
 *  - `2024-13-01_杭州`       → reason: '日期非法'
 *  - `杭州` / `2024_杭州`    → reason: '不是 日期_地点名 形态'
 */
export function parseVisitFolderName(dirName) {
  const name = String(dirName || '');
  const m = DATE_DIR_RE.exec(name);
  if (!m) return { ok: false, reason: '不是 日期_地点名 形态' };
  const [, y, mo, d, rawName] = m;
  if (!validDate(y, mo, d)) return { ok: false, reason: '日期非法' };
  const placeName = rawName.trim();
  if (!placeName) return { ok: false, reason: '地点名为空' };
  return { ok: true, date: `${y}-${mo}-${d}`, name: placeName };
}

/**
 * 从父级路径解析省/市/区县提示。
 * 只认「末级日期文件夹之前正好 3 级」的标准结构；旧结构的年份目录不算地区。
 * 返回 null 表示没有可靠提示（扫描不依赖它）。
 */
export function parseRegionHint(parentSegments) {
  const segs = (parentSegments || []).filter(Boolean);
  if (segs.length < 3) return null;
  const last3 = segs.slice(-3);
  // 旧结构 年/日期_地点名：最后一级是 4 位年份，不当作区县
  if (/^\d{4}$/.test(last3[2])) return null;
  const clean = (s) => (s && s !== '未标注' ? s : null);
  const [province, city, county] = last3.map(clean);
  if (!province && !city && !county) return null;
  return { province, city, county };
}

/**
 * 遍历素材库（只读）。
 * 返回：
 *   visits:       识别出的到访文件夹（含文件清单、封面、note）
 *   unclassified: 未归类文件（_inbox / 非日期目录里的散图）
 *   ignored:      非媒体文件计数
 */
export function scanLibrary(mediaRoot) {
  const root = String(mediaRoot || '');
  const out = {
    root,
    visits: [],
    unclassified: [],
    ignored: { count: 0, samples: [] },
    errors: [],
    dirs: 0,
    files: 0,
  };
  if (!root) {
    out.errors.push('素材库路径为空');
    return out;
  }
  try {
    if (!statSync(root).isDirectory()) {
      out.errors.push('素材库路径不是文件夹');
      return out;
    }
  } catch (e) {
    out.errors.push(`素材库路径不可访问：${e.message}`);
    return out;
  }

  const ignore = (name) => {
    out.ignored.count += 1;
    if (out.ignored.samples.length < 10) out.ignored.samples.push(name);
  };

  const readEntries = (abs) => {
    try {
      out.dirs += 1;
      return readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      out.errors.push(`读取目录失败：${relative(root, abs) || abs}（${e.message}）`);
      return [];
    }
  };

  /** 收集一个到访文件夹内的所有媒体（子目录 = 相册分组，不新建到访） */
  const collectVisitFiles = (absDir, relDir, acc) => {
    const ents = readEntries(absDir);
    // 先按名字排序，保证「第一张照片」稳定
    ents.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    for (const e of ents) {
      const full = join(absDir, e.name);
      const rel = join(relDir, e.name);
      if (e.isDirectory()) {
        if (isIgnoredDir(e.name)) continue;
        collectVisitFiles(full, rel, acc);
        continue;
      }
      const lower = e.name.toLowerCase();
      if (lower === 'note.md') {
        if (acc.note == null) {
          try {
            acc.note = readFileSync(full, 'utf8').replace(/^\uFEFF/, '').trim().slice(0, 20000);
          } catch (err) {
            acc.warnings.push(`note.md 读取失败：${err.message}`);
          }
        }
        continue;
      }
      const ext = extOf(e.name);
      if (/^_cover\.[a-z0-9]+$/i.test(e.name) && PHOTO_EXT.has(ext)) {
        if (!acc.cover) {
          acc.cover = { relPath: rel, name: e.name, ...statInfo(full, acc) };
        } else {
          acc.warnings.push(`有多个 _cover 文件，只认第一个（${acc.cover.name}）`);
        }
        continue;
      }
      if (isMediaExt(ext)) {
        const info = statInfo(full, acc);
        if (!info) continue;
        acc.files.push({
          relPath: rel,
          name: e.name,
          kind: PHOTO_EXT.has(ext) ? 'photo' : 'video',
          ...info,
        });
        continue;
      }
      if (isIgnoredName(e.name)) continue;
      ignore(e.name);
    }
  };

  const statInfo = (full, acc) => {
    try {
      const st = statSync(full);
      out.files += 1;
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch (e) {
      acc.errors.push(`读取文件失败：${basename(full)}（${e.message}）`);
      return null;
    }
  };

  /** 递归遍历容器目录（非到访文件夹） */
  const walk = (absDir, relSegs, inboxContext) => {
    const ents = readEntries(absDir);
    ents.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    for (const e of ents) {
      const full = join(absDir, e.name);
      if (e.isDirectory()) {
        if (isIgnoredDir(e.name)) continue;
        const subSegs = [...relSegs, e.name];
        const relDir = subSegs.join(sep);
        const inInbox = inboxContext || isInbox(e.name);

        // 到访文件夹：末级 `YYYY-MM-DD_地点名`
        const parsed = parseVisitFolderName(e.name);
        if (parsed.ok) {
          addVisit(full, relDir, relSegs, parsed, 'folder', false, inInbox);
          continue;
        }
        // 日期非法（如 2024-13-01_杭州）：仍当到访，用文件夹修改时间兜底并标待确认
        if (DATE_DIR_RE.test(e.name)) {
          addVisit(full, relDir, relSegs, null, 'mtime', true, inInbox);
          continue;
        }
        walk(full, subSegs, inInbox);
        continue;
      }

      // 容器目录里的散图 → 未归类（F-IMP-05）
      const ext = extOf(e.name);
      if (isMediaExt(ext)) {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          /* 读不到大小不影响列出 */
        }
        out.files += 1;
        out.unclassified.push({
          // D-388：对外统一 POSIX `/`
          relPath: normPath(join(relSegs.join(sep), e.name)),
          name: e.name,
          kind: PHOTO_EXT.has(ext) ? 'photo' : 'video',
          size,
          reason: inboxContext ? 'inbox' : relSegs.length ? 'folder' : 'root',
          folder: normPath(relSegs.join(sep)),
        });
        continue;
      }
      if (isIgnoredName(e.name)) continue;
      ignore(e.name);
    }
  };

  const addVisit = (absDir, relDir, parentSegs, parsed, dateFrom, needsConfirm, inInbox) => {
    const acc = { files: [], cover: null, note: null, warnings: [], errors: [] };
    let dirMtime = 0;
    try {
      dirMtime = statSync(absDir).mtimeMs;
    } catch {
      /* ignore */
    }
    collectVisitFiles(absDir, relDir, acc);

    // 日期：文件夹名优先；非法/缺失时用文件夹修改时间兜底（F-IMP-01）
    let date = parsed?.date ?? null;
    let name = parsed?.name ?? null;
    if (!date) {
      date = localDate(dirMtime || Date.now());
      dateFrom = 'mtime';
      needsConfirm = true;
      acc.warnings.push('文件夹名里的日期非法，已用文件夹修改时间兜底，请在导入前确认');
    }
    if (!name) {
      // DATE_DIR_RE 匹配但日期非法时，名字仍取 `_` 之后
      const m = DATE_DIR_RE.exec(basename(absDir));
      name = m ? m[4].trim() : basename(absDir);
      needsConfirm = true;
      if (!m) acc.warnings.push('文件夹名不是 日期_地点名 形态，已按文件夹名当地点名，请在导入前确认日期');
    }
    if (!name) name = basename(absDir);

    const region = parseRegionHint(parentSegs);
    if (inInbox) acc.warnings.push('位于 _inbox 里，确认后仍会按日期文件夹导入');
    if (!acc.files.length) acc.warnings.push('没有可导入的媒体文件');

    out.visits.push({
      // D-388：对外统一 POSIX `/`（与 DB 存储口径一致；磁盘操作仍用 absDir）
      relDir: normPath(relDir),
      absDir,
      date,
      name,
      dateFrom,
      needsConfirm,
      region,
      dirMtime,
      files: acc.files.map((f) => ({ ...f, relPath: normPath(f.relPath) })),
      cover: acc.cover ? { ...acc.cover, relPath: normPath(acc.cover.relPath) } : null,
      note: acc.note,
      warnings: acc.warnings,
      errors: acc.errors,
      inInbox,
    });
  };

  walk(root, [], false);
  out.visits.sort((a, b) => a.relDir.localeCompare(b.relDir, 'zh-Hans-CN'));
  out.unclassified.sort((a, b) => a.relPath.localeCompare(b.relPath, 'zh-Hans-CN'));
  return out;
}

// ───────────────────────── 判重 / 计划 ─────────────────────────

const same = (a, b) => Boolean(a) && Boolean(b) && String(a) === String(b);
const empty = (v) => v == null || v === '';

/**
 * 生成导入计划（只读，不写库）。
 *
 * 判重四层（2026-11-01 定稿，D-46）：
 *  L1 文件夹级：这里不做增量状态，预览只看「库里已有什么」；F-IMP-04 再加 import_folder 表
 *  L2 媒体级：rel_path 已在库 → 已存在；否则算 hash，同一到访内去重（跨到访只提示不拦）
 *  L3 到访级：地点 + 日期 复用已有到访；同一天多条到访时按「文件夹内已有媒体归属」选一条
 *  L4 地点级（最保守，D-47）：同名 + 同区县 + 距离 < 500m 才复用；区县对不上就新建
 *
 * 预览阶段不调地理编码：新地点标「导入时定位」，导入时再补坐标并按距离复核。
 *
 * M6 P2-2（D-202）：可选第二参数 `ownerId` = 当前账号；非空时只拿该账号的
 * place / visit / media 做判重，并按 owner 前缀换算扫描根的相对路径
 * （multi：DB 的 rel_path 是 `<owner>/省/市/...`，扫描根是 `mediaRoot/<owner>`）。
 * ownerId = null（local）时 SQL 与旧版逐字一致。
 */
export async function buildPreview(scan, ownerId = null) {
  const t0 = Date.now();
  const { db } = await import('./db.mjs');
  const owner = ownerId || null;
  // owner 过滤片段：local 下为空串，SQL 与旧版一致
  const own = owner ? ' AND user_id = ?' : '';
  const ownArgs = owner ? [owner] : [];

  const places = db.prepare(`
    SELECT id, name, lng, lat, province, city, county, province_code, city_code, county_code, created_at
    FROM place WHERE deleted_at IS NULL${own}
  `).all(...ownArgs);
  const visits = db.prepare(`
    SELECT id, place_id, date, note, title, created_at
    FROM visit WHERE deleted_at IS NULL${own}
  `).all(...ownArgs);
  const media = db.prepare(`
    SELECT id, visit_id, rel_path, hash, kind
    FROM media WHERE deleted_at IS NULL${own}
  `).all(...ownArgs);

  const placesByName = new Map();
  for (const p of places) {
    const arr = placesByName.get(p.name);
    if (arr) arr.push(p);
    else placesByName.set(p.name, [p]);
  }

  const visitsByPlace = new Map();
  for (const v of visits) {
    const arr = visitsByPlace.get(v.place_id);
    if (arr) arr.push(v);
    else visitsByPlace.set(v.place_id, [v]);
  }

  const mediaByPath = new Map();
  const hashesByVisit = new Map();
  const mediaCountByVisit = new Map();
  const hashOwners = new Map();
  const visitById = new Map(visits.map((v) => [v.id, v]));
  const placeById = new Map(places.map((p) => [p.id, p]));
  // multi：DB rel_path 带 owner 前缀、扫描路径相对 mediaRoot/<owner>；比较前统一去掉前缀。
  const ownerPrefix = owner ? `${owner}/` : '';
  const scanKey = (rel) => {
    const n = normPath(rel);
    return ownerPrefix && n.startsWith(ownerPrefix) ? n.slice(ownerPrefix.length) : n;
  };
  for (const m of media) {
    mediaByPath.set(scanKey(m.rel_path), m);
    mediaCountByVisit.set(m.visit_id, (mediaCountByVisit.get(m.visit_id) || 0) + 1);
    if (m.hash) {
      const set = hashesByVisit.get(m.visit_id) || new Set();
      set.add(m.hash);
      hashesByVisit.set(m.visit_id, set);
      const owners = hashOwners.get(m.hash) || [];
      const v = visitById.get(m.visit_id);
      const p = v ? placeById.get(v.place_id) : null;
      owners.push({ visitId: m.visit_id, placeName: p?.name || '?', visitDate: v?.date || '?' });
      hashOwners.set(m.hash, owners);
    }
  }

  const folders = [];

  for (const f of scan.visits) {
    const warnings = [...f.warnings];
    for (const e of f.errors) warnings.push(e);

    // ── L4 地点匹配 ──
    let candidates = placesByName.get(f.name) || [];
    let narrowed = candidates.slice();
    const hintsApplied = [];
    const region = f.region || {};
    if (narrowed.length > 1 && region.county) {
      const x = narrowed.filter((p) => same(p.county, region.county));
      if (x.length) { narrowed = x; hintsApplied.push('county'); }
    }
    if (narrowed.length > 1 && region.city) {
      const x = narrowed.filter((p) => same(p.city, region.city));
      if (x.length) { narrowed = x; hintsApplied.push('city'); }
    }
    if (narrowed.length > 1 && region.province) {
      const x = narrowed.filter((p) => same(p.province, region.province));
      if (x.length) { narrowed = x; hintsApplied.push('province'); }
    }
    if (narrowed.length > 1 && f.date) {
      const x = narrowed.filter((p) =>
        (visitsByPlace.get(p.id) || []).some((v) => v.date === f.date)
      );
      if (x.length) { narrowed = x; hintsApplied.push('same-date'); }
    }

    let place;
    if (narrowed.length === 1) {
      const p = narrowed[0];
      const countyMismatch = Boolean(region.county && p.county && !same(p.county, region.county));
      if (countyMismatch) {
        place = {
          status: 'new',
          note: `有同名地点，但路径区县（${region.county}）与库里（${p.county}）不一致，将新建`,
          name: f.name,
        };
        warnings.push('同名地点区县不一致：按最保守规则新建，避免并错（可用 F-PLC-08 再合并）');
      } else {
        place = {
          status: 'existing',
          placeId: p.id,
          name: p.name,
          province: p.province,
          city: p.city,
          county: p.county,
          hintsApplied,
          note: region.county
            ? '同名 + 同区县（导入时按坐标 <500m 复核）'
            : '同名但路径缺区县提示（导入时按坐标 <500m 复核）',
        };
        if (!region.county) warnings.push('路径里没有区县提示，导入时会用地理编码坐标复核 <500m');
      }
    } else if (narrowed.length > 1) {
      place = {
        status: 'ambiguous',
        name: f.name,
        candidates: narrowed.slice(0, 8).map((p) => ({
          placeId: p.id,
          name: p.name,
          province: p.province,
          city: p.city,
          county: p.county,
        })),
        note: `有 ${narrowed.length} 个同名地点，需要选择复用哪一条或新建`,
      };
      warnings.push(`有 ${narrowed.length} 个同名地点无法自动消歧，请在导入前选择`);
    } else {
      place = {
        status: 'new',
        name: f.name,
        note: '将新建地点（导入时按地名地理编码定位）',
      };
    }

    // ── L3 到访匹配 ──
    let visit = { status: 'new' };
    if (place.status === 'existing' && f.date) {
      const vs = (visitsByPlace.get(place.placeId) || []).filter((v) => v.date === f.date);
      if (vs.length === 1) {
        visit = { status: 'existing', visitId: vs[0].id, date: f.date };
      } else if (vs.length > 1) {
        // 同一天多条到访：优先「这个文件夹里已有媒体」归属的那条，其次媒体最多，再其次最新创建
        let best = null;
        let bestScore = -1;
        for (const v of vs) {
          const own = f.files.filter((file) => {
            const hit = mediaByPath.get(scanKey(file.relPath));
            return hit && hit.visit_id === v.id;
          }).length;
          const score = own * 1000 + (mediaCountByVisit.get(v.id) || 0) * 10;
          if (score > bestScore || (score === bestScore && v.created_at > best.created_at)) {
            best = v;
            bestScore = score;
          }
        }
        visit = { status: 'existing', visitId: best.id, date: f.date, sameDayCount: vs.length };
        warnings.push(`这一天已有 ${vs.length} 条到访，默认挂到「${best.title || '未命名'}」那条，导入前可选`);
      }
    }

    // ── L2 媒体判重 ──
    const seen = new Set();
    const matchedVisitId = visit.status === 'existing' ? visit.visitId : null;
    if (matchedVisitId) for (const h of hashesByVisit.get(matchedVisitId) || []) seen.add(h);

    const fileHashes = new Map(); // 导入后能指向的 hash → 文件相对路径（库里已有 / 本次将新增）
    let existingMedia = 0;
    let addedMedia = 0;
    let duplicateMedia = 0;
    let crossVisitDuplicates = 0;
    const crossSamples = [];

    for (const file of f.files) {
      const hit = mediaByPath.get(scanKey(file.relPath));
      if (hit) {
        existingMedia += 1;
        if (hit.hash) fileHashes.set(hit.hash, file.relPath);
        if (matchedVisitId && hit.visit_id !== matchedVisitId) {
          const owner = visitById.get(hit.visit_id);
          const ownerPlace = owner ? placeById.get(owner.place_id) : null;
          warnings.push(
            `文件已在库里但挂在别的到访：${file.name} → ${ownerPlace?.name || '?'} ${owner?.date || '?'}`
          );
        }
        continue;
      }
      let hash = null;
      try {
        hash = await hashFile16(join(scan.root, file.relPath));
      } catch (e) {
        warnings.push(`计算 hash 失败：${file.name}（${e.message}）`);
        continue;
      }
      if (seen.has(hash)) {
        duplicateMedia += 1;
        continue;
      }
      const owners = hashOwners.get(hash);
      if (owners && owners.length) {
        // 按定稿：跨到访重复只提示、不拦（同一张图可能被有意分成两个到访）
        crossVisitDuplicates += 1;
        if (crossSamples.length < 5) {
          crossSamples.push(`${file.name} 已存在于 ${owners[0].placeName} ${owners[0].visitDate}`);
        }
      }
      seen.add(hash);
      fileHashes.set(hash, file.relPath);
      addedMedia += 1;
    }
    if (crossVisitDuplicates) {
      warnings.push(
        `有 ${crossVisitDuplicates} 个文件内容与别的到访重复，仍会导入：${crossSamples.join('；')}`
      );
    }

    // ── 封面 / note ──
    let cover = null;
    if (f.cover) {
      let hash = null;
      try {
        hash = await hashFile16(join(scan.root, f.cover.relPath));
      } catch (e) {
        warnings.push(`封面文件读取失败：${f.cover.name}（${e.message}）`);
      }
      if (hash && fileHashes.has(hash)) {
        // 封面内容 = 文件夹里某张已存在/将导入的照片：直接指向它，不额外存一条
        cover = { action: 'use-folder-file', relPath: fileHashes.get(hash), added: false };
      } else if (hash) {
        const own = (hashOwners.get(hash) || []).find((o) => o.visitId === matchedVisitId);
        if (own) cover = { action: 'use-existing-media', added: false };
      }
      if (!cover) {
        cover = {
          action: 'add-cover-as-media',
          name: f.cover.name,
          relPath: f.cover.relPath,
          added: true,
        };
        addedMedia += 1;
      }
    }

    let note = { has: Boolean(f.note) };
    if (f.note) {
      if (visit.status === 'new') {
        note = { has: true, action: 'apply' };
      } else {
        const existingVisit = visits.find((v) => v.id === visit.visitId);
        note = existingVisit && !empty(existingVisit.note)
          ? { has: true, action: 'skip-existing-note' }
          : { has: true, action: 'apply' };
        if (note.action === 'skip-existing-note') {
          warnings.push('note.md 不会覆盖已有笔记');
        }
      }
    }

    folders.push({
      relDir: f.relDir,
      date: f.date,
      name: f.name,
      dateFrom: f.dateFrom,
      needsConfirm: f.needsConfirm,
      region: f.region,
      fileCount: f.files.length,
      photoCount: f.files.filter((x) => x.kind === 'photo').length,
      videoCount: f.files.filter((x) => x.kind === 'video').length,
      hasNote: Boolean(f.note),
      hasCover: Boolean(f.cover),
      place,
      visit,
      media: {
        existing: existingMedia,
        added: addedMedia,
        duplicate: duplicateMedia,
        crossVisit: crossVisitDuplicates,
      },
      cover,
      note,
      warnings,
      // 内部字段：导入时用（不返回给前端）
      _files: f.files,
    });
  }

  const summary = {
    folders: folders.length,
    existingPlaces: folders.filter((x) => x.place.status === 'existing').length,
    newPlaces: folders.filter((x) => x.place.status === 'new').length,
    ambiguousPlaces: folders.filter((x) => x.place.status === 'ambiguous').length,
    existingVisits: folders.filter((x) => x.visit.status === 'existing').length,
    newVisits: folders.filter((x) => x.visit.status === 'new').length,
    addedMedia: folders.reduce((n, x) => n + x.media.added, 0),
    existingMedia: folders.reduce((n, x) => n + x.media.existing, 0),
    duplicateMedia: folders.reduce((n, x) => n + x.media.duplicate, 0),
    crossVisitDuplicates: folders.reduce((n, x) => n + x.media.crossVisit, 0),
    needsConfirmFolders: folders.filter((x) => x.needsConfirm).length,
    warningFolders: folders.filter((x) => x.warnings.length).length,
    unclassifiedFiles: scan.unclassified.length,
    ignoredFiles: scan.ignored.count,
    photos: folders.reduce(
      (n, x) => n + x.photoCount + (x.cover?.action === 'add-cover-as-media' ? 1 : 0),
      0
    ),
    videos: folders.reduce((n, x) => n + x.videoCount, 0),
  };

  const ms = Date.now() - t0;

  return {
    root: scan.root,
    scannedAt: Date.now(),
    ms,
    scanned: { dirs: scan.dirs, files: scan.files },
    summary,
    folders,
    unclassified: scan.unclassified,
    ignored: scan.ignored,
    errors: scan.errors,
  };
}

/** 给前端的精简视图（去掉内部字段） */
export function publicPreview(preview) {
  return {
    ...preview,
    folders: preview.folders.map(({ _files, ...rest }) => rest),
  };
}
