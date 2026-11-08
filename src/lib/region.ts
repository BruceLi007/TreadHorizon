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

/**
 * 34 个省级行政区全称（D-263 从地址文本解析省份用；长名在前，避免前缀误匹配）。
 * 2026-11-08 D-284：也用于「地点编辑 → 地区」的省份候选（datalist）。
 */
export const PROVINCE_FULL_NAMES = [
  '内蒙古自治区',
  '广西壮族自治区',
  '宁夏回族自治区',
  '新疆维吾尔自治区',
  '西藏自治区',
  '香港特别行政区',
  '澳门特别行政区',
  '黑龙江省',
  '北京市',
  '天津市',
  '河北省',
  '山西省',
  '辽宁省',
  '吉林省',
  '上海市',
  '江苏省',
  '浙江省',
  '安徽省',
  '福建省',
  '江西省',
  '山东省',
  '河南省',
  '湖北省',
  '湖南省',
  '广东省',
  '海南省',
  '重庆市',
  '四川省',
  '贵州省',
  '云南省',
  '陕西省',
  '甘肃省',
  '青海省',
  '台湾省',
];

/**
 * 是否是中国省级行政区全称（逆地理 / 地址文本解析结果都是全称，例如「浙江省」「香港特别行政区」）。
 * 2026-11-07 D-264：用作「国内」判定的第二重兜底——沿海港口 / 近岸水域 / 离岛 POI
 * 会掉出省界多边形被误判「国外」，但它们的地址文本 / 逆地理结果带中国省份，可据此放行。
 */
export function isChineseProvinceName(name?: string | null): boolean {
  const s = clean(name);
  return Boolean(s && PROVINCE_FULL_NAMES.includes(s));
}

/**
 * 2026-11-08 D-283：港澳台三个省级行政区。
 * 天地图逆地理对它们可能只返回省级（实测澳门：province=澳门特别行政区，city/county 都为空），
 * 因此「city 为空」不一定是数据缺失，界面不能一律当成「未标注」。
 */
const HMT_PROVINCE_NAMES = ['香港特别行政区', '澳门特别行政区', '台湾省'];

export function isHmtProvince(name?: string | null): boolean {
  const s = clean(name);
  return Boolean(s && HMT_PROVINCE_NAMES.includes(s));
}

/**
 * 地点是否需要「补全地区 / 修复未标注」（2026-11-08 D-283）：
 * - 省为空 → 需要；
 * - 非港澳台且市为空 → 需要（多为主陆历史数据缺 city）；
 * - 港澳台且市为空 → **不需要**（天地图对澳门等只返回省级，补全也拿不到市，属正常数据）。
 */
export function regionNeedsFill(p: { province?: string | null; city?: string | null }): boolean {
  if (!p.province) return true;
  return !p.city && !isHmtProvince(p.province);
}

/**
 * 2026-11-07 D-263：从天地图 POI 地址文本解析省 / 市 / 区。
 * 用于「逆地理对水域 / 特殊坐标返回空省市区」时的兜底——
 * 例如搜索「维多利亚港」时 POI 地址是「香港特别行政区油尖旺区维多利亚港」，
 * 逆地理却只返回「维多利亚港西北约0米」（province/city/county 全空），
 * 不兜底会存成「未标注」地点。
 * 只在逆地理缺省份时使用，解析失败返回 null（不影响正常流程）。
 */
export function regionFromText(text?: string | null): RegionFields | null {
  const s = clean(text);
  if (!s) return null;
  const province = PROVINCE_FULL_NAMES.find((p) => s.startsWith(p));
  if (!province) return null;
  let rest = s.slice(province.length);
  let city: string | undefined;
  let county: string | undefined;
  const mCity = rest.match(/^(.+?(?:市|自治州|地区|盟))/);
  if (mCity) {
    city = mCity[1];
    rest = rest.slice(city.length);
  }
  const mCounty = rest.match(/^(.+?(?:区|县|旗|市))/);
  if (mCounty) county = mCounty[1];
  // 港澳台这种「省下面直接是区」的地址不设 city（由 normalizeRegion 的 city=county 兜底存库），
  // 避免界面显示「香港特别行政区 · 油尖旺区 · 油尖旺区」这种重复。
  return { province, city, county };
}
