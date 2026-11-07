/**
 * 地名搜索诊断 —— 验证「地理编码」和「POI 检索」分别认什么
 *
 *   node scripts/check-geocode.mjs 杭州 西湖 青海湖
 *
 * 不打印 key。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function env(key) {
  const p = resolve(ROOT, '.env.local');
  if (!existsSync(p)) return '';
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === key) return m[2];
  }
  return '';
}

const TK = env('TDT_TK');
if (!TK) {
  console.error('❌ .env.local 里没有 TDT_TK');
  process.exit(1);
}

const keywords = process.argv.slice(2);
if (!keywords.length) keywords.push('杭州');

// 天地图「浏览器端」key 拒绝非浏览器客户端，服务端调用必须带 UA
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'http://localhost:5173/',
};

/** 地理编码：地名 → 坐标（只能用 ds 参数，postStr 会报 lon/lat 未填写） */
async function geocode(kw) {
  const url =
    'https://api.tianditu.gov.cn/geocoder?ds=' +
    encodeURIComponent(JSON.stringify({ keyWord: kw })) +
    '&tk=' + TK;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers: BROWSER_HEADERS });
    const j = await r.json();
    if (j.status !== '0') {
      return { ok: false, why: `status=${j.status} ${j.msg || j.resolve || ''}` };
    }
    const loc = j.location || {};
    return {
      ok: true,
      ms: Date.now() - t0,
      lon: loc.lon,
      lat: loc.lat,
      level: loc.level,
      addr: j.result?.formatted_address || '',
    };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

/** 行政区划：能拿到边界多边形，用于省份点亮 */
async function division(kw) {
  const url = `https://api.tianditu.gov.cn/v2/administrative?keyword=${encodeURIComponent(kw)}&childLevel=1&extensions=true&tk=${TK}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    return { ok: j.status?.infocode === 1000 || j.returncode === '100', raw: j.status?.infocode ?? j.returncode };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

const main = async () => {
  console.log('\n地名搜索诊断（地理编码 REST）');
  console.log('─'.repeat(58));

  for (const kw of keywords) {
    const g = await geocode(kw);
    if (g.ok) {
      console.log(`✅ ${kw}`);
      console.log(`   坐标  ${g.lon}, ${g.lat}   ${g.ms}ms`);
      console.log(`   级别  ${g.level || '(空)'}`);
      if (g.addr) console.log(`   地址  ${g.addr}`);
    } else {
      console.log(`❌ ${kw}  ${g.why}`);
    }
  }

  console.log('─'.repeat(58));
  console.log('说明：JS 的 Geocoder.getPoint() 就是调这个接口，');
  console.log('所以这里能出坐标，前端搜索框就能搜到城市名。');
};

main().catch((e) => {
  console.error('诊断失败：', e.message);
  process.exitCode = 1;
});
