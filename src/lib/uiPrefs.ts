/**
 * 界面偏好的 HTML 属性引导（2026-11-15 D-426，用户验收反馈「分享页这个界面样式没统一」）。
 *
 * 正式版由 `App` 的 useLayoutEffect 往 <html> 写 `data-theme` / `data-font` / `data-fontsize`
 * / `data-fontweight`，`styles.css` 再据此决定主题色板、`--font-ui`、`--fs-scale`、`--font-weight-ui`。
 * 分享页的**密码门 / 状态页**在 `App` 挂载之前就要显示（App 还没挂，属性一个都没写），
 * 于是会退化成「系统字体 + 系统主题」，看起来和正式版登录页 / Key 弹窗不是一套。
 *
 * 这里按**同一套 localStorage key 与默认值**把四个属性补上（只读偏好、不写回），
 * 让分享页在任何阶段都和正式版同一字体、同一字号档、同一主题。
 */
import {
  DEFAULT_FONT,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_WEIGHT,
  isAppFont,
  isFontSize,
  isFontWeight,
} from '../ui/settings/types';

const THEME_KEY = 'tm-theme';
const FONT_KEY = 'tm-font';
const FONT_SIZE_KEY = 'tm-font-size';
const FONT_WEIGHT_KEY = 'tm-font-weight';

function readPref(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** 主题偏好 → 实际档位（与 App 的 effectiveTheme 同口径：system 按系统深浅解析，默认「纯白」） */
function resolveTheme(raw: string | null): string {
  if (raw === 'white' || raw === 'light' || raw === 'dark' || raw === 'black') return raw;
  if (raw === 'system') {
    try {
      return typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    } catch {
      return 'dark';
    }
  }
  return 'white';
}

/** 把本机偏好写到 <html>（幂等；只在分享页启动时调一次） */
export function applyUiPrefs(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(readPref(THEME_KEY));

  const font = readPref(FONT_KEY);
  root.dataset.font = isAppFont(font) ? font : DEFAULT_FONT;

  const size = readPref(FONT_SIZE_KEY);
  root.dataset.fontsize = isFontSize(size) ? size : DEFAULT_FONT_SIZE;

  const weight = readPref(FONT_WEIGHT_KEY);
  root.dataset.fontweight = isFontWeight(weight) ? weight : DEFAULT_FONT_WEIGHT;
}
