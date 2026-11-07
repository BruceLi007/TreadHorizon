/**
 * 天地图 Web 服务 API（服务端调用）
 *
 * 三个硬约束（2026-10-31 实测）：
 *   1. key 是「浏览器端」类型，服务端必须带浏览器 UA，否则 403 权限类型错误
 *   2. QPS 很低，连发 5 个就返回「该tk已限流」→ 全局限速 + 重试
 *   3. 地理编码只能用 ds 参数；逆地理编码用 postStr
 */
import { CONFIG } from './config.mjs';

const BASE = 'https://api.tianditu.gov.cn';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 全局限速：两次请求之间至少 280ms
let lastAt = 0;
async function gap() {
  const wait = 280 - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
}

async function raw(path) {
  await gap();
  const res = await fetch(BASE + path, {
    headers: {
      'User-Agent': UA,
      Referer: 'http://localhost:5173/',
      Accept: 'application/json, text/plain, */*',
    },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`天地图返回非 JSON（HTTP ${res.status}）：${text.slice(0, 80)}`);
  }
}

/** 带限流重试的 GET */
async function tdt(path, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const j = await raw(path);
      const msg = String(j?.msg || j?.resolve || '');
      if (msg.includes('限流')) {
        lastErr = new Error('天地图限流');
        await sleep(1000 * (i + 1));
        continue;
      }
      return j;
    } catch (e) {
      lastErr = e;
      await sleep(400);
    }
  }
  throw lastErr || new Error('天地图请求失败');
}

const qs = (o) => encodeURIComponent(JSON.stringify(o));

/**
 * 实际使用的天地图 Key（M6 P2-2，D-202）：调用方可以传当前用户的 Key；
 * 不传 / 空串时回落全局 CONFIG.tdtTk —— local 模式下调用方永远不传，行为与以前一致。
 */
const effectiveTk = (tk) => {
  const own = typeof tk === 'string' ? tk.trim() : '';
  return own || CONFIG.tdtTk;
};

/** 地名 → 坐标（地理编码，ds 参数） */
export async function geocodeName(keyword, tk) {
  const j = await tdt(`/geocoder?ds=${qs({ keyWord: keyword })}&tk=${effectiveTk(tk)}`);
  if (String(j.status) !== '0') return null;
  const loc = j.location || {};
  if (!loc.lon || !loc.lat) return null;
  return {
    name: keyword,
    address: j.result?.formatted_address || '',
    lnglat: `${loc.lon},${loc.lat}`,
    source: 'geocode',
  };
}

/** 地名 → POI 列表（v2 搜索） */
export async function searchPoi(keyword, count = 6, tk) {
  const post = { keyWord: keyword, level: 12, mapBound: '73,3,136,54', queryType: 1, start: 0, count };
  const j = await tdt(`/v2/search?postStr=${qs(post)}&type=query&tk=${effectiveTk(tk)}`);
  const pois = Array.isArray(j.pois) ? j.pois : [];
  return pois
    .filter((p) => p.name && p.lonlat)
    .map((p) => ({
      name: p.name,
      address: p.address || '',
      lnglat: p.lonlat,
      source: 'poi',
    }));
}

/** 坐标 → 省市区（逆地理编码，postStr 参数） */
export async function reverseGeocode(lng, lat, tk) {
  const j = await tdt(
    `/geocoder?postStr=${qs({ lon: lng, lat, ver: 1 })}&type=geocode&tk=${effectiveTk(tk)}`
  );
  if (String(j.status) !== '0') return null;
  const c = j.result?.addressComponent || {};
  return {
    province: c.province ?? null,
    city: c.city ?? null,
    county: c.county ?? null,
    province_code: c.province_code ?? null,
    city_code: c.city_code ?? null,
    county_code: c.county_code ?? null,
    formatted: j.result?.formatted_address ?? null,
    poi: c.poi ?? null,
  };
}

/** 搜索缓存：同一个词不重复打接口（key 的额度很宝贵） */
const cache = new Map();

/**
 * 综合搜索：POI 优先 + 地理编码兜底。
 *
 * 排序为什么是 POI 在前：
 *   地理编码只认名字，同名地点取第一个 —— 搜「西湖」会返回广东惠州的西湖。
 *   POI 检索带上下文和相关性排序，搜「西湖」第一条是杭州的西湖美术馆。
 *   所以 POI 结果更可信，放前面；地理编码放在后面兜底城市/区县名。
 *
 * 地理编码结果会补一次逆地理拿地址，否则用户无法判断它指的是哪个同名地方。
 */
export async function searchPlace(keyword, tk) {
  const q = String(keyword || '').trim();
  if (!q) return [];

  // 缓存只按关键词：搜索结果与 Key 无关（Key 只影响额度归属），跨用户复用不泄露数据。
  const hit = cache.get(q);
  if (hit) return hit;

  const out = [];
  const errors = [];

  // 1) POI 检索（更准）
  try {
    for (const p of await searchPoi(q, 6, tk)) {
      if (!out.some((x) => x.name === p.name)) out.push(p);
    }
  } catch (e) {
    errors.push('POI：' + e.message);
  }

  // 2) 地理编码兜底（城市/区县名只能靠它）
  try {
    const g = await geocodeName(q, tk);
    if (g && !out.some((x) => x.name === g.name)) {
      // 补地址，用于消歧
      try {
        const lnglat = g.lnglat.split(',').map(Number);
        const rv = await reverseGeocode(lnglat[0], lnglat[1], tk);
        if (rv) {
          g.address = rv.formatted || [rv.province, rv.city, rv.county].filter(Boolean).join('');
        }
      } catch {
        /* 补不到地址不影响主流程 */
      }
      out.push(g);
    }
  } catch (e) {
    errors.push('地理编码：' + e.message);
  }

  const res = out.slice(0, 8);
  if (res.length) {
    cache.set(q, res);
    if (cache.size > 200) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  if (!res.length && errors.length) {
    const err = new Error(errors.join('；'));
    err.empty = true;
    throw err;
  }
  return res;
}
