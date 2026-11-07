/**
 * M3 功能冒烟测试（F-SYS-07 回收站 / D-57「按删除动作分层」+ D-56 媒体软删与空间）
 *
 *   node scripts/smoke-m3.mjs
 *
 * 全隔离：空临时 DATA_DIR + 空临时素材库 + 4197 端口独立实例（SMOKE_M3_PORT 可覆盖），跑完清理。
 * 不碰真实 data/travel.db、.dev-media、.env.local。
 *
 * D-57 口径：照片/到访/媒体永远留在自己当初被删的层级；父级删除只带走“当时还活着”的子项；
 * 恢复父级默认只恢复同一次删除的子项，`restoreEarlier:true` 才一并恢复此前单独删除的子项。
 * 彻底删除总是删 B 原片 + 缓存并释放空间（D-56），且不要求父级已恢复。
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_M3_PORT || 4197);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
};
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? '' : `实际=${a} 期望=${b}`);
};
const section = (title) => console.log(`\n── ${title} ──`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 临时目录（run() 里赋值，便于 helper 复用）
let mediaRoot = '';
let thumbDir = '';

// ── HTTP 小工具 ──────────────────────────────────────────────

const j = async (r) => {
  const t = await r.text();
  if (!r.ok) {
    let msg = `HTTP ${r.status}: ${t.slice(0, 300)}`;
    try {
      const b = JSON.parse(t);
      if (b?.error) msg = `HTTP ${r.status}: ${b.error}`;
    } catch {
      /* keep */
    }
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return JSON.parse(t);
};

const getJson = (path) => fetch(BASE + path).then(j);
const postJson = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);
const patchJson = (path, body) =>
  fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);
const delJson = (path) => fetch(BASE + path, { method: 'DELETE' }).then(j);
const statusOf = async (path) => {
  const r = await fetch(BASE + path);
  try {
    await r.arrayBuffer();
  } catch {
    /* 只关心状态码，但把 body 读掉免得连接挂着 */
  }
  return r.status;
};

/** 断言某个请求失败且 HTTP 状态码符合预期（400 / 404 / 409） */
const expectStatus = async (label, status, fn) => {
  let actual = null;
  let msg = '';
  try {
    await fn();
    actual = 200;
  } catch (e) {
    actual = e.status ?? null;
    msg = e.message;
  }
  check(
    `${label} → HTTP ${status}`,
    actual === status,
    actual === status ? '' : `实际=${actual ?? '无'}${msg ? `（${msg.slice(0, 120)}）` : ''}`
  );
};

// ── 业务小工具 ──────────────────────────────────────────────

const createPlace = (name, extra = {}) =>
  postJson('/api/places', {
    name,
    lng: 120.1 + Math.random() * 0.1,
    lat: 30.2 + Math.random() * 0.1,
    province: '浙江省',
    city: '杭州市',
    county: '西湖区',
    province_code: '156330000',
    city_code: '156330100',
    county_code: '156330105',
    kind: 'visited',
    date: '2024-01-01',
    ...extra,
  });

const getPlace = (id) => getJson(`/api/places/${id}`);
const listPlaces = () => getJson('/api/places');
const getLibrary = () => getJson('/api/library');
const deletePlace = (id) => delJson(`/api/places/${id}`);
const deleteVisit = (id) => delJson(`/api/visits/${id}`);
const deleteMedia = (id) => delJson(`/api/media/${id}`);

const restoreItems = (items) => postJson('/api/trash/restore', { items });
const purgeItems = (items, extra = {}) =>
  postJson('/api/trash/purge', { items: Array.isArray(items) ? items : [items], confirm: true, ...extra });
const getTrashRaw = () => getJson('/api/trash');
const getTrashCountRaw = () => getJson('/api/trash/count');

const uploadOne = async (visitId, name, buf) => {
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: 'image/jpeg' }), name);
  return fetch(`${BASE}/api/media/upload?visitId=${encodeURIComponent(visitId)}`, {
    method: 'POST',
    body: fd,
  }).then(j);
};

const makeJpg = (r, g, b) =>
  sharp({ create: { width: 240, height: 180, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 80 })
    .toBuffer();

const sumBy = (arr, key) => arr.reduce((n, it) => n + (Number(it?.[key]) || 0), 0);
const typeItem = (t, type, id) => t.items.find((it) => it.type === type && it.id === id);
const mediaIdsOf = (detail) => (detail.visits || []).flatMap((v) => (v.media || []).map((m) => m.id));

// ── 磁盘小工具（B 库原片 / data/thumbs 缓存）────────────────

function walkFiles(root) {
  const out = [];
  const rec = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(join(abs, e.name), r);
      else out.push(r);
    }
  };
  if (existsSync(root)) rec(root, '');
  return out.sort();
}

const listThumbs = () => {
  try {
    return readdirSync(thumbDir);
  } catch {
    return [];
  }
};

/** 媒体缓存：<id>.webp（缩略图）/ <id>_p.webp（1600 预览）/ <id>_poster.webp（视频封面帧） */
const cacheBytesFor = (id) => {
  let total = 0;
  for (const f of [`${id}.webp`, `${id}_p.webp`, `${id}_poster.webp`]) {
    try {
      total += statSync(join(thumbDir, f)).size;
    } catch {
      /* 缓存不在就算了 */
    }
  }
  return total;
};
const hasAnyCacheFor = (id) => listThumbs().some((f) => f.startsWith(id));

/** 请求一次 1600 预览，确保预览缓存真实存在（用于验证占用空间 / 彻底删除缓存） */
const ensurePreviewCache = async (id) => {
  const r = await fetch(`${BASE}/api/media/${id}/preview`);
  const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : Buffer.alloc(0);
  return r.ok && buf.length > 0;
};

/** 上传并记录：id / 落盘相对路径 / 原片字节 / 当前缓存字节 */
const trackUpload = async (visitId, name, buf) => {
  const before = walkFiles(mediaRoot);
  const up = await uploadOne(visitId, name, buf);
  const newFiles = walkFiles(mediaRoot).filter((f) => !before.includes(f));
  const item = up.added?.[0]
    ? {
        id: up.added[0].id,
        name,
        rel: newFiles[0] ?? null,
        bytes: newFiles[0] ? statSync(join(mediaRoot, newFiles[0])).size : 0,
        cache: cacheBytesFor(up.added[0].id),
      }
    : null;
  return { up, newFiles, item };
};

// ── 回收站断言小工具 ────────────────────────────────────────

const TRASH_TYPES = new Set(['place', 'visit', 'media']);

const assertSorted = (label, items) => {
  let ok = true;
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1];
    const b = items[i];
    if (a.deleted_at < b.deleted_at) {
      ok = false;
      break;
    }
    if (a.deleted_at === b.deleted_at) {
      if (a.type > b.type) {
        ok = false;
        break;
      }
      if (a.type === b.type && a.id > b.id) {
        ok = false;
        break;
      }
    }
  }
  check(`${label}：按 deleted_at 倒序（同时间按 type/id）`, ok);
};

/** 取回收站列表，并顺带断言 D-57 的全部口径 */
const getTrash = async (label) => {
  const t = await getTrashRaw();
  check(`${label}：响应含 items 数组`, Array.isArray(t.items));
  check(
    `${label}：条目类型只会是 place/visit/media`,
    t.items.every((it) => TRASH_TYPES.has(it?.type))
  );
  const places = t.items.filter((it) => it.type === 'place');
  const visits = t.items.filter((it) => it.type === 'visit');
  const media = t.items.filter((it) => it.type === 'media');

  eq(`${label}：total = items.length`, t.total, t.items.length);
  eq(
    `${label}：total = placeCount + visitCount + mediaCount`,
    t.total,
    t.placeCount + t.visitCount + t.mediaCount
  );
  eq(`${label}：placeCount = place 行数`, t.placeCount, places.length);
  eq(`${label}：visitCount = visit 行数`, t.visitCount, visits.length);
  eq(`${label}：mediaCount = 单独媒体行数`, t.mediaCount, media.length);
  eq(
    `${label}：mediaTotal = mediaCount + Σplace.media_count + Σvisit.media_count`,
    t.mediaTotal,
    t.mediaCount + sumBy(places, 'media_count') + sumBy(visits, 'media_count')
  );
  eq(`${label}：bytes = Σitems.bytes`, t.bytes, sumBy(t.items, 'bytes'));
  eq(`${label}：cacheBytes = Σitems.cache_bytes`, t.cacheBytes, sumBy(t.items, 'cache_bytes'));
  eq(`${label}：size = bytes + cacheBytes`, t.size, t.bytes + t.cacheBytes);
  eq(`${label}：size = Σitems.size`, t.size, sumBy(t.items, 'size'));
  check(
    `${label}：bytes/cacheBytes/size 都是非负数字`,
    [t.bytes, t.cacheBytes, t.size].every((n) => typeof n === 'number' && n >= 0)
  );
  check(`${label}：mediaTotal >= mediaCount`, t.mediaTotal >= t.mediaCount, `${t.mediaTotal}/${t.mediaCount}`);
  check(
    `${label}：place/visit 行含 D-57 分层字段`,
    [...places, ...visits].every(
      (it) =>
        typeof it.deleted_at === 'number' &&
        typeof it.media_count === 'number' &&
        typeof it.bytes === 'number' &&
        typeof it.cache_bytes === 'number' &&
        typeof it.size === 'number' &&
        typeof it.earlier_media_count === 'number' &&
        typeof it.earlier_bytes === 'number' &&
        typeof it.earlier_cache_bytes === 'number' &&
        typeof it.earlier_size === 'number' &&
        (it.type === 'visit' || typeof it.earlier_visit_count === 'number') &&
        (it.type === 'place' || it.place_deleted_at === null || typeof it.place_deleted_at === 'number')
    )
  );
  check(
    `${label}：media 行含 parent_*_deleted 标记与字段`,
    media.every(
      (it) =>
        typeof it.name === 'string' &&
        (it.kind === 'photo' || it.kind === 'video') &&
        typeof it.visit_id === 'string' &&
        typeof it.place_id === 'string' &&
        typeof it.place_name === 'string' &&
        typeof it.date === 'string' &&
        typeof it.parent_visit_deleted === 'boolean' &&
        typeof it.parent_place_deleted === 'boolean' &&
        typeof it.deleted_at === 'number'
    )
  );
  for (const it of t.items) {
    eq(`${label}：${it.type} 行 size = bytes + cache_bytes`, it.size, it.bytes + it.cache_bytes);
    if (it.type !== 'media') {
      eq(
        `${label}：${it.type} 行 earlier_size = earlier_bytes + earlier_cache_bytes`,
        it.earlier_size,
        it.earlier_bytes + it.earlier_cache_bytes
      );
    }
  }
  assertSorted(label, t.items);
  return t;
};

/** 断言 restore / purge 返回的 remaining 与 GET /api/trash 口径一致 */
const checkRemaining = async (label, remaining) => {
  const t = await getTrashRaw();
  eq(`${label}：remaining.total 与列表一致`, remaining?.total, t.total);
  eq(`${label}：remaining.places 与 placeCount 一致`, remaining?.places, t.placeCount);
  eq(`${label}：remaining.visits 与 visitCount 一致`, remaining?.visits, t.visitCount);
  eq(`${label}：remaining.media 与 mediaCount 一致`, remaining?.media, t.mediaCount);
};

/** 断言 /api/trash/count 与 /api/trash 列表口径一致 */
const checkCount = async (label, expected = null) => {
  const c = await getTrashCountRaw();
  const t = await getTrashRaw();
  eq(`${label}：count.total = places + visits + media`, c.total, c.places + c.visits + c.media);
  eq(`${label}：count.total 与列表 total 一致`, c.total, t.total);
  eq(`${label}：count.places 与 placeCount 一致`, c.places, t.placeCount);
  eq(`${label}：count.visits 与 visitCount 一致`, c.visits, t.visitCount);
  eq(`${label}：count.media 与 mediaCount 一致`, c.media, t.mediaCount);
  if (expected) {
    eq(`${label}：count.total 期望值`, c.total, expected.total);
    eq(`${label}：count.places 期望值`, c.places, expected.places);
    eq(`${label}：count.visits 期望值`, c.visits, expected.visits);
    eq(`${label}：count.media 期望值`, c.media, expected.media);
  }
};

/** 回收站彻底清空（含占用空间） */
const checkTrashZero = async (label) => {
  const t = await getTrash(label);
  eq(`${label}：回收站为空`, t.total, 0);
  eq(`${label}：mediaTotal=0`, t.mediaTotal, 0);
  eq(`${label}：bytes=0`, t.bytes, 0);
  eq(`${label}：cacheBytes=0`, t.cacheBytes, 0);
  eq(`${label}：size=0`, t.size, 0);
};

/** 彻底删除返回的 files 统计：deleted 只计原片（缓存另验磁盘） */
const checkFiles = (label, files, expectedOriginals) => {
  check(`${label}：返回 files 统计`, files && typeof files === 'object' && !Array.isArray(files));
  eq(`${label}：files.deleted = 原片数`, files?.deleted, expectedOriginals);
  eq(`${label}：files.missing=0`, files?.missing, 0);
  eq(`${label}：files.errors=[]`, files?.errors, []);
};

/** restored* 计数器只算显式请求项；restoredEarlier* 只算 restoreEarlier 额外恢复的 */
const checkRestored = (label, r, expected) => {
  for (const k of [
    'restoredPlaces',
    'restoredVisits',
    'restoredMedia',
    'restoredEarlierVisits',
    'restoredEarlierMedia',
  ]) {
    eq(`${label}：${k}`, r?.[k], expected[k]);
  }
};

// ── 主流程 ──────────────────────────────────────────────────

const run = async () => {
  console.log(`\nM3 回收站冒烟（F-SYS-07 / D-57 分层回收站 + D-56 空间，隔离实例 :${PORT}）`);
  console.log('─'.repeat(64));

  const tmp = mkdtempSync(join(ROOT, '.smoke-m3-'));
  const dataDir = join(tmp, 'data');
  mediaRoot = join(tmp, 'media');
  thumbDir = join(dataDir, 'thumbs');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });

  let child = null;
  let logFd = null;
  const logPath = join(tmp, 'server.log');
  const readLogs = () => {
    try {
      return readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };

  try {
    logFd = openSync(logPath, 'a');
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        MEDIA_ROOT: mediaRoot,
        MEDIA_ROOT_DEV: mediaRoot,
      },
      // 沙箱不允许 pipe：stdout/stderr 一律重定向到日志文件
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });

    let health = null;
    for (let i = 0; i < 60; i++) {
      try {
        health = await getJson('/api/health');
        if (health?.ok) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!health?.ok) throw new Error('服务没起来：\n' + readLogs().slice(-2000));
    check(
      '隔离实例在线且素材库指向临时目录',
      resolve(health.mediaRoot) === resolve(mediaRoot),
      health.mediaRoot
    );
    check('健康检查 ok', health.ok === true);

    // ── 1) 初始状态 ────────────────────────────────────────
    section('1) 初始状态：回收站为空、占用空间 0');
    const t0 = await getTrash('初始');
    eq('初始 items 为空', t0.items.length, 0);
    eq('初始 placeCount=0', t0.placeCount, 0);
    eq('初始 visitCount=0', t0.visitCount, 0);
    eq('初始 mediaCount=0', t0.mediaCount, 0);
    eq('初始 mediaTotal=0', t0.mediaTotal, 0);
    eq('初始 bytes=0', t0.bytes, 0);
    eq('初始 cacheBytes=0', t0.cacheBytes, 0);
    eq('初始 size=0', t0.size, 0);
    await checkCount('初始', { total: 0, places: 0, visits: 0, media: 0 });

    // ── 2) A：删照片 → 删到访（分层：media 行和 visit 行都在）────
    section('2) A：删照片 → 删到访（分层：media 行与 visit 行都在，不折叠）');
    const A = await createPlace('冒烟M3-A');
    const va = A.visits[0].id;
    const upA1 = await trackUpload(va, 'a1.jpg', await makeJpg(10, 20, 30));
    const upA2 = await trackUpload(va, 'a2.jpg', await makeJpg(40, 50, 60));
    const a1 = upA1.item;
    const a2 = upA2.item;
    eq('A 上传 2 张', upA1.up.added.length + upA2.up.added.length, 2);
    check('a1 的 1600 预览生成成功', await ensurePreviewCache(a1.id));
    a1.cache = cacheBytesFor(a1.id);
    eq('A 相册 2 张', mediaIdsOf(await getPlace(A.id)).length, 2);

    const delA1 = await deleteMedia(a1.id);
    eq('DELETE 媒体返回 ok', delA1.ok, true);
    eq('DELETE 媒体返回 trashed=true', delA1.trashed, true);
    eq('DELETE 媒体返回 mediaId', delA1.mediaId, a1.id);
    eq('DELETE 媒体返回 visitId', delA1.visitId, va);
    eq('DELETE 媒体返回 bytes', delA1.bytes, a1.bytes);
    check('软删后原片文件仍保留（B 库不动）', existsSync(join(mediaRoot, a1.rel)));
    check('软删后缩略图/预览缓存仍保留', existsSync(join(thumbDir, `${a1.id}.webp`)) && existsSync(join(thumbDir, `${a1.id}_p.webp`)));
    eq('相册剩 1 张', mediaIdsOf(await getPlace(A.id)).length, 1);

    const tA1 = await getTrash('删 A 的照片 a1 后');
    eq('只有 1 条 media 行', tA1.total, 1);
    eq('placeCount=0', tA1.placeCount, 0);
    eq('visitCount=0', tA1.visitCount, 0);
    eq('mediaCount=1', tA1.mediaCount, 1);
    eq('mediaTotal=1', tA1.mediaTotal, 1);
    eq('顶层 size = a1 总占用', tA1.size, a1.bytes + a1.cache);
    const a1Row = typeItem(tA1, 'media', a1.id);
    eq('media 行 name = 文件名', a1Row.name, 'a1.jpg');
    eq('media 行 bytes = 原片大小', a1Row.bytes, a1.bytes);
    eq('media 行 cache_bytes = 缓存大小（磁盘 stat 校验）', a1Row.cache_bytes, a1.cache);
    eq('media 行 size = bytes + cache', a1Row.size, a1.bytes + a1.cache);
    eq('media 行 parent_visit_deleted=false', a1Row.parent_visit_deleted, false);
    eq('media 行 parent_place_deleted=false', a1Row.parent_place_deleted, false);
    await checkCount('删 A 的照片 a1 后', { total: 1, places: 0, visits: 0, media: 1 });

    await deleteVisit(va); // 到访删除：只剩 a2 还算「同次删除」
    const tA2 = await getTrash('删 A 的到访后');
    eq('visit 行 + media 行都在（不再折叠）', tA2.total, 2);
    eq('placeCount=0', tA2.placeCount, 0);
    eq('visitCount=1', tA2.visitCount, 1);
    eq('mediaCount=1（a1 仍留在媒体层）', tA2.mediaCount, 1);
    eq('mediaTotal=2（a1 + a2）', tA2.mediaTotal, 2);
    const vaRow = typeItem(tA2, 'visit', va);
    eq('visit.media_count 只算随到访一起删的 a2', vaRow.media_count, 1);
    eq('visit.bytes 只算 a2 原片', vaRow.bytes, a2.bytes);
    eq('visit.cache_bytes 只算 a2 缓存', vaRow.cache_bytes, a2.cache);
    eq('visit.size 只算 a2 总占用', vaRow.size, a2.bytes + a2.cache);
    eq('visit.earlier_media_count=1（此前单独删的 a1）', vaRow.earlier_media_count, 1);
    eq('visit.earlier_bytes = a1 原片', vaRow.earlier_bytes, a1.bytes);
    eq('visit.earlier_cache_bytes = a1 缓存', vaRow.earlier_cache_bytes, a1.cache);
    eq('visit.earlier_size = a1 总占用', vaRow.earlier_size, a1.bytes + a1.cache);
    eq('visit.place_deleted_at=null（地点还活着）', vaRow.place_deleted_at, null);
    const a1Row2 = typeItem(tA2, 'media', a1.id);
    eq('a1 仍在 media 层', Boolean(a1Row2), true);
    eq('a1.parent_visit_deleted=true', a1Row2.parent_visit_deleted, true);
    eq('a1.parent_place_deleted=false', a1Row2.parent_place_deleted, false);
    eq('A 相册 0 张', mediaIdsOf(await getPlace(A.id)).length, 0);
    await checkCount('删 A 的到访后', { total: 2, places: 0, visits: 1, media: 1 });

    // 3) 恢复到访默认：只回 a2，a1 留在回收站
    section('3) A 续：恢复到访默认只回同次删除的 a2，a1 留在回收站');
    const restVA = await restoreItems([{ type: 'visit', id: va }]);
    checkRestored('默认恢复到访 A', restVA, {
      restoredPlaces: 0,
      restoredVisits: 1,
      restoredMedia: 0,
      restoredEarlierVisits: 0,
      restoredEarlierMedia: 0,
    });
    await checkRemaining('默认恢复 A 的到访后', restVA.remaining);
    const tA3 = await getTrash('默认恢复 A 的到访后');
    eq('回收站只剩 a1', tA3.total, 1);
    eq('mediaCount=1', tA3.mediaCount, 1);
    const a1Row3 = tA3.items[0];
    eq('a1 仍在回收站', a1Row3.id, a1.id);
    eq('a1.parent_visit_deleted 变 false', a1Row3.parent_visit_deleted, false);
    eq('相册回到 1 张（只有 a2）', mediaIdsOf(await getPlace(A.id)).length, 1);
    const restA1 = await restoreItems([{ type: 'media', id: a1.id }]);
    checkRestored('单独恢复 a1', restA1, {
      restoredPlaces: 0,
      restoredVisits: 0,
      restoredMedia: 1,
      restoredEarlierVisits: 0,
      restoredEarlierMedia: 0,
    });
    eq('相册回到 2 张', mediaIdsOf(await getPlace(A.id)).length, 2);
    await checkTrashZero('恢复 A 的全部媒体后');

    // 4) 第二轮：恢复 visit 时 restoreEarlier 一并恢复早删媒体
    section('4) A 再走一遍：恢复 visit 时 restoreEarlier:true 一并恢复早删照片');
    await deleteMedia(a1.id);
    await deleteVisit(va);
    const tA4 = await getTrash('第二轮删照片+到访后');
    eq('visit 行 + media 行都在', tA4.total, 2);
    eq('mediaCount=1', tA4.mediaCount, 1);
    eq('visitCount=1', tA4.visitCount, 1);
    const restVA2 = await restoreItems([{ type: 'visit', id: va, restoreEarlier: true }]);
    checkRestored('restoreEarlier 恢复到访 A', restVA2, {
      restoredPlaces: 0,
      restoredVisits: 1,
      restoredMedia: 0,
      restoredEarlierVisits: 0,
      restoredEarlierMedia: 1,
    });
    eq('相册 2 张（a1 + a2 都回来）', mediaIdsOf(await getPlace(A.id)).length, 2);
    await checkTrashZero('restoreEarlier 恢复 A 的到访后');

    // ── 5) B：先删到访、再删地点（place 行 + visit 行都在）──────
    section('5) B：先删到访再删地点（place 行 + visit 行都在；默认恢复不带早删子项）');
    const B = await createPlace('冒烟M3-B');
    const vb = B.visits[0].id;
    const upB1 = await trackUpload(vb, 'b1.jpg', await makeJpg(70, 80, 90));
    const upB2 = await trackUpload(vb, 'b2.jpg', await makeJpg(100, 110, 120));
    const b1 = upB1.item;
    const b2 = upB2.item;
    eq('B 上传 2 张', upB1.up.added.length + upB2.up.added.length, 2);
    await deleteVisit(vb);
    const tB1 = await getTrash('删 B 的到访后');
    eq('visitCount=1', tB1.visitCount, 1);
    eq('mediaCount=0（媒体随到访同次删除，嵌在 visit 行）', tB1.mediaCount, 0);
    eq('visit.media_count=2', tB1.items[0]?.media_count, 2);
    eq('visit.earlier_media_count=0', tB1.items[0]?.earlier_media_count, 0);

    await sleep(15);
    await deletePlace(B.id); // 地点删除只带走「当时还活着」的子项；到访早已删
    const tB2 = await getTrash('再删 B 的地点后');
    eq('place 行 + 早删 visit 行都在', tB2.total, 2);
    eq('placeCount=1', tB2.placeCount, 1);
    eq('visitCount=1（早删到访保留 visit 行）', tB2.visitCount, 1);
    eq('mediaCount=0', tB2.mediaCount, 0);
    eq('mediaTotal=2（visit 行里的两张）', tB2.mediaTotal, 2);
    const pB = typeItem(tB2, 'place', B.id);
    const vB = typeItem(tB2, 'visit', vb);
    eq('place.visit_count=0（没有同次删除的到访）', pB.visit_count, 0);
    eq('place.media_count=0（没有同次删除的媒体）', pB.media_count, 0);
    eq('place.bytes=0', pB.bytes, 0);
    eq('place.size=0', pB.size, 0);
    eq('place.earlier_visit_count=1（早删到访）', pB.earlier_visit_count, 1);
    eq('place.earlier_media_count=2（早删到访里的两张）', pB.earlier_media_count, 2);
    eq('place.earlier_bytes = b1+b2 原片', pB.earlier_bytes, b1.bytes + b2.bytes);
    eq('place.earlier_cache_bytes = b1+b2 缓存', pB.earlier_cache_bytes, b1.cache + b2.cache);
    eq('place.earlier_size = b1+b2 总占用', pB.earlier_size, b1.bytes + b1.cache + b2.bytes + b2.cache);
    check('visit.place_deleted_at 非空（父地点在回收站）', typeof vB.place_deleted_at === 'number', String(vB.place_deleted_at));
    eq('visit.media_count=2', vB.media_count, 2);
    eq('visit.earlier_media_count=0', vB.earlier_media_count, 0);
    eq('visit.size = 两张总占用', vB.size, b1.bytes + b1.cache + b2.bytes + b2.cache);
    await checkCount('再删 B 的地点后', { total: 2, places: 1, visits: 1, media: 0 });

    const restB1 = await restoreItems([{ type: 'place', id: B.id }]);
    checkRestored('默认恢复 B 的地点', restB1, {
      restoredPlaces: 1,
      restoredVisits: 0,
      restoredMedia: 0,
      restoredEarlierVisits: 0,
      restoredEarlierMedia: 0,
    });
    const tB3 = await getTrash('默认恢复 B 的地点后');
    eq('place 行消失、早删 visit 行仍在', tB3.total, 1);
    eq('visitCount=1', tB3.visitCount, 1);
    eq('placeCount=0', tB3.placeCount, 0);
    eq('早删到访仍在回收站', tB3.items[0]?.id, vb);
    eq('visit.place_deleted_at 变 null', tB3.items[0]?.place_deleted_at, null);
    eq('B 详情 0 次到访（到访还没恢复）', (await getPlace(B.id)).visits.length, 0);

    // 第二轮：再删地点，用 restoreEarlier 恢复地点 + 早删到访 + 媒体
    await sleep(15);
    await deletePlace(B.id);
    const tB4 = await getTrash('第二轮删 B 的地点后');
    eq('place + visit 都在', tB4.total, 2);
    const pB2 = typeItem(tB4, 'place', B.id);
    eq('place.earlier_visit_count=1', pB2.earlier_visit_count, 1);
    eq('place.earlier_media_count=2', pB2.earlier_media_count, 2);
    const restB2 = await restoreItems([{ type: 'place', id: B.id, restoreEarlier: true }]);
    checkRestored('restoreEarlier 恢复 B 的地点', restB2, {
      restoredPlaces: 1,
      restoredVisits: 0,
      restoredMedia: 0,
      restoredEarlierVisits: 1,
      restoredEarlierMedia: 2,
    });
    eq('B 详情恢复 2 张照片', mediaIdsOf(await getPlace(B.id)).length, 2);
    await checkTrashZero('restoreEarlier 恢复 B 的地点后');

    // ── 6) C：父级已删时单独彻底删除子项（允许；父级 earlier 计数下降）──
    section('6) C：父级已删时单独 purge 媒体/到访（允许，父级 earlier 计数随之下降）');
    const C = await createPlace('冒烟M3-C');
    const vc = C.visits[0].id;
    const upC1 = await trackUpload(vc, 'c1.jpg', await makeJpg(130, 140, 150));
    const upC2 = await trackUpload(vc, 'c2.jpg', await makeJpg(160, 170, 180));
    const c1 = upC1.item;
    const c2 = upC2.item;
    await deleteMedia(c1.id);
    await sleep(10);
    await deleteVisit(vc);
    await sleep(10);
    await deletePlace(C.id);
    const tC1 = await getTrash('C 三层都删后');
    eq('place + visit + media 三行都在', tC1.total, 3);
    eq('placeCount=1', tC1.placeCount, 1);
    eq('visitCount=1', tC1.visitCount, 1);
    eq('mediaCount=1', tC1.mediaCount, 1);
    eq('mediaTotal=2', tC1.mediaTotal, 2);
    const pC = typeItem(tC1, 'place', C.id);
    const vC = typeItem(tC1, 'visit', vc);
    const mC = typeItem(tC1, 'media', c1.id);
    eq('place.earlier_visit_count=1', pC.earlier_visit_count, 1);
    eq('place.earlier_media_count=2', pC.earlier_media_count, 2);
    eq('place.media_count=0', pC.media_count, 0);
    check('visit.place_deleted_at 非空', typeof vC.place_deleted_at === 'number', String(vC.place_deleted_at));
    eq('visit.media_count=1（c2 同次）', vC.media_count, 1);
    eq('visit.earlier_media_count=1（c1 早删）', vC.earlier_media_count, 1);
    eq('media 行 parent_visit_deleted=true', mC.parent_visit_deleted, true);
    eq('media 行 parent_place_deleted=true', mC.parent_place_deleted, true);
    await checkCount('C 三层都删后', { total: 3, places: 1, visits: 1, media: 1 });

    const purgedC1 = await purgeItems([{ type: 'media', id: c1.id }]);
    eq('父级已删时单独彻底删除媒体：purgedMedia=1', purgedC1.purgedMedia, 1);
    eq('purgedPlaces=0', purgedC1.purgedPlaces, 0);
    eq('purgedVisits=0', purgedC1.purgedVisits, 0);
    checkFiles('单独彻底删除 C 的媒体 c1', purgedC1.files, 1);
    check('c1 原片已释放', !existsSync(join(mediaRoot, c1.rel)));
    check('c1 缓存已释放', !hasAnyCacheFor(c1.id));
    const tC2 = await getTrash('单独彻底删除 C 的媒体后');
    eq('回收站剩 place + visit', tC2.total, 2);
    eq('mediaCount=0', tC2.mediaCount, 0);
    const pC2 = typeItem(tC2, 'place', C.id);
    const vC2 = typeItem(tC2, 'visit', vc);
    eq('place.earlier_media_count 降到 1', pC2.earlier_media_count, 1);
    eq('place.earlier_bytes 只剩 c2', pC2.earlier_bytes, c2.bytes);
    eq('place.earlier_size 只剩 c2 总占用', pC2.earlier_size, c2.bytes + c2.cache);
    eq('visit.earlier_media_count 降到 0', vC2.earlier_media_count, 0);
    eq('visit.earlier_size 降到 0', vC2.earlier_size, 0);

    const purgedC2 = await purgeItems([{ type: 'visit', id: vc }]);
    eq('父级已删时单独彻底删除到访：purgedVisits=1', purgedC2.purgedVisits, 1);
    eq('purgedPlaces=0', purgedC2.purgedPlaces, 0);
    eq('purgedMedia=0', purgedC2.purgedMedia, 0);
    checkFiles('单独彻底删除 C 的到访', purgedC2.files, 1);
    check('c2 原片已释放', !existsSync(join(mediaRoot, c2.rel)));
    const tC3 = await getTrash('单独彻底删除 C 的到访后');
    eq('回收站只剩 place', tC3.total, 1);
    eq('place.earlier_visit_count=0', tC3.items[0]?.earlier_visit_count, 0);
    eq('place.earlier_media_count=0', tC3.items[0]?.earlier_media_count, 0);
    eq('place.earlier_size=0', tC3.items[0]?.earlier_size, 0);
    const purgedC3 = await purgeItems([{ type: 'place', id: C.id }]);
    eq('彻底删除地点 C 成功', purgedC3.purgedPlaces, 1);
    eq('C 没有媒体可删（files.deleted=0）', purgedC3.files?.deleted, 0);
    await checkTrashZero('彻底删除地点 C 后');

    // ── 7) D：同一请求恢复 place + 早删 visit + 早删 media ──────
    section('7) D：同一请求恢复 place + 早删 visit + 早删 media 不报错');
    const D = await createPlace('冒烟M3-D');
    const vd = D.visits[0].id;
    const upD1 = await trackUpload(vd, 'd1.jpg', await makeJpg(190, 200, 210));
    const upD2 = await trackUpload(vd, 'd2.jpg', await makeJpg(220, 230, 240));
    const d1 = upD1.item;
    const d2 = upD2.item;
    await deleteMedia(d1.id);
    await sleep(10);
    await deleteVisit(vd);
    await sleep(10);
    await deletePlace(D.id);
    const tD1 = await getTrash('D 三层都删后');
    eq('place + visit + media 三行都在', tD1.total, 3);
    eq('mediaTotal=2', tD1.mediaTotal, 2);
    const restD1 = await restoreItems([
      { type: 'place', id: D.id },
      { type: 'visit', id: vd },
      { type: 'media', id: d1.id },
    ]);
    checkRestored('同一请求（不带 restoreEarlier）', restD1, {
      restoredPlaces: 1,
      restoredVisits: 1,
      restoredMedia: 1,
      restoredEarlierVisits: 0,
      restoredEarlierMedia: 0,
    });
    eq('D 详情恢复 2 张', mediaIdsOf(await getPlace(D.id)).length, 2);
    await checkTrashZero('同一请求恢复 D 后');

    // 第二轮：只选 place + restoreEarlier，一次带回早删 visit 与媒体
    await deleteMedia(d1.id);
    await sleep(10);
    await deleteVisit(vd);
    await sleep(10);
    await deletePlace(D.id);
    const restD2 = await restoreItems([{ type: 'place', id: D.id, restoreEarlier: true }]);
    checkRestored('restoreEarlier 恢复 D 的地点', restD2, {
      restoredPlaces: 1,
      restoredVisits: 0,
      restoredMedia: 0,
      restoredEarlierVisits: 1,
      restoredEarlierMedia: 2,
    });
    eq('D 详情恢复 2 张', mediaIdsOf(await getPlace(D.id)).length, 2);
    await checkTrashZero('restoreEarlier 恢复 D 后');

    // ── 8) E：混合批量彻底删除（父子同时选中）─────────────────
    section('8) E：混合批量彻底删除（父子同时选中）不报错，files.deleted=唯一原片数');
    const E1 = await createPlace('冒烟M3-E1');
    const E1v = E1.visits[0].id;
    const upE1 = await trackUpload(E1v, 'e1.jpg', await makeJpg(30, 60, 90));
    const e1 = upE1.item;
    const E2 = await createPlace('冒烟M3-E2');
    const E2v = E2.visits[0].id;
    const upE2 = await trackUpload(E2v, 'e2.jpg', await makeJpg(60, 90, 120));
    const e2 = upE2.item;
    const E3 = await createPlace('冒烟M3-E3');
    const E3v = E3.visits[0].id;
    const upE3 = await trackUpload(E3v, 'e3.jpg', await makeJpg(90, 120, 150));
    const e3 = upE3.item;
    eq('三张照片上传成功', upE1.up.added.length + upE2.up.added.length + upE3.up.added.length, 3);
    await deleteVisit(E2v); // 早删到访
    await deleteMedia(e3.id); // 单独删媒体
    await deletePlace(E1.id); // 地点 + 同次到访/媒体
    const tE = await getTrash('E 混合清理前');
    eq('place + visit + media 三行', tE.total, 3);
    eq('placeCount=1', tE.placeCount, 1);
    eq('visitCount=1', tE.visitCount, 1);
    eq('mediaCount=1', tE.mediaCount, 1);
    eq('mediaTotal=3', tE.mediaTotal, 3);
    const libBeforeE = await getLibrary();
    const purgedE = await purgeItems([
      { type: 'place', id: E1.id },
      { type: 'visit', id: E1v }, // 父级与同次到访同时选中
      { type: 'visit', id: E2v },
      { type: 'media', id: e3.id },
    ]);
    eq('purgedPlaces=1', purgedE.purgedPlaces, 1);
    eq('purgedVisits=2（显式两项）', purgedE.purgedVisits, 2);
    eq('purgedMedia=1', purgedE.purgedMedia, 1);
    checkFiles('混合批量彻底删除', purgedE.files, 3);
    check(
      '三张原片都释放',
      !existsSync(join(mediaRoot, e1.rel)) &&
        !existsSync(join(mediaRoot, e2.rel)) &&
        !existsSync(join(mediaRoot, e3.rel))
    );
    check(
      '三张照片缓存都释放',
      !hasAnyCacheFor(e1.id) && !hasAnyCacheFor(e2.id) && !hasAnyCacheFor(e3.id)
    );
    eq('批量清理后 remaining.total=0', purgedE.remaining?.total, 0);
    await checkRemaining('混合批量彻底删除后', purgedE.remaining);
    const libAfterE = await getLibrary();
    eq('彻底删除后库软删记录 -3', libAfterE.deleted, libBeforeE.deleted - 3);
    await expectStatus('清理后地点 E1 详情 → 404', 404, () => getPlace(E1.id));
    eq('E2 详情 0 次到访', (await getPlace(E2.id)).visits.length, 0);
    eq('E3 详情 0 张媒体', mediaIdsOf(await getPlace(E3.id)).length, 0);
    await checkTrashZero('混合批量彻底删除后');
    await checkCount('混合批量彻底删除后', { total: 0, places: 0, visits: 0, media: 0 });

    // ── 9) F：D-56 空间/软删/上传去重保持不变 ──────────────────
    section('9) F：D-56 空间/软删/上传去重保持不变');
    const F = await createPlace('冒烟M3-F');
    const vf = F.visits[0].id;
    const imgF = await makeJpg(15, 45, 75);
    const libBeforeF = await getLibrary();
    const upF = await trackUpload(vf, 'f.jpg', imgF);
    const mf = upF.item;
    eq('F 上传成功 1 张', upF.up.added.length, 1);
    check('F 的 1600 预览生成成功', await ensurePreviewCache(mf.id));
    mf.cache = cacheBytesFor(mf.id);
    const libAfterUpF = await getLibrary();
    eq('上传后库 total +1', libAfterUpF.total, libBeforeF.total + 1);

    await deleteMedia(mf.id);
    const tF1 = await getTrash('软删 F 的照片后');
    eq('media 行出现', tF1.mediaCount, 1);
    eq('media 行 bytes = 原片大小', tF1.items[0]?.bytes, mf.bytes);
    eq('media 行 cache_bytes = 缓存大小', tF1.items[0]?.cache_bytes, mf.cache);
    check('软删后原片+缓存都还在', existsSync(join(mediaRoot, mf.rel)) && existsSync(join(thumbDir, `${mf.id}_p.webp`)));
    eq('软删后 orig 仍可访问', await statusOf(`/api/media/${mf.id}/orig`), 200);
    const libSoftF = await getLibrary();
    eq('软删后库 total -1', libSoftF.total, libAfterUpF.total - 1);
    eq('软删后库 deleted +1', libSoftF.deleted, libAfterUpF.deleted + 1);

    const filesBeforeF = walkFiles(mediaRoot).length;
    const reF = await uploadOne(vf, 'f.jpg', imgF);
    eq('软删后重传同内容：added 只有 1 条', reF.added.length, 1);
    eq('软删后重传同内容：恢复旧 media id', reF.added[0]?.id, mf.id);
    eq('软删后重传同内容：restored=true', reF.added[0]?.restored, true);
    eq('软删后重传同内容：name 是上传文件名', reF.added[0]?.name, 'f.jpg');
    eq('软删后重传同内容：磁盘不新增文件', walkFiles(mediaRoot).length, filesBeforeF);
    eq('相册里恢复旧记录', mediaIdsOf(await getPlace(F.id))[0], mf.id);
    await checkTrashZero('重传恢复 F 的照片后');
    eq('库 total 回来', (await getLibrary()).total, libAfterUpF.total);
    eq('库 deleted 归零', (await getLibrary()).deleted, 0);

    // 彻底删除释放空间（旧 deleteMedia:false 参数不再有开关，仍删文件）
    await deleteMedia(mf.id);
    const purgedF = await purgeItems([{ type: 'media', id: mf.id }], { deleteMedia: false });
    eq('彻底删除媒体：purgedMedia=1', purgedF.purgedMedia, 1);
    checkFiles('彻底删除 F 的媒体', purgedF.files, 1);
    check('原片已释放', !existsSync(join(mediaRoot, mf.rel)));
    check('缩略图/预览缓存已释放', !hasAnyCacheFor(mf.id));
    eq('原图接口 404', await statusOf(`/api/media/${mf.id}/orig`), 404);
    eq('库 total 保持（记录本就不在 total）', (await getLibrary()).total, libAfterUpF.total - 1);
    eq('库 deleted 归零', (await getLibrary()).deleted, 0);

    // 彻底删除后重传同内容 → 正常新增
    const upF2 = await trackUpload(vf, 'f.jpg', imgF);
    eq('旧记录彻底删除后重传：新增 1 条', upF2.up.added.length, 1);
    check('新记录 id 与旧记录不同', upF2.item.id !== mf.id);
    check('新记录没有 restored 标记', upF2.up.added[0]?.restored !== true);
    eq('磁盘新增 1 个文件', upF2.newFiles.length, 1);
    eq('相册 1 张', mediaIdsOf(await getPlace(F.id)).length, 1);
    // 清理 F：彻底删除地点（连带媒体释放）
    await deletePlace(F.id);
    const tF2 = await getTrash('删地点 F 后');
    eq('删地点后 mediaTotal=1', tF2.mediaTotal, 1);
    const purgedF2 = await purgeItems([{ type: 'place', id: F.id }]);
    eq('彻底删除地点 F 成功', purgedF2.purgedPlaces, 1);
    checkFiles('彻底删除地点 F', purgedF2.files, 1);
    check('F 的原片已释放', !existsSync(join(mediaRoot, upF2.item.rel)));
    await checkTrashZero('彻底删除地点 F 后');
    eq('库 total 回到清理前', (await getLibrary()).total, libBeforeF.total);

    // ── 10) 参数校验 / 409 ─────────────────────────────────────
    section('10) 参数校验（400/404/409）');
    await expectStatus('restore 缺 items 字段', 400, () => postJson('/api/trash/restore', {}));
    await expectStatus('restore items 为空', 400, () => restoreItems([]));
    await expectStatus('restore 非法 type', 400, () => restoreItems([{ type: 'bogus', id: 'x' }]));
    await expectStatus('restore 不存在的 place id', 404, () =>
      restoreItems([{ type: 'place', id: 'not-exist-id' }])
    );
    await expectStatus('restore 不存在的 visit id', 404, () =>
      restoreItems([{ type: 'visit', id: 'not-exist-id' }])
    );
    await expectStatus('restore 不存在的 media id', 404, () =>
      restoreItems([{ type: 'media', id: 'not-exist-id' }])
    );
    await expectStatus('purge 缺 confirm', 400, () =>
      postJson('/api/trash/purge', { items: [{ type: 'place', id: 'x' }] })
    );
    await expectStatus('purge confirm=false', 400, () =>
      purgeItems([{ type: 'place', id: 'x' }], { confirm: false })
    );
    await expectStatus('purge items 为空', 400, () => purgeItems([]));
    await expectStatus('purge 非法 type', 400, () => purgeItems([{ type: 'bogus', id: 'x' }]));
    await expectStatus('purge 不存在的 place id', 404, () =>
      purgeItems([{ type: 'place', id: 'not-exist-id' }])
    );
    await expectStatus('purge 不存在的 media id', 404, () =>
      purgeItems([{ type: 'media', id: 'not-exist-id' }])
    );

    // 409：父级还在回收站时恢复子项
    const H = await createPlace('冒烟M3-H');
    const hv = H.visits[0].id;
    const upH1 = await trackUpload(hv, 'h1.jpg', await makeJpg(200, 100, 50));
    const h1 = upH1.item;
    const upH2 = await trackUpload(hv, 'h2.jpg', await makeJpg(50, 100, 200));
    const h2 = upH2.item;
    await deleteMedia(h1.id);
    await sleep(10);
    await deleteVisit(hv);
    await sleep(10);
    await deletePlace(H.id);
    const tH = await getTrash('H 三层都删后');
    eq('place + visit + media 三行', tH.total, 3);
    await expectStatus('父级在回收站：restore 媒体 → 409', 409, () =>
      restoreItems([{ type: 'media', id: h1.id }])
    );
    await expectStatus('父级在回收站：restore 早删媒体 h2 → 409', 409, () =>
      restoreItems([{ type: 'media', id: h2.id }])
    );
    await expectStatus('父级在回收站：restore 到访 → 409', 409, () =>
      restoreItems([{ type: 'visit', id: hv }])
    );
    // 父级已删时直接 purge 子项 → 成功
    const purgedH1 = await purgeItems([{ type: 'media', id: h1.id }]);
    eq('父级已删时直接 purge 媒体成功', purgedH1.purgedMedia, 1);
    checkFiles('直接 purge H 的媒体 h1', purgedH1.files, 1);
    const purgedH2 = await purgeItems([{ type: 'visit', id: hv }]);
    eq('父级已删时直接 purge 到访成功', purgedH2.purgedVisits, 1);
    checkFiles('直接 purge H 的到访（连带 h2）', purgedH2.files, 1);
    const tH2 = await getTrash('H 只剩地点后');
    eq('只剩 place 行', tH2.total, 1);
    eq('place.earlier_visit_count=0', tH2.items[0]?.earlier_visit_count, 0);
    eq('place.earlier_media_count=0', tH2.items[0]?.earlier_media_count, 0);
    const purgedH3 = await purgeItems([{ type: 'place', id: H.id }]);
    eq('彻底删除空地点 H 成功', purgedH3.purgedPlaces, 1);
    eq('空地点没有文件可删', purgedH3.files?.deleted, 0);
    await checkTrashZero('清理 H 后');

    // ── 11) 想去地点也进回收站 ─────────────────────────────────
    section('11) 想去地点（无到访）也进回收站');
    const W = await createPlace('冒烟M3-W', { kind: 'wishlist', date: undefined });
    await deletePlace(W.id);
    const tW = await getTrash('删想去地点 W 后');
    eq('回收站有 1 条', tW.total, 1);
    eq('类型是 place', tW.items[0]?.type, 'place');
    eq('kind=wishlist', tW.items[0]?.kind, 'wishlist');
    eq('visit_count=0', tW.items[0]?.visit_count, 0);
    eq('media_count=0', tW.items[0]?.media_count, 0);
    eq('earlier_visit_count=0', tW.items[0]?.earlier_visit_count, 0);
    eq('earlier_media_count=0', tW.items[0]?.earlier_media_count, 0);
    eq('size=0', tW.items[0]?.size, 0);
    const restW = await restoreItems([{ type: 'place', id: W.id }]);
    eq('恢复想去地点成功', restW.restoredPlaces, 1);
    await checkRemaining('恢复想去地点 W 后', restW.remaining);
    await checkTrashZero('恢复想去地点 W 后');
    check('/api/places 列表恢复想去地点 W', (await listPlaces()).some((p) => p.id === W.id));
    eq('W 详情没有到访', (await getPlace(W.id)).visits.length, 0);

    // ── 12) 最终一致性 ────────────────────────────────────────
    section('12) 最终一致性');
    await checkTrashZero('最终');
    await checkCount('最终', { total: 0, places: 0, visits: 0, media: 0 });
    const libEnd = await getLibrary();
    eq('素材库没有软删记录', libEnd.deleted, 0);
    eq('素材库没有丢失原片', libEnd.missing, 0);
    const liveC = mediaIdsOf(await getPlace(A.id)); // A 2 张
    const liveB = mediaIdsOf(await getPlace(B.id)); // B 2 张
    const liveD = mediaIdsOf(await getPlace(D.id)); // D 2 张
    eq('A 相册 2 张', liveC.length, 2);
    eq('B 相册 2 张', liveB.length, 2);
    eq('D 相册 2 张', liveD.length, 2);
    eq('素材库正好 6 张（A+B+D）', libEnd.total, 6);
    const expectedRels = [a1.rel, a2.rel, b1.rel, b2.rel, d1.rel, d2.rel].sort();
    const finalFiles = walkFiles(mediaRoot);
    eq('磁盘上正好 6 个原片（没有残留孤儿）', finalFiles.length, 6);
    eq('磁盘原片就是 A/B/D 的 6 个文件', finalFiles, expectedRels);
    check(
      '6 张照片的缩略图缓存都在',
      [a1.id, a2.id, b1.id, b2.id, d1.id, d2.id].every((id) => existsSync(join(thumbDir, `${id}.webp`)))
    );

    console.log('\n' + '─'.repeat(64));
    console.log(`通过 ${pass} 项，失败 ${fail} 项 ${fail === 0 ? '✅' : '❌'}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(100);
    }
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
    }
    await sleep(150);
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.log(`  (临时目录清理失败，可手动删：${tmp} — ${e.message})`);
    }
  }
};

run().catch((e) => {
  console.error('\nM3 回收站冒烟异常：', e?.message || e);
  process.exitCode = 1;
});
