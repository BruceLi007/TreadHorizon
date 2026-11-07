/**
 * F-BRW-04 照片墙：GET /api/photos
 *
 * 只返回 alive 媒体 + alive 到访 + alive 地点（软删的媒体/到访/地点都不出现）。
 * 排序：visit.date DESC, media.created_at DESC（再加 id 保证分页稳定）。
 * 前端契约见 src/lib/types.ts 的 PhotoWallData / PhotoWallItem。
 */
import { db } from './db.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['photo', 'video']);

const asText = (v) => (v == null ? '' : String(v).trim());

/** 校验 /api/photos 查询参数；返回 { value } 或 { error } */
export function parsePhotosQuery(q = {}) {
  const value = {
    from: null,
    to: null,
    province: null,
    city: null,
    place_id: null,
    kind: null,
    limit: 60,
    offset: 0,
  };

  const from = asText(q.from);
  const to = asText(q.to);
  if (from) {
    if (!DATE_RE.test(from)) return { error: 'from 日期格式不正确，应为 YYYY-MM-DD' };
    value.from = from;
  }
  if (to) {
    if (!DATE_RE.test(to)) return { error: 'to 日期格式不正确，应为 YYYY-MM-DD' };
    value.to = to;
  }
  if (value.from && value.to && value.from > value.to) {
    return { error: 'from 不能晚于 to' };
  }

  value.province = asText(q.province) || null;
  value.city = asText(q.city) || null;
  value.place_id = asText(q.place_id) || null;

  const kind = asText(q.kind);
  if (kind) {
    if (!KINDS.has(kind)) return { error: 'kind 只能是 photo / video' };
    value.kind = kind;
  }

  if (q.limit !== undefined && q.limit !== null && asText(q.limit) !== '') {
    const limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return { error: 'limit 必须是 1~200 的整数' };
    }
    value.limit = limit;
  }
  if (q.offset !== undefined && q.offset !== null && asText(q.offset) !== '') {
    const offset = Number(q.offset);
    if (!Number.isInteger(offset) || offset < 0) {
      return { error: 'offset 必须是不小于 0 的整数' };
    }
    value.offset = offset;
  }

  return { value };
}

/** 构造 WHERE 与参数（媒体 / 到访 / 地点三层都要 alive）
 *  ownerId 非空（multi）时三层都加 user_id 过滤；为空（local）不加，保持旧行为。 */
function buildWhere(parsed, ownerId = null) {
  const where = ['m.deleted_at IS NULL', 'v.deleted_at IS NULL', 'p.deleted_at IS NULL'];
  const params = [];
  if (parsed.from) {
    where.push('v.date >= ?');
    params.push(parsed.from);
  }
  if (parsed.to) {
    where.push('v.date <= ?');
    params.push(parsed.to);
  }
  if (parsed.province) {
    where.push('p.province = ?');
    params.push(parsed.province);
  }
  if (parsed.city) {
    where.push('p.city = ?');
    params.push(parsed.city);
  }
  if (parsed.place_id) {
    where.push('p.id = ?');
    params.push(parsed.place_id);
  }
  if (parsed.kind) {
    where.push('m.kind = ?');
    params.push(parsed.kind);
  }
  if (ownerId) {
    where.push('m.user_id = ?', 'v.user_id = ?', 'p.user_id = ?');
    params.push(ownerId, ownerId, ownerId);
  }
  return { sql: where.join(' AND '), params };
}

export function buildPhotos(parsed, ownerId = null) {
  const { sql, params } = buildWhere(parsed, ownerId);

  const total = Number(
    db
      .prepare(`
        SELECT COUNT(*) AS n
        FROM media m
        JOIN visit v ON v.id = m.visit_id
        JOIN place p ON p.id = v.place_id
        WHERE ${sql}
      `)
      .get(...params).n
  ) || 0;

  const years = db
    .prepare(`
      SELECT substr(v.date, 1, 4) AS year, COUNT(*) AS count
      FROM media m
      JOIN visit v ON v.id = m.visit_id
      JOIN place p ON p.id = v.place_id
      WHERE ${sql}
      GROUP BY year
      ORDER BY year DESC
    `)
    .all(...params)
    .map((r) => ({ year: String(r.year), count: Number(r.count) }));

  const rows = db
    .prepare(`
      SELECT m.id, m.kind, m.width, m.height, m.duration, m.bytes, m.created_at,
             v.id AS visit_id, v.date, v.title AS visit_title,
             p.id AS place_id, p.name AS place_name,
             p.province, p.city, p.county, p.secret
      FROM media m
      JOIN visit v ON v.id = m.visit_id
      JOIN place p ON p.id = v.place_id
      WHERE ${sql}
      ORDER BY v.date DESC, m.created_at DESC, m.id DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, parsed.limit, parsed.offset);

  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    width: r.width ?? null,
    height: r.height ?? null,
    duration: r.duration ?? null,
    bytes: r.bytes ?? null,
    created_at: r.created_at,
    date: r.date,
    visit_id: r.visit_id,
    visit_title: r.visit_title ?? null,
    place: {
      id: r.place_id,
      name: r.place_name,
      province: r.province ?? null,
      city: r.city ?? null,
      county: r.county ?? null,
    },
    secret: Number(r.secret) || 0,
  }));

  return { total, items, years };
}
