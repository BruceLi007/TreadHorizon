import { tr } from '../i18n';

declare global {
  interface Window {
    T: any;
  }
}

let pending: Promise<any> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(tr('脚本加载失败：{src}', { src })));
    document.head.appendChild(s);
  });
}

/**
 * 天地图 SDK 分三个包，缺一不可：
 *   1. api?v=4.0          核心（Map / Marker / Icon / Control）
 *   2. v4.0/service.js    Geocoder / LocalSearch / AdministrativeDivision
 *   3. v4.0/components.js MarkerClusterer / Label 等
 * 少加载一个，T.Geocoder 就是 undefined。
 *
 * 注意：地名搜索和逆地理编码走的是我们自己的 /api/search、/api/reverse，
 * 服务端统一处理了天地图的 UA 校验、限流和缓存。前端只用它渲染地图。
 */
export function loadTdt(tk: string): Promise<any> {
  if (pending) return pending;
  if (!tk) return Promise.reject(new Error(tr('还没有配置天地图 Key')));

  pending = (async () => {
    await loadScript(`https://api.tianditu.gov.cn/api?v=4.0&tk=${encodeURIComponent(tk)}`);
    await loadScript('https://api.tianditu.gov.cn/v4.0/service.js');
    await loadScript('https://api.tianditu.gov.cn/v4.0/components.js');
    const T = window.T;
    if (!T || typeof T.Map !== 'function') {
      throw new Error(tr('天地图 SDK 初始化失败：window.T 不存在'));
    }
    return T;
  })().catch((err) => {
    // 关键：失败不要缓存，否则后续拿到 key 也永远起不来
    pending = null;
    throw err;
  });

  return pending;
}
