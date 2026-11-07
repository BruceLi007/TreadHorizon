import type { ProvinceBoundaryData, ProvinceBoundaryFeature, ProvinceLight } from '../lib/types';

/**
 * 省份点亮（F-STA-01）的纯函数工具：名称归一、等级、命中测试、路径生成。
 *
 * 归属判断永远用 place.province_code / place.province（D-60），省界多边形只用于画图；
 * 这里做的只是把库里的省名/省代码和 GeoJSON feature 对上。
 */

const SUFFIXES = [
  '壮族自治区',
  '回族自治区',
  '维吾尔自治区',
  '特别行政区',
  '自治区',
  '省',
  '市',
];

/** 「浙江省」「广西壮族自治区」「北京市」→「浙江」「广西」「北京」 */
export function normProvinceName(name?: string | null): string {
  let s = String(name ?? '').trim();
  for (const suf of SUFFIXES) {
    if (s.endsWith(suf) && s.length > suf.length) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s;
}

/** 行政区划代码归一：TDT 逆地理返回 9 位（156330000），GeoJSON adcode 是 6 位（330000） */
export function normProvinceCode(code?: string | null): string {
  const digits = String(code ?? '').replace(/\D/g, '');
  return digits.length > 6 ? digits.slice(-6) : digits;
}

/** 4 档 + 未去灰（D-60）：按「地点数」固定分档，与统计面板图例一致：1 / 2–3 / 4–9 / 10+ */
export function provinceLevel(places: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(places) || places <= 0) return 0;
  if (places <= 1) return 1;
  if (places <= 3) return 2;
  if (places <= 9) return 3;
  return 4;
}

/**
 * 4 档点亮（D-60；D-168 用户指定：省界点亮保持橙色，且比原来的强调橙亮一档）。
 * 地图底图在 4 档外观下都是浅色，所以这组橙色固定不变、不跟黑白强调色走；
 * 具体色值在 src/styles.css 的 --province / --province-rgb / --province-hi-rgb。
 */
export const PROVINCE_FILLS: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'rgba(255, 255, 255, 0.045)',
  1: 'rgba(var(--province-rgb), 0.22)',
  2: 'rgba(var(--province-rgb), 0.40)',
  3: 'rgba(var(--province-rgb), 0.60)',
  4: 'rgba(var(--province-rgb), 0.82)',
};

export const PROVINCE_STROKES: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: 'rgba(255, 255, 255, 0.16)',
  1: 'rgba(var(--province-rgb), 0.42)',
  2: 'rgba(var(--province-rgb), 0.55)',
  3: 'rgba(var(--province-rgb), 0.70)',
  4: 'rgba(var(--province-hi-rgb), 0.85)',
};

/** GeoJSON feature 的边界盒（命中测试前先粗筛，个人库 34 个省足够快） */
export function featureBBox(f: ProvinceBoundaryFeature): [number, number, number, number] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const ring of f.rings) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLng, minLat, maxLng, maxLat];
}

/** 奇偶规则的点在多边形内判定（所有环合在一起算，洞会被自然扣掉） */
export function pointInFeature(lng: number, lat: number, f: ProvinceBoundaryFeature): boolean {
  let inside = false;
  for (const ring of f.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** 在边界数据里按「省名归一」找 feature，其次按 adcode 匹配 */
export function matchProvinceFeature(
  data: ProvinceBoundaryData,
  light: Pick<ProvinceLight, 'name' | 'code'> | string
): ProvinceBoundaryFeature | null {
  const name = typeof light === 'string' ? light : light.name;
  const code = typeof light === 'string' ? '' : light.code ?? '';
  const n = normProvinceName(name);
  const c = normProvinceCode(code);
  if (c) {
    const byCode = data.features.find((f) => normProvinceCode(f.adcode) === c);
    if (byCode) return byCode;
  }
  if (n) {
    const byName = data.features.find((f) => normProvinceName(f.name) === n);
    if (byName) return byName;
  }
  return null;
}

/** 统计面板/地图 hover 用的归一索引：名字、代码都能查到 */
export function buildLightIndex(
  lights: ProvinceLight[]
): { byName: Map<string, ProvinceLight>; byCode: Map<string, ProvinceLight>; maxPlaces: number } {
  const byName = new Map<string, ProvinceLight>();
  const byCode = new Map<string, ProvinceLight>();
  let maxPlaces = 0;
  for (const p of lights) {
    byName.set(normProvinceName(p.name), p);
    const code = normProvinceCode(p.code);
    if (code) byCode.set(code, p);
    if (p.places > maxPlaces) maxPlaces = p.places;
  }
  return { byName, byCode, maxPlaces };
}

/** 画一个环的 SVG path（输入已经是屏幕坐标） */
export function ringToPath(points: [number, number][]): string {
  if (points.length < 3) return '';
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
  }
  return d + 'Z';
}
