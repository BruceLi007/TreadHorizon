import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG } from './config.mjs';

export const db = new DatabaseSync(resolve(CONFIG.dataDir, 'travel.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS place (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,                                -- 归属账号（M6 P2-2；local 模式为 NULL）
  name          TEXT NOT NULL,
  lng           REAL NOT NULL,
  lat           REAL NOT NULL,
  province      TEXT,
  city          TEXT,
  county        TEXT,
  province_code TEXT,
  city_code     TEXT,
  county_code   TEXT,
  kind          TEXT NOT NULL DEFAULT 'visited',
  cover_media_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE TABLE IF NOT EXISTS visit (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,                                   -- 归属账号（M6 P2-2；local 模式为 NULL）
  place_id   TEXT NOT NULL REFERENCES place(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  title      TEXT,
  note       TEXT,
  rating     INTEGER,
  companions TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,                                   -- 归属账号（M6 P2-2；local 模式为 NULL）
  visit_id   TEXT NOT NULL REFERENCES visit(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  rel_path   TEXT NOT NULL UNIQUE,
  hash       TEXT,
  bytes      INTEGER,
  width      INTEGER,
  height     INTEGER,
  duration   REAL,
  taken_at   INTEGER,
  thumb      TEXT,
  preview    TEXT,
  poster     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_visit_place  ON visit(place_id, date);
CREATE INDEX IF NOT EXISTS idx_media_visit  ON media(visit_id, created_at);
CREATE INDEX IF NOT EXISTS idx_place_region ON place(province_code);
CREATE INDEX IF NOT EXISTS idx_media_hash   ON media(hash);
`);

/**
 * 账号 / 会话 / 邀请码（2026-11-06 M6 P2-1，D-200）。
 * 本地模式（AUTH_MODE=local，默认）不会写这三张表，表存在不影响旧行为；
 * 云端多用户模式（AUTH_MODE=multi）下 use。
 */
db.exec(`
CREATE TABLE IF NOT EXISTS user (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',      -- admin | user
  status        TEXT NOT NULL DEFAULT 'active',    -- active | disabled
  quota_bytes   INTEGER NOT NULL DEFAULT 0,        -- 0 = 用服务端默认配额（5 GiB）
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS session (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  ip          TEXT,
  ua          TEXT,
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS invite (
  id         TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  note       TEXT,
  expires_at INTEGER NOT NULL,
  used_by    TEXT REFERENCES user(id),
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_user    ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_expires ON session(expires_at);
CREATE INDEX IF NOT EXISTS idx_invite_expires  ON invite(expires_at);

-- 每用户独立设置（M6 P2-2，D-202）：秘密基地密码 / 自己的天地图 Key / 备份提醒。
-- local 模式不写这张表（沿用 data/config.json 的旧逻辑，行为不变）。
CREATE TABLE IF NOT EXISTS user_setting (
  user_id               TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  secret                TEXT,        -- JSON { salt, hash }：秘密基地密码（scrypt）
  tdt_tk                TEXT,        -- 该用户自己的天地图 Key（浏览器端类型；服务端地理编码用）
  media_root            TEXT,        -- 该账号自己的素材库根目录（2026-11-07 D-212；NULL = 用服务器默认）
  last_backup_at        INTEGER,
  backup_threshold_days INTEGER,
  backup_snooze_until   INTEGER,
  updated_at            INTEGER NOT NULL
);
`);

/**
 * 轻量迁移：老库（M0 建的）缺列时补上，不改已有数据。
 * 不用迁移框架，这个项目只有一个数据库文件、单人使用。
 */
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

// F-MED-05：删媒体 = 软删，磁盘文件不动
addColumnIfMissing('media', 'deleted_at', 'deleted_at INTEGER');
// F-VST-03：同行人（JSON 字符串数组）
addColumnIfMissing('visit', 'companions', 'companions TEXT');
// F-PLC-11：秘密基地标记（1 = 是）
addColumnIfMissing('place', 'secret', 'secret INTEGER NOT NULL DEFAULT 0');
// F-PLC-12：「家」地点标记（1 = 是；老库自动补列，默认 0）
addColumnIfMissing('place', 'home', 'home INTEGER NOT NULL DEFAULT 0');
// M6 P2-2（D-202）：place / visit / media 归属账号列；老库补 NULL，迁移脚本再归到管理员
addColumnIfMissing('place', 'user_id', 'user_id TEXT');
addColumnIfMissing('visit', 'user_id', 'user_id TEXT');
addColumnIfMissing('media', 'user_id', 'user_id TEXT');
// M6 D-212（2026-11-07）：每个账号可自定义自己的素材库根目录（NULL = 服务器默认）
addColumnIfMissing('user_setting', 'media_root', 'media_root TEXT');
// 2026-11-07（D-224）：账号头像更新时间（0/NULL = 没上传过头像；文件放 data/avatars/<userId>.webp）
addColumnIfMissing('user', 'avatar_updated_at', 'avatar_updated_at INTEGER');

// 上面补列之后才能建索引（老库的建表语句里没有 user_id 列）
db.exec(`
CREATE INDEX IF NOT EXISTS idx_place_user ON place(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_visit_user ON visit(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_media_user ON media(user_id);
`);

/**
 * 旧数据清理（幂等）：M1 之前「想去」地点也会自动建一条空到访，
 * 导致侧栏显示「去过 1 次」、时间轴和统计被污染。
 * 只清理「日期 = 地点创建日、且标题/笔记/评分/同行人/媒体全空」的到访 —— 这是自动建的那条的特征。
 * 用户手动加过内容的到访不会被删。
 */
function cleanupWishlistAutoVisits() {
  const rows = db.prepare(`
    SELECT v.id, v.date, v.title, v.note, v.rating, v.companions, p.created_at
    FROM visit v JOIN place p ON p.id = v.place_id
    WHERE p.kind = 'wishlist' AND v.deleted_at IS NULL
  `).all();
  if (!rows.length) return;
  const softDelete = db.prepare('UPDATE visit SET deleted_at = ? WHERE id = ?');
  const countMedia = db.prepare(
    'SELECT COUNT(*) AS n FROM media WHERE visit_id = ? AND deleted_at IS NULL'
  );
  const ts = Date.now();
  for (const r of rows) {
    if (r.title || r.note || r.rating) continue;
    let comps = [];
    try {
      comps = JSON.parse(r.companions || '[]');
    } catch {
      comps = [];
    }
    if (Array.isArray(comps) && comps.length) continue;
    if (countMedia.get(r.id).n) continue;
    const createdDate = new Date(r.created_at).toISOString().slice(0, 10);
    if (r.date !== createdDate) continue;
    softDelete.run(ts, r.id);
  }
}

cleanupWishlistAutoVisits();

export const now = () => Date.now();

/** 解析 companions：库里存 JSON 字符串，出口统一成数组 */
function parseCompanions(v) {
  if (!v.companions) return [];
  try {
    const arr = JSON.parse(v.companions);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * owner（账号）过滤条件（2026-11-06 M6 P2-2，D-202）。
 * - ownerId 为空（local 单机模式，或调用方还没接线）：返回 `{ sql: '', params: [] }`，
 *   SQL 与绑定参数跟改造前完全一样，不加任何 user_id 过滤；
 * - ownerId 非空（multi 多用户模式）：` AND <alias>.user_id = ?`。
 * 注意：占位符按 SQL 文本顺序绑定，调用方必须在「拼接该片段的位置」把 params 按同样顺序推入。
 */
function ownerCond(ownerId, alias) {
  return ownerId
    ? { sql: ` AND ${alias}.user_id = ?`, params: [ownerId] }
    : { sql: '', params: [] };
}

/** 地点封面子查询（依赖外层别名 p）；ownerId 非空时顺带限定媒体 / 到访归属 */
function coverSubquery(ownerId) {
  const mOwner = ownerCond(ownerId, 'm');
  const v2Owner = ownerCond(ownerId, 'v2');
  return {
    sql: `
  COALESCE(
    p.cover_media_id,
    (SELECT m.id FROM media m JOIN visit v2 ON v2.id = m.visit_id
      WHERE v2.place_id = p.id AND v2.deleted_at IS NULL AND m.deleted_at IS NULL${mOwner.sql}${v2Owner.sql}
      ORDER BY m.created_at LIMIT 1)
  ) AS cover_id`,
    params: [...mOwner.params, ...v2Owner.params],
  };
}

/** 每个地点的 alive 照片 / 视频数量（2026-11-04，D-117）：My旅迹地点行「照片 N · 视频 M」展示用 */
function mediaCountSubquery(ownerId) {
  const mOwner = ownerCond(ownerId, 'm');
  const mvOwner = ownerCond(ownerId, 'mv');
  const cond = `AND mv.deleted_at IS NULL AND m.deleted_at IS NULL${mOwner.sql}${mvOwner.sql}`;
  return {
    sql: `
  (SELECT COUNT(*) FROM media m JOIN visit mv ON mv.id = m.visit_id
    WHERE mv.place_id = p.id ${cond}
      AND m.kind = 'photo') AS photos,
  (SELECT COUNT(*) FROM media m JOIN visit mv ON mv.id = m.visit_id
    WHERE mv.place_id = p.id ${cond}
      AND m.kind = 'video') AS videos`,
    params: [...mOwner.params, ...mvOwner.params, ...mOwner.params, ...mvOwner.params],
  };
}

// ── 同行人（F-BRW-06）──────────────────────────────────────
// companions 存的是 JSON 字符串数组（可能为 NULL / 空串 / 非法 JSON），
// 统一用「合法 JSON 才 json_each，否则当空数组」的表达式，避免一条脏数据 500。
const companionsJson = (alias) =>
  `CASE WHEN json_valid(${alias}.companions) THEN ${alias}.companions ELSE '[]' END`;

/** 同行人参数归一：支持字符串（逗号分隔）/ 数组；去空去重 */
function normalizeCompanions(input) {
  const list = Array.isArray(input)
    ? input
    : String(input ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const name = String(raw ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 某条 alive 到访的 companions 是否包含「其中任意一个」名字（多选 = OR，取并集） */
const hasAnyCompanion = (alias, names) => {
  const ph = names.map(() => '?').join(',');
  return `EXISTS (SELECT 1 FROM json_each(${companionsJson(alias)}) je
           WHERE je.type = 'text' AND trim(je.value) IN (${ph}))`;
};

/** 位置点列表（带封面、到访数、首末日期）；q 非空时按名称或到访笔记本地搜索
 *  companion 非空（可逗号分隔多选）时：
 *   - 只返回「至少有一条 alive 到访的 companions 包含其中任意一个名字」的去过地点；
 *   - visit_count / first_date / last_date 也只算 companions 包含这些名字的 alive 到访，
 *     与 /api/map/visits?companion 口径一致（前端「共 N 次」不会和地图对不上）；
 *   - 封面保持 alive 口径即可（不按同行人筛，避免同一地点换个同行人就变空封面）。
 *  ownerId 非空（multi）时只返回该账号的地点，所有子查询也只算该账号的数据。 */
export function listPlaces(q = '', companion = '', ownerId = null) {
  const names = normalizeCompanions(companion);
  const params = [];
  const pOwner = ownerCond(ownerId, 'p');
  const vOwner = ownerCond(ownerId, 'v');
  const vcOwner = ownerCond(ownerId, 'vc');
  const v3Owner = ownerCond(ownerId, 'v3');
  const cover = coverSubquery(ownerId);
  const mediaCounts = mediaCountSubquery(ownerId);
  // 占位符按 SQL 文本顺序绑定：
  // SELECT 里 3 个同行人子查询（各自先同行人参数、再 owner）→ COVER / MEDIA_COUNT 子查询
  // → WHERE 的 p owner → q 过滤 → companion 过滤（同行人参数、owner）
  const companionVisitCond = names.length ? `AND ${hasAnyCompanion('v', names)}` : '';
  for (let i = 0; i < 3; i++) {
    if (names.length) params.push(...names);
    params.push(...vOwner.params);
  }
  params.push(...cover.params, ...mediaCounts.params, ...pOwner.params);
  let filter = '';
  if (q) {
    const like = `%${q}%`;
    filter += `AND (
      p.name LIKE ?
      OR EXISTS (SELECT 1 FROM visit v3
                 WHERE v3.place_id = p.id AND v3.deleted_at IS NULL
                   AND (v3.title LIKE ? OR v3.note LIKE ?)${v3Owner.sql})
    )`;
    params.push(like, like, like, ...v3Owner.params);
  }
  if (names.length) {
    filter += `
    AND p.kind = 'visited'
    AND EXISTS (
      SELECT 1 FROM visit vc
      WHERE vc.place_id = p.id AND vc.deleted_at IS NULL AND ${hasAnyCompanion('vc', names)}${vcOwner.sql}
    )`;
    params.push(...names, ...vcOwner.params);
  }
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM visit v
        WHERE v.place_id = p.id AND v.deleted_at IS NULL ${companionVisitCond}${vOwner.sql}) AS visit_count,
      (SELECT MIN(v.date) FROM visit v
        WHERE v.place_id = p.id AND v.deleted_at IS NULL ${companionVisitCond}${vOwner.sql}) AS first_date,
      (SELECT MAX(v.date) FROM visit v
        WHERE v.place_id = p.id AND v.deleted_at IS NULL ${companionVisitCond}${vOwner.sql}) AS last_date,
      ${cover.sql},
      ${mediaCounts.sql}
    FROM place p
    WHERE p.deleted_at IS NULL${pOwner.sql}
    ${filter}
    ORDER BY p.created_at DESC
  `).all(...params);
}

/** 时间轴过滤：只返回在 [from, to] 区间内有到访的地点
 *  companion 非空（可逗号分隔多选）时：区间内的到访、total_* 的总到访都只算
 *  「companions 包含其中任意一个名字」的到访（多选 = OR）。
 *  ownerId 非空（multi）时只算该账号的地点 / 到访。 */
export function placesInRange(from, to, companion = '', ownerId = null) {
  const names = normalizeCompanions(companion);
  const pOwner = ownerCond(ownerId, 'p');
  const vOwner = ownerCond(ownerId, 'v');
  const tvOwner = ownerCond(ownerId, 'tv');
  const cover = coverSubquery(ownerId);
  const mediaCounts = mediaCountSubquery(ownerId);
  // 注意占位符按 SQL 文本顺序绑定：3 个 total_* 子查询（同行人参数、tv owner）
  // → COVER / MEDIA_COUNT 子查询 → JOIN 条件（同行人参数、v owner）→ WHERE 的 p owner → 日期区间
  const params = [];
  let totalCond = '';
  let joinCond = '';
  for (let i = 0; i < 3; i++) {
    if (names.length) params.push(...names);
    params.push(...tvOwner.params);
  }
  if (names.length) totalCond = `AND ${hasAnyCompanion('tv', names)}`;
  params.push(...cover.params, ...mediaCounts.params);
  if (names.length) {
    params.push(...names);
    joinCond = `AND ${hasAnyCompanion('v', names)}`;
  }
  params.push(...vOwner.params, ...pOwner.params, from, to);
  const kindCond = names.length ? "AND p.kind = 'visited'" : '';
  return db.prepare(`
    SELECT p.*,
      COUNT(v.id) AS visit_count,
      MIN(v.date) AS first_date,
      MAX(v.date) AS last_date,
      (SELECT COUNT(*) FROM visit tv
        WHERE tv.place_id = p.id AND tv.deleted_at IS NULL ${totalCond}${tvOwner.sql}) AS total_visit_count,
      (SELECT MIN(tv.date) FROM visit tv
        WHERE tv.place_id = p.id AND tv.deleted_at IS NULL ${totalCond}${tvOwner.sql}) AS total_first_date,
      (SELECT MAX(tv.date) FROM visit tv
        WHERE tv.place_id = p.id AND tv.deleted_at IS NULL ${totalCond}${tvOwner.sql}) AS total_last_date,
      ${cover.sql},
      ${mediaCounts.sql}
    FROM place p
    JOIN visit v ON v.place_id = p.id AND v.deleted_at IS NULL ${joinCond}${vOwner.sql}
    WHERE p.deleted_at IS NULL${pOwner.sql} ${kindCond} AND v.date >= ? AND v.date <= ?
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all(...params);
}

/**
 * 随行人员聚合（F-BRW-06）：只算 alive 的到访 + alive 的去过地点。
 * 用 SQLite JSON1 的 json_each 展开 companions；JSON1 不可用时退回 JS 解析（个人库数据量小）。
 * 同一条到访里重复写同一个名字只算一次；排序 places DESC, visits DESC。
 * ownerId 非空（multi）时只算该账号的到访 / 地点。
 */
export function listCompanions(ownerId = null) {
  const vOwner = ownerCond(ownerId, 'v');
  const pOwner = ownerCond(ownerId, 'p');
  const params = [...vOwner.params, ...pOwner.params];
  try {
    return db
      .prepare(`
        SELECT trim(je.value) AS name,
          COUNT(DISTINCT v.id) AS visits,
          COUNT(DISTINCT v.place_id) AS places,
          MIN(v.date) AS first_date,
          MAX(v.date) AS last_date
        FROM visit v
        JOIN place p ON p.id = v.place_id AND p.deleted_at IS NULL AND p.kind = 'visited'
        JOIN json_each(${companionsJson('v')}) je
        WHERE v.deleted_at IS NULL AND je.type = 'text' AND trim(je.value) <> ''${vOwner.sql}${pOwner.sql}
        GROUP BY trim(je.value)
        ORDER BY places DESC, visits DESC, name ASC
      `)
      .all(...params);
  } catch (e) {
    console.warn('[db] json_each 不可用，随行人员退回 JS 解析：', e.message);
    const rows = db
      .prepare(`
        SELECT v.id, v.place_id, v.date, v.companions
        FROM visit v
        JOIN place p ON p.id = v.place_id AND p.deleted_at IS NULL AND p.kind = 'visited'
        WHERE v.deleted_at IS NULL${vOwner.sql}${pOwner.sql}
      `)
      .all(...params);
    const agg = new Map();
    for (const r of rows) {
      let names = [];
      try {
        const parsed = JSON.parse(r.companions || '[]');
        if (Array.isArray(parsed)) names = parsed.map((s) => String(s).trim()).filter(Boolean);
      } catch {
        names = [];
      }
      for (const name of new Set(names)) {
        let a = agg.get(name);
        if (!a) {
          a = { name, visits: 0, places: new Set(), first_date: null, last_date: null };
          agg.set(name, a);
        }
        a.visits += 1;
        a.places.add(r.place_id);
        if (!a.first_date || r.date < a.first_date) a.first_date = r.date;
        if (!a.last_date || r.date > a.last_date) a.last_date = r.date;
      }
    }
    return [...agg.values()]
      .map((a) => ({
        name: a.name,
        visits: a.visits,
        places: a.places.size,
        first_date: a.first_date,
        last_date: a.last_date,
      }))
      .sort(
        (a, b) =>
          b.places - a.places ||
          b.visits - a.visits ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      );
  }
}

/** 时间轴刻度：首末日期 + 按季度统计到访数 + 去重后的到访日期（播放跳空白用）
 *  ownerId 非空（multi）时只算该账号的到访。 */
export function timeline(ownerId = null) {
  const vOwner = ownerCond(ownerId, 'v');
  const all = db.prepare(
    `SELECT v.date FROM visit v WHERE v.deleted_at IS NULL${vOwner.sql} ORDER BY v.date`
  ).all(...vOwner.params);
  if (!all.length) return { first: null, last: null, buckets: [], dates: [] };
  const counts = new Map();
  for (const v of all) {
    const d = String(v.date);
    const y = d.slice(0, 4);
    const m = Number(d.slice(5, 7));
    if (!y || !m) continue;
    const q = `${y}-Q${Math.min(4, Math.max(1, Math.ceil(m / 3)))}`;
    counts.set(q, (counts.get(q) || 0) + 1);
  }
  return {
    first: all[0].date,
    last: all[all.length - 1].date,
    buckets: [...counts.entries()].map(([q, n]) => ({ q, n })),
    dates: [...new Set(all.map((v) => String(v.date)))],
  };
}

/** 地点详情；ownerId 非空时只返回该账号的地点（别人的 id 一律当不存在 → null） */
export function getPlace(id, ownerId = null) {
  const pOwner = ownerCond(ownerId, 'p');
  const vOwner = ownerCond(ownerId, 'v');
  const mOwner = ownerCond(ownerId, 'm');
  const cover = coverSubquery(ownerId);
  const place = db.prepare(`
    SELECT p.*, ${cover.sql}
    FROM place p
    WHERE p.id = ? AND p.deleted_at IS NULL${pOwner.sql}
  `).get(...cover.params, id, ...pOwner.params);
  if (!place) return null;
  const visits = db.prepare(
    `SELECT v.* FROM visit v
     WHERE v.place_id = ? AND v.deleted_at IS NULL${vOwner.sql}
     ORDER BY v.date DESC`
  ).all(id, ...vOwner.params);
  for (const v of visits) {
    v.companions = parseCompanions(v);
    v.media = db.prepare(
      `SELECT m.id, m.kind, m.width, m.height, m.duration, m.created_at
       FROM media m WHERE m.visit_id = ? AND m.deleted_at IS NULL${mOwner.sql}
       ORDER BY m.created_at`
    ).all(v.id, ...mOwner.params);
  }
  return { ...place, visits };
}

/** 媒体缓存文件占用（缩略图 / 1600 预览 / 视频封面帧）；读不到按 0 算。
 *  multi 模式的缓存在 data/thumbs/<ownerId>/ 下（D-202），local 仍在 thumbs 根目录。 */
function cacheBytes(m, ownerId = null) {
  const dir = ownerId ? join(CONFIG.thumbDir, String(ownerId)) : CONFIG.thumbDir;
  let total = 0;
  for (const f of [m.thumb, m.poster, `${m.id}_p.webp`]) {
    if (!f) continue;
    try {
      total += statSync(join(dir, f)).size;
    } catch {
      /* 缓存不在就算了 */
    }
  }
  return total;
}

/**
 * 回收站里的全部媒体：媒体自己软删、或它的到访/地点被软删都算。
 * 数量小（个人库），缓存大小现场 stat，保证「占用空间」和磁盘实际一致。
 * ownerId 非空（multi）时只回收该账号的媒体 / 到访 / 地点。
 */
function trashMediaRows(ownerId = null) {
  const mOwner = ownerCond(ownerId, 'm');
  const vOwner = ownerCond(ownerId, 'v');
  const pOwner = ownerCond(ownerId, 'p');
  const rows = db.prepare(`
    SELECT m.id, m.visit_id, m.kind, m.rel_path, m.bytes, m.thumb, m.poster, m.deleted_at,
      v.date AS visit_date, v.deleted_at AS visit_deleted_at,
      p.id AS place_id, p.name AS place_name, p.province, p.city, p.county,
      p.deleted_at AS place_deleted_at
    FROM media m
    JOIN visit v ON v.id = m.visit_id
    JOIN place p ON p.id = v.place_id
    WHERE (m.deleted_at IS NOT NULL OR v.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL)${mOwner.sql}${vOwner.sql}${pOwner.sql}
  `).all(...mOwner.params, ...vOwner.params, ...pOwner.params);
  for (const m of rows) {
    m.name = String(m.rel_path || '').split(/[\\/]/).pop() || '';
    m.bytes = Number(m.bytes) || 0;
    m.cache_bytes = cacheBytes(m, ownerId);
    m.size = m.bytes + m.cache_bytes;
  }
  return rows;
}

/**
 * 回收站列表（F-SYS-07 / D-57「按删除动作分层」）：地点 / 到访 / 媒体。
 *
 * 规则：
 * - 父级删除只带走「当时还活着」的子项；此前单独删除的子项保留在各自层级。
 * - 父级行的 media_count/bytes/size 只算「随本次删除」的媒体；
 *   另有 earlier_* 字段描述此前单独删除、默认不随父级恢复的部分。
 * - 媒体行永远留在媒体层；父级已在回收站时 `parent_*_deleted=true`，恢复需先恢复父级。
 *
 * ownerId 非空（multi）时只返回该账号的回收站内容。
 */
export function listTrash(ownerId = null) {
  const mediaRows = trashMediaRows(ownerId);
  const pOwner = ownerCond(ownerId, 'p');
  const vOwner = ownerCond(ownerId, 'v');
  const blank = () => ({ media_count: 0, bytes: 0, cache_bytes: 0, size: 0 });
  const add = (map, key, m) => {
    let a = map.get(key);
    if (!a) {
      a = blank();
      map.set(key, a);
    }
    a.media_count += 1;
    a.bytes += m.bytes;
    a.cache_bytes += m.cache_bytes;
    a.size += m.size;
  };

  const placeSame = new Map();
  const visitSame = new Map();
  const visitEarlier = new Map();
  const placeEarlier = new Map();
  const mediaItems = [];

  for (const m of mediaRows) {
    const mDel = m.deleted_at;
    const vDel = m.visit_deleted_at;
    const pDel = m.place_deleted_at;
    const visitSameAction = vDel !== null && (mDel === null || mDel === vDel);
    const placeSameAction = pDel !== null && (mDel === null || mDel === pDel);

    if (visitSameAction) {
      // 到访和地点同一次删除时，到访行不单列，媒体归到地点行
      if (pDel !== null && vDel === pDel) add(placeSame, m.place_id, m);
      else add(visitSame, m.visit_id, m);
    } else if (placeSameAction) {
      add(placeSame, m.place_id, m);
    } else if (mDel !== null) {
      // 单独删除的媒体：永远留在媒体层
      mediaItems.push({
        type: 'media',
        id: m.id,
        visit_id: m.visit_id,
        place_id: m.place_id,
        place_name: m.place_name,
        date: m.visit_date,
        kind: m.kind,
        name: m.name,
        bytes: m.bytes,
        cache_bytes: m.cache_bytes,
        size: m.size,
        deleted_at: m.deleted_at,
        parent_visit_deleted: vDel !== null,
        parent_place_deleted: pDel !== null,
      });
    } else if (vDel !== null) {
      // 旧数据：媒体没写 deleted_at，但父级已删，按随父级处理
      add(visitSame, m.visit_id, m);
    } else if (pDel !== null) {
      add(placeSame, m.place_id, m);
    }

    // 比父级删除更早的媒体：默认不随父级恢复，算「此前单独删除」
    if (vDel !== null && mDel !== null && mDel !== vDel) add(visitEarlier, m.visit_id, m);
    if (pDel !== null && mDel !== null && mDel !== pDel) add(placeEarlier, m.place_id, m);
  }

  const places = db.prepare(`
    SELECT p.id, p.name, p.kind, p.province, p.city, p.county, p.deleted_at,
      (SELECT COUNT(*) FROM visit v
        WHERE v.place_id = p.id AND v.deleted_at = p.deleted_at${vOwner.sql}) AS visit_count,
      (SELECT COUNT(*) FROM visit v
        WHERE v.place_id = p.id AND v.deleted_at IS NOT NULL
          AND v.deleted_at != p.deleted_at${vOwner.sql}) AS earlier_visit_count
    FROM place p
    WHERE p.deleted_at IS NOT NULL${pOwner.sql}
    ORDER BY p.deleted_at DESC
  `).all(...vOwner.params, ...vOwner.params, ...pOwner.params).map((p) => {
    const same = placeSame.get(p.id) || blank();
    const earlier = placeEarlier.get(p.id) || blank();
    return {
      type: 'place',
      ...p,
      media_count: same.media_count,
      bytes: same.bytes,
      cache_bytes: same.cache_bytes,
      size: same.size,
      earlier_media_count: earlier.media_count,
      earlier_bytes: earlier.bytes,
      earlier_cache_bytes: earlier.cache_bytes,
      earlier_size: earlier.size,
    };
  });

  const visits = db.prepare(`
    SELECT v.id, v.place_id, v.date, v.title, v.deleted_at,
      p.name AS place_name, p.province, p.city, p.county,
      p.deleted_at AS place_deleted_at
    FROM visit v JOIN place p ON p.id = v.place_id
    WHERE v.deleted_at IS NOT NULL
      AND (p.deleted_at IS NULL OR v.deleted_at != p.deleted_at)${vOwner.sql}${pOwner.sql}
    ORDER BY v.deleted_at DESC
  `).all(...vOwner.params, ...pOwner.params).map((v) => {
    const same = visitSame.get(v.id) || blank();
    const earlier = visitEarlier.get(v.id) || blank();
    return {
      type: 'visit',
      ...v,
      media_count: same.media_count,
      bytes: same.bytes,
      cache_bytes: same.cache_bytes,
      size: same.size,
      earlier_media_count: earlier.media_count,
      earlier_bytes: earlier.bytes,
      earlier_cache_bytes: earlier.cache_bytes,
      earlier_size: earlier.size,
    };
  });

  const items = [...places, ...visits, ...mediaItems].sort((a, b) => {
    if (b.deleted_at !== a.deleted_at) return b.deleted_at - a.deleted_at;
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.id.localeCompare(b.id);
  });

  const totals = mediaRows.reduce(
    (acc, m) => {
      acc.bytes += m.bytes;
      acc.cacheBytes += m.cache_bytes;
      acc.size += m.size;
      return acc;
    },
    { bytes: 0, cacheBytes: 0, size: 0 }
  );

  return {
    items,
    total: items.length,
    placeCount: places.length,
    visitCount: visits.length,
    mediaCount: mediaItems.length,
    mediaTotal: mediaRows.length,
    bytes: totals.bytes,
    cacheBytes: totals.cacheBytes,
    size: totals.size,
  };
}

/** 顶栏角标用：数量口径与 listTrash 一致（随父级删除的子项不重复计数）；ownerId 非空只算该账号 */
export function trashCount(ownerId = null) {
  const pOwner = ownerCond(ownerId, 'p');
  const vOwner = ownerCond(ownerId, 'v');
  const mOwner = ownerCond(ownerId, 'm');
  const places = db.prepare(
    `SELECT COUNT(*) AS n FROM place p WHERE p.deleted_at IS NOT NULL${pOwner.sql}`
  ).get(...pOwner.params).n;
  const visits = db.prepare(`
    SELECT COUNT(*) AS n FROM visit v JOIN place p ON p.id = v.place_id
    WHERE v.deleted_at IS NOT NULL
      AND (p.deleted_at IS NULL OR v.deleted_at != p.deleted_at)${vOwner.sql}${pOwner.sql}
  `).get(...vOwner.params, ...pOwner.params).n;
  const media = db.prepare(`
    SELECT COUNT(*) AS n FROM media m
    JOIN visit v ON v.id = m.visit_id
    JOIN place p ON p.id = v.place_id
    WHERE m.deleted_at IS NOT NULL
      AND (v.deleted_at IS NULL OR m.deleted_at != v.deleted_at)
      AND (p.deleted_at IS NULL OR m.deleted_at != p.deleted_at)${mOwner.sql}${vOwner.sql}${pOwner.sql}
  `).get(...mOwner.params, ...vOwner.params, ...pOwner.params).n;
  return { total: places + visits + media, places, visits, media };
}

/** 首页 / health 用的粗口径计数；ownerId 非空（multi）只统计该账号的数据 */
export function stats(ownerId = null) {
  const pOwner = ownerCond(ownerId, 'p');
  const vOwner = ownerCond(ownerId, 'v');
  const mOwner = ownerCond(ownerId, 'm');
  const one = (sql, params = []) => db.prepare(sql).get(...params);
  return {
    places: one(`SELECT COUNT(*) AS n FROM place p WHERE p.deleted_at IS NULL${pOwner.sql}`, pOwner.params).n,
    visits: one(`SELECT COUNT(*) AS n FROM visit v WHERE v.deleted_at IS NULL${vOwner.sql}`, vOwner.params).n,
    photos: one(`SELECT COUNT(*) AS n FROM media m WHERE m.kind='photo' AND m.deleted_at IS NULL${mOwner.sql}`, mOwner.params).n,
    videos: one(`SELECT COUNT(*) AS n FROM media m WHERE m.kind='video' AND m.deleted_at IS NULL${mOwner.sql}`, mOwner.params).n,
    provinces: one(`SELECT COUNT(DISTINCT p.province_code) AS n FROM place p WHERE p.deleted_at IS NULL AND p.province_code IS NOT NULL${pOwner.sql}`, pOwner.params).n,
  };
}
