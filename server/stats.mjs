/**
 * F-STA 统计（D-60）：/api/stats 与 /api/stats/provinces
 *
 * 口径（全线只算 alive 数据）：
 * - 地点：place.deleted_at IS NULL AND kind='visited'
 * - 到访：visit.deleted_at IS NULL
 * - 媒体：media.deleted_at IS NULL（父级到访/地点由 JOIN 保证 alive）
 *
 * 统计全部在 JS 里聚合：个人库数据量小（几千条到访），比堆 SQL 更好读、好维护。
 * 前端接口契约见 src/lib/types.ts 的 StatsData / StatsTimePoint / StatsSeries / ProvinceLightData。
 */
import { db } from './db.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BUCKETS = new Set(['year', 'quarter', 'month']);
const SERIES_BY = new Set(['province', 'city']);
const UNKNOWN = '未标注';

const asText = (v) => (v == null ? '' : String(v).trim());

/**
 * owner（账号）过滤条件（2026-11-06 M6 P2-2，D-202）。
 * - ownerId 为空（local 单机模式）：什么都不加，SQL / 参数与改造前一致；
 * - ownerId 非空（multi）：追加 `<alias>.user_id = ?`。
 * 直接往 where / params 两个数组里推，保证参数顺序与 SQL 文本顺序一致。
 */
function pushOwner(where, params, ownerId, alias) {
  if (!ownerId) return;
  where.push(`${alias}.user_id = ?`);
  params.push(ownerId);
}

/** 校验 /api/stats 查询参数；返回 { value } 或 { error } */
export function parseStatsQuery(q = {}) {
  const value = {
    from: null,
    to: null,
    province: null,
    city: null,
    bucket: 'year',
    seriesBy: null,
    limit: 10,
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

  const bucket = asText(q.bucket);
  if (bucket) {
    if (!BUCKETS.has(bucket)) return { error: 'bucket 只能是 year / quarter / month' };
    value.bucket = bucket;
  }

  const seriesBy = asText(q.seriesBy);
  if (seriesBy) {
    if (!SERIES_BY.has(seriesBy)) return { error: 'seriesBy 只能是 province / city' };
    value.seriesBy = seriesBy;
  }

  if (q.limit !== undefined && q.limit !== null && asText(q.limit) !== '') {
    const limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return { error: 'limit 必须是 1~100 的整数' };
    }
    value.limit = limit;
  }

  return { value };
}

// ── 时间桶 ─────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');

/** 日期 → 桶下标 + 展示文案 */
function bucketOf(date, mode) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (mode === 'year') return { index: y, key: String(y), label: String(y) };
  if (mode === 'quarter') {
    const q = Math.min(4, Math.max(1, Math.ceil(m / 3)));
    return { index: y * 4 + (q - 1), key: `${y}-Q${q}`, label: `${y}.Q${q}` };
  }
  return { index: y * 12 + (m - 1), key: `${y}-${pad2(m)}`, label: `${y}.${pad2(m)}` };
}

/** 桶下标 → 桶 key / label（补齐空桶用） */
function bucketFromIndex(mode, index) {
  if (mode === 'year') return { index, key: String(index), label: String(index) };
  if (mode === 'quarter') {
    const y = Math.floor(index / 4);
    const q = (index % 4) + 1;
    return { index, key: `${y}-Q${q}`, label: `${y}.Q${q}` };
  }
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return { index, key: `${y}-${pad2(m)}`, label: `${y}.${pad2(m)}` };
}

// ── 数据加载 ───────────────────────────────────────────────

/** 按筛选条件取 alive 到访（带地点字段），按 date / created_at / id 升序；ownerId 非空只取该账号 */
function loadVisits(parsed, ownerId = null) {
  const where = ['p.deleted_at IS NULL', "p.kind = 'visited'", 'v.deleted_at IS NULL'];
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
  pushOwner(where, params, ownerId, 'v');
  pushOwner(where, params, ownerId, 'p');
  return db
    .prepare(`
      SELECT v.id AS visit_id, v.date, v.created_at AS visit_created_at,
             p.id AS place_id, p.name AS place_name, p.province, p.province_code,
             p.city, p.lng, p.lat, p.secret
      FROM visit v
      JOIN place p ON p.id = v.place_id
      WHERE ${where.join(' AND ')}
      ORDER BY v.date ASC, v.created_at ASC, v.id ASC
    `)
    .all(...params);
}

/** 同一筛选下的 alive 媒体数：visit_id → { photos, videos }；ownerId 非空只取该账号 */
function loadMediaCounts(parsed, ownerId = null) {
  const where = [
    'm.deleted_at IS NULL',
    'v.deleted_at IS NULL',
    'p.deleted_at IS NULL',
    "p.kind = 'visited'",
  ];
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
  pushOwner(where, params, ownerId, 'm');
  pushOwner(where, params, ownerId, 'v');
  pushOwner(where, params, ownerId, 'p');
  const rows = db
    .prepare(`
      SELECT m.visit_id AS visit_id, m.kind AS kind, COUNT(*) AS n
      FROM media m
      JOIN visit v ON v.id = m.visit_id
      JOIN place p ON p.id = v.place_id
      WHERE ${where.join(' AND ')}
      GROUP BY m.visit_id, m.kind
    `)
    .all(...params);
  const map = new Map();
  for (const r of rows) {
    const item = map.get(r.visit_id) || { photos: 0, videos: 0 };
    if (r.kind === 'photo') item.photos += Number(r.n) || 0;
    else if (r.kind === 'video') item.videos += Number(r.n) || 0;
    map.set(r.visit_id, item);
  }
  return map;
}

// ── 聚合小工具 ─────────────────────────────────────────────

const provName = (v) => v.province || v.province_code || UNKNOWN;
const cityName = (v) => v.city || UNKNOWN;
const cityKey = (v) => `${provName(v)}\u0000${cityName(v)}`;

const byCountThenName = (a, b) =>
  b.places - a.places ||
  b.visits - a.visits ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** 两点直线距离（km，Haversine；用来算「离家最远」） */
export function haversineKm(lng1, lat1, lng2, lat2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371.0088;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 家（place.home=1，唯一）的坐标；未设置时返回 null。ownerId 非空只认该账号的家 */
function homePoint(ownerId = null) {
  const row = db
    .prepare(
      `SELECT p.id, p.name, p.lng, p.lat FROM place p
       WHERE p.deleted_at IS NULL AND p.home = 1${ownerId ? ' AND p.user_id = ?' : ''} LIMIT 1`
    )
    .get(...(ownerId ? [ownerId] : []));
  if (!row) return null;
  const lng = Number(row.lng);
  const lat = Number(row.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { id: row.id, name: row.name, lng, lat };
}

function firstLast(visit) {
  if (!visit) return null;
  return {
    date: visit.date,
    place_id: visit.place_id,
    place_name: visit.place_name,
    province: visit.province ?? null,
    city: visit.city ?? null,
    lng: visit.lng,
    lat: visit.lat,
  };
}

// ── 统计主体 ───────────────────────────────────────────────

export function buildStats(parsed, ownerId = null) {
  const visits = loadVisits(parsed, ownerId);
  const media = loadMediaCounts(parsed, ownerId);

  const mediaOf = (v) => media.get(v.visit_id) || { photos: 0, videos: 0 };

  // totals
  const provSet = new Set();
  const citySet = new Set();
  const placeSet = new Set();
  let photos = 0;
  let videos = 0;
  for (const v of visits) {
    provSet.add(provName(v));
    citySet.add(cityKey(v));
    placeSet.add(v.place_id);
    const m = mediaOf(v);
    photos += m.photos;
    videos += m.videos;
  }

  // 地点排行（同时用于 places 数组）
  const placeAgg = new Map();
  for (const v of visits) {
    let row = placeAgg.get(v.place_id);
    if (!row) {
      row = {
        id: v.place_id,
        name: v.place_name,
        province: v.province ?? null,
        city: v.city ?? null,
        secret: Number(v.secret) || 0,
        lng: Number(v.lng),
        lat: Number(v.lat),
        visits: 0,
        photos: 0,
        videos: 0,
        first_date: null,
        last_date: null,
      };
      placeAgg.set(v.place_id, row);
    }
    const m = mediaOf(v);
    row.visits += 1;
    row.photos += m.photos;
    row.videos += m.videos;
    if (!row.first_date || v.date < row.first_date) row.first_date = v.date;
    if (!row.last_date || v.date > row.last_date) row.last_date = v.date;
  }

  // 离家距离（2026-11-06 用户需求）：按当前筛选范围内的地点，算到「家」的直线距离。
  // 一次算出全部地点的距离，同时给「离家最远」摘要和「离家距离」排行视图用（服务端现算，不写库）。
  // 2026-11-06 追加「统计里加一项：按照离家距离排序」——distance_places 按距离从远到近。
  const home = homePoint(ownerId);
  const distanceRows = [];
  if (home) {
    for (const row of placeAgg.values()) {
      // 「家」本身不算进离家距离排行（它到自己的距离是 0，没有意义）
      if (row.id === home.id) continue;
      if (!Number.isFinite(row.lng) || !Number.isFinite(row.lat)) continue;
      distanceRows.push({
        ...row,
        distance_km: Math.round(haversineKm(home.lng, home.lat, row.lng, row.lat) * 10) / 10,
      });
    }
    distanceRows.sort(
      (a, b) =>
        b.distance_km - a.distance_km || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
  }
  const farthestRow = distanceRows[0] ?? null;
  const farthest = farthestRow
    ? {
        distance_km: farthestRow.distance_km,
        place_id: farthestRow.id,
        name: farthestRow.name,
        province: farthestRow.province,
        city: farthestRow.city,
        lng: farthestRow.lng,
        lat: farthestRow.lat,
      }
    : null;

  // 省 / 市排行
  const provAgg = new Map();
  const cityAgg = new Map();
  for (const v of visits) {
    const m = mediaOf(v);
    const pn = provName(v);
    let p = provAgg.get(pn);
    if (!p) {
      p = {
        name: pn,
        code: null,
        places: new Set(),
        visits: 0,
        photos: 0,
        videos: 0,
        first_date: null,
        last_date: null,
      };
      provAgg.set(pn, p);
    }
    if (!p.code && v.province_code) p.code = v.province_code;
    p.places.add(v.place_id);
    p.visits += 1;
    p.photos += m.photos;
    p.videos += m.videos;
    if (!p.first_date || v.date < p.first_date) p.first_date = v.date;
    if (!p.last_date || v.date > p.last_date) p.last_date = v.date;

    const ck = cityKey(v);
    let c = cityAgg.get(ck);
    if (!c) {
      c = {
        name: cityName(v),
        province: v.province ?? null,
        places: new Set(),
        visits: 0,
        photos: 0,
        videos: 0,
        first_date: null,
        last_date: null,
      };
      cityAgg.set(ck, c);
    }
    c.places.add(v.place_id);
    c.visits += 1;
    c.photos += m.photos;
    c.videos += m.videos;
    if (!c.first_date || v.date < c.first_date) c.first_date = v.date;
    if (!c.last_date || v.date > c.last_date) c.last_date = v.date;
  }

  const provinces = [...provAgg.values()]
    .map((p) => ({
      name: p.name,
      code: p.code,
      places: p.places.size,
      visits: p.visits,
      photos: p.photos,
      videos: p.videos,
      first_date: p.first_date,
      last_date: p.last_date,
    }))
    .sort(byCountThenName)
    .slice(0, parsed.limit);

  const cities = [...cityAgg.values()]
    .map((c) => ({
      name: c.name,
      province: c.province,
      places: c.places.size,
      visits: c.visits,
      photos: c.photos,
      videos: c.videos,
      first_date: c.first_date,
      last_date: c.last_date,
    }))
    .sort(byCountThenName)
    .slice(0, parsed.limit);

  const places = [...placeAgg.values()]
    .sort(
      (a, b) =>
        b.visits - a.visits ||
        String(b.last_date || '').localeCompare(String(a.last_date || '')) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    )
    .slice(0, parsed.limit)
    // lng/lat 只用于内部算「离家最远」，不改变 /api/stats places 的既有字段契约
    .map(({ lng, lat, ...rest }) => rest);

  // 离家距离排行（2026-11-06 追加：统计里加一项「按照离家距离排序」）
  // 与 farthest 同口径：当前筛选内、有坐标的 alive 地点（排除「家」本身），从远到近；
  // limit 与其它排行一致（前端传 100），distance_total 给前端显示「显示前 N / 共 M 个」。
  const distancePlaces = distanceRows
    .slice(0, parsed.limit)
    .map(({ lng, lat, ...rest }) => rest);

  // 每地点首访（筛选后的首条到访，tie 用 date/created_at/id 升序保证唯一）
  const firstVisitByPlace = new Map();
  for (const v of visits) {
    if (!firstVisitByPlace.has(v.place_id)) firstVisitByPlace.set(v.place_id, v.visit_id);
  }

  // 时间趋势：先聚合，再补齐首末之间的空桶
  const mode = parsed.bucket;
  const timeAgg = new Map();
  for (const v of visits) {
    const b = bucketOf(v.date, mode);
    let a = timeAgg.get(b.index);
    if (!a) {
      a = { visits: 0, places: new Set(), first_visits: 0, photos: 0, videos: 0 };
      timeAgg.set(b.index, a);
    }
    const m = mediaOf(v);
    a.visits += 1;
    a.places.add(v.place_id);
    if (firstVisitByPlace.get(v.place_id) === v.visit_id) a.first_visits += 1;
    a.photos += m.photos;
    a.videos += m.videos;
  }
  let time = [];
  if (timeAgg.size) {
    const indexes = [...timeAgg.keys()];
    const min = Math.min(...indexes);
    const max = Math.max(...indexes);
    for (let i = min; i <= max; i++) {
      const b = bucketFromIndex(mode, i);
      const a = timeAgg.get(i) || null;
      time.push({
        bucket: b.key,
        label: b.label,
        visits: a ? a.visits : 0,
        places: a ? a.places.size : 0,
        first_visits: a ? a.first_visits : 0,
        photos: a ? a.photos : 0,
        videos: a ? a.videos : 0,
      });
    }
  }

  // 分组序列：Top 6 + 其他（按总数 visits 排序）
  let series = [];
  if (parsed.seriesBy) {
    const groupOf = parsed.seriesBy === 'province' ? provName : cityName;
    const groups = new Map();
    for (const v of visits) {
      const name = groupOf(v);
      let g = groups.get(name);
      if (!g) {
        g = { visitsByBucket: new Map(), placesByBucket: new Map(), totalVisits: 0 };
        groups.set(name, g);
      }
      const idx = bucketOf(v.date, mode).index;
      g.visitsByBucket.set(idx, (g.visitsByBucket.get(idx) || 0) + 1);
      let ps = g.placesByBucket.get(idx);
      if (!ps) {
        ps = new Set();
        g.placesByBucket.set(idx, ps);
      }
      ps.add(v.place_id);
      g.totalVisits += 1;
    }
    const ranked = [...groups.entries()].sort(
      (a, b) => b[1].totalVisits - a[1].totalVisits || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    );
    const top = ranked.slice(0, 6);
    const rest = ranked.slice(6);
    // 与 time 用同一套桶（含被补齐的空桶），前端画多条折线时 x 轴对齐
    const keys = time.map((t) => t.bucket);
    const idxs = keys.map((key) => bucketIndexFromKey(mode, key));
    const pointsOf = (g) =>
      idxs.map((idx, i) => ({
        bucket: keys[i],
        visits: g.visitsByBucket.get(idx) || 0,
        places: (g.placesByBucket.get(idx) || { size: 0 }).size,
      }));
    series = top.map(([name, g]) => ({ name, points: pointsOf(g) }));
    if (rest.length) {
      const agg = { visitsByBucket: new Map(), placesByBucket: new Map() };
      for (const [, g] of rest) {
        for (const [idx, n] of g.visitsByBucket) {
          agg.visitsByBucket.set(idx, (agg.visitsByBucket.get(idx) || 0) + n);
        }
        for (const [idx, ps] of g.placesByBucket) {
          let s = agg.placesByBucket.get(idx);
          if (!s) {
            s = new Set();
            agg.placesByBucket.set(idx, s);
          }
          for (const pid of ps) s.add(pid);
        }
      }
      series.push({ name: '其他', points: pointsOf(agg) });
    }
  }

  return {
    range: {
      from: parsed.from,
      to: parsed.to,
      province: parsed.province,
      city: parsed.city,
    },
    totals: {
      provinces: provSet.size,
      cities: citySet.size,
      places: placeSet.size,
      visits: visits.length,
      photos,
      videos,
    },
    first: firstLast(visits[0]),
    last: firstLast(visits[visits.length - 1]),
    // 家：给前端「离家距离」视图显示「以家（名称）为原点」；未设置家时为 null
    home: home ? { id: home.id, name: home.name } : null,
    farthest,
    distance_places: distancePlaces,
    distance_total: distanceRows.length,
    time,
    series,
    provinces,
    cities,
    places,
  };
}

/** time 里的 bucket key → 桶下标（series 用） */
function bucketIndexFromKey(mode, key) {
  const y = Number(key.slice(0, 4));
  if (mode === 'year') return y;
  if (mode === 'quarter') {
    const q = Number(key.slice(6, 7));
    return y * 4 + (q - 1);
  }
  const m = Number(key.slice(5, 7));
  return y * 12 + (m - 1);
}

// ── 省份点亮（F-STA-01，全量口径）─────────────────────────

/** ownerId 非空（multi）时只点亮该账号去过的省份 */
export function provinceLight(ownerId = null) {
  const vOwner = ownerId ? ' AND v.user_id = ?' : '';
  const pOwner = ownerId ? ' AND p.user_id = ?' : '';
  const params = ownerId ? [ownerId, ownerId, ownerId, ownerId] : [];
  const rows = db
    .prepare(`
      SELECT p.id, p.province, p.province_code,
        (SELECT COUNT(*) FROM visit v
          WHERE v.place_id = p.id AND v.deleted_at IS NULL${vOwner}) AS visits,
        (SELECT MIN(v.date) FROM visit v
          WHERE v.place_id = p.id AND v.deleted_at IS NULL${vOwner}) AS first_date,
        (SELECT MAX(v.date) FROM visit v
          WHERE v.place_id = p.id AND v.deleted_at IS NULL${vOwner}) AS last_date
      FROM place p
      WHERE p.deleted_at IS NULL AND p.kind = 'visited'${pOwner}
    `)
    .all(...params);

  const agg = new Map();
  for (const r of rows) {
    const name = r.province || r.province_code || UNKNOWN;
    let a = agg.get(name);
    if (!a) {
      a = { name, code: null, places: 0, visits: 0, first_date: null, last_date: null };
      agg.set(name, a);
    }
    if (!a.code && r.province_code) a.code = r.province_code;
    a.places += 1;
    a.visits += Number(r.visits) || 0;
    if (r.first_date && (!a.first_date || r.first_date < a.first_date)) a.first_date = r.first_date;
    if (r.last_date && (!a.last_date || r.last_date > a.last_date)) a.last_date = r.last_date;
  }

  const provinces = [...agg.values()].sort(byCountThenName);
  return {
    provinces,
    maxPlaces: provinces.reduce((n, p) => Math.max(n, p.places), 0),
    maxVisits: provinces.reduce((n, p) => Math.max(n, p.visits), 0),
  };
}
