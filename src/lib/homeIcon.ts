/**
 * 「家」地图图标（2026-11-05，D-161）：
 * 用户选了 2 号极简剪影屋，并要求在 设置 → 通用 → 外观 里可选配色。
 * D-164 起色板改为「十二色相环」长条（`markerPalette.ts`），和去过 / 想去 / 秘密基地共用；
 * 默认色改为 **青**（2026-11-05 深夜用户截图指定，原为青绿）。
 *
 * 图标是 public/ 下的静态 SVG（<img> 引用，不能靠 CSS 改色），所以每种颜色
 * 各一个文件（由 `scripts/build-marker-colors.mjs` 生成），这里集中维护文件路径映射
 * 与 localStorage 读写。偏好只存本机浏览器 `tm-home-color`，不写 data/、不进备份。
 */
import {
  MARKER_COLOR_OPTIONS,
  isMarkerColorId,
  markerColorHex,
  normalizeMarkerColorId,
  type MarkerColorId,
} from './markerPalette';

export type HomeColor = MarkerColorId;

export interface HomeColorOption {
  id: HomeColor;
  /** 中文展示名（英文界面由 i18n 字典翻译） */
  label: string;
  hex: string;
  src: string;
}

export const HOME_COLOR_KEY = 'tm-home-color';

/** 家图标按颜色取文件：青绿沿用最初的 marker-home.svg，其余 11 色为 marker-home-<id>.svg */
const HOME_MARKER_SRC: Record<HomeColor, string> = {
  red: '/marker-home-red.svg',
  orange: '/marker-home-orange.svg',
  yellow: '/marker-home-yellow.svg',
  lime: '/marker-home-lime.svg',
  green: '/marker-home-green.svg',
  teal: '/marker-home.svg',
  cyan: '/marker-home-cyan.svg',
  sky: '/marker-home-sky.svg',
  indigo: '/marker-home-indigo.svg',
  violet: '/marker-home-violet.svg',
  fuchsia: '/marker-home-fuchsia.svg',
  coral: '/marker-home-coral.svg',
};

/** 顺序 = 十二色相环顺序（设置页色条顺序） */
export const HOME_COLOR_OPTIONS: HomeColorOption[] = MARKER_COLOR_OPTIONS.map((o) => ({
  ...o,
  src: HOME_MARKER_SRC[o.id],
}));

export const DEFAULT_HOME_COLOR: HomeColor = 'cyan';

export function isHomeColor(v: string | null | undefined): v is HomeColor {
  return isMarkerColorId(v);
}

export function readHomeColor(): HomeColor {
  try {
    const v = localStorage.getItem(HOME_COLOR_KEY);
    // D-164 修订：旧 7 色 id（forest / pine / amber）平滑映射到最接近的新色相
    return normalizeMarkerColorId(v) ?? DEFAULT_HOME_COLOR;
  } catch {
    return DEFAULT_HOME_COLOR;
  }
}

export function homeMarkerSrc(color: HomeColor): string {
  return HOME_MARKER_SRC[color] ?? HOME_MARKER_SRC.teal;
}

/** 家图标当前色值（点击涟漪用；D-164 起跟着配色走，不再固定青绿） */
export function homeMarkerHex(color: HomeColor): string {
  return markerColorHex(color);
}
