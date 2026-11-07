/**
 * 中英文切换（2026-11-04，D-138）
 *
 * 设计要点（改文案前先看这里）：
 * 1) **以中文原文为 key**：中文模式直接返回原文，所以现有中文界面零改动；
 *    英文模式查 `src/i18n/en/*.ts` 的字典，缺词条自动回退中文（不会白屏）。
 * 2) 英文词条分域放在 `src/i18n/en/` 下（common / settings / sidebar / panels / lists），
 *    由 `en/index.ts` 合并；同一 key 出现在多个域时按合并顺序覆盖，所以同词保持同一译法。
 * 3) React 组件用 `useT()`：Context 变化即重渲染，切换语言**立即生效、不用刷新**。
 *    纯模块（`map/cluster.ts`、`lib/tdt.ts`、`lib/api.ts` 之类）用 `tr()`，
 *    它读模块级的 currentLang（App 每次渲染时 `setCurrentLang` 同步写入）。
 * 4) 插值统一用 `{name}` 占位符，键和英文译文里的占位符要一致：
 *      t('共 {n} 个地点', { n: 3 })
 * 5) 省份名用 `useTp()` / `tp()` 翻译（34 个省级行政区，见 ./provinces.ts）；
 *    市 / 区县 / 地点名 / 笔记 / 同行人是用户数据，**永远保持原样**。
 * 6) 只翻「界面文案」：按钮、标签、说明、toast、确认框、aria-label / title / placeholder。
 *    不翻：console 日志、代码注释、data/ 里的数据、天地图返回的 POI / 地名、服务端返回的错误文案。
 *
 * 自检：`node scripts/i18n-check.mjs`（缺词条 = 0 才算完；同时会报「未使用词条」和残留中文）。
 */
import { createContext, useContext } from 'react';
import { EN } from './en';
import { PROVINCE_EN, provinceKey } from './provinces';

export type Lang = 'zh' | 'en';

/** 语言选项（设置 → 通用「语言」）：标签始终显示各自母语，英文界面下也能切回中文 */
export const LANGS: { id: Lang; label: string }[] = [
  { id: 'zh', label: '简体中文' },
  { id: 'en', label: 'English' },
];

/** 默认简体中文（保持现有行为；D-138） */
export const DEFAULT_LANG: Lang = 'zh';

export const isLang = (v: string | null | undefined): v is Lang => v === 'zh' || v === 'en';

/** 插值参数：{n} / {name} / {total} 等 */
export type TParams = Record<string, string | number>;

/** 翻译函数：第一个参数是中文原文（zh 模式原样返回，en 模式查字典） */
export type TFn = (zh: string, params?: TParams) => string;

/** 省份名翻译函数（zh 模式原样返回） */
export type TPfn = (province: string | null | undefined) => string;

/** 英文词条字典：中文原文 → 英文 */
export type Dict = Record<string, string>;

const interpolate = (text: string, params?: TParams): string => {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
};

/**
 * 模块级当前语言：只给非 React 代码（tr / tp）用。
 * App 每次渲染都会调用 setCurrentLang，保证两处始终一致。
 */
let currentLang: Lang = DEFAULT_LANG;

/**
 * 上下文限定 key：`'次||metric'`。
 *
 * 同一个中文词在不同语境需要不同英文时（例如「主 / 次」里的「次」= Secondary，
 * 而统计单位「次」= visits），在 t() 的 key 后面加 `||上下文`：
 * - 中文模式只渲染 `||` 前面的部分（仍是「次」，逐字不变）；
 * - 英文模式优先查带上下文的词条，找不到再退回不带上下文的中文 key。
 * 这样不用改任何中文文案，也不影响现有词条。
 */
const zhBase = (key: string): string => {
  const i = key.indexOf('||');
  return i === -1 ? key : key.slice(0, i);
};

export const setCurrentLang = (lang: Lang) => {
  currentLang = lang;
};

export const makeT = (lang: Lang): TFn => (zh, params) => {
  if (lang !== 'en') return interpolate(zhBase(zh), params);
  const hit = EN[zh] ?? EN[zhBase(zh)];
  return interpolate(hit ?? zhBase(zh), params);
};

export const makeTp = (lang: Lang): TPfn => (province) => {
  const name = String(province ?? '').trim();
  if (lang !== 'en' || !name) return name;
  return PROVINCE_EN[name] ?? PROVINCE_EN[provinceKey(name)] ?? name;
};

/** 非 React 模块用的翻译函数（读模块级语言；组件里请用 useT） */
export const tr: TFn = (zh, params) => makeT(currentLang)(zh, params);

/** 非 React 模块用的省份翻译函数 */
export const tp: TPfn = (province) => makeTp(currentLang)(province);

export interface I18nValue {
  lang: Lang;
  t: TFn;
  tp: TPfn;
}

export const I18nContext = createContext<I18nValue>({
  lang: DEFAULT_LANG,
  t: makeT(DEFAULT_LANG),
  tp: makeTp(DEFAULT_LANG),
});

export const useI18n = (): I18nValue => useContext(I18nContext);
export const useT = (): TFn => useContext(I18nContext).t;
export const useTp = (): TPfn => useContext(I18nContext).tp;
export const useLang = (): Lang => useContext(I18nContext).lang;
