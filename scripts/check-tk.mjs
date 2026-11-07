#!/usr/bin/env node
/**
 * 检查本地配置是否可用（不会打印完整 key）
 *
 *   node scripts/check-tk.mjs
 *
 * 做三件事：
 *   1. 读 .env.local
 *   2. 调一次天地图逆地理，确认 key 没被封/没超额
 *   3. 检查素材库目录是否存在
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env.local');

function loadEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const mask = (s) => (s.length <= 10 ? '***' : `${s.slice(0, 3)}…${s.slice(-3)}（${s.length} 位）`);
const line = (s = '') => console.log(s);

line('天地图配置检查');
line('─'.repeat(48));

if (!existsSync(ENV_PATH)) {
  console.error('❌ 找不到 .env.local');
  console.error('   执行:  copy .env.example .env.local   然后填入 TDT_TK');
  process.exit(1);
}

const env = loadEnv(ENV_PATH);
const tk = env.TDT_TK;

if (!tk) {
  console.error('❌ .env.local 里的 TDT_TK 是空的');
  console.error(`   文件位置: ${ENV_PATH}`);
  console.error('   用记事本或 VS Code 打开，在 TDT_TK= 后面粘贴 32 位密钥后保存。');
  process.exit(1);
}
if (tk.length !== 32) {
  console.warn(`⚠️  key 长度是 ${tk.length}，通常应该是 32 位——可能多粘了空格或换行`);
}
line(`key      ${mask(tk)}`);

// ── 素材库目录 ──
const mediaRoot = env.MEDIA_ROOT || '.dev-media';
if (existsSync(mediaRoot) && statSync(mediaRoot).isDirectory()) {
  line(`素材库   ✅ ${mediaRoot}`);
} else {
  line(`素材库   ⚠️  ${mediaRoot} 不存在，扫描前需要先建好这个目录`);
}

// ── 连通性 ──
const url =
  'https://api.tianditu.gov.cn/geocoder?postStr=' +
  encodeURIComponent(JSON.stringify({ lon: 120.15, lat: 30.28, ver: 1 })) +
  '&type=geocode&tk=' +
  tk;

const t0 = Date.now();
try {
  // 关键：key 是「浏览器端」类型，服务端调用必须伪装成浏览器，否则 403 权限类型错误
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Referer: 'http://localhost:5173/',
    },
  });
  const ms = Date.now() - t0;
  const text = await res.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    line(`接口     ❌ 返回的不是 JSON（HTTP ${res.status}）`);
    line('   前 200 字：');
    line('   ' + text.slice(0, 200).split(tk).join('***'));
    line('');
    line('   多半是：key 类型不对（需选「浏览器端」）、域名白名单、或当日配额用完');
    process.exit(1);
  }

  if (data.status !== '0') {
    line(`接口     ❌ status=${data.status}  msg=${data.msg}`);
    process.exit(1);
  }

  const c = data.result.addressComponent;
  line(`接口     ✅ HTTP ${res.status}  ${ms}ms`);
  line(`位置     ${c.province} · ${c.city} · ${c.county}`);
  line(`区划码   ${c.province_code} / ${c.city_code} / ${c.county_code}`);
  line('');
  line('全部正常，可以开工。');
} catch (e) {
  line(`接口     ❌ 请求失败：${String(e.message).split(tk).join('***')}`);
  line('   检查网络，或公司网络是否拦截了 api.tianditu.gov.cn');
  process.exit(1);
}
