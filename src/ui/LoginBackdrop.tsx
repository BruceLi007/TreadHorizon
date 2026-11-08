/**
 * 登录 / Key 引导页的「Q 版 3D 中国地图」品牌背景
 * （2026-11-08 D-266 初版 → D-267 动效/透明卡 → D-268 立体化 + 地形元素 + Q 版化，方案 A）
 *
 * 为什么不用真地图：未登录时 multi 模式拿不到任何账号 Key 与数据（/api/* 除 auth/health 全 401），
 * 直接渲染 T.Map 只会是灰块。这里用项目自带的省界数据（public/province-boundaries-low.json，
 * 40KB 概化版，与统计面板省份点亮同源）搭一个「桌面立体模型」风格的 Q 版中国地图：
 * - 3D 立体感：整块地图做成有厚度的小岛模型——底面阴影 + 侧面厚度 + 顶面省份「拼图」色块 + 白色描边；
 * - 色彩丰富：按地形给各省上色（雪山 / 沙漠 / 草原 / 森林 / 平原 / 水乡 / 南方），并叠加地形元素：
 *   雪山、沙漠沙丘、湖泊（带涟漪）、森林小树、草原小羊、黄河 / 长江两条会流动的河；
 * - Q 版：圆角、厚描边、粉彩配色，云朵 / 太阳 / 小羊 / 小树 / 水波都有轻快的弹性动效；
 * - 项目自带的 marker / 家图标做成「白色圆徽章 + 彩色圈」贴在地图上，并按 14s 时间轴依次演示
 *   呼吸 → 悬停轻跳 → 点击压扁回弹 → 3D 涟漪 → 松手回弹；另有一组聚合点脉冲；
 * - 纯 SVG + CSS，无接口 / 无 Key / 无第三方资源；prefers-reduced-motion 关闭所有动效；窄屏 slice 铺满。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import type { ProvinceBoundaryData, ProvinceBoundaryFeature } from '../lib/types';
import {
  PROVINCE_STICKERS,
  StickerIcon,
  type StickerIconKind,
} from './LoginProvinceStickers';
import { MARKER_COLOR_OPTIONS, markerColorHex, type MarkerColorId } from '../lib/markerPalette';
import './LoginBackdrop.css';

/** SVG 设计画布（16:9，正好覆盖常见桌面视口） */
const VIEW_W = 1600;
const VIEW_H = 900;
/** 地图四周留白（比例） */
const MAP_PAD = 0.045;
/** 用于计算投影范围的最低纬度：排除南海诸岛那些远离主图的碎点 */
const MAINLAND_MIN_LAT = 17.5;

/** 省份 → 地形配色（色调偏粉彩、饱和度足够，拼图感更明显） */
type Terrain =
  | 'snow'
  | 'desert'
  | 'grass'
  | 'forest'
  | 'plain'
  | 'lake'
  | 'south'
  | 'basin'
  | 'loess';
const PROVINCE_TERRAIN: Record<string, Terrain> = {
  北京市: 'plain',
  天津市: 'plain',
  河北省: 'plain',
  山西省: 'loess',
  内蒙古自治区: 'grass',
  辽宁省: 'forest',
  吉林省: 'forest',
  黑龙江省: 'forest',
  上海市: 'plain',
  江苏省: 'plain',
  浙江省: 'plain',
  安徽省: 'plain',
  福建省: 'forest',
  江西省: 'plain',
  山东省: 'plain',
  河南省: 'plain',
  湖北省: 'lake',
  湖南省: 'lake',
  广东省: 'south',
  广西壮族自治区: 'south',
  海南省: 'south',
  重庆市: 'basin',
  四川省: 'basin',
  贵州省: 'south',
  云南省: 'forest',
  西藏自治区: 'snow',
  陕西省: 'loess',
  甘肃省: 'desert',
  青海省: 'snow',
  宁夏回族自治区: 'desert',
  新疆维吾尔自治区: 'desert',
  台湾省: 'south',
  香港特别行政区: 'plain',
  澳门特别行政区: 'plain',
};
/** 同类地形给 2~3 个近似色，避免整片颜色完全一样；按省名稳定取色 */
const TERRAIN_FILLS: Record<Terrain, string[]> = {
  snow: ['#dbeaf9', '#d1e3f6', '#e4f0fc'],
  desert: ['#f6dfae', '#f1d59c', '#f8e5bb'],
  grass: ['#cfe9a4', '#c5e39a', '#d7edb0'],
  forest: ['#a8d68f', '#99cb81', '#b5dda0'],
  plain: ['#e9ecb2', '#e1e7a8', '#f0f0c2'],
  lake: ['#d3eabc', '#cbe6b4', '#dbefc6'],
  south: ['#b7e29c', '#aadc91', '#c1e7a8'],
  basin: ['#d8e9aa', '#d0e3a1', '#e0edb5'],
  loess: ['#ecd8ac', '#e7d1a1', '#f0ddb6'],
};
/** 小岛模型底座颜色（侧面厚度 + 底面阴影） */
const SLAB_SIDE = '#7f8f6d';
const SLAB_SIDE_DARK = '#5f6d51';

/** 单个 marker 的实际显示尺寸（与 src/map/cluster.ts 的 SINGLE_SIZE 一致） */
const PIN_SIZE = 30;
/** 悬停卡片尺寸（2026-11-08 用户要求：把 hover 时那行字做到卡通贴里 → 加高卡片、底部留文字区） */
const CARD_W = 76;
const CARD_H = 56;
/** 卡片底部文字区高度：放「省名 + 景点名」两行 */
const CARD_TEXT_H = 20;
/** 卡片底边位置（marker 高 30 + 8 间距，卡片在 marker 正上方） */
const CARD_BOTTOM = PIN_SIZE + 8;
/** 2026-11-08 D-277（用户要求）：34 省卡通贴自动演示——每次 5 个一起弹出、2 秒后消失、循环 34 省 */
const AUTO_CARD_COUNT = 5;
const AUTO_CARD_MS = 2000;
const AUTO_CARD_BATCHES = Math.ceil(PROVINCE_STICKERS.length / AUTO_CARD_COUNT);
/** 34 省 marker 的配色：12 色相环按 (i*5+3)%12 均匀铺开（相邻省不撞色，34 张里每色 2~3 次） */
const markerColorIdFor = (i: number): MarkerColorId =>
  MARKER_COLOR_OPTIONS[(i * 5 + 3) % MARKER_COLOR_OPTIONS.length].id;

/** 与项目 MapView 的 animPhase 完全一致：由稳定 seed 派生确定性呼吸相位（3.6~5.8s + 负延迟错峰） */
function animPhase(seed: string): { dur: number; delay: number } {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = (h >>> 0) / 4294967296;
  return { dur: 3.6 + u * 2.2, delay: -(u * 6.4) };
}

/** ── 2026-11-08（用户要求）：地图打标签互动 ──
 *  鼠标移进地图范围变成「打标签」光标，点击落一个 Q 版标签：
 *  最多同时存在 5 个（第 6 个出现时最早那个播放消失动画），每个标签 10s 后自动消失。 */
const MAX_TAGS = 5;
const TAG_LIFE_MS = 10_000;
/** 消失动画时长（与 LoginBackdrop.css 的 lb-tag-out 保持一致） */
const TAG_LEAVE_MS = 340;
/** 标签徽章圈色：与地图 marker 同一套 Q 版配色循环 */
const TAG_COLORS = ['#22c55e', '#22d3ee', '#6aa9d8', '#a78bfa', '#f4ae62'];

interface MapTag {
  id: number;
  /** SVG viewBox 坐标（跟着地图一起缩放） */
  x: number;
  y: number;
  color: string;
  /** true = 正在播放消失动画，动画结束后从列表移除 */
  leaving: boolean;
}

/** 点击 marker 的 3D 地面涟漪（和项目实际点击动效一致：椭圆 + 双环错峰 560ms） */
interface PinRipple {
  id: number;
  x: number;
  y: number;
  color: string;
}

/** 地形元素（经纬度 + 尺寸系数） */
const MOUNTAINS = [
  { lng: 86.9, lat: 27.9, s: 1.35 }, // 珠峰
  { lng: 92.5, lat: 32.2, s: 1.05 }, // 唐古拉
  { lng: 94.8, lat: 36.2, s: 0.9 }, // 昆仑
  { lng: 83.6, lat: 42.9, s: 1.1 }, // 天山
  { lng: 99.0, lat: 38.4, s: 0.85 }, // 祁连
  { lng: 99.3, lat: 27.8, s: 0.95 }, // 横断
];
const DESERTS = [
  { lng: 82.0, lat: 39.2, s: 1.5 }, // 塔克拉玛干
  { lng: 89.2, lat: 40.4, s: 1.15 }, // 库姆塔格
  { lng: 104.5, lat: 41.5, s: 0.9 }, // 巴丹吉林
];
const LAKES = [
  { lng: 100.2, lat: 36.9, rx: 32, ry: 16, big: true }, // 青海湖
  { lng: 116.3, lat: 29.2, rx: 16, ry: 8.5, big: false }, // 鄱阳湖
  { lng: 112.9, lat: 29.3, rx: 18, ry: 9.5, big: false }, // 洞庭湖
  { lng: 120.2, lat: 31.2, rx: 13, ry: 7, big: false }, // 太湖
  { lng: 102.7, lat: 24.8, rx: 11, ry: 6, big: false }, // 滇池
  { lng: 117.3, lat: 48.9, rx: 12, ry: 6, big: false }, // 呼伦湖
];
const FORESTS = [
  { lng: 122.6, lat: 50.6, s: 1.25 }, // 大兴安岭
  { lng: 128.4, lat: 47.2, s: 1.1 }, // 小兴安岭
  { lng: 128.1, lat: 42.4, s: 1.0 }, // 长白山
  { lng: 101.2, lat: 25.3, s: 1.1 }, // 滇西
  { lng: 108.9, lat: 33.9, s: 0.9 }, // 秦岭
  { lng: 117.8, lat: 27.7, s: 0.9 }, // 武夷山
];
const GRASSLANDS = [
  { lng: 119.6, lat: 46.6, s: 1.35 }, // 呼伦贝尔草原
  { lng: 96.5, lat: 33.8, s: 1.05 }, // 藏北草原
];
/** 黄河 / 长江 的示意折线（经纬度） */
const RIVERS: { key: string; color: string; width: number; points: [number, number][] }[] = [
  {
    key: 'huanghe',
    color: '#e0a95c',
    width: 4.2,
    points: [
      [96.2, 34.8],
      [100.5, 35.6],
      [103.8, 36.1],
      [106.5, 38.2],
      [109.5, 39.9],
      [111.2, 37.2],
      [110.4, 34.6],
      [113.6, 34.8],
      [116.2, 35.6],
      [118.4, 37.5],
      [119.1, 37.8],
    ],
  },
  {
    key: 'changjiang',
    color: '#62bfe8',
    width: 4.6,
    points: [
      [91.2, 33.4],
      [95.5, 30.5],
      [99.2, 28.2],
      [104.6, 28.8],
      [106.5, 29.6],
      [111.3, 30.7],
      [114.3, 30.6],
      [118.8, 32.0],
      [121.5, 31.4],
    ],
  },
];

interface ScenePoint {
  x: number;
  y: number;
}
interface Scene {
  provinces: { key: string; d: string; fill: string }[];
  /** 34 省 marker（2026-11-08 用户要求：换成应用里那套 marker + 均匀配色；悬停显示 4:3 卡通贴） */
  provincePins: (ScenePoint & {
    key: string;
    province: string;
    attraction: string;
    icon: StickerIconKind;
    stickerColor: string;
    markerSrc: string;
    markerColor: string;
  })[];
  mountains: (ScenePoint & { key: string; s: number })[];
  deserts: (ScenePoint & { key: string; s: number })[];
  lakes: (ScenePoint & { key: string; rx: number; ry: number; big: boolean })[];
  forests: (ScenePoint & { key: string; s: number })[];
  grasslands: (ScenePoint & { key: string; s: number })[];
  rivers: { key: string; d: string; color: string; width: number }[];
  sun: ScenePoint;
  clouds: (ScenePoint & { key: string; s: number; dur: number; delay: number })[];
  waves: { key: string; d: string }[];
}

/** 平滑折线（Catmull-Rom 近似），用于河流 / 足迹 */
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/** 将省界 GeoJSON 投影成 Q 版立体地图场景 */
function buildScene(data: ProvinceBoundaryData): Scene {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const f of data.features) {
    for (const ring of f.rings) {
      for (const [lng, lat] of ring) {
        if (lat < MAINLAND_MIN_LAT) continue;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  const empty: Scene = {
    provinces: [],
    provincePins: [],
    mountains: [],
    deserts: [],
    lakes: [],
    forests: [],
    grasslands: [],
    rivers: [],
    sun: { x: VIEW_W * 0.9, y: VIEW_H * 0.12 },
    clouds: [],
    waves: [],
  };
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return empty;

  const padX = VIEW_W * MAP_PAD;
  const padY = VIEW_H * MAP_PAD;
  const availW = VIEW_W - padX * 2;
  const availH = VIEW_H - padY * 2;
  const lngSpan = maxLng - minLng;
  const latSpan = maxLat - minLat;
  const scale = Math.min(availW / lngSpan, availH / latSpan);
  const mapW = lngSpan * scale;
  const mapH = latSpan * scale;
  const offX = (VIEW_W - mapW) / 2;
  const offY = (VIEW_H - mapH) / 2;

  const project = (lng: number, lat: number): [number, number] => [
    offX + (lng - minLng) * scale,
    offY + (maxLat - lat) * scale,
  ];
  const at = (lng: number, lat: number): ScenePoint => {
    const [x, y] = project(lng, lat);
    return { x, y };
  };

  const provinces = (data.features as ProvinceBoundaryFeature[]).map((f, fi) => {
    const d = f.rings
      .map((ring) => {
        const pts = ring.map(([lng, lat]) => project(lng, lat));
        if (!pts.length) return '';
        return (
          pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + 'Z'
        );
      })
      .join(' ');
    const terrain = PROVINCE_TERRAIN[f.name] ?? 'plain';
    const palette = TERRAIN_FILLS[terrain];
    // 用省名 + 序号做一个稳定的色号，避免整片同色
    const seed = [...f.name].reduce((n, ch) => n + ch.charCodeAt(0), fi);
    return { key: `${f.name}-${f.adcode}-${fi}`, d, fill: palette[seed % palette.length] };
  });

  const mountains = MOUNTAINS.map((m, i) => ({ ...at(m.lng, m.lat), key: `mt-${i}`, s: m.s }));

  /* 34 省 marker（2026-11-08 用户要求）：每个省一个应用里那套 marker，12 色相环均匀配色；
     悬停时在 marker 正上方显示该省景点的 4:3 卡通贴卡片。
     个别景点位置会压到装饰元素（湖 / 河 / 森林）上，做少量示意性偏移（仍在本省附近）。 */
  const STICKER_NUDGE: Record<string, [number, number]> = {
    天津市: [0.5, -0.5],
    山西省: [0.6, 0.3],
    吉林省: [-0.6, -0.5],
    黑龙江省: [-1.3, 0.7],
    江苏省: [0.0, 1.0],
    浙江省: [-0.4, -0.5],
    江西省: [0.6, -0.7],
    河南省: [0.1, -0.55],
    湖北省: [-0.15, 0.55],
    广东省: [-0.6, 0.5],
    重庆市: [0.55, 0.32],
    云南省: [-0.6, 0.6],
    西藏自治区: [-0.9, 0.7],
    陕西省: [0.5, 0.35],
    青海省: [1.0, -0.5],
    新疆维吾尔自治区: [0.8, -0.4],
    香港特别行政区: [0.55, 0.1],
    澳门特别行政区: [-0.35, -0.45],
  };
  const provincePins = PROVINCE_STICKERS.map((s, i) => {
    const [dx, dy] = STICKER_NUDGE[s.province] ?? [0, 0];
    const colorId = markerColorIdFor(i);
    return {
      ...at(s.lng + dx, s.lat + dy),
      key: s.province,
      province: s.province,
      attraction: s.attraction,
      icon: s.icon,
      stickerColor: s.color,
      markerSrc: `/marker-color-${colorId}.svg`,
      markerColor: markerColorHex(colorId),
    };
  });
  const deserts = DESERTS.map((m, i) => ({ ...at(m.lng, m.lat), key: `ds-${i}`, s: m.s }));
  const lakes = LAKES.map((m, i) => ({ ...at(m.lng, m.lat), key: `lk-${i}`, rx: m.rx, ry: m.ry, big: m.big }));
  const forests = FORESTS.map((m, i) => ({ ...at(m.lng, m.lat), key: `fs-${i}`, s: m.s }));
  const grasslands = GRASSLANDS.map((m, i) => ({ ...at(m.lng, m.lat), key: `gr-${i}`, s: m.s }));

  const rivers = RIVERS.map((r) => ({
    key: r.key,
    color: r.color,
    width: r.width,
    d: smoothPath(r.points.map(([lng, lat]) => project(lng, lat))),
  }));

  // Q 版天空装饰：太阳固定在右上，云朵在天空区域（dur / delay 控制漂移节奏）
  const sun = { x: VIEW_W * 0.905, y: VIEW_H * 0.13 };
  const clouds = [
    { key: 'c1', x: VIEW_W * 0.14, y: VIEW_H * 0.14, s: 1.05, dur: 18, delay: 0 },
    { key: 'c2', x: VIEW_W * 0.575, y: VIEW_H * 0.19, s: 0.78, dur: 23, delay: 1.4 },
    { key: 'c3', x: VIEW_W * 0.7, y: VIEW_H * 0.2, s: 0.6, dur: 28, delay: 0.6 },
    { key: 'c4', x: VIEW_W * 0.28, y: VIEW_H * 0.32, s: 0.5, dur: 21, delay: 2.2 },
    { key: 'c5', x: VIEW_W * 0.245, y: VIEW_H * 0.055, s: 0.4, dur: 31, delay: 3.1 },
  ];

  // 海面波浪：沿画面下方 / 右下的装饰弧线
  const waves = [
    { key: 'w1', d: `M60 845 Q140 820 220 845 T380 845` },
    { key: 'w2', d: `M1180 852 Q1260 826 1340 852 T1500 852` },
    { key: 'w3', d: `M920 872 Q1000 848 1080 872 T1240 872` },
    { key: 'w4', d: `M1470 640 Q1520 615 1570 640` },
    { key: 'w5', d: `M40 690 Q90 665 140 690` },
  ];

  return {
    provinces,
    provincePins,
    mountains,
    deserts,
    lakes,
    forests,
    grasslands,
    rivers,
    sun,
    clouds,
    waves,
  };
}

export default function LoginBackdrop() {
  const [data, setData] = useState<ProvinceBoundaryData | null>(null);
  /** 窄屏（手机竖屏）：SVG 改成 slice 铺满，否则 meet 会把地图缩得很小、背景几乎空白 */
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 700px)').matches
  );

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 700px)');
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  /* ── 2026-11-08 D-277（用户要求）：34 省卡通贴自动循环演示 ──
     每 2 秒切换一批（5 个省的卡片一起弹出，2 秒后随下一批切换消失），
     7 批覆盖 34 个省后从头循环；悬停某省时该省卡片仍会显示。 */
  const [autoBatch, setAutoBatch] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setAutoBatch((b) => (b + 1) % AUTO_CARD_BATCHES);
    }, AUTO_CARD_MS);
    return () => clearInterval(timer);
  }, []);

  /* ── 2026-11-08（用户要求）：点击地图打标签 ──
     标签位置存 SVG viewBox 坐标（随地图缩放），最多 5 个、存活 10s；
     第 6 个出现时最早那个先播消失动画再移除。 */
  const [tags, setTags] = useState<MapTag[]>([]);
  const tagsRef = useRef<MapTag[]>([]);
  const tagSeq = useRef(0);
  const expireTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const removeTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const commitTags = useCallback((next: MapTag[]) => {
    tagsRef.current = next;
    setTags(next);
  }, []);

  /** 播放完消失动画后把标签从 DOM 移除 */
  const scheduleRemove = useCallback(
    (id: number) => {
      const timer = setTimeout(() => {
        removeTimers.current.delete(id);
        expireTimers.current.delete(id);
        commitTags(tagsRef.current.filter((t) => t.id !== id));
      }, TAG_LEAVE_MS);
      removeTimers.current.set(id, timer);
    },
    [commitTags]
  );

  /** 让某个标签开始消失（10s 到期 / 超过 5 个被挤出） */
  const leaveTag = useCallback(
    (id: number) => {
      if (!tagsRef.current.some((t) => t.id === id && !t.leaving)) return;
      const expire = expireTimers.current.get(id);
      if (expire) {
        clearTimeout(expire);
        expireTimers.current.delete(id);
      }
      commitTags(tagsRef.current.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      scheduleRemove(id);
    },
    [commitTags, scheduleRemove]
  );

  const addTag = useCallback(
    (x: number, y: number) => {
      const id = ++tagSeq.current;
      const tag: MapTag = {
        id,
        x,
        y,
        color: TAG_COLORS[(id - 1) % TAG_COLORS.length],
        leaving: false,
      };
      const current = tagsRef.current;
      const active = current.filter((t) => !t.leaving);
      if (active.length >= MAX_TAGS) {
        // 满 5 个：最早打的那个开始消失，新标签同时弹出
        const oldest = active[0];
        const expire = expireTimers.current.get(oldest.id);
        if (expire) {
          clearTimeout(expire);
          expireTimers.current.delete(oldest.id);
        }
        commitTags([
          ...current.map((t) => (t.id === oldest.id ? { ...t, leaving: true } : t)),
          tag,
        ]);
        scheduleRemove(oldest.id);
      } else {
        commitTags([...current, tag]);
      }
      expireTimers.current.set(
        id,
        setTimeout(() => leaveTag(id), TAG_LIFE_MS)
      );
    },
    [commitTags, leaveTag, scheduleRemove]
  );

  // 组件卸载（登录成功 / 切页）时清掉所有定时器
  useEffect(
    () => () => {
      expireTimers.current.forEach((t) => clearTimeout(t));
      removeTimers.current.forEach((t) => clearTimeout(t));
      expireTimers.current.clear();
      removeTimers.current.clear();
    },
    []
  );

  /** 点击地图：屏幕坐标 → SVG viewBox 坐标 */
  const handleMapClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const point = svg.createSVGPoint();
      point.x = e.clientX;
      point.y = e.clientY;
      const p = point.matrixTransform(ctm.inverse());
      // 夹在 viewBox 内，避免边缘点击把标签画到画布外
      const x = Math.max(10, Math.min(VIEW_W - 10, p.x));
      const y = Math.max(30, Math.min(VIEW_H - 6, p.y));
      addTag(x, y);
    },
    [addTag]
  );

  /* ── 2026-11-08（用户要求）：marker 的悬停 / 点击反馈和项目实际完全一致 ── */
  const [clickedPin, setClickedPin] = useState<string | null>(null);
  const [pinRipples, setPinRipples] = useState<PinRipple[]>([]);
  const rippleSeq = useRef(0);

  const spawnPinRipple = useCallback((x: number, y: number, color: string) => {
    const id = ++rippleSeq.current;
    setPinRipples((prev) => [...prev, { id, x, y, color }]);
    // 双环最晚 110ms 起跑 + 560ms 播完，900ms 后清理（与项目一致）
    window.setTimeout(() => setPinRipples((prev) => prev.filter((r) => r.id !== id)), 900);
  }, []);

  const handlePinClick = useCallback(
    (ev: ReactMouseEvent<SVGGElement>, key: string, x: number, y: number, color: string) => {
      // 和项目一致：点标记 = 标记自己的压扁回弹 + 3D 涟漪，不当作「点击地图空白」去打标签
      ev.stopPropagation();
      setClickedPin(key);
      window.setTimeout(() => setClickedPin((cur) => (cur === key ? null : cur)), 480);
      spawnPinRipple(x, y, color);
    },
    [spawnPinRipple]
  );

  useEffect(() => {
    let alive = true;
    fetch('/province-boundaries-low.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ProvinceBoundaryData | null) => {
        if (alive && d && Array.isArray(d.features) && d.features.length > 0) setData(d);
      })
      .catch(() => {
        /* 背景加载失败不影响登录 / 配置流程 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const scene = useMemo(() => (data ? buildScene(data) : null), [data]);

  return (
    <div className="login-backdrop" aria-hidden="true">
      {/* 天空 / 海面底色（CSS 渐变，独立于主题） */}
      <div className="lb-sky" />
      {scene && (
        <svg
          className="lb-map"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio={narrow ? 'xMidYMid slice' : 'xMidYMid meet'}
          focusable="false"
          onClick={handleMapClick}
        >
          <defs>
            <filter id="lb-slab-blur" x="-10%" y="-10%" width="120%" height="130%">
              <feGaussianBlur stdDeviation="9" />
            </filter>
            <radialGradient id="lb-sun-glow">
              <stop offset="0%" stopColor="#fff3bf" stopOpacity="0.9" />
              <stop offset="60%" stopColor="#ffe89a" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#ffe89a" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="lb-lake" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8fd6f4" />
              <stop offset="100%" stopColor="#4faee0" />
            </linearGradient>
            <linearGradient id="lb-mountain-body" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a9c4e0" />
              <stop offset="100%" stopColor="#6f93bb" />
            </linearGradient>
          </defs>

          {/* 海面波浪 */}
          <g className="lb-waves">
            {scene.waves.map((w) => (
              <path key={w.key} className="lb-wave" d={w.d} />
            ))}
          </g>

          {/* 小岛模型：底面阴影 → 侧面厚度 → 顶面省份拼图 */}
          <g className="lb-slab-shadow" filter="url(#lb-slab-blur)">
            {scene.provinces.map((p) => (
              <path key={`ss-${p.key}`} d={p.d} transform="translate(10 26)" />
            ))}
          </g>
          <g className="lb-slab-side">
            {scene.provinces.map((p) => (
              <path key={`sd-${p.key}`} d={p.d} transform="translate(0 13)" />
            ))}
          </g>
          <g className="lb-slab-top">
            {scene.provinces.map((p) => (
              <path key={`tp-${p.key}`} d={p.d} fill={p.fill} />
            ))}
          </g>

          {/* 河流（黄河 / 长江）：实色河身 + 流动的浅色水光 */}
          <g className="lb-rivers">
            {scene.rivers.map((r) => (
              <g key={r.key}>
                <path className="lb-river-under" d={r.d} strokeWidth={r.width + 3} />
                <path className="lb-river" d={r.d} stroke={r.color} strokeWidth={r.width} />
                <path className="lb-river-flow" d={r.d} strokeWidth={Math.max(1.5, r.width * 0.45)} />
              </g>
            ))}
          </g>

          {/* 地形元素：湖泊 / 沙漠 / 草原 / 森林 / 雪山 */}
          <g className="lb-lakes">
            {scene.lakes.map((lk) => (
              <g key={lk.key} transform={`translate(${lk.x.toFixed(1)} ${lk.y.toFixed(1)})`}>
                <ellipse className="lb-lake" rx={lk.rx} ry={lk.ry} />
                <ellipse className="lb-lake-shine" cx={-lk.rx * 0.24} cy={-lk.ry * 0.34} rx={lk.rx * 0.38} ry={lk.ry * 0.26} />
                {lk.big && <ellipse className="lb-lake-ring" rx={lk.rx * 0.7} ry={lk.ry * 0.7} />}
              </g>
            ))}
          </g>

          <g className="lb-deserts">
            {scene.deserts.map((d) => (
              <g key={d.key} transform={`translate(${d.x.toFixed(1)} ${d.y.toFixed(1)}) scale(${d.s})`}>
                <path className="lb-dune d1" d="M-34 6 Q-22 -14 -6 2 T26 4 T44 0 L44 10 L-34 10 Z" />
                <path className="lb-dune d2" d="M-18 10 Q-6 -8 8 4 T32 8 L32 14 L-18 14 Z" />
                <circle className="lb-sparkle s1" cx={-22} cy={-8} r={2.4} />
                <circle className="lb-sparkle s2" cx={16} cy={-6} r={2} />
              </g>
            ))}
          </g>

          <g className="lb-grasslands">
            {scene.grasslands.map((g) => (
              <g key={g.key} transform={`translate(${g.x.toFixed(1)} ${g.y.toFixed(1)}) scale(${g.s})`}>
                <path className="lb-hill" d="M-40 4 Q-26 -12 -12 2 T16 2 T40 0 L40 10 L-40 10 Z" />
                <g className="lb-sheep sheep-a">
                  <ellipse cx="-8" cy="-4" rx="6" ry="4.4" fill="#ffffff" />
                  <circle cx="-1" cy="-6.2" r="2.6" fill="#ffffff" />
                  <circle cx="-0.2" cy="-6.8" r="0.7" fill="#6b7280" />
                </g>
                <g className="lb-sheep sheep-b">
                  <ellipse cx="12" cy="-2" rx="5.4" ry="4" fill="#ffffff" />
                  <circle cx="18" cy="-4" r="2.3" fill="#ffffff" />
                  <circle cx="18.6" cy="-4.6" r="0.65" fill="#6b7280" />
                </g>
              </g>
            ))}
          </g>

          <g className="lb-forests">
            {scene.forests.map((f) => (
              <g key={f.key} transform={`translate(${f.x.toFixed(1)} ${f.y.toFixed(1)}) scale(${f.s})`}>
                <g className="lb-tree tree-a">
                  <rect x="-1.6" y="2" width="3.2" height="7" rx="1.4" fill="#a97b4d" />
                  <path d="M0 -18 L10 -2 Q0 3 -10 -2 Z" fill="#59b36a" />
                  <path d="M0 -11 L8 1 Q0 5 -8 1 Z" fill="#74c780" />
                </g>
                <g transform="translate(13 3) scale(0.82)">
                  <g className="lb-tree tree-b">
                    <rect x="-1.5" y="2" width="3" height="6.5" rx="1.3" fill="#a97b4d" />
                    <path d="M0 -17 L9 -2 Q0 3 -9 -2 Z" fill="#4fa863" />
                    <path d="M0 -10 L7 1 Q0 5 -7 1 Z" fill="#6fc27c" />
                  </g>
                </g>
                <g transform="translate(-12 4) scale(0.7)">
                  <g className="lb-tree tree-c">
                    <rect x="-1.5" y="2" width="3" height="6.5" rx="1.3" fill="#a97b4d" />
                    <path d="M0 -17 L9 -2 Q0 3 -9 -2 Z" fill="#63bb70" />
                    <path d="M0 -10 L7 1 Q0 5 -7 1 Z" fill="#7fcb87" />
                  </g>
                </g>
              </g>
            ))}
          </g>

          <g className="lb-mountains">
            {scene.mountains.map((mt, i) => (
              <g key={mt.key} transform={`translate(${mt.x.toFixed(1)} ${mt.y.toFixed(1)}) scale(${mt.s})`}>
                <g className="lb-mountain" style={{ animationDelay: `${(i % 3) * 0.7}s` }}>
                  <ellipse className="lb-mt-shadow" cx="2" cy="5" rx="30" ry="8" />
                  <path className="lb-mt-body" d="M-30 4 L-7 -24 Q0 -33 7 -24 L30 4 Z" />
                  <path className="lb-mt-snow" d="M-11 -17 L-7 -24 Q0 -33 7 -24 L11 -17 Q4 -11 0 -15 Q-6 -10 -11 -17 Z" />
                  <path className="lb-mt-shade" d="M0 -29 L0 4 L30 4 L7 -24 Q0 -33 0 -29 Z" opacity="0.16" fill="#3d5d80" />
                </g>
              </g>
            ))}
          </g>

          {/* 2026-11-08 D-277（用户要求）：太阳从地图内挪到「页面右上角」，
              由 <svg className="lb-sun-page"> 在下方地图 SVG 之外渲染（见文件末尾）。
              这里只保留云朵（Q 版天空）。 */}
          <g className="lb-clouds">
            {scene.clouds.map((c) => (
              <g key={c.key} transform={`translate(${c.x.toFixed(1)} ${c.y.toFixed(1)}) scale(${c.s})`}>
                <g className="lb-cloud" style={{ animationDuration: `${c.dur}s`, animationDelay: `${c.delay}s` }}>
                  <ellipse className="lb-cloud-shadow" cx="2" cy="16" rx="34" ry="8" />
                  <circle cx="-18" cy="2" r="16" fill="#ffffff" />
                  <circle cx="4" cy="-6" r="21" fill="#ffffff" />
                  <circle cx="24" cy="4" r="14" fill="#ffffff" />
                  <rect x="-20" y="4" width="46" height="12" rx="6" fill="#ffffff" />
                </g>
              </g>
            ))}
          </g>

          {/* Q 版海面小帆船 + 海鸟（纯装饰） */}
          <g className="lb-boats">
            <g transform="translate(1360 764)">
              <g className="lb-boat">
                <path d="M-22 6 L22 6 L16 16 L-16 16 Z" fill="#f6fbff" stroke="#bcd9ea" strokeWidth="1.5" />
                <path d="M0 -18 L14 4 L-14 4 Z" fill="#ffffff" stroke="#e2eef6" strokeWidth="1.2" />
                <rect x="-1.4" y="4" width="2.8" height="8" fill="#a97b4d" />
              </g>
            </g>
            <g transform="translate(238 842) scale(0.78)">
              <g className="lb-boat boat-b">
                <path d="M-22 6 L22 6 L16 16 L-16 16 Z" fill="#f6fbff" stroke="#bcd9ea" strokeWidth="1.5" />
                <path d="M0 -18 L14 4 L-14 4 Z" fill="#ffffff" stroke="#e2eef6" strokeWidth="1.2" />
                <rect x="-1.4" y="4" width="2.8" height="8" fill="#a97b4d" />
              </g>
            </g>
          </g>
          <g className="lb-birds">
            <path className="lb-bird" d="M1252 96 q6 -6 12 0 q6 -6 12 0" />
            <path className="lb-bird bird-b" d="M1300 128 q5 -5 10 0 q5 -5 10 0" />
          </g>

          {/* 34 省 marker（2026-11-08 用户要求）：应用里那套 marker + 12 色相环均匀配色；
              悬停时在 marker 正上方显示该省景点的 4:3 卡通贴卡片（比原来的圆形贴纸稍大）；
              2026-11-08 D-277：另外每 2 秒自动弹出一批 5 个省的卡片（34 省循环演示）。 */}
          <g className="lb-pins">
            {scene.provincePins.map((p, i) => {
              const phase = animPhase(p.key);
              const autoCard = Math.floor(i / AUTO_CARD_COUNT) === autoBatch;
              return (
                <g
                  key={p.key}
                  className={['lb-pin', clickedPin === p.key ? 'is-clicked' : '', autoCard ? 'is-auto-card' : '']
                    .filter(Boolean)
                    .join(' ')}
                  transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
                  role="img"
                  aria-label={`${p.province} · ${p.attraction}`}
                  style={
                    {
                      '--lb-breath-dur': `${phase.dur.toFixed(2)}s`,
                      '--lb-breath-delay': `${phase.delay.toFixed(2)}s`,
                    } as CSSProperties
                  }
                  onClick={(ev) => handlePinClick(ev, p.key, p.x, p.y, p.markerColor)}
                >
                  <g className="lb-pin-body">
                    <g className="lb-pin-media">
                      <image
                        href={p.markerSrc}
                        x={-PIN_SIZE / 2}
                        y={-PIN_SIZE}
                        width={PIN_SIZE}
                        height={PIN_SIZE}
                      />
                    </g>
                  </g>
                  {/* 悬停 / 自动演示时显示的 4:3 卡通贴卡片 */}
                  <g
                    className="lb-pin-card"
                    aria-hidden="true"
                    style={autoCard ? { transitionDelay: `${(i % AUTO_CARD_COUNT) * 80}ms` } : undefined}
                  >
                    <g className="lb-pin-card-inner">
                      <rect
                        className="lb-pin-card-bg"
                        x={-CARD_W / 2}
                        y={-CARD_BOTTOM - CARD_H}
                        width={CARD_W}
                        height={CARD_H}
                        rx={10}
                        fill={p.stickerColor}
                      />
                      {/* 卡通贴图标：居中在上方区域，底部 CARD_TEXT_H 留给文字 */}
                      <g transform={`translate(0 ${-CARD_BOTTOM - CARD_H + (CARD_H - CARD_TEXT_H) / 2}) scale(1.9)`}>
                        <StickerIcon kind={p.icon} />
                      </g>
                      {/* 2026-11-08（用户要求）：原来 hover 时浏览器原生 tooltip 那行字（省 · 景点）
                          改成画进卡通贴底部，卡片和文字作为一个整体；贴图本身不改。 */}
                      <rect
                        className="lb-pin-card-labelbg"
                        x={-CARD_W / 2 + 4}
                        y={-CARD_BOTTOM - CARD_TEXT_H + 1}
                        width={CARD_W - 8}
                        height={CARD_TEXT_H - 3}
                        rx={7}
                      />
                      <text
                        className="lb-pin-card-prov"
                        x={0}
                        y={-CARD_BOTTOM - CARD_TEXT_H + 8}
                        textAnchor="middle"
                      >
                        {p.province}
                      </text>
                      <text
                        className="lb-pin-card-attr"
                        x={0}
                        y={-CARD_BOTTOM - CARD_TEXT_H + 16.5}
                        textAnchor="middle"
                      >
                        {p.attraction}
                      </text>
                    </g>
                  </g>
                </g>
              );
            })}
          </g>

          {/* 点击 marker 的 3D 地面涟漪（椭圆 + 双环错峰，与项目实际点击动效一致） */}
          <g className="lb-pin-ripples">
            {pinRipples.map((r) => (
              <g
                key={r.id}
                className="lb-pin-ripple"
                transform={`translate(${r.x.toFixed(1)} ${r.y.toFixed(1)})`}
                style={{ '--lb-ripple': r.color } as CSSProperties}
              >
                <ellipse className="lb-pin-ripple-ring" rx="24" ry="8.6" />
                <ellipse className="lb-pin-ripple-ring ring-b" rx="24" ry="8.6" />
              </g>
            ))}
          </g>
          {/* 地图打标签（2026-11-08 用户要求）：点击落标签、最多 5 个、10s 自动消失 */}
          <g className="lb-tags">
            {tags.map((tag) => (
              <g
                key={tag.id}
                className={tag.leaving ? 'lb-tag leaving' : 'lb-tag'}
                data-tag-id={tag.id}
                transform={`translate(${tag.x.toFixed(1)} ${tag.y.toFixed(1)})`}
              >
                <ellipse className="lb-tag-shadow" cx="0" cy="1" rx="12" ry="4.4" />
                <ellipse className="lb-tag-ring" cx="0" cy="0" rx="17" ry="6.4" />
                <g className="lb-tag-inner">
                  <path
                    className="lb-tag-tail"
                    d="M-5.5 -12 L0 -1 L5.5 -12 Z"
                    fill="#ffffff"
                    stroke={tag.color}
                    strokeWidth="2.4"
                  />
                  <circle className="lb-tag-badge" cx="0" cy="-27" r="14" fill="#ffffff" stroke={tag.color} strokeWidth="3" />
                  <rect className="lb-tag-body" x="-6.5" y="-32" width="13" height="10.5" rx="2.6" fill={tag.color} />
                  <circle className="lb-tag-hole" cx="-2.6" cy="-29.5" r="1.7" fill="#ffffff" />
                </g>
              </g>
            ))}
          </g>
        </svg>
      )}
      {/* 2026-11-08 D-277（用户要求）：太阳移到页面右上角（不再跟随地图 inset 缩放） */}
      <svg className="lb-sun-page" viewBox="-110 -110 220 220" aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id="lb-sun-glow-page">
            <stop offset="0%" stopColor="#fff3bf" stopOpacity="0.9" />
            <stop offset="60%" stopColor="#ffe89a" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#ffe89a" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g className="lb-sun">
          <circle className="lb-sun-glow" r="96" fill="url(#lb-sun-glow-page)" />
          <g className="lb-sun-rays">
            {Array.from({ length: 8 }).map((_, i) => (
              <rect
                key={i}
                className="lb-sun-ray"
                x="-2.6"
                y="-68"
                width="5.2"
                height="15"
                rx="2.6"
                transform={`rotate(${i * 45})`}
              />
            ))}
          </g>
          <circle className="lb-sun-body" r="32" />
          <g className="lb-sun-face">
            <path d="M-12 -6 Q-9 -11 -6 -6" />
            <path d="M6 -6 Q9 -11 12 -6" />
            <path d="M-8 6 Q0 13 8 6" />
          </g>
        </g>
      </svg>
      <div className="lb-vignette" />
    </div>
  );
}
