/**
 * 开发期一次性脚本：生成 public/province-boundaries.json（省级边界，供前端自绘 SVG 点亮省份用）
 *
 *   node scripts/build-province-geo.mjs
 *
 * 数据源：geojson.cn 的「天地图-国家标准矢量地图」全国省级边界（34 个省级行政区，
 * 附加若干「境界线」要素，本脚本跳过）。
 *   https://geojson.cn/api/tiandi/100000.json
 * 坐标系：CGCS2000 (EPSG:4490) —— 与天地图底图同源同坐标系，点亮边界能和底图省界对齐。
 * （最初用 DataV.GeoAtlas 的数据，用户实测发现点亮边界与天地图底图省界偏差明显：
 *  DataV 是 GCJ-02 且边界数据版本/取舍与天地图不同，故 2026-11-02 换成天地图官方数据。）
 * 为什么不用天地图 /administrative 服务端接口：被 WAF 拦（HTTP 418），v2 路由也不可用。
 *
 * 处理：Polygon / MultiPolygon 统一拆成 rings（外环 + 内环都当填充环），
 * Douglas-Peucker 简化（容差 0.003~0.008°，按总点数上限自动选最细的），
 * 坐标保留 4 位小数（约 11m 精度，足够画图），输出幂等、可重复运行。
 *
 * 产物格式（见 src/lib/types.ts 的 ProvinceBoundaryData）：
 * { source, generated_at, features: [{ name, adcode, center, rings }] }
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL = 'https://geojson.cn/api/tiandi/100000.json';
const OUT_PATH = join(ROOT, 'public', 'province-boundaries.json');
/** 低缩放（z<7）用的概化版：天地图底图在低缩放时省界更平滑，概化后视觉上更贴底图 */
const LOW_OUT_PATH = join(ROOT, 'public', 'province-boundaries-low.json');
const LOW_TOLERANCE = 0.12;
/** 总点数上限：太大拖慢 SVG 每帧重绘；0.005° 在省级视图误差 < 0.25px，放大到市级也只有几 px */
const MAX_POINTS = 32000;
const TOLERANCES = [0.005, 0.006, 0.008, 0.01];
const COORD_SCALE = 10000; // 保留 4 位小数

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

/** Douglas-Peucker（闭合环：首尾同点，递归时会自动在最远点处分段） */
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
    if (maxD > tol2 && idx !== -1) {
      keep[idx] = 1;
      stack.push([start, idx], [idx, end]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

const roundCoord = (v) => Math.round(v * COORD_SCALE) / COORD_SCALE;

/** 取整 + 去掉连续重复点；不足 4 个点（或面积退化为 0）的环丢弃 */
function cleanRing(ring) {
  const out = [];
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const pt = [roundCoord(p[0]), roundCoord(p[1])];
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const prev = out[out.length - 1];
    if (prev && prev[0] === pt[0] && prev[1] === pt[1]) continue;
    out.push(pt);
  }
  if (out.length < 3) return null;
  // 保证闭合
  if (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1]) {
    out.push([out[0][0], out[0][1]]);
  }
  if (out.length < 4) return null;
  // 退化环（所有点共线 / 面积 0）丢弃，省得前端填充出怪东西
  let area2 = 0;
  for (let i = 0; i < out.length - 1; i++) {
    area2 += out[i][0] * out[i + 1][1] - out[i + 1][0] * out[i][1];
  }
  if (Math.abs(area2) < 1e-8) return null;
  return out;
}

/** Polygon → [ring…]；MultiPolygon → 所有多边形的环拍平 */
function ringsOf(geometry) {
  if (!geometry) return [];
  const { type, coordinates } = geometry;
  if (type === 'Polygon') return Array.isArray(coordinates) ? coordinates : [];
  if (type === 'MultiPolygon') {
    return Array.isArray(coordinates) ? coordinates.flat(1) : [];
  }
  return [];
}

function buildFeatures(geo, tolerance) {
  const features = [];
  let totalPoints = 0;
  let dropped = 0;
  for (const f of geo.features || []) {
    const props = f?.properties || {};
    const name = String(props.name || '').trim();
    // 天地图数据里除 34 个省级行政区外还有 8 条「境界线」（未定国界/九段线之类），跳过
    if (!name || name === '境界线') continue;
    const geomType = f?.geometry?.type;
    if (geomType !== 'Polygon' && geomType !== 'MultiPolygon') continue;
    // 天地图数据用 code（6 位），兼容 DataV 的 adcode
    const adcode =
      props.code != null
        ? String(props.code)
        : props.adcode != null
          ? String(props.adcode)
          : '';
    if (!adcode) continue;
    const rings = [];
    for (const rawRing of ringsOf(f.geometry)) {
      if (!Array.isArray(rawRing) || rawRing.length < 3) continue;
      const simplified = simplify(rawRing, tolerance);
      const ring = cleanRing(simplified);
      if (ring) rings.push(ring);
      else dropped += 1;
    }
    if (!rings.length) continue;
    for (const r of rings) totalPoints += r.length;
    let center = null;
    if (Array.isArray(props.center) && props.center.length === 2) {
      center = [roundCoord(props.center[0]), roundCoord(props.center[1])];
    } else if (Array.isArray(props.centroid) && props.centroid.length === 2) {
      center = [roundCoord(props.centroid[0]), roundCoord(props.centroid[1])];
    } else {
      // 天地图数据没有 center/centroid：用 bbox 中心兜底（只用于将来可能需要定位的场景）
      let minLng = Infinity;
      let minLat = Infinity;
      let maxLng = -Infinity;
      let maxLat = -Infinity;
      for (const r of rings) {
        for (const [lng, lat] of r) {
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
      if (Number.isFinite(minLng)) {
        center = [roundCoord((minLng + maxLng) / 2), roundCoord((minLat + maxLat) / 2)];
      }
    }
    features.push({ name, adcode, center, rings });
  }
  features.sort((a, b) => Number(a.adcode) - Number(b.adcode));
  return { features, totalPoints, dropped };
}

async function main() {
  console.log(`[geo] 下载省界：${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL, {
    headers: { 'user-agent': 'travel-maps-build/1.0' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const text = await res.text();
  console.log(`[geo] 下载完成：${(text.length / 1024).toFixed(1)} KB`);
  const geo = JSON.parse(text);
  if (!Array.isArray(geo?.features) || !geo.features.length) {
    throw new Error('GeoJSON 结构异常：没有 features');
  }
  console.log(`[geo] 原始 feature 数：${geo.features.length}`);

  let chosen = null;
  for (const tolerance of TOLERANCES) {
    const built = buildFeatures(geo, tolerance);
    console.log(
      `[geo] 容差 ${tolerance}° → ${built.features.length} 个 feature，总点数 ${built.totalPoints}` +
        `（丢弃退化环 ${built.dropped} 个）`
    );
    chosen = { tolerance, ...built };
    if (built.totalPoints <= MAX_POINTS) break;
  }
  if (!chosen) throw new Error('简化失败：没有产出任何 feature');
  if (chosen.totalPoints > MAX_POINTS) {
    console.warn(
      `[geo] ⚠️ 最小可用容差 ${chosen.tolerance}° 下总点数 ${chosen.totalPoints} 仍超过 ${MAX_POINTS}`
    );
  }

  const out = {
    source: 'geojson-cn/tiandi/100000 (CGCS2000)',
    generated_at: new Date().toISOString(),
    features: chosen.features,
  };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  const json = JSON.stringify(out);
  writeFileSync(OUT_PATH, json, 'utf8');

  const bytes = Buffer.byteLength(json, 'utf8');
  console.log(
    `[geo] ✅ 已写入 ${OUT_PATH}：${(bytes / 1024).toFixed(1)} KB，` +
      `${out.features.length} 个 feature，总点数 ${chosen.totalPoints}，容差 ${chosen.tolerance}°`
  );

  // ── 低缩放（z < 7）用的概化版：天地图底图在低缩放时省界本身是概化/平滑的，
  // 高精度省界直接铺在低缩放画面上会显得“对不齐”；这一版用较大容差让形状更接近底图。
  // 注意：低缩放时不画描边（只留半透明填充），避免两条线并排出现差异。
  const lowBuilt = buildFeatures(geo, LOW_TOLERANCE);
  const fullByName = new Map(out.features.map((f) => [f.name, f]));
  const lowFeatures = lowBuilt.features.map((f) => {
    // 极小行政区简化后可能丢了环：回退到高精度版本，保证 34 个省都在
    if (!f.rings.length) {
      const full = fullByName.get(f.name);
      return full || f;
    }
    return f;
  });
  // 概化后整个 feature 都没了的（极小行政区）：用高精度版本补上
  const lowNames = new Set(lowFeatures.map((f) => f.name));
  for (const f of out.features) {
    if (!lowNames.has(f.name)) lowFeatures.push(f);
  }
  lowFeatures.sort((a, b) => Number(a.adcode) - Number(b.adcode));
  const lowOut = {
    source: out.source,
    generated_at: out.generated_at,
    simplified_for_zoom: `z<7, tolerance ${LOW_TOLERANCE}°`,
    features: lowFeatures,
  };
  const lowJson = JSON.stringify(lowOut);
  writeFileSync(LOW_OUT_PATH, lowJson, 'utf8');
  const lowPoints = lowFeatures.reduce((n, f) => n + f.rings.reduce((m, r) => m + r.length, 0), 0);
  console.log(
    `[geo] ✅ 已写入 ${LOW_OUT_PATH}：${(Buffer.byteLength(lowJson, 'utf8') / 1024).toFixed(1)} KB，` +
      `${lowFeatures.length} 个 feature，总点数 ${lowPoints}，容差 ${LOW_TOLERANCE}°`
  );
  console.log(
    `[geo] 示例：${out.features[0].name} adcode=${out.features[0].adcode} ` +
      `环数=${out.features[0].rings.length} 首环点数=${out.features[0].rings[0].length}`
  );
}

main().catch((e) => {
  console.error('[geo] 生成失败：', e?.message || e);
  process.exitCode = 1;
});
