import type {
  CityLight,
  ProvinceBoundaryData,
  ProvinceBoundaryFeature,
  ProvinceLight,
} from '../lib/types';

/**
 * 省份点亮（F-STA-01）的纯函数工具：名称归一、等级、命中测试、路径生成。
 *
 * 归属判断永远用 place.province_code / place.province（D-60），省界多边形只用于画图；
 * 这里做的只是把库里的省名/省代码和 GeoJSON feature 对上。
 *
 * 2026-11-16 D-490：热力图改成按**市**点亮后，本文件的归一/等级工具同时服务城市，
 * 城市侧的名字/代码归一规则单独一组（normCityName / normCityCode）。
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

// ── 城市点亮（2026-11-16 D-490）─────────────────────────────────────────────

/** 城市名后缀：从长到短依次尝试，只剥一个 */
const CITY_SUFFIXES = ['特别行政区', '土家族苗族自治州', '藏族自治州', '彝族自治州', '蒙古族藏族自治州', '自治州', '地区', '林区', '盟', '市', '州'];

/**
 * 「杭州市」「恩施土家族苗族自治州」「锡林郭勒盟」「阿里地区」→ 去掉行政级别后缀。
 * 库里 place.city 与 GeoJSON feature.name 都走同一条规则，所以两端能对上；
 * 直辖市「北京市」和整块省级多边形的名字也都归一成「北京」。
 */
export function normCityName(name?: string | null): string {
  let s = String(name ?? '').trim();
  for (const suf of CITY_SUFFIXES) {
    if (s.endsWith(suf) && s.length > suf.length) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s;
}

/**
 * 城市代码归一：
 *  - 去掉 156 前缀（TDT 逆地理返回 9 位）、只留后 6 位；
 *  - **直辖市 / 港澳台**：库里点位的 city_code 常是「市辖区」110100 / 120100 / 310100 / 500100，
 *    而边界数据用的是整块省级多边形（110000 …），这里统一折到省级代码上。
 */
export function normCityCode(code?: string | null): string {
  const digits = normProvinceCode(code);
  if (!digits) return '';
  if (/^(11|12|31|50)0100$/.test(digits)) return digits.slice(0, 2) + '0000';
  return digits;
}

/** 城市点亮索引：名字、代码都能查到（结构复用省份那套，只换成城市的归一规则） */
export function buildCityIndex(cities: CityLight[]): {
  byName: Map<string, CityLight>;
  byCode: Map<string, CityLight>;
  maxPlaces: number;
} {
  const byName = new Map<string, CityLight>();
  const byCode = new Map<string, CityLight>();
  let maxPlaces = 0;
  for (const c of cities) {
    const n = normCityName(c.name);
    if (n) byName.set(n, c);
    const code = normCityCode(c.code);
    if (code) byCode.set(code, c);
    if (c.places > maxPlaces) maxPlaces = c.places;
  }
  return { byName, byCode, maxPlaces };
}

