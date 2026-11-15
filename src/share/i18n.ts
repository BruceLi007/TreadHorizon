/**
 * 分享只读页的独立小 i18n（2026-11-14 D-416 / P2）。
 * 不引用 src/i18n 的 1150+ 词条；只保留分享页需要的几十条。
 * MapView 自身仍会用主 i18n 的默认上下文（中文），分享页的外壳文案走这里。
 */
export type ShareLang = 'zh' | 'en';

export function detectShareLang(): ShareLang {
  try {
    return String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

const ZH = {
  loading: '正在加载分享…',
  brand: 'Tread Horizon',
  privateTitle: '这是一个私密分享',
  privateHint: '输入分享者设置的访问密码后查看。',
  passwordPlaceholder: '访问密码',
  unlock: '查看分享',
  unlocking: '正在验证…',
  wrongPassword: '密码不正确，请重试。',
  rateLimited: '尝试次数过多，请稍后再试。',
  expiredTitle: '链接已过期',
  expiredBody: '这份分享已到期，照片等数据已自动删除。',
  revokedTitle: '链接已被撤销',
  revokedBody: '分享者已撤销这份分享，内容不再可查看。',
  notFoundTitle: '链接不存在',
  notFoundBody: '可能已过期、被撤销，或地址输入有误。',
  errorTitle: '加载失败',
  errorBody: '网络或服务暂时不可用，请稍后重试。',
  retry: '重试',
  places: '{n} 个地点',
  photos: '{n} 张照片',
  expiresAt: '链接 {time} 失效',
  forever: '长期有效 · 直到撤销',
  onlyViewing: '只看：{name}',
  clear: '清除',
  allYears: '全部年份',
  allProvinces: '全部省份',
  unknownMonth: '未知月份',
  noPhotos: '这份分享没有照片。',
  mapUnavailable: '底图未配置',
  mapUnavailableHint: '地图底图未配置，地点与照片仍可正常查看。',
  mapKeyTitle: '地图底图需要你自己的天地图 Key',
  mapKeyBody:
    '底图由天地图提供，需要 Key 才能加载。你可以到天地图官网免费申请一个浏览器端 Key 后填在这里；不填也能看照片和地点。',
  mapKeyPrivacy:
    'Key 只保存在这台设备的浏览器里，不会上传到本站服务器，也不会写进分享链接。',
  mapKeyPlaceholder: '32 位天地图 Key',
  mapKeyEnter: '填写地图 Key',
  mapKeySave: '保存并加载地图',
  mapKeyCancel: '暂不使用底图',
  mapKeyChange: '更换地图 Key',
  mapKeyClear: '清除 Key',
  mapKeyInvalid: 'Key 应为 32 位字母或数字。',
  mapKeyWhitelist:
    '如果提示 Referer / 域名不允许，请在你的天地图 Key 白名单里加上当前访问的域名。',
  mapKeySavedReload: '保存后会刷新页面，用新 Key 重新加载地图。',
  mapErrorHint:
    '底图加载失败：请检查 Key 是否正确、是否允许当前域名（Referer 白名单），或稍后再试。',
  mapError: '地图加载失败',
  shareBy: '由 {name} 分享',
  close: '关闭',
  prev: '上一张',
  next: '下一张',
  footer: 'Tread Horizon · 分享链接到期或撤销后自动失效',
  home: '家',
  distance: '离家 {km} km',
} as const;

type Key = keyof typeof ZH;

const EN: Record<Key, string> = {
  loading: 'Loading shared trip…',
  brand: 'Tread Horizon',
  privateTitle: 'This share is private',
  privateHint: 'Enter the password set by the sharer to continue.',
  passwordPlaceholder: 'Password',
  unlock: 'View share',
  unlocking: 'Checking…',
  wrongPassword: 'Wrong password. Please try again.',
  rateLimited: 'Too many attempts. Please try again later.',
  expiredTitle: 'This link has expired',
  expiredBody: 'The share has expired and its photos have been deleted automatically.',
  revokedTitle: 'This link was revoked',
  revokedBody: 'The sharer revoked this share. Its content is no longer available.',
  notFoundTitle: 'Link not found',
  notFoundBody: 'It may have expired, been revoked, or the address is incorrect.',
  errorTitle: 'Something went wrong',
  errorBody: 'The service is temporarily unavailable. Please try again.',
  retry: 'Retry',
  places: '{n} places',
  photos: '{n} photos',
  expiresAt: 'Link expires {time}',
  forever: 'Active until revoked',
  onlyViewing: 'Only: {name}',
  clear: 'Clear',
  allYears: 'All years',
  allProvinces: 'All provinces',
  unknownMonth: 'Unknown month',
  noPhotos: 'No photos in this share.',
  mapUnavailable: 'Basemap not configured',
  mapUnavailableHint: 'The basemap is not configured, but places and photos are still available.',
  mapKeyTitle: 'The basemap needs your own Tianditu key',
  mapKeyBody:
    'The basemap is provided by Tianditu and requires a key. You can apply for a free browser key on the Tianditu website and enter it here; photos and places still work without one.',
  mapKeyPrivacy:
    'The key is stored only in this browser and is never sent to this site or written into the share link.',
  mapKeyPlaceholder: '32-character Tianditu key',
  mapKeyEnter: 'Enter map key',
  mapKeySave: 'Save and load map',
  mapKeyCancel: 'Continue without basemap',
  mapKeyChange: 'Change map key',
  mapKeyClear: 'Clear key',
  mapKeyInvalid: 'The key must be 32 letters or digits.',
  mapKeyWhitelist:
    'If the map reports a Referer / domain error, add this site’s domain to your Tianditu key whitelist.',
  mapKeySavedReload: 'Saving reloads the page so the map can load with the new key.',
  mapErrorHint:
    'Basemap failed to load: check the key, its domain (Referer) whitelist, or try again later.',
  mapError: 'Map failed to load',
  shareBy: 'Shared by {name}',
  close: 'Close',
  prev: 'Previous',
  next: 'Next',
  footer: 'Tread Horizon · Links stop working after they expire or are revoked',
  home: 'Home',
  distance: '{km} km from home',
};

const DICT: Record<ShareLang, Record<Key, string>> = { zh: ZH, en: EN };

export function shareT(lang: ShareLang, key: Key, params: Record<string, string | number> = {}) {
  let out = DICT[lang][key] ?? ZH[key] ?? key;
  for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

export type ShareTFn = (key: Key, params?: Record<string, string | number>) => string;

export function makeShareT(lang: ShareLang): ShareTFn {
  return (key, params) => shareT(lang, key, params);
}
