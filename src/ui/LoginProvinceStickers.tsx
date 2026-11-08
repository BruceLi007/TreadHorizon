/**
 * 云端登录页「Q 版 3D 中国地图」的省级景点贴纸图标（2026-11-08，D-269）。
 *
 * 用途：
 *  - 登录 / Key 引导页背景（src/ui/LoginBackdrop.tsx 渲染的粉彩立体中国地图）上，
 *    给 34 个省级行政区各贴一张「粉底 + 白描边 + 景点小图标」的卡通贴纸；
 *  - 本文件只提供「数据 + 图标 SVG 内容」，不负责圆底、白描边、定位和缩放，
 *    贴纸外圈（r=13 的粉彩圆 + 白色描边）由 LoginBackdrop.tsx 统一渲染。
 *
 * 坐标约定：
 *  - 画布：1600×900 的 SVG viewBox，贴纸直径约 26 个 viewBox 单位；
 *  - StickerIcon 返回的是「局部坐标系」内容，原点 (0,0) 为图标中心；
 *  - 内容控制在半径 9 以内（约 -9..9），底部大致落在 y=+8 附近，
 *    避免顶到 r=13 的贴纸圆底与白色描边。
 *
 * 画风约定（与项目现有地图插画一致）：
 *  - 纯 SVG 基本图形（path / rect / circle / ellipse / polygon / line），
 *    所有 fill / stroke 内联书写，不引外部图片、不写 CSS 类名、不加动画；
 *  - 深墨色描边 #33423a、stroke-width 1.2~1.6、圆角圆头；
 *  - 主体用中等饱和的粉彩色（金 #f0b26a、墙红 #e08a7a、水蓝 #7cc4e8、
 *    草绿 #86c76e、土黄 #e6c07a、夜紫 #9a8fd0 等），再点少量白色高光；
 *  - 造型圆润、简单、一眼认得出，单图 5~10 个图形，22~26px 下仍可辨认。
 *
 * 省名清单来源：
 *  - 与项目省界数据 public/province-boundaries-low.json 的 34 个 feature.name
 *    逐一对应（统计局口径的 34 个省级行政区全称），顺序保持一致；
 *  - 经纬度取该景点的大致真实位置（允许 ±0.5° 误差），供 LoginBackdrop 投影。
 *
 * 地图上的 34 张贴纸（省份 → 图标 kind → 景点）：
 *  北京市→palace（故宫）          天津市→ferris（天津之眼）
 *  河北省→wall（山海关长城）      山西省→oldtown（平遥古城）
 *  内蒙古→yurt（呼伦贝尔草原）    辽宁省→palace-gate（沈阳故宫）
 *  吉林省→snow（长白山）          黑龙江省→ice-castle（冰雪大世界）
 *  上海市→tv-tower（东方明珠）    江苏省→garden（苏州园林）
 *  浙江省→lake-temple（西湖）     安徽省→mountain（黄山）
 *  福建省→tulou（福建土楼）       江西省→pagoda（滕王阁）
 *  山东省→mountain-sunrise（泰山）河南省→temple（少林寺）
 *  湖北省→pavilion（黄鹤楼）      湖南省→pillar（张家界）
 *  广东省→tower（广州塔）         广西→karst（桂林山水）
 *  海南省→palm（天涯海角）        重庆市→stilt（洪崖洞）
 *  四川省→panda（熊猫基地）       贵州省→waterfall（黄果树瀑布）
 *  云南省→three-pagoda（大理三塔）西藏→potala（布达拉宫）
 *  陕西省→warrior（兵马俑）       甘肃省→grotto（莫高窟）
 *  青海省→lake（青海湖）          宁夏→camel（沙坡头）
 *  新疆→grape（葡萄沟）           台湾省→tower-101（台北 101）
 *  香港→skyline（维多利亚港）     澳门→arch（大三巴牌坊）
 */
import type { ReactElement } from 'react';

/** 贴纸图标类型：每个省级行政区一个专属造型（34 省 34 种，不重复） */
export type StickerIconKind =
  | 'palace'
  | 'ferris'
  | 'wall'
  | 'oldtown'
  | 'yurt'
  | 'palace-gate'
  | 'snow'
  | 'ice-castle'
  | 'tv-tower'
  | 'garden'
  | 'lake-temple'
  | 'mountain'
  | 'tulou'
  | 'pagoda'
  | 'mountain-sunrise'
  | 'temple'
  | 'pavilion'
  | 'pillar'
  | 'tower'
  | 'karst'
  | 'palm'
  | 'stilt'
  | 'panda'
  | 'waterfall'
  | 'three-pagoda'
  | 'potala'
  | 'warrior'
  | 'grotto'
  | 'lake'
  | 'camel'
  | 'grape'
  | 'tower-101'
  | 'skyline'
  | 'arch';

/** 一张省级景点贴纸的数据定义（不含渲染，渲染交给 LoginBackdrop.tsx） */
export interface ProvinceStickerDef {
  /** 省级行政区全称，必须与项目省界数据一致（见下） */
  province: string;
  /** 景点名（2~6 字，用于 <title> 悬停提示） */
  attraction: string;
  /** 景点大致经纬度（贴纸位置） */
  lng: number;
  lat: number;
  icon: StickerIconKind;
  /** 贴纸圆底颜色：粉彩色（参考 #f6c8c8 #f8d9a8 #f2e8a8 #c8e6b0 #a8dcd8 #b8d4f0 #d4c8f0 #f0c8e0 等，饱和度不要太高） */
  color: string;
}

/** 34 个省级行政区 → 该省最广为人知的景点（名称与省界数据逐字一致） */
export const PROVINCE_STICKERS: ProvinceStickerDef[] = [
  { province: '北京市', attraction: '故宫', lng: 116.397, lat: 39.918, icon: 'palace', color: '#f6c8c8' },
  { province: '天津市', attraction: '天津之眼', lng: 117.18, lat: 39.153, icon: 'ferris', color: '#b8d4f0' },
  { province: '河北省', attraction: '山海关长城', lng: 119.753, lat: 40.009, icon: 'wall', color: '#f2e8a8' },
  { province: '山西省', attraction: '平遥古城', lng: 112.176, lat: 37.201, icon: 'oldtown', color: '#f8d9a8' },
  { province: '内蒙古自治区', attraction: '呼伦贝尔草原', lng: 119.77, lat: 49.21, icon: 'yurt', color: '#c8e6b0' },
  { province: '辽宁省', attraction: '沈阳故宫', lng: 123.457, lat: 41.796, icon: 'palace-gate', color: '#f0c8e0' },
  { province: '吉林省', attraction: '长白山', lng: 128.06, lat: 42.0, icon: 'snow', color: '#d8e8f8' },
  { province: '黑龙江省', attraction: '冰雪大世界', lng: 126.58, lat: 45.78, icon: 'ice-castle', color: '#d4c8f0' },
  { province: '上海市', attraction: '东方明珠', lng: 121.499, lat: 31.24, icon: 'tv-tower', color: '#a8dcd8' },
  { province: '江苏省', attraction: '苏州园林', lng: 120.629, lat: 31.326, icon: 'garden', color: '#c8e6b0' },
  { province: '浙江省', attraction: '西湖', lng: 120.15, lat: 30.246, icon: 'lake-temple', color: '#b8d4f0' },
  { province: '安徽省', attraction: '黄山', lng: 118.17, lat: 30.14, icon: 'mountain', color: '#c8e6b0' },
  { province: '福建省', attraction: '福建土楼', lng: 117.06, lat: 24.66, icon: 'tulou', color: '#f8d9a8' },
  { province: '江西省', attraction: '滕王阁', lng: 115.881, lat: 28.682, icon: 'pagoda', color: '#f6c8c8' },
  { province: '山东省', attraction: '泰山', lng: 117.1, lat: 36.25, icon: 'mountain-sunrise', color: '#f2e8a8' },
  { province: '河南省', attraction: '少林寺', lng: 112.94, lat: 34.51, icon: 'temple', color: '#d8e8f8' },
  { province: '湖北省', attraction: '黄鹤楼', lng: 114.3, lat: 30.54, icon: 'pavilion', color: '#f0c8e0' },
  { province: '湖南省', attraction: '张家界', lng: 110.47, lat: 29.32, icon: 'pillar', color: '#a8dcd8' },
  { province: '广东省', attraction: '广州塔', lng: 113.324, lat: 23.106, icon: 'tower', color: '#b8d4f0' },
  { province: '广西壮族自治区', attraction: '桂林山水', lng: 110.29, lat: 25.27, icon: 'karst', color: '#c8e6b0' },
  { province: '海南省', attraction: '天涯海角', lng: 109.38, lat: 18.29, icon: 'palm', color: '#f8d9a8' },
  { province: '重庆市', attraction: '洪崖洞', lng: 106.579, lat: 29.563, icon: 'stilt', color: '#f6c8c8' },
  { province: '四川省', attraction: '熊猫基地', lng: 104.15, lat: 30.735, icon: 'panda', color: '#d8e8f8' },
  { province: '贵州省', attraction: '黄果树瀑布', lng: 105.667, lat: 25.99, icon: 'waterfall', color: '#a8dcd8' },
  { province: '云南省', attraction: '大理三塔', lng: 100.147, lat: 25.703, icon: 'three-pagoda', color: '#d4c8f0' },
  { province: '西藏自治区', attraction: '布达拉宫', lng: 91.117, lat: 29.658, icon: 'potala', color: '#f8d9a8' },
  { province: '陕西省', attraction: '兵马俑', lng: 109.278, lat: 34.385, icon: 'warrior', color: '#f2e8a8' },
  { province: '甘肃省', attraction: '莫高窟', lng: 94.809, lat: 40.042, icon: 'grotto', color: '#e8d4c0' },
  { province: '青海省', attraction: '青海湖', lng: 100.2, lat: 36.9, icon: 'lake', color: '#b8d4f0' },
  { province: '宁夏回族自治区', attraction: '沙坡头', lng: 104.96, lat: 37.51, icon: 'camel', color: '#f2e8a8' },
  { province: '新疆维吾尔自治区', attraction: '葡萄沟', lng: 89.19, lat: 42.95, icon: 'grape', color: '#d4c8f0' },
  { province: '台湾省', attraction: '台北101', lng: 121.565, lat: 25.034, icon: 'tower-101', color: '#a8dcd8' },
  { province: '香港特别行政区', attraction: '维多利亚港', lng: 114.17, lat: 22.29, icon: 'skyline', color: '#d4c8f0' },
  { province: '澳门特别行政区', attraction: '大三巴牌坊', lng: 113.54, lat: 22.19, icon: 'arch', color: '#e8d4c0' },
];

/* ───────────────────────── 图标绘制公用常量 ─────────────────────────
   深墨色线稿 + 粉彩填充，所有图形只写内联 fill / stroke，不依赖 CSS。 */
const C = {
  ink: '#33423a', // 深墨色描边
  gold: '#f0b26a', // 屋檐金
  goldDeep: '#e39a55', // 屋檐金（暗）
  red: '#e08a7a', // 墙红
  redDeep: '#c96f63', // 墙红（暗）
  snow: '#ffffff', // 雪白
  water: '#7cc4e8', // 水蓝
  waterDeep: '#4faee0', // 水蓝（深）
  grass: '#86c76e', // 草绿
  grassDeep: '#5fa55e', // 草绿（深）
  sand: '#e6c07a', // 土黄 / 沙
  sandDeep: '#c9a06a', // 土黄（暗）
  stone: '#e8d3b0', // 石阶 / 台基
  stoneDeep: '#c9b895', // 石阶（暗）
  tile: '#84938a', // 青瓦
  night: '#9a8fd0', // 夜紫
  pink: '#f0c8e0', // 粉
  brown: '#b98a5e', // 木色
  brownDeep: '#8a6a4a', // 木色（深）
  cream: '#f5efe2', // 奶白
  ice: '#cfeeff', // 冰蓝
} as const;

/** 主轮廓：深墨色描边 1.3 + 圆角圆头（路径 / 基本图形通用） */
const LINE = {
  stroke: C.ink,
  strokeWidth: 1.3,
  strokeLinejoin: 'round',
  strokeLinecap: 'round',
} as const;

/** 次级线条：细节用的墨线 1.2（同样在 1.2~1.6 规范内），保持线稿层次 */
const THIN = {
  stroke: C.ink,
  strokeWidth: 1.2,
  strokeLinejoin: 'round',
  strokeLinecap: 'round',
} as const;

/** 白高光短线（大面积色块上点一笔，避免图标发闷） */
const SHINE = {
  stroke: '#ffffff',
  strokeWidth: 0.9,
  strokeLinecap: 'round',
} as const;

/* ───────────────────────── 34 个景点图标 ─────────────────────────
   每个图标都是 <g> 内容，局部坐标以 (0,0) 为中心、范围约 -9..9。 */
const STICKER_ICONS: Record<StickerIconKind, () => ReactElement> = {
  /* 北京 · 故宫：重檐大殿 + 石台基 + 朱门 */
  palace: () => (
    <g>
      <rect {...LINE} x={-8.2} y={5.3} width={16.4} height={2.1} rx={0.8} fill={C.stone} />
      <rect {...LINE} x={-6.2} y={1.1} width={12.4} height={4.6} rx={0.7} fill={C.red} />
      <rect {...LINE} x={-1.4} y={2.3} width={2.8} height={3.4} rx={0.9} fill={C.brownDeep} />
      <circle cx={-0.6} cy={3.5} r={0.32} fill={C.gold} />
      <circle cx={0.6} cy={3.5} r={0.32} fill={C.gold} />
      <path {...LINE} fill={C.gold} d="M-8.6 1.8 Q-6.4 -1.6 -4.2 -1.6 H4.2 Q6.4 -1.6 8.6 1.8 Q4.2 2.8 0 2.5 Q-4.2 2.8 -8.6 1.8 Z" />
      <path {...LINE} fill={C.gold} d="M-5.6 -1.8 Q-4.4 -5.6 -2.6 -5.6 H2.6 Q4.4 -5.6 5.6 -1.8 Q2.8 -1.0 0 -1.1 Q-2.8 -1.0 -5.6 -1.8 Z" />
      <circle {...THIN} cx={0} cy={-5.8} r={0.7} fill={C.gold} />
      <path {...SHINE} d="M-3.6 -3.4 Q-2.0 -4.4 -0.4 -4.6" fill="none" opacity={0.7} />
    </g>
  ),

  /* 天津 · 天津之眼：桥上摩天轮 + 观景舱 */
  ferris: () => (
    <g>
      <rect {...LINE} x={-8.2} y={6.0} width={16.4} height={1.7} rx={0.8} fill={C.stone} />
      <path {...LINE} fill="none" d="M-5.2 6.1 L0 -0.9 L5.2 6.1" />
      <circle {...LINE} cx={0} cy={-0.9} r={5.9} fill={C.snow} />
      <circle {...THIN} cx={0} cy={-0.9} r={5.0} fill="none" />
      <path {...THIN} fill="none" d="M0 -6.8 V4.9 M-5.9 -0.9 H5.9 M-4.2 -5.1 L4.2 3.3 M4.2 -5.1 L-4.2 3.3" />
      <circle {...LINE} cx={0} cy={-0.9} r={1.2} fill={C.gold} />
      <rect {...THIN} x={-0.9} y={-8.3} width={1.8} height={1.4} rx={0.5} fill={C.red} />
      <rect {...THIN} x={-5.7} y={-6.3} width={1.8} height={1.4} rx={0.5} fill={C.red} />
      <rect {...THIN} x={3.9} y={-6.3} width={1.8} height={1.4} rx={0.5} fill={C.red} />
      <rect {...THIN} x={-5.7} y={2.5} width={1.8} height={1.4} rx={0.5} fill={C.red} />
      <rect {...THIN} x={3.9} y={2.5} width={1.8} height={1.4} rx={0.5} fill={C.red} />
      <circle cx={-0.5} cy={-1.5} r={0.4} fill="#ffffff" />
    </g>
  ),

  /* 河北 · 山海关长城：带垛口的城墙 + 关楼 + 红旗 */
  wall: () => (
    <g>
      <path {...LINE} fill={C.grass} d="M-9 5.8 Q0 4.8 9 5.8 L9 7.8 L-9 7.8 Z" />
      <rect {...LINE} x={-8.4} y={2.8} width={16.8} height={3.6} rx={0.3} fill={C.sand} />
      <rect {...LINE} x={-8.4} y={1.0} width={3.2} height={1.9} rx={0.2} fill={C.sand} />
      <rect {...LINE} x={-4.6} y={1.0} width={3.2} height={1.9} rx={0.2} fill={C.sand} />
      <rect {...LINE} x={-0.8} y={1.0} width={3.2} height={1.9} rx={0.2} fill={C.sand} />
      <rect {...LINE} x={3.0} y={1.0} width={3.2} height={1.9} rx={0.2} fill={C.sand} />
      <path {...LINE} fill={C.brownDeep} d="M-2.0 6.4 V4.2 Q-2.0 3.0 0 3.0 Q2.0 3.0 2.0 4.2 V6.4 Z" />
      <rect {...LINE} x={5.8} y={-2.6} width={3.2} height={9.0} rx={0.4} fill={C.sand} />
      <rect {...LINE} x={5.5} y={-3.8} width={3.8} height={1.2} rx={0.2} fill={C.sand} />
      <path {...THIN} fill="none" d="M7.4 -3.9 V-5.9" />
      <path {...LINE} fill={C.red} d="M7.4 -5.9 L9.1 -5.2 L7.4 -4.5 Z" />
      <rect x={-7.4} y={-1.2} width={0.6} height={1.6} rx={0.3} fill="#ffffff" opacity={0.5} />
      <path {...SHINE} d="M-6.8 3.2 Q-3.0 2.6 0 3.2" fill="none" opacity={0.5} />
    </g>
  ),

  /* 山西 · 平遥古城：城墙 + 城楼 + 大红灯笼 */
  oldtown: () => (
    <g>
      <path {...LINE} fill={C.grass} d="M-9 6.6 Q0 5.9 9 6.6 L9 7.8 L-9 7.8 Z" />
      <rect {...LINE} x={-8.2} y={2.4} width={16.4} height={4.0} rx={0.4} fill={C.sandDeep} />
      <rect {...LINE} x={-8.2} y={1.3} width={1.8} height={1.2} rx={0.2} fill={C.sandDeep} />
      <rect {...LINE} x={-6.2} y={1.3} width={1.8} height={1.2} rx={0.2} fill={C.sandDeep} />
      <rect {...LINE} x={4.4} y={1.3} width={1.8} height={1.2} rx={0.2} fill={C.sandDeep} />
      <rect {...LINE} x={6.4} y={1.3} width={1.8} height={1.2} rx={0.2} fill={C.sandDeep} />
      <rect {...LINE} x={-3.4} y={-0.6} width={6.8} height={3.2} rx={0.4} fill={C.red} />
      <path {...LINE} fill={C.gold} d="M-5.2 -0.6 Q-4.0 -3.8 -2.4 -3.8 H2.4 Q4.0 -3.8 5.2 -0.6 Q2.6 0.2 0 0.0 Q-2.6 0.2 -5.2 -0.6 Z" />
      <path {...THIN} fill="none" d="M0 -3.8 V-4.5" />
      <circle {...THIN} cx={0} cy={-4.7} r={0.6} fill={C.gold} />
      <path {...LINE} fill={C.brownDeep} d="M-1.7 6.4 V4.4 Q-1.7 3.2 0 3.2 Q1.7 3.2 1.7 4.4 V6.4 Z" />
      <circle {...THIN} cx={-4.9} cy={4.3} r={0.7} fill={C.redDeep} />
      <circle {...THIN} cx={4.9} cy={4.3} r={0.7} fill={C.redDeep} />
      <path {...SHINE} d="M-2.6 -2.6 Q0 -3.2 2.6 -2.6" fill="none" opacity={0.7} />
    </g>
  ),

  /* 内蒙古 · 呼伦贝尔草原：蒙古包 + 草原 */
  yurt: () => (
    <g>
      <path {...LINE} fill={C.grass} d="M-9 5.2 Q-4.6 3.2 0 4.4 Q4.6 5.6 9 4.0 L9 7.8 L-9 7.8 Z" />
      <path {...LINE} fill={C.snow} d="M-5.2 1.0 Q-4.6 -3.4 0 -4.4 Q4.6 -3.4 5.2 1.0 Z" />
      <rect {...LINE} x={-5.0} y={0.6} width={10.0} height={4.8} rx={1.6} fill={C.snow} />
      <path fill="none" stroke={C.goldDeep} strokeWidth={1.4} strokeLinecap="round" d="M-4.9 1.0 Q0 2.2 4.9 1.0" />
      <ellipse {...THIN} cx={0} cy={-4.1} rx={1.3} ry={0.6} fill={C.gold} />
      <rect {...LINE} x={-1.3} y={1.8} width={2.6} height={3.6} rx={0.8} fill={C.red} />
      <ellipse cx={-1.8} cy={-2.4} rx={0.9} ry={0.5} fill="#ffffff" opacity={0.9} />
    </g>
  ),

  /* 辽宁 · 沈阳故宫：红墙金瓦宫门 + 门钉 */
  'palace-gate': () => (
    <g>
      <rect {...LINE} x={-8.4} y={5.9} width={16.8} height={1.7} rx={0.6} fill={C.stone} />
      <rect {...LINE} x={-7.4} y={-0.2} width={14.8} height={6.2} rx={0.6} fill={C.red} />
      <rect {...LINE} x={-5.7} y={2.2} width={2.0} height={3.0} rx={0.5} fill={C.redDeep} />
      <rect {...LINE} x={3.7} y={2.2} width={2.0} height={3.0} rx={0.5} fill={C.redDeep} />
      <path {...LINE} fill={C.gold} d="M-6.8 -0.2 Q-5.4 -3.8 -3.4 -3.8 H3.4 Q5.4 -3.8 6.8 -0.2 Q3.4 0.6 0 0.4 Q-3.4 0.6 -6.8 -0.2 Z" />
      <path {...THIN} fill="none" d="M0 -3.8 V-4.8" />
      <circle {...THIN} cx={0} cy={-5.0} r={0.65} fill={C.gold} />
      <path {...LINE} fill={C.brownDeep} d="M-2.2 5.9 V2.6 Q-2.2 1.0 0 1.0 Q2.2 1.0 2.2 2.6 V5.9 Z" />
      <circle cx={-1.0} cy={3.3} r={0.3} fill={C.gold} />
      <circle cx={1.0} cy={3.3} r={0.3} fill={C.gold} />
      <circle cx={-1.0} cy={4.4} r={0.3} fill={C.gold} />
      <circle cx={1.0} cy={4.4} r={0.3} fill={C.gold} />
      <rect x={-6.6} y={0.6} width={0.7} height={1.5} rx={0.3} fill="#ffffff" opacity={0.4} />
    </g>
  ),

  /* 吉林 · 长白山：雪峰 + 天池 */
  snow: () => (
    <g>
      <path {...LINE} fill="#8fb0d0" d="M-0.8 6.0 L3.0 -3.0 Q3.6 -4.4 4.2 -3.0 L8.4 6.0 Z" />
      <path {...LINE} fill="#a9c4e0" d="M-8.4 6.0 L-3.8 -4.0 Q-2.8 -6.2 -1.8 -4.0 L3.0 6.0 Z" />
      <path {...LINE} fill={C.snow} d="M1.8 -1.6 L3.2 -3.4 Q3.7 -4.3 4.2 -3.4 L5.6 -1.6 Q4.2 -0.9 3.0 -1.3 Q2.4 -0.9 1.8 -1.6 Z" />
      <path {...LINE} fill={C.snow} d="M-5.6 -1.8 L-3.8 -4.0 Q-2.8 -6.2 -1.8 -4.0 L0.0 -1.8 Q-1.4 -0.8 -2.8 -1.4 Q-4.2 -0.8 -5.6 -1.8 Z" />
      <path {...LINE} fill="#eef6fd" d="M-9 5.0 Q-4.0 3.6 0 4.6 Q4.6 5.6 9 4.2 L9 7.8 L-9 7.8 Z" />
      <ellipse {...THIN} cx={0.6} cy={5.7} rx={3.2} ry={1.0} fill={C.water} />
      <path {...LINE} fill={C.grassDeep} d="M-7.6 5.6 L-6.9 3.8 L-6.2 5.6 Z" />
      <path {...LINE} fill={C.grassDeep} d="M-8.6 5.9 L-8.0 4.4 L-7.4 5.9 Z" />
      <ellipse cx={-0.8} cy={5.4} rx={1.0} ry={0.35} fill="#ffffff" opacity={0.9} />
    </g>
  ),

  /* 黑龙江 · 冰雪大世界：冰城堡 + 塔尖 + 雪花 */
  'ice-castle': () => (
    <g>
      <path {...LINE} fill="#e3f2fb" d="M-9 5.8 Q-4 4.4 0 5.2 Q4.6 6 9 4.8 L9 7.8 L-9 7.8 Z" />
      <rect {...LINE} x={-7.2} y={0.6} width={2.8} height={5.4} rx={0.6} fill={C.ice} />
      <path {...LINE} fill="#c3e6fa" d="M-8.0 0.6 L-5.8 -2.8 L-3.6 0.6 Z" />
      <rect {...LINE} x={4.4} y={0.6} width={2.8} height={5.4} rx={0.6} fill={C.ice} />
      <path {...LINE} fill="#c3e6fa" d="M3.6 0.6 L5.8 -2.8 L8.0 0.6 Z" />
      <rect {...LINE} x={-2.4} y={-1.2} width={4.8} height={7.2} rx={0.8} fill="#e3f4fe" />
      <path {...LINE} fill="#c3e6fa" d="M-3.4 -1.2 L0 -5.6 L3.4 -1.2 Z" />
      <circle {...THIN} cx={0} cy={-6.4} r={0.6} fill={C.snow} />
      <path {...THIN} fill="none" d="M0 -5.6 V-5.9" />
      <path {...LINE} fill="#4f86b8" d="M-1.0 3.8 V1.2 Q-1.0 0.2 0 0.2 Q1.0 0.2 1.0 1.2 V3.8 Z" />
      <rect x={-1.8} y={-0.6} width={0.6} height={3.2} rx={0.3} fill="#ffffff" opacity={0.8} />
    </g>
  ),

  /* 上海 · 东方明珠：三球串珠 + 斜撑 + 天线 */
  'tv-tower': () => (
    <g>
      <rect {...LINE} x={-5.4} y={6.4} width={10.8} height={1.5} rx={0.8} fill="#b8d4f0" />
      <path {...LINE} fill="none" d="M-4.6 6.5 L-1.0 1.4 M4.6 6.5 L1.0 1.4 M0 6.5 V1.4" />
      <rect {...LINE} x={-0.8} y={-4.4} width={1.6} height={10.6} rx={0.8} fill="#c9c3e8" />
      <circle {...LINE} cx={0} cy={1.4} r={2.9} fill="#f4a7a7" />
      <circle {...LINE} cx={0} cy={-3.4} r={1.9} fill="#f4a7a7" />
      <circle {...LINE} cx={0} cy={-6.2} r={1.0} fill="#f4a7a7" />
      <path {...LINE} fill="none" d="M0 -7.2 V-8.0" />
      <circle cx={0} cy={-8.15} r={0.32} fill={C.gold} />
      <ellipse cx={-0.9} cy={0.6} rx={0.8} ry={0.5} fill="#ffffff" opacity={0.9} />
      <circle cx={-0.55} cy={-3.9} r={0.35} fill="#ffffff" opacity={0.9} />
      <path {...THIN} fill="none" d="M-7.4 7.3 Q-3.7 6.8 0 7.2 Q3.7 7.6 7.4 7.2" stroke={C.water} />
    </g>
  ),

  /* 江苏 · 苏州园林：假山 + 水榭亭 + 池塘 + 竹 */
  garden: () => (
    <g>
      <path {...LINE} fill={C.water} d="M-9 4.0 Q0 3.4 9 4.0 L9 7.8 L-9 7.8 Z" />
      <path {...LINE} fill={C.grass} d="M-9 2.6 Q0 2.0 9 2.6 L9 4.6 Q0 4.0 -9 4.6 Z" />
      <path {...LINE} fill="#c9c3b8" d="M-8.2 2.8 Q-8.4 -0.2 -6.8 -0.8 Q-5.8 -1.2 -5.2 0.0 Q-4.6 -0.6 -3.9 0.4 Q-3.2 1.4 -3.4 2.8 Z" />
      <path {...THIN} fill="none" stroke={C.grassDeep} d="M-1.6 4.2 Q-2.2 1.0 -1.4 -1.6" />
      <path {...THIN} fill={C.grassDeep} d="M-1.6 1.2 Q-2.9 0.7 -3.2 -0.2 Q-2.0 0.2 -1.6 1.2 Z" />
      <path {...THIN} fill={C.grassDeep} d="M-1.3 0.0 Q-0.1 -0.4 0.2 -1.3 Q-0.8 -0.9 -1.3 0.0 Z" />
      <rect {...LINE} x={2.2} y={1.0} width={4.2} height={3.4} rx={0.3} fill={C.snow} />
      <path {...LINE} fill={C.gold} d="M1.0 1.0 Q2.8 -2.2 4.3 -2.2 Q5.8 -2.2 7.6 1.0 Q4.3 1.8 1.0 1.0 Z" />
      <path {...THIN} fill="none" d="M4.3 -2.2 V-3.0" />
      <path {...LINE} fill={C.brownDeep} d="M3.6 4.4 V3.4 Q3.6 2.8 4.3 2.8 Q5.0 2.8 5.0 3.4 V4.4 Z" />
      <path {...SHINE} d="M-6.4 5.6 Q-5.4 5.2 -4.4 5.6 M1.0 6.0 Q2.0 5.6 3.0 6.0" fill="none" />
    </g>
  ),

  /* 浙江 · 西湖：拱桥 + 湖心亭 + 荷叶 */
  'lake-temple': () => (
    <g>
      <path {...LINE} fill={C.water} d="M-8.8 3.6 Q-4.4 2.6 0 3.2 Q4.4 3.8 8.8 2.8 L8.8 7.8 L-8.8 7.8 Z" />
      <path {...LINE} fill={C.snow} d="M-7.6 5.4 Q0 -3.0 7.6 5.4 Z" />
      <path {...LINE} fill={C.water} d="M-4.6 5.4 Q0 1.8 4.6 5.4 Z" />
      <rect {...LINE} x={-1.8} y={-1.6} width={3.6} height={2.8} rx={0.4} fill={C.snow} />
      <path {...LINE} fill={C.gold} d="M-3.1 -1.6 Q-1.8 -4.2 0 -4.2 Q1.8 -4.2 3.1 -1.6 Q0 -0.8 -3.1 -1.6 Z" />
      <path {...THIN} fill="none" d="M0 -4.2 V-5.0" />
      <path {...LINE} fill={C.brownDeep} d="M-0.6 -0.2 V-0.8 Q-0.6 -1.4 0 -1.4 Q0.6 -1.4 0.6 -0.8 V-0.2 Z" />
      <ellipse {...THIN} cx={-6.0} cy={6.6} rx={1.8} ry={0.7} fill={C.grass} />
      <circle {...THIN} cx={-6.0} cy={5.8} r={0.9} fill={C.pink} />
      <path {...SHINE} d="M-5.2 4.8 Q-4.2 4.4 -3.2 4.8 M2.4 5.4 Q3.4 5.0 4.4 5.4" fill="none" />
    </g>
  ),

  /* 安徽 · 黄山：双峰 + 迎客松 + 云海 */
  mountain: () => (
    <g>
      <circle {...THIN} cx={-6.4} cy={-5.4} r={1.5} fill={C.gold} />
      <path {...LINE} fill="#a9bfa0" d="M-8.6 5.8 L-4.8 -3.2 Q-4.0 -5.0 -3.2 -3.2 L0.8 5.8 Z" />
      <path {...LINE} fill="#86b878" d="M-1.4 5.8 L3.0 -4.6 Q3.8 -6.4 4.6 -4.6 L8.6 5.8 Z" />
      <path fill={C.snow} opacity={0.85} d="M-9 2.6 Q-4.4 1.4 0 2.2 Q4.4 3.0 9 1.8 L9 3.4 Q4.4 4.6 0 3.8 Q-4.4 3.0 -9 4.2 Z" />
      <path {...THIN} fill="none" stroke={C.brownDeep} d="M-4.0 -4.2 V-5.0" />
      <path {...LINE} fill={C.grassDeep} d="M-4.0 -7.9 L-2.5 -4.9 Q-4.0 -4.2 -5.5 -4.9 Z" />
      <path {...THIN} fill={C.grass} d="M-4.0 -6.5 L-3.1 -4.9 Q-4.0 -4.5 -4.9 -4.9 Z" />
      <path {...LINE} fill={C.grass} d="M-9 5.8 Q0 5.0 9 5.8 L9 7.8 L-9 7.8 Z" />
      <path {...THIN} fill="none" d="M5.2 -7.6 Q6.0 -8.3 6.8 -7.6 Q7.6 -8.3 8.4 -7.6" />
    </g>
  ),

  /* 福建 · 福建土楼：圆形土楼 + 瓦顶 + 圆窗 */
  tulou: () => (
    <g>
      <path {...LINE} fill={C.grass} d="M-9 7.0 Q0 6.2 9 7.0 L9 7.8 L-9 7.8 Z" />
      <rect {...LINE} x={-7.2} y={0.0} width={14.4} height={7.2} rx={2.8} fill={C.sand} />
      <path {...LINE} fill={C.tile} d="M-8.4 0.0 Q-7.4 -2.6 -3.8 -2.6 H3.8 Q7.4 -2.6 8.4 0.0 Q4.2 0.8 0 0.6 Q-4.2 0.8 -8.4 0.0 Z" />
      <path {...THIN} fill="none" stroke={C.gold} d="M-4.6 -2.2 Q0 -1.4 4.6 -2.2" />
      <circle {...THIN} cx={0} cy={-2.9} r={0.6} fill={C.gold} />
      <path {...THIN} fill="none" stroke={C.sandDeep} d="M-5.6 0.8 Q-6.6 3.4 -5.4 6.2 M5.6 0.8 Q6.6 3.4 5.4 6.2" />
      <rect {...THIN} x={-3.9} y={1.6} width={1.1} height={1.1} rx={0.25} fill={C.brownDeep} />
      <rect {...THIN} x={-0.55} y={1.6} width={1.1} height={1.1} rx={0.25} fill={C.brownDeep} />
      <rect {...THIN} x={2.8} y={1.6} width={1.1} height={1.1} rx={0.25} fill={C.brownDeep} />
      <path {...LINE} fill={C.brownDeep} d="M-1.4 7.0 V4.6 Q-1.4 3.4 0 3.4 Q1.4 3.4 1.4 4.6 V7.0 Z" />
      <path {...SHINE} d="M-6.0 -0.8 Q-3.2 -2.2 -0.6 -2.3" fill="none" opacity={0.6} />
    </g>
  ),

  /* 江西 · 滕王阁：三层飞檐楼阁 + 塔尖 */
  pagoda: () => (
    <g>
      <rect {...LINE} x={-6.2} y={6.2} width={12.4} height={1.4} rx={0.5} fill={C.stone} />
      <rect {...LINE} x={-3.6} y={-2.6} width={7.2} height={1.6} rx={0.4} fill={C.red} />
      <rect {...LINE} x={-2.0} y={-6.0} width={4.0} height={1.0} rx={0.3} fill={C.red} />
      <rect {...LINE} x={-5.4} y={2.2} width={10.8} height={4.2} rx={0.5} fill={C.red} />
      <path {...LINE} fill={C.gold} d="M-7.8 2.4 Q-5.8 -1.2 -3.8 -1.2 H3.8 Q5.8 -1.2 7.8 2.4 Q3.8 3.2 0 3.0 Q-3.8 3.2 -7.8 2.4 Z" />
      <path {...LINE} fill={C.gold} d="M-5.6 -2.6 Q-4.0 -5.2 -2.6 -5.2 H2.6 Q4.0 -5.2 5.6 -2.6 Q2.8 -1.8 0 -2.0 Q-2.8 -1.8 -5.6 -2.6 Z" />
      <path {...LINE} fill={C.gold} d="M-3.6 -6.0 Q-2.4 -8.0 -1.2 -8.0 H1.2 Q2.4 -8.0 3.6 -6.0 Q1.8 -5.4 0 -5.5 Q-1.8 -5.4 -3.6 -6.0 Z" />
      <path {...THIN} fill="none" d="M0 -8.0 V-8.4" />
      <path {...LINE} fill={C.brownDeep} d="M-1.4 6.4 V4.2 Q-1.4 3.0 0 3.0 Q1.4 3.0 1.4 4.2 V6.4 Z" />
      <rect {...THIN} x={-2.3} y={-2.4} width={0.8} height={0.9} rx={0.2} fill={C.brownDeep} />
      <rect {...THIN} x={1.5} y={-2.4} width={0.8} height={0.9} rx={0.2} fill={C.brownDeep} />
      <rect x={-4.6} y={3.0} width={0.7} height={2.2} rx={0.3} fill="#ffffff" opacity={0.45} />
    </g>
  ),

  /* 山东 · 泰山：日出 + 主峰 + 十八盘 + 云海 */
  'mountain-sunrise': () => (
    <g>
      <circle {...THIN} cx={5.4} cy={-4.4} r={2.2} fill={C.gold} />
      <path {...LINE} fill="#a9bf9a" d="M-9 6.0 L-0.6 -6.0 Q0.2 -7.2 1.0 -6.0 L9 6.0 Z" />
      <path fill="#8fae85" d="M0.2 -7.2 L1.0 -6.0 L9 6.0 L0.2 6.0 Z" />
      <path fill={C.snow} opacity={0.85} d="M-9 2.2 Q-4.6 1.0 0 1.8 Q4.6 2.6 9 1.4 L9 2.9 Q4.6 4.1 0 3.3 Q-4.6 2.5 -9 3.7 Z" />
      <path fill="none" stroke="#ffffff" strokeWidth={1.2} strokeLinecap="round" d="M0.6 -4.2 L2.2 -2.4 L0.8 -0.6 L2.4 1.2" />
      <path {...LINE} fill={C.grass} d="M-9 6.0 Q0 5.2 9 6.0 L9 7.8 L-9 7.8 Z" />
      <circle cx={4.7} cy={-5.0} r={0.6} fill="#ffffff" opacity={0.8} />
    </g>
  ),

  /* 河南 · 少林寺：灰瓦红墙山门 + 灯笼 + 门钉 */
  temple: () => (
    <g>
      <rect {...LINE} x={-8.4} y={6.0} width={16.8} height={1.6} rx={0.5} fill={C.stone} />
      <rect {...LINE} x={-6.6} y={1.2} width={13.2} height={4.8} rx={0.6} fill={C.red} />
      <path {...LINE} fill={C.tile} d="M-8.8 1.4 Q-6.8 -3.0 -4.2 -3.0 H4.2 Q6.8 -3.0 8.8 1.4 Q4.5 2.4 0 2.2 Q-4.5 2.4 -8.8 1.4 Z" />
      <circle {...THIN} cx={-8.4} cy={1.2} r={0.45} fill={C.gold} />
      <circle {...THIN} cx={8.4} cy={1.2} r={0.45} fill={C.gold} />
      <path {...LINE} fill={C.brownDeep} d="M-1.8 6.0 V2.8 Q-1.8 1.4 0 1.4 Q1.8 1.4 1.8 2.8 V6.0 Z" />
      <circle cx={-1.0} cy={3.4} r={0.28} fill={C.gold} />
      <circle cx={1.0} cy={3.4} r={0.28} fill={C.gold} />
      <circle cx={-1.0} cy={4.5} r={0.28} fill={C.gold} />
      <circle cx={1.0} cy={4.5} r={0.28} fill={C.gold} />
      <circle {...THIN} cx={-4.8} cy={3.0} r={1.0} fill={C.redDeep} />
      <circle {...THIN} cx={4.8} cy={3.0} r={1.0} fill={C.redDeep} />
      <path {...THIN} fill="none" stroke={C.gold} d="M-4.8 4.0 V4.7 M4.8 4.0 V4.7" />
      <rect x={-5.8} y={2.0} width={0.7} height={2.0} rx={0.3} fill="#ffffff" opacity={0.4} />
    </g>
  ),

  /* 湖北 · 黄鹤楼：重檐楼阁 + 飞檐 + 黄鹤 */
  pavilion: () => (
    <g>
      <rect {...LINE} x={-7.4} y={6.0} width={14.8} height={1.5} rx={0.5} fill={C.stone} />
      <rect {...LINE} x={-6.0} y={1.8} width={12.0} height={4.4} rx={0.6} fill={C.red} />
      <rect {...LINE} x={-4.0} y={-2.8} width={8.0} height={1.4} rx={0.4} fill={C.red} />
      <path {...LINE} fill={C.gold} d="M-8.8 2.0 Q-7.2 -1.6 -5.2 -1.6 H5.2 Q7.2 -1.6 8.8 2.0 Q4.6 3.0 0 2.8 Q-4.6 3.0 -8.8 2.0 Z" />
      <path {...LINE} fill={C.gold} d="M-6.4 -2.8 Q-4.8 -6.2 -3.0 -6.2 H3.0 Q4.8 -6.2 6.4 -2.8 Q2.9 -2.1 0 -2.2 Q-2.9 -2.1 -6.4 -2.8 Z" />
      <circle {...THIN} cx={0} cy={-6.7} r={0.65} fill={C.gold} />
      <path {...LINE} fill={C.brownDeep} d="M-1.4 6.0 V4.0 Q-1.4 2.8 0 2.8 Q1.4 2.8 1.4 4.0 V6.0 Z" />
      <rect {...THIN} x={-2.2} y={-2.5} width={0.9} height={0.8} rx={0.2} fill={C.brownDeep} />
      <rect {...THIN} x={1.3} y={-2.5} width={0.9} height={0.8} rx={0.2} fill={C.brownDeep} />
      <path {...THIN} fill="none" d="M3.4 -7.2 Q4.1 -7.9 4.8 -7.2 M5.6 -7.6 Q6.3 -8.3 7.0 -7.6" />
      <rect x={-4.6} y={3.0} width={0.7} height={2.2} rx={0.3} fill="#ffffff" opacity={0.45} />
    </g>
  ),

  /* 湖南 · 张家界：石英砂岩峰柱 + 峰顶青松 + 云雾 */
  pillar: () => (
    <g>
      <path {...LINE} fill={C.grass} d="M-9 6.2 Q0 5.4 9 6.2 L9 7.8 L-9 7.8 Z" />
      <path {...LINE} fill="#b8b0a0" d="M-7.4 6.2 L-7.0 -3.0 Q-6.9 -4.0 -6.1 -4.0 Q-5.3 -4.0 -5.2 -3.0 L-4.8 6.2 Z" />
      <path {...LINE} fill="#a8a496" d="M4.2 6.2 L4.5 -1.6 Q4.6 -2.6 5.4 -2.6 Q6.2 -2.6 6.3 -1.6 L6.6 6.2 Z" />
      <path {...LINE} fill="#c9c3b8" d="M-1.8 6.2 L-1.5 -6.0 Q-1.4 -7.2 0 -7.2 Q1.4 -7.2 1.5 -6.0 L1.8 6.2 Z" />
      <ellipse {...THIN} cx={-6.1} cy={-4.2} rx={1.8} ry={0.8} fill={C.grass} />
      <ellipse {...THIN} cx={5.4} cy={-2.8} rx={1.5} ry={0.7} fill="#6fb868" />
      <ellipse {...THIN} cx={0} cy={-7.3} rx={2.0} ry={0.85} fill={C.grassDeep} />
      <path fill={C.snow} opacity={0.8} d="M-9 2.4 Q-4 1.6 0 2.2 Q4.6 2.8 9 1.8 L9 3.2 Q0 4.4 -9 3.6 Z" />
      <path {...SHINE} d="M-0.9 -5.2 V4.8" fill="none" opacity={0.45} />
    </g>
  ),

  /* 广东 · 广州塔：小蛮腰 + 斜撑塔身 + 天线 */
  tower: () => (
    <g>
      <path {...LINE} fill={C.water} d="M-9 6.8 Q0 6.0 9 6.8 L9 7.8 L-9 7.8 Z" />
      <path {...LINE} fill="#c9d8ea" d="M-5.2 6.6 C-4.0 3.0 -1.7 -0.2 -0.8 -2.6 H0.8 C1.7 -0.2 4.0 3.0 5.2 6.6 Z" />
      <path {...LINE} fill="#b8d4f0" d="M-0.8 -2.6 L-2.2 -5.8 Q-1.1 -6.2 0 -6.2 Q1.1 -6.2 2.2 -5.8 L0.8 -2.6 Z" />
      <path {...LINE} fill="none" d="M0 -6.2 V-8.0" />
      <circle cx={0} cy={-8.1} r={0.3} fill={C.gold} />
      <rect {...LINE} x={-5.8} y={6.2} width={11.6} height={1.1} rx={0.5} fill={C.stone} />
      <path {...SHINE} d="M-2.7 3.6 Q-3.3 4.8 -2.7 5.8 M-1.3 -1.2 Q-1.7 0.2 -1.1 1.6" fill="none" opacity={0.6} />
    </g>
  ),

  /* 广西 · 桂林山水：圆润喀斯特峰丛 + 江水 + 小船 */
  karst: () => (
    <g>
      <path {...LINE} fill="#8fbf86" d="M-7.5 3.4 Q-7.2 -2.2 -4.8 -3.8 Q-2.4 -5.2 -0.6 -3.8 Q1.4 -2.2 1.6 3.4 Z" />
      <path {...LINE} fill="#a9d49a" d="M0.6 3.4 Q1.2 -1.4 3.0 -2.8 Q4.6 -3.8 5.8 -2.8 Q7.6 -1.4 8.4 3.4 Z" />
      <path {...LINE} fill={C.water} d="M-9 3.2 Q-4.4 2.4 0 3.0 Q4.4 3.6 9 2.8 L9 7.8 L-9 7.8 Z" />
      <path fill="none" stroke="#ffffff" strokeWidth={1.1} strokeLinecap="round" d="M-5.0 5.0 Q-4.2 4.6 -3.4 5.0 M2.2 5.6 Q3.0 5.2 3.8 5.6 M-1.2 6.6 Q-0.4 6.2 0.4 6.6" />
      <path {...THIN} fill={C.snow} d="M-0.4 6.1 L2.4 6.1 L1.6 6.9 L0.4 6.9 Z" />
      <path {...THIN} fill="none" stroke={C.brownDeep} d="M1.0 6.1 V4.6" />
    </g>
  ),

  /* 海南 · 天涯海角：弯椰树 + 沙滩 + 三片椰叶 */
  palm: () => (
    <g>
      <path {...LINE} fill={C.sand} d="M-9 6.2 Q-4 5.2 0 5.9 Q4.6 6.6 9 5.4 L9 7.8 L-9 7.8 Z" />
      <path {...LINE} fill={C.brown} d="M-1.6 6.4 Q-2.8 2.2 -1.2 -1.0 Q-0.2 -3.2 1.4 -4.0 L2.5 -3.0 Q1.0 -2.2 0.5 0.0 Q-0.4 3.0 0.4 6.4 Z" />
      <path {...LINE} fill={C.grassDeep} d="M1.6 -3.7 Q-2.2 -6.6 -6.4 -5.8 Q-2.6 -4.2 0.2 -3.4 Z" />
      <path {...LINE} fill="#6fbf72" d="M2.0 -3.6 Q5.4 -7.0 8.6 -5.6 Q5.0 -4.0 2.0 -3.2 Z" />
      <path {...LINE} fill="#4f9e63" d="M1.9 -3.8 Q1.2 -7.4 3.4 -8.4 Q3.6 -6.0 2.6 -3.8 Z" />
      <circle {...THIN} cx={1.0} cy={-2.8} r={0.85} fill={C.brownDeep} />
      <circle {...THIN} cx={2.3} cy={-2.6} r={0.8} fill={C.brownDeep} />
      <path {...SHINE} d="M-5.0 -5.4 Q-3.4 -5.0 -1.8 -4.4" fill="none" opacity={0.5} />
    </g>
  ),

  /* 重庆 · 洪崖洞：吊脚楼两层灯火 + 江面 */
  stilt: () => (
    <g>
      <path {...LINE} fill={C.water} d="M-9 6.9 Q0 6.3 9 6.9 L9 7.8 L-9 7.8 Z" />
      <path {...THIN} fill="none" stroke={C.brownDeep} d="M-4.8 5.0 V7.0 M-1.6 5.0 V7.0 M1.6 5.0 V7.0 M4.8 5.0 V7.0" />
      <rect {...LINE} x={-6.4} y={2.0} width={12.8} height={3.2} rx={0.4} fill={C.red} />
      <rect {...THIN} x={-4.3} y={2.8} width={1.6} height={1.6} rx={0.3} fill={C.gold} />
      <rect {...THIN} x={-0.8} y={2.8} width={1.6} height={1.6} rx={0.3} fill={C.gold} />
      <rect {...THIN} x={2.7} y={2.8} width={1.6} height={1.6} rx={0.3} fill={C.gold} />
      <path {...LINE} fill={C.tile} d="M-7.6 2.0 Q-6.0 -0.2 -4.0 -0.2 H4.0 Q6.0 -0.2 7.6 2.0 Q4.0 2.8 0 2.6 Q-4.0 2.8 -7.6 2.0 Z" />
      <rect {...LINE} x={-5.4} y={-3.6} width={10.8} height={3.2} rx={0.4} fill={C.red} />
      <rect {...THIN} x={-3.6} y={-2.7} width={1.5} height={1.5} rx={0.3} fill={C.gold} />
      <rect {...THIN} x={-0.75} y={-2.7} width={1.5} height={1.5} rx={0.3} fill={C.gold} />
      <rect {...THIN} x={2.1} y={-2.7} width={1.5} height={1.5} rx={0.3} fill={C.gold} />
      <path {...LINE} fill={C.tile} d="M-6.6 -3.6 Q-5.2 -6.0 -3.4 -6.0 H3.4 Q5.2 -6.0 6.6 -3.6 Q3.4 -2.8 0 -3.0 Q-3.4 -2.8 -6.6 -3.6 Z" />
      <circle {...THIN} cx={0} cy={-6.4} r={0.55} fill={C.gold} />
      <path {...SHINE} d="M-5.6 -0.6 Q-3.0 -0.1 0 -0.3" fill="none" opacity={0.5} />
    </g>
  ),

  /* 四川 · 熊猫基地：熊猫大脸 + 黑耳黑眼圈 + 竹叶 */
  panda: () => (
    <g>
      <circle {...LINE} cx={-4.2} cy={-4.6} r={2.2} fill="#3f3a35" />
      <circle {...LINE} cx={4.2} cy={-4.6} r={2.2} fill="#3f3a35" />
      <circle {...LINE} cx={0} cy={0.4} r={6.0} fill={C.snow} />
      <ellipse {...LINE} cx={-2.4} cy={-0.2} rx={1.5} ry={2.0} transform="rotate(-14 -2.4 -0.2)" fill="#3f3a35" />
      <ellipse {...LINE} cx={2.4} cy={-0.2} rx={1.5} ry={2.0} transform="rotate(14 2.4 -0.2)" fill="#3f3a35" />
      <circle cx={-2.1} cy={-0.5} r={0.55} fill="#ffffff" />
      <circle cx={2.1} cy={-0.5} r={0.55} fill="#ffffff" />
      <ellipse {...THIN} cx={0} cy={2.0} rx={0.9} ry={0.65} fill="#3f3a35" />
      <path {...THIN} fill="none" d="M-0.8 2.7 Q0 3.5 0.8 2.7" />
      <path {...THIN} fill={C.grass} d="M0.9 3.0 Q2.6 2.6 3.5 3.7 Q1.9 4.0 0.9 3.0 Z" />
      <circle cx={-4.0} cy={2.4} r={1.0} fill="#f6c8c8" opacity={0.9} />
      <circle cx={4.0} cy={2.4} r={1.0} fill="#f6c8c8" opacity={0.9} />
      <circle cx={0.9} cy={1.8} r={0.28} fill="#ffffff" />
    </g>
  ),

  /* 贵州 · 黄果树瀑布：崖壁 + 白练 + 水雾 + 崖顶松 */
  waterfall: () => (
    <g>
      <path {...LINE} fill="#b3c0a4" d="M-9 7.8 V-1.8 Q-9 -5.2 -6.2 -5.2 Q-5.0 -5.2 -4.6 -4.0 L-3.6 7.8 Z" />
      <path {...LINE} fill="#b3c0a4" d="M9 7.8 V-1.8 Q9 -5.2 6.2 -5.2 Q5.0 -5.2 4.6 -4.0 L3.6 7.8 Z" />
      <path {...LINE} fill={C.water} d="M-3.4 -3.2 Q0 -4.2 3.4 -3.2 L2.8 6.4 Q0 7.6 -2.8 6.4 Z" />
      <path fill="none" stroke="#ffffff" strokeWidth={1.1} strokeLinecap="round" d="M-2.0 -2.8 V5.8 M0 -3.1 V6.2 M2.0 -2.8 V5.8" />
      <path {...THIN} fill="none" stroke={C.waterDeep} d="M-3.8 -4.6 Q0 -5.8 3.8 -4.6" />
      <path {...LINE} fill={C.grassDeep} d="M-7.2 -5.0 L-6.2 -7.6 L-5.2 -5.0 Z" />
      <path {...LINE} fill={C.grass} d="M5.2 -5.0 L6.2 -7.2 L7.2 -5.0 Z" />
      <circle cx={-2.4} cy={6.4} r={1.3} fill="#ffffff" opacity={0.9} />
      <circle cx={2.6} cy={6.5} r={1.2} fill="#ffffff" opacity={0.9} />
      <ellipse cx={0.2} cy={6.8} rx={2.1} ry={0.9} fill="#ffffff" opacity={0.8} />
    </g>
  ),

  /* 云南 · 大理三塔：一高两矮三座白塔 + 塔尖 */
  'three-pagoda': () => (
    <g>
      <path {...LINE} fill="#c8e6b0" d="M-9 6.8 Q0 6.0 9 6.8 L9 7.8 L-9 7.8 Z" />
      <path {...LINE} fill={C.cream} d="M-3.0 6.4 L-2.2 -2.2 H2.2 L3.0 6.4 Z" />
      <path {...THIN} fill="none" d="M-3.6 -2.2 H3.6 M-3.4 0.8 H3.4 M-3.2 3.6 H3.2" />
      <path {...LINE} fill={C.gold} d="M-3.4 -2.2 L0 -4.4 L3.4 -2.2 Z" />
      <path {...THIN} fill="none" d="M0 -4.4 V-6.6" />
      <path {...THIN} fill="none" d="M-0.9 -5.2 H0.9 M-0.7 -6.0 H0.7" />
      <path {...LINE} fill={C.brownDeep} d="M-1.2 6.4 V4.8 Q-1.2 4.0 0 4.0 Q1.2 4.0 1.2 4.8 V6.4 Z" />
      <path {...LINE} fill={C.cream} d="M-7.4 6.4 L-6.9 -0.4 H-5.1 L-4.6 6.4 Z" />
      <path {...THIN} fill="none" d="M-7.7 -0.4 H-4.3 M-7.5 2.4 H-4.5" />
      <path {...LINE} fill={C.gold} d="M-7.6 -0.4 L-6.0 -2.8 L-4.4 -0.4 Z" />
      <path {...THIN} fill="none" d="M-6.0 -2.8 V-4.6" />
      <path {...LINE} fill={C.cream} d="M4.6 6.4 L5.1 -0.4 H6.9 L7.4 6.4 Z" />
      <path {...THIN} fill="none" d="M4.3 -0.4 H7.7 M4.5 2.4 H7.5" />
      <path {...LINE} fill={C.gold} d="M4.4 -0.4 L6.0 -2.8 L7.6 -0.4 Z" />
      <path {...THIN} fill="none" d="M6.0 -2.8 V-4.6" />
      <path {...SHINE} d="M-1.6 -1.4 V4.6" fill="none" opacity={0.5} />
    </g>
  ),

  /* 西藏 · 布达拉宫：白宫红宫 + 金顶 + 山体 */
  potala: () => (
    <g>
      <path {...LINE} fill="#a9b89a" d="M-9 4.4 Q-4.4 2.2 0 3.4 Q4.6 4.6 9 2.6 L9 7.8 L-9 7.8 Z" />
      <rect {...LINE} x={-6.8} y={-1.4} width={3.8} height={5.4} rx={0.3} fill={C.snow} />
      <rect {...LINE} x={3.0} y={-1.4} width={3.8} height={5.4} rx={0.3} fill={C.snow} />
      <rect {...LINE} x={-3.4} y={-3.4} width={6.8} height={7.4} rx={0.3} fill={C.redDeep} />
      <path {...LINE} fill={C.gold} d="M-4.2 -3.4 Q-2.6 -6.0 -1.4 -6.0 H1.4 Q2.6 -6.0 4.2 -3.4 Q2.0 -2.6 0 -2.8 Q-2.0 -2.6 -4.2 -3.4 Z" />
      <circle {...THIN} cx={0} cy={-6.4} r={0.55} fill={C.gold} />
      <path {...LINE} fill={C.brownDeep} d="M-1.4 4.0 V3.0 Q-1.4 2.2 0 2.2 Q1.4 2.2 1.4 3.0 V4.0 Z" />
      <path {...SHINE} d="M-2.8 -4.2 Q0 -4.9 2.8 -4.2" fill="none" opacity={0.6} />
    </g>
  ),

  /* 陕西 · 兵马俑：Q 版陶俑（发髻 + 甲胄 + 护肩） */
  warrior: () => (
    <g>
      <path {...LINE} fill={C.sandDeep} d="M-6.2 7.6 Q-6.4 3.4 -4.6 2.0 Q-2.4 0.9 0 0.9 Q2.4 0.9 4.6 2.0 Q6.4 3.4 6.2 7.6 Z" />
      <ellipse {...LINE} cx={-5.2} cy={2.4} rx={1.6} ry={1.4} fill={C.redDeep} />
      <ellipse {...LINE} cx={5.2} cy={2.4} rx={1.6} ry={1.4} fill={C.redDeep} />
      <path {...THIN} fill="none" stroke="#a9743f" d="M-3.8 4.0 Q0 5.0 3.8 4.0 M-4.0 5.6 Q0 6.6 4.0 5.6" />
      <circle {...LINE} cx={0} cy={-2.4} r={3.3} fill={C.sand} />
      <circle {...LINE} cx={0.6} cy={-5.8} r={1.2} fill={C.brownDeep} />
      <path {...THIN} fill="none" stroke={C.brownDeep} d="M-3.0 -3.6 Q0 -4.6 3.0 -3.6" />
      <path {...THIN} fill="none" d="M-2.3 -3.1 L-0.9 -2.8 M0.9 -2.8 L2.3 -3.1" />
      <circle cx={-1.5} cy={-2.1} r={0.4} fill={C.ink} />
      <circle cx={1.5} cy={-2.1} r={0.4} fill={C.ink} />
      <path {...THIN} fill="none" d="M-0.8 -0.9 Q0 -0.3 0.8 -0.9" />
      <path {...THIN} fill="none" d="M-2.0 0.1 Q0 1.6 2.0 0.1" />
      <path {...SHINE} d="M-4.4 3.4 Q-5.0 4.6 -4.6 5.8" fill="none" opacity={0.4} />
    </g>
  ),

  /* 甘肃 · 莫高窟：砂崖 + 三座洞窟 + 金佛 */
  grotto: () => (
    <g>
      <path {...LINE} fill={C.sand} d="M-8 7.8 V-1.8 Q-8 -5.2 -4.4 -5.2 Q-1.6 -5.2 0 -4.4 Q1.6 -5.2 4.4 -5.2 Q8 -5.2 8 -1.8 V7.8 Z" />
      <path {...LINE} fill={C.brownDeep} d="M-2.4 4.6 V-0.2 Q-2.4 -3.8 0 -3.8 Q2.4 -3.8 2.4 -0.2 V4.6 Z" />
      <path {...LINE} fill={C.brownDeep} d="M-6.4 2.6 V0.4 Q-6.4 -1.4 -5.4 -1.4 Q-4.4 -1.4 -4.4 0.4 V2.6 Z" />
      <path {...LINE} fill={C.brownDeep} d="M4.4 2.6 V0.4 Q4.4 -1.4 5.4 -1.4 Q6.4 -1.4 6.4 0.4 V2.6 Z" />
      <circle {...THIN} cx={0} cy={-0.6} r={0.85} fill={C.gold} />
      <path {...THIN} fill={C.gold} d="M-1.3 4.4 Q-1.3 0.8 0 0.4 Q1.3 0.8 1.3 4.4 Z" />
      <path {...SHINE} d="M-6.6 -3.2 Q-4.4 -4.4 -2.6 -4.2" fill="none" opacity={0.5} />
    </g>
  ),

  /* 青海 · 青海湖：远山雪峰 + 草滩 + 大湖 + 飞鸟 */
  lake: () => (
    <g>
      <path {...LINE} fill="#a9c4e0" d="M-8.8 2.0 L-5.2 -3.8 L-1.6 2.0 Z" />
      <path {...LINE} fill={C.snow} d="M-7.0 -0.8 L-5.2 -3.8 L-3.4 -0.8 Q-4.3 0.0 -5.2 -0.5 Q-6.1 0.0 -7.0 -0.8 Z" />
      <path {...LINE} fill="#8fb0d0" d="M-2.8 2.0 L1.4 -4.8 L5.6 2.0 Z" />
      <path {...LINE} fill={C.snow} d="M-0.2 -1.2 L1.4 -4.8 L3.0 -1.2 Q1.6 -0.3 1.4 -0.8 Q1.2 -0.3 -0.2 -1.2 Z" />
      <path {...LINE} fill={C.grass} d="M-9 1.8 Q0 0.8 9 1.8 L9 3.6 Q0 2.6 -9 3.6 Z" />
      <path {...LINE} fill={C.water} d="M-9 3.4 Q-4.4 2.6 0 3.2 Q4.4 3.8 9 2.8 L9 6.8 Q4.4 7.8 0 7.2 Q-4.4 6.6 -9 7.4 Z" />
      <path fill="none" stroke="#ffffff" strokeWidth={1.0} strokeLinecap="round" d="M-5.0 5.0 Q-4.0 4.6 -3.0 5.0 M2.0 5.6 Q3.0 5.2 4.0 5.6" />
      <path {...LINE} fill={C.grass} d="M-9 6.6 Q0 5.8 9 6.6 L9 7.8 L-9 7.8 Z" />
      <path {...THIN} fill="none" stroke={C.grassDeep} d="M-6.4 7.2 Q-6.0 6.4 -5.4 7.0 M5.4 7.0 Q5.8 6.2 6.4 6.8" />
      <circle cx={-7.4} cy={7.2} r={0.4} fill={C.gold} />
      <circle cx={7.6} cy={7.1} r={0.4} fill={C.gold} />
      <path {...THIN} fill="none" d="M-6.6 -4.6 Q-5.8 -5.5 -5.0 -4.6 Q-4.2 -5.5 -3.4 -4.6" />
      <path {...THIN} fill="none" d="M0.6 -6.2 Q1.2 -6.9 1.8 -6.2 Q2.4 -6.9 3.0 -6.2" />
    </g>
  ),

  /* 宁夏 · 沙坡头：沙丘 + 双峰骆驼 + 落日 */
  camel: () => (
    <g>
      <circle {...THIN} cx={-6.6} cy={-5.0} r={1.8} fill={C.gold} />
      <path {...LINE} fill={C.sand} d="M-9 2.8 Q-4.4 0.2 0 1.8 Q4.6 3.4 9 1.0 L9 7.8 L-9 7.8 Z" />
      <path {...LINE} fill={C.sandDeep} d="M-4.6 0.8 Q-4.8 -3.0 -2.2 -3.0 Q-0.6 -3.0 0 -1.1 Q0.5 -3.2 2.8 -3.2 Q4.6 -3.2 4.7 -1.2 Q5.3 -1.5 5.3 -2.8 Q5.4 -3.8 6.2 -4.0 Q7.2 -4.3 7.4 -3.3 Q7.6 -2.6 6.8 -2.4 Q6.1 -2.2 6.0 -1.2 Q5.7 0.3 5.0 0.8 Z" />
      <path {...THIN} fill={C.sandDeep} d="M6.4 -4.0 L6.8 -4.8 L7.0 -4.0 Z" />
      <path fill="none" stroke="#a9743f" strokeWidth={1.4} strokeLinecap="round" d="M-2.6 1.2 V4.2 M-0.2 1.4 V4.4 M3.0 1.2 V4.2 M4.2 1.4 V4.0" />
      <path fill="none" stroke={C.sandDeep} strokeWidth={1.2} strokeLinecap="round" d="M-4.6 0.2 Q-5.6 0.4 -5.6 1.6" />
      <circle cx={6.3} cy={-3.1} r={0.32} fill={C.ink} />
      <path {...THIN} fill="none" stroke={C.sandDeep} d="M-6.0 5.4 Q-2.0 6.4 2.0 5.6" />
      <path {...SHINE} d="M-7.2 -5.5 Q-6.6 -6.1 -6.0 -5.5" fill="none" opacity={0.7} />
    </g>
  ),

  /* 新疆 · 葡萄沟：紫葡萄串 + 两片叶 + 卷须 */
  grape: () => (
    <g transform="translate(0 1.1)">
      <circle {...LINE} cx={-2.8} cy={-1.5} r={1.4} fill={C.night} />
      <circle {...LINE} cx={0} cy={-1.5} r={1.4} fill={C.night} />
      <circle {...LINE} cx={2.8} cy={-1.5} r={1.4} fill={C.night} />
      <circle {...LINE} cx={-1.4} cy={0.9} r={1.4} fill={C.night} />
      <circle {...LINE} cx={1.4} cy={0.9} r={1.4} fill={C.night} />
      <circle {...LINE} cx={0} cy={3.3} r={1.4} fill={C.night} />
      <path {...THIN} fill="none" stroke={C.brownDeep} d="M0 -2.9 Q-0.2 -4.4 1.2 -5.0" />
      <path {...LINE} fill={C.grassDeep} d="M0.6 -4.8 Q-2.0 -7.4 -4.8 -6.2 Q-3.0 -4.0 0.6 -4.8 Z" />
      <path {...LINE} fill="#6fb868" d="M1.4 -5.0 Q3.2 -7.2 5.4 -6.4 Q4.2 -4.6 1.4 -5.0 Z" />
      <path {...THIN} fill="none" stroke={C.brown} d="M-0.8 -4.9 Q-2.8 -6.6 -1.8 -7.7 Q-1.0 -8.4 -0.6 -7.6" />
      <circle cx={-3.1} cy={-1.9} r={0.32} fill="#ffffff" opacity={0.8} />
      <circle cx={0.3} cy={0.6} r={0.3} fill="#ffffff" opacity={0.8} />
    </g>
  ),

  /* 台湾 · 台北 101：竹节塔身 + 塔尖 + 塔基 */
  'tower-101': () => (
    <g>
      <path {...LINE} fill="#c8e6b0" d="M-9 7.2 Q0 6.5 9 7.2 L9 7.8 L-9 7.8 Z" />
      <rect {...LINE} x={-5.0} y={5.2} width={10.0} height={2.2} rx={0.5} fill="#c9c3d8" />
      <path {...LINE} fill="#a8dcd8" d="M-3.4 5.4 L-4.0 3.4 H4.0 L3.4 5.4 Z" />
      <path {...LINE} fill="#b8e4e0" d="M-3.1 3.4 L-3.7 1.4 H3.7 L3.1 3.4 Z" />
      <path {...LINE} fill="#a8dcd8" d="M-2.8 1.4 L-3.4 -0.6 H3.4 L2.8 1.4 Z" />
      <path {...LINE} fill="#b8e4e0" d="M-2.5 -0.6 L-3.1 -2.6 H3.1 L2.5 -0.6 Z" />
      <path {...LINE} fill="#a8dcd8" d="M-2.2 -2.6 L-2.8 -4.6 H2.8 L2.2 -2.6 Z" />
      <path {...LINE} fill="#c9c3d8" d="M-2.6 -4.6 H2.6 L1.6 -5.6 H-1.6 Z" />
      <path {...LINE} fill="none" d="M0 -5.6 V-8.0" />
      <circle cx={0.45} cy={-8.15} r={0.32} fill={C.gold} />
      <path {...SHINE} d="M-3.0 5.0 L-3.5 3.4 L-3.0 1.4 L-3.2 -0.6" fill="none" opacity={0.6} />
    </g>
  ),

  /* 香港 · 维多利亚港：夜景天际线 + 月亮 + 红帆船 */
  skyline: () => (
    <g>
      <circle {...THIN} cx={-6.4} cy={-4.8} r={1.8} fill={C.gold} />
      <circle cx={-6.9} cy={-5.3} r={0.45} fill="#ffffff" opacity={0.8} />
      <rect {...LINE} x={-8.4} y={-1.0} width={3.2} height={5.8} rx={0.2} fill="#b8d4f0" />
      <rect {...LINE} x={-4.6} y={-3.0} width={3.2} height={7.8} rx={0.2} fill={C.night} />
      <rect {...LINE} x={-0.8} y={-4.8} width={3.4} height={9.6} rx={0.2} fill="#a8c4e8" />
      <path {...LINE} fill="none" d="M0.9 -4.8 V-6.6" />
      <rect {...LINE} x={3.2} y={-2.2} width={3.0} height={7.0} rx={0.2} fill={C.night} />
      <rect {...LINE} x={6.8} y={0.4} width={2.0} height={4.4} rx={0.2} fill="#b8d4f0" />
      <path {...LINE} fill={C.water} d="M-9 4.8 Q0 4.2 9 4.8 L9 7.6 L-9 7.6 Z" />
      <path fill="none" stroke="#ffffff" strokeWidth={1.0} strokeLinecap="round" d="M-5.8 6.2 V6.9 M-0.8 6.0 V6.8 M4.6 6.2 V7.0" />
      <path {...LINE} fill={C.red} d="M-2.6 5.4 L2.6 5.4 L1.8 6.4 L-1.8 6.4 Z" />
      <path {...THIN} fill={C.red} d="M-0.4 5.2 V3.2 L1.9 5.2 Z" />
    </g>
  ),

  /* 澳门 · 大三巴牌坊：巴洛克立面 + 三拱门 + 十字架 */
  arch: () => (
    <g>
      <rect {...LINE} x={-7.8} y={7.0} width={15.6} height={0.9} rx={0.2} fill={C.stoneDeep} />
      <rect {...LINE} x={-7.0} y={6.2} width={14.0} height={0.9} rx={0.2} fill={C.stone} />
      <rect {...LINE} x={-6.2} y={1.2} width={12.4} height={5.0} rx={0.2} fill={C.stone} />
      <path {...THIN} fill="none" stroke={C.stoneDeep} d="M-4.8 1.6 V6.0 M-1.6 1.6 V6.0 M1.6 1.6 V6.0 M4.8 1.6 V6.0" />
      <path {...LINE} fill={C.brownDeep} d="M-1.5 6.2 V3.6 Q-1.5 2.2 0 2.2 Q1.5 2.2 1.5 3.6 V6.2 Z" />
      <path {...LINE} fill={C.brownDeep} d="M-5.6 6.2 V4.8 Q-5.6 4.0 -4.8 4.0 Q-4.0 4.0 -4.0 4.8 V6.2 Z" />
      <path {...LINE} fill={C.brownDeep} d="M4.0 6.2 V4.8 Q4.0 4.0 4.8 4.0 Q5.6 4.0 5.6 4.8 V6.2 Z" />
      <rect {...LINE} x={-4.4} y={-2.6} width={8.8} height={3.8} rx={0.2} fill={C.stone} />
      <path {...THIN} fill="none" stroke={C.stoneDeep} d="M-3.4 -2.2 V0.8 M3.4 -2.2 V0.8" />
      <path {...LINE} fill={C.brownDeep} d="M-0.7 -0.2 V-1.8 Q-0.7 -2.4 0 -2.4 Q0.7 -2.4 0.7 -1.8 V-0.2 Z" />
      <path {...LINE} fill={C.stone} d="M-4.4 -2.6 L0 -5.4 L4.4 -2.6 Z" />
      <circle {...THIN} cx={0} cy={-3.7} r={0.5} fill={C.stoneDeep} />
      <path {...LINE} fill="none" d="M0 -5.4 V-7.2 M-1.0 -6.4 H1.0" />
      <rect x={-5.8} y={1.8} width={0.8} height={3.8} rx={0.2} fill="#ffffff" opacity={0.35} />
    </g>
  ),
};

/**
 * 按 kind 返回图标 SVG 内容。
 * 返回 `<g>` 片段（局部坐标：以 (0,0) 为中心，内容控制在半径 9 以内），
 * 由 LoginBackdrop.tsx 放进贴纸的圆底 / 白描边 <g> 中渲染。
 */
export function StickerIcon({ kind }: { kind: StickerIconKind }): ReactElement | null {
  const render = STICKER_ICONS[kind];
  return typeof render === 'function' ? render() : null;
}
