/**
 * 欢迎页「时段」——日出 / 中午 / 日落 / 午夜（2026-11-17，用户要求四套欢迎页）。
 *
 * 约定：
 * - 没人动控件时 = `auto`：按**本机当前时间**选时段，页面一直开着跨过时段也会自己切（每 30s 对一次表）；
 * - 点了某个时段 = 本机这次浏览的临时覆盖，刷新 / 重新进入欢迎页回到「设置里的偏好」（不写 localStorage，
 *   避免「上次点过日落，之后每次开都停在日落」）；
 * - 时段分界：05:00~08:00 日出 / 08:00~16:30 中午 / 16:30~19:00 日落 / 其余午夜。
 *
 * 2026-11-17 D-521（用户要求「设置里的时段项」）：偏好的持久化落在**设置 → 通用 → 欢迎页**
 * （`tm-sky`，和主题 / 字体一样只存本机，默认 auto）；欢迎页左下角控件仍是临时覆盖，
 * 刷新后回到设置里的值 —— 两层语义分别在本文件的 `readSkyPref` 与 `useSkyTime(preferred)`。
 */
import { useCallback, useEffect, useState } from 'react';

export type SkyTime = 'sunrise' | 'noon' | 'sunset' | 'night';
/** 控件档位：auto + 四个时段 */
export type SkyMode = 'auto' | SkyTime;

export const SKY_TIMES: readonly SkyTime[] = ['sunrise', 'noon', 'sunset', 'night'];

/** 文案用中文原文做 key（和项目 i18n 一致），英文词条在 src/i18n/en/common.ts */
export const SKY_LABELS: Record<SkyTime, string> = {
  sunrise: '日出',
  noon: '中午',
  sunset: '日落',
  night: '午夜',
};

export const isSkyTime = (v: unknown): v is SkyTime =>
  v === 'sunrise' || v === 'noon' || v === 'sunset' || v === 'night';

/** 偏好与档位同一套取值：auto + 四个时段 */
export const isSkyMode = (v: unknown): v is SkyMode => v === 'auto' || isSkyTime(v);

/**
 * 欢迎页时段偏好（设置 → 通用 → 欢迎页）。
 * 只存本机浏览器，和 `tm-theme` / `tm-font` 一致；缺省 / 坏数据一律 auto。
 */
export const SKY_PREF_KEY = 'tm-sky';
export const readSkyPref = (): SkyMode => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(SKY_PREF_KEY) : null;
    return isSkyMode(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
};

/** 本地时间 → 时段 */
export function skyTimeForDate(date: Date = new Date()): SkyTime {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 5 && h < 8) return 'sunrise';
  if (h >= 8 && h < 16.5) return 'noon';
  if (h >= 16.5 && h < 19) return 'sunset';
  return 'night';
}

/**
 * 欢迎页时段状态。
 * `preferred` = 设置里的持久化偏好（默认 auto）；控件点击只做**本次浏览**的临时覆盖。
 * `mode` 给切换控件显示当前档位；`time` 是真正渲染的时段（auto 时 = 当前时间的时段）。
 */
export interface SkyTimeState {
  mode: SkyMode;
  time: SkyTime;
  choose: (mode: SkyMode) => void;
}

export function useSkyTime(preferred: SkyMode = 'auto'): SkyTimeState {
  const [clockTime, setClockTime] = useState<SkyTime>(() => skyTimeForDate());
  /** null = 跟随设置里的偏好；非 null = 本次浏览的临时覆盖（刷新即失效） */
  const [override, setOverride] = useState<SkyMode | null>(null);

  // auto 档：页面一直开着也跟时间走（30s 一次，跨过 08:00 / 16:30 / 19:00 / 05:00 会自己换）
  useEffect(() => {
    const timer = window.setInterval(() => setClockTime(skyTimeForDate()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const choose = useCallback((mode: SkyMode) => {
    setOverride(mode);
  }, []);

  const mode: SkyMode = override ?? preferred;
  return { mode, time: mode === 'auto' ? clockTime : mode, choose };
}
