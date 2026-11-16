/**
 * 开发期一次性脚本：生成 public/city-boundaries.json（地级市边界，供前端自绘 SVG 按市点亮）
 *
 *   node scripts/build-city-geo.mjs
 *
 * 数据源：geojson.cn 的「天地图-国家标准矢量地图」（CGCS2000，与天地图底图同源同坐标系，
 * 和 province-boundaries.json 是同一家数据，边界能对齐）：
 *   - 省级清单：https://geojson.cn/api/tiandi/100000.json
 *   - 每个省的下辖市/州：https://geojson.cn/api/tiandi/<省 adcode>.json
 *
 * 直辖市 / 港澳台：数据源在这些 adcode 上给的是「区」（北京 16 区…），而库里地点的
 * 城市字段是「北京市 / 上海市 / 天津市 / 重庆市 / 香港特别行政区…」，
 * 所以这 7 个直接复用 province-boundaries.json 里那一整块省级多边形，
 * 当成一个「市」要素（2026-11-16 用户确认：直辖市整体算一个市）。
 *
 * 处理：Polygon / MultiPolygon 拆成 rings，Douglas-Peucker 简化（按总点数上限自动选容差），
 * 坐标保留 4 位小数；产物与省界同格式，前端可复用同一套投影 / 命中 / 上色代码。
 * 产物：
 *   public/city-boundaries.json      （z>=7 用的精细版，总点数 <= 64000）
 *   public/city-boundaries-low.json  （z<7 用概化版，总点数 <= 26000，贴低缩放底图）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(ROOT, 'public', 'city-boundaries.json');
const LOW_OUT_PATH = join(ROOT, 'public', 'city-boundaries-low.json');
const PROVINCE_PATH = join(ROOT, 'public', 'province-boundaries.json');
const LIST_URL = 'https://geojson.cn/api/tiandi/100000.json';
const CITY_URL = (code) => `https://geojson.cn/api/tiandi/${code}.json`;

/**
 * 这些「省」直接用整块省级多边形当一个市：
 * 京津沪渝（数据源给的是「区」，库里城市字段是「北京市」等整块）+ 港澳（无下级市）。
 * 台湾不在此列：数据源 710000.json 有 20 个市/县（台北市、高雄市…），按正常地级市取。
 */
const WHOLE_AS_CITY = new Set(['110000', '120000', '310000', '500000', '810000', '820000']);

const MAX_POINTS = 64000;
const LOW_MAX_POINTS = 26000;
const TOLERANCES = [0.004, 0.006, 0.008, 0.012, 0.016, 0.02];
const LOW_TOLERANCES = [0.02, 0.03, 0.04, 0.06];
const COORD_SCALE = 10000; // 4 位小数

const getJson = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
};

/** 点到线段（ab）距离的平方 */
function perpDistSq(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) {
    const ex = p[0] - a[0];
    const ey = p[1] - a[1];
    return ex * ex + ey * ey;
  }
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  const px = a[0] + t * dx;
  const py = a[1] + t * dy;
  const ex = p[0] - px;
  const ey = p[1] - py;
  return ex * ex + ey * ey;
}

/** Douglas-Peucker（闭合环：首尾同点） */
function simplify(points, tolerance) {
  if (points.length <= 4) return points.slice();
  const tol2 = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end - start < 2) continue;
    let maxD = -1;
    let idx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDistSq(points[i], points[start], points[end]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol2 && idx > 0) {
      keep[idx] = 1;
      stack.push([start, idx], [idx, end]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

const round = (v) => Math.round(v * COORD_SCALE) / COORD_SCALE;

/** 把 GeoJSON geometry 拆成 rings（外环 + 内环都当填充环） */
function ringsOf(geometry) {
  if (!geometry) return [];
  const polys =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  const rings = [];
  for (const poly of polys) {
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 4) continue;
      rings.push(ring);
    }
  }
  return rings;
}

const bboxCenter = (rings) => {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return {
    lng: Math.round(((minLng + maxLng) / 2) * COORD_SCALE) / COORD_SCALE,
    lat: Math.round(((minLat + maxLat) / 2) * COORD_SCALE) / COORD_SCALE,
  };
};

const countPoints = (features) => features.reduce((n, f) => n + f.rings.reduce((m, r) => m + r.length, 0), 0);

/** 按总点数上限挑最细的容差，输出 features */
function buildAtBudget(features, tolerances, maxPoints) {
  let best = null;
  for (const tol of tolerances) {
    const out = features.map((f) => ({
      name: f.name,
      adcode: f.adcode,
      center: f.center,
      rings: f.rings
        .map((ring) => simplify(ring, tol).map(([lng, lat]) => [round(lng), round(lat)]))
        .filter((ring) => ring.length >= 4),
    }));
    const pts = countPoints(out);
    best = { tol, features: out, points: pts };
    if (pts <= maxPoints) return best;
  }
  return best;
}

const main = async () => {
  console.log('[city-geo] 拉取省级清单…');
  const list = await getJson(LIST_URL);
  const provinces = (list.features || [])
    .map((f) => ({ name: f.properties?.name, code: String(f.properties?.code ?? ''), geometry: f.geometry }))
    .filter((p) => /^\d{6}$/.test(p.code));
  console.log(`[city-geo] 省级 ${provinces.length} 个`);

  const provinceFile = JSON.parse(readFileSync(PROVINCE_PATH, 'utf8'));
  const provinceFeatureByCode = new Map(
    (provinceFile.features || []).map((f) => [String(f.adcode ?? ''), f])
  );

  const raw = [];
  for (const p of provinces) {
    if (WHOLE_AS_CITY.has(p.code)) {
      const pf = provinceFeatureByCode.get(p.code);
      if (!pf) {
        console.warn(`[city-geo] 省界里找不到 ${p.code}，跳过`);
        continue;
      }
      raw.push({ name: pf.name, adcode: p.code, rings: pf.rings.map((r) => r.slice()), center: pf.center });
      console.log(`  ${p.code} ${p.name} -> 整块 1 个市`);
      continue;
    }
    try {
      const j = await getJson(CITY_URL(p.code));
      const feats = (j.features || [])
        .map((f) => ({ name: f.properties?.name, code: String(f.properties?.code ?? ''), geometry: f.geometry }))
        .filter((f) => /^\d{6}$/.test(f.code) && f.name);
      for (const f of feats) {
        const rings = ringsOf(f.geometry);
        if (!rings.length) continue;
        raw.push({ name: f.name, adcode: f.code, rings, center: bboxCenter(rings) });
      }
      console.log(`  ${p.code} ${p.name} -> ${feats.length} 个市`);
    } catch (e) {
      console.warn(`[city-geo] ${p.code} ${p.name} 拉取失败：${e.message}`);
    }
  }

  // 去掉重名（理论不该有）：同名只保留第一个
  const seen = new Set();
  const features = raw.filter((f) => {
    if (seen.has(f.name)) {
      console.warn(`[city-geo] 重名要素，跳过：${f.name}`);
      return false;
    }
    seen.add(f.name);
    return true;
  });

  console.log(`[city-geo] 合计 ${features.length} 个要素，原始顶点 ${countPoints(features)}`);
  const full = buildAtBudget(features, TOLERANCES, MAX_POINTS);
  const low = buildAtBudget(features, LOW_TOLERANCES, LOW_MAX_POINTS);
  console.log(`[city-geo] 精细版 tol=${full.tol} 顶点=${full.points}`);
  console.log(`[city-geo] 概化版 tol=${low.tol} 顶点=${low.points}`);

  const stamp = new Date().toISOString();
  const write = (path, built) => {
    const payload = {
      source: 'geojson-cn/tiandi/<adcode> (CGCS2000) · 地级市',
      generated_at: stamp,
      features: built.features,
    };
    writeFileSync(path, JSON.stringify(payload), 'utf8');
    console.log(`[city-geo] 写出 ${path}（${(Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(0)} KB）`);
  };
  write(OUT_PATH, full);
  write(LOW_OUT_PATH, low);
};

main().catch((e) => {
  console.error('[city-geo] 失败：', e);
  process.exit(1);
});
