import type { Addr } from './types';

/** 地点的省 / 市 / 区字段（创建地点、补全地区时用） */
export interface RegionFields {
  province?: string;
  city?: string;
  county?: string;
  province_code?: string;
  city_code?: string;
  county_code?: string;
}

const clean = (v?: string | null): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
};

/**
 * 逆地理结果 → 地点地区字段（2026-11-04 修复「未标注」）。
 * 天地图对「直辖市 / 兵团城市」会返回 city 为空
 * （如 重庆市 + 云阳县、新疆维吾尔自治区 + 五家渠市），这里在 city 为空时用区县兜底，
 * 避免 My旅迹按「省 → 市」分组时出现「未标注」。
 */
export function normalizeRegion(addr: Addr | null | undefined): RegionFields {
  const province = clean(addr?.province);
  const county = clean(addr?.county);
  const city = clean(addr?.city) || county;
  return {
    province,
    city,
    county,
    province_code: clean(addr?.province_code),
    city_code: clean(addr?.city_code),
    county_code: clean(addr?.county_code),
  };
}
