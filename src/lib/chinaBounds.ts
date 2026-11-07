import type { ProvinceBoundaryData } from './types';
import { pointInFeature } from '../map/provinces';

/**
 * 「坐标是否在国内」判断（2026-11-06 用户要求：暂不支持国外到访记录）。
 *
 * 天地图只有很粗的全球底图、搜索 / 逆地理基本只覆盖国内，所以打点时如果落点在国外，
 * 直接提示「暂不支持国外到访记录」并拒绝落点 / 保存。
 *
 * 判定数据用 34 个省级行政区边界（public/province-boundaries.json，完整版约 490KB，
 * 与统计面板省份点亮同源）做点在多边形内判定；首次需要时懒加载并缓存。
 * 2026-11-07 D-249（用户反馈）：原来用 province-boundaries-low.json（40KB 概化版），
 * 香港 / 澳门这种小区域被简化掉大半，中环、铜锣湾、机场等坐标会落在多边形外 → 被误判
 * 「不支持国外到访」；改用完整版后香港/澳门/台湾的细边界都能正确命中。
 * 2026-11-07 D-263（用户反馈：v0.2.2 搜索「维多利亚港」仍提示国外区域）：
 * 完整版省界只画陆地海岸线，**港口 / 近岸水域 / 部分填海区**仍会落在多边形外
 * （实测维多利亚港 POI 114.174618,22.290681 离香港多边形仅约 0.24km；九龙站、维港中心水域同理）。
 * 因此给港澳台补一个「近岸 5km 容差」：点在任一港澳台省界 5km 内也算国内。
 * 港澳台周边 5km 内没有外国领土，不会放过真正境外的点（东京 / 首尔 / 新加坡等远大于 5km）。
 * 加载失败时退化为「中国大致经纬度范围」兜底（偏严格），避免国外坐标漏过。
 */
let bounds: ProvinceBoundaryData | null = null;
let loading: Promise<ProvinceBoundaryData | null> | null = null;

/** D-263：港澳台「近岸容差」——完整省界不含海域，靠海 POI 会落在多边形外 */
const EXTRA_TERRITORY_NAME_PARTS = ['香港', '澳门', '台湾'];
const NEAR_TERRITORY_TOLERANCE_KM = 5;

/** 懒加载省界数据（幂等；失败返回 null，下次调用会重试） */
export function loadChinaBounds(): Promise<ProvinceBoundaryData | null> {
  if (bounds) return Promise.resolve(bounds);
  if (!loading) {
    loading = fetch('/province-boundaries.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ProvinceBoundaryData | null) => {
        if (d && Array.isArray(d.features) && d.features.length > 0) {
          bounds = d;
          return d;
        }
        return null;
      })
      .catch(() => null)
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** 点到线段的最近距离（km）：把经纬度按查询点纬度投影成局部平面，够 5km 尺度判断用 */
function pointToSegmentKm(
  lng: number,
  lat: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  kx: number
): number {
  const ax = (x1 - lng) * kx;
  const ay = (y1 - lat) * 110.57;
  const bx = (x2 - lng) * kx;
  const by = (y2 - lat) * 110.57;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(ax, ay);
  let t = -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** D-263：点是否在港澳台省界多边形的「近岸 5km」缓冲区内（只对港澳台生效） */
function nearExtraTerritory(lng: number, lat: number): boolean {
  if (!bounds) return false;
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  for (const f of bounds.features) {
    if (!EXTRA_TERRITORY_NAME_PARTS.some((part) => f.name.includes(part))) continue;
    for (const ring of f.rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const d = pointToSegmentKm(lng, lat, ring[j][0], ring[j][1], ring[i][0], ring[i][1], kx);
        if (d <= NEAR_TERRITORY_TOLERANCE_KM) return true;
      }
    }
  }
  return false;
}

/** 同步判定：需先 `await loadChinaBounds()`。
 *  边界数据还没加载到（或加载失败）时，退化为「中国大致经纬度范围」兜底判断，
 *  宁可挡住个别边缘坐标，也不让明显在国外的坐标落库。 */
export function isInsideChina(lng: number, lat: number): boolean {
  if (!bounds) {
    // 粗范围：主land + 海南 + 台湾 + 港澳（南海外岛不在此列；需要时等数据加载完再精确判断）
    return lng >= 73.0 && lng <= 135.6 && lat >= 18.0 && lat <= 54.0;
  }
  // 多边形命中（省级行政区陆地），或港澳台近岸 5km 缓冲（D-263：港口 / 近岸水域 / 填海区）
  return (
    bounds.features.some((f) => pointInFeature(lng, lat, f)) ||
    nearExtraTerritory(lng, lat)
  );
}
