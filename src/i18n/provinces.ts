/**
 * 34 个省级行政区的中文 → 英文映射（2026-11-04，D-138）。
 *
 * 只用于「显示」：My旅迹省分组头、统计面板省/地区分布、聚合簇提示、省份点亮 hover 等。
 * 库里的 `place.province` 是中文数据、GeoJSON feature 也是中文名，**匹配永远用中文**，
 * 只有渲染到界面上时才经过这里翻译；市 / 区县不翻（用户数据，无法可靠翻译）。
 *
 * key 用「归一化名」（去掉 省/市/自治区/特别行政区 等后缀，和 `map/provinces.ts`
 * 的 normProvinceName 一致），例如「浙江省」→「浙江」、「新疆维吾尔自治区」→「新疆」。
 */

export const PROVINCE_EN: Record<string, string> = {
  北京: 'Beijing',
  天津: 'Tianjin',
  河北: 'Hebei',
  山西: 'Shanxi',
  内蒙古: 'Inner Mongolia',
  辽宁: 'Liaoning',
  吉林: 'Jilin',
  黑龙江: 'Heilongjiang',
  上海: 'Shanghai',
  江苏: 'Jiangsu',
  浙江: 'Zhejiang',
  安徽: 'Anhui',
  福建: 'Fujian',
  江西: 'Jiangxi',
  山东: 'Shandong',
  河南: 'Henan',
  湖北: 'Hubei',
  湖南: 'Hunan',
  广东: 'Guangdong',
  广西: 'Guangxi',
  海南: 'Hainan',
  重庆: 'Chongqing',
  四川: 'Sichuan',
  贵州: 'Guizhou',
  云南: 'Yunnan',
  西藏: 'Tibet',
  陕西: 'Shaanxi',
  甘肃: 'Gansu',
  青海: 'Qinghai',
  宁夏: 'Ningxia',
  新疆: 'Xinjiang',
  台湾: 'Taiwan',
  香港: 'Hong Kong',
  澳门: 'Macao',
};

/** 与 `map/provinces.ts` 的 SUFFIXES 同序（长的先匹配），避免 i18n 反向依赖地图模块 */
const SUFFIXES = ['壮族自治区', '回族自治区', '维吾尔自治区', '特别行政区', '自治区', '省', '市'];

/** 「浙江省」「广西壮族自治区」「北京市」→「浙江」（只用于查表，不改变原始数据） */
export function provinceKey(name: string): string {
  let s = String(name ?? '').trim();
  for (const suf of SUFFIXES) {
    if (s.endsWith(suf) && s.length > suf.length) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s;
}
