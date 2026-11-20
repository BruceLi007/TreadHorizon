/**
 * 分享功能冒烟测试（F-SHR-01 / 2026-11-14 D-416）
 *
 *   node scripts/smoke-share.mjs
 *
 * 全隔离：临时 DATA_DIR + 临时素材库 + 独立端口（默认 4197，SMOKE_SHARE_PORT 可覆盖），
 * AUTH_MODE=multi + STARTER_DATA=0；不碰真实 data/ 与 .dev-media/。
 *
 * 覆盖：鉴权白名单 / 邀请码注册 / 导入十道校验 / 公开三接口 / 密码解锁 / 秘密基地剔除 /
 * 家与离家距离 / 打开次数 + 独立访客 / 不限时 / 到期删除 + 7 天墓碑 / 撤销 / 跨账号隔离 /
 * 配额 / 分享份数上限 / 禁用账号 / 重启清理 / 备份包不含 shares。
 * （P4 本地导出相关断言在导出接口实现后追加。）
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { ZipFile } from 'yazl';
import { openPromise } from 'yauzl';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_SHARE_PORT || 4197);
const BASE = `http://127.0.0.1:${PORT}`;
const SHARE_MAX_ZIP = 20000; // 测试把单份上限压到 20 KB，方便测「超限 413」
const PRUNE_MS = 200;

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label + (extra ? `（${extra}）` : ''));
  }
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
};
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? '' : `实际=${a} 期望=${b}`);
};
const section = (title) => console.log(`\n── ${title} ──`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────── 临时实例 ─────────────

const tmp = mkdtempSync(join(tmpdir(), 'th-share-'));
const dataDir = join(tmp, 'data');
const mediaRoot = join(tmp, 'media');
const sharesRoot = join(dataDir, 'shares');
mkdirSync(dataDir, { recursive: true });
mkdirSync(mediaRoot, { recursive: true });
const dbPath = join(dataDir, 'travel.db');
const logPath = join(tmp, 'server.log');

function readLogs() {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

let child = null;
let logFd = null;

async function startServer() {
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      MEDIA_ROOT: mediaRoot,
      MEDIA_ROOT_DEV: mediaRoot,
      AUTH_MODE: 'multi',
      PORT: String(PORT),
      ADMIN_USERNAME: 'smokeadm',
      ADMIN_PASSWORD: 'smokepass123',
      STARTER_DATA: '0',
      SHARE_MAX_BYTES: String(SHARE_MAX_ZIP),
      SHARE_PRUNE_MS: String(PRUNE_MS),
    },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  let ok = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) {
        ok = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  if (!ok) throw new Error('隔离实例没起来：\n' + readLogs().slice(-3000));
}

async function stopServer() {
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  await sleep(500);
  child = null;
}

// ───────────── HTTP / Cookie ─────────────

class Jar {
  constructor() {
    this.map = new Map();
  }
  store(res) {
    const list = res.headers.getSetCookie?.() ?? [];
    for (const sc of list) {
      const first = String(sc).split(';')[0];
      const i = first.indexOf('=');
      if (i > 0) this.map.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name) {
    return this.map.get(name) || '';
  }
}

async function req(path, { method = 'GET', jar, body, headers = {}, cookie } = {}) {
  const h = { ...headers };
  if (jar) h.cookie = jar.header();
  else if (cookie) h.cookie = cookie;
  const res = await fetch(BASE + path, { method, headers: h, body });
  if (jar) jar.store(res);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, body: data, text };
}

const postJson = (path, obj, opts = {}) =>
  req(path, {
    ...opts,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(obj),
  });

const patchJson = (path, obj, opts = {}) =>
  req(path, {
    ...opts,
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(obj),
  });

const del = (path, opts = {}) => req(path, { ...opts, method: 'DELETE' });

async function importZip(jar, zipPath, fields = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(zipPath)], { type: 'application/zip' }), 'share.zip');
  for (const [k, v] of Object.entries({ expiresIn: '24h', ...fields })) fd.append(k, String(v));
  return req('/api/shares/import', { method: 'POST', jar, body: fd });
}

// ───────────── 分享包构造 ─────────────

const sha16 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

async function makePhoto(id, { noise = false, size = 64 } = {}) {
  let buf;
  if (noise) {
    const w = 256;
    const h = 256;
    const raw = randomBytes(w * h * 3);
    buf = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .webp({ lossless: true })
      .toBuffer();
  } else {
    buf = await sharp({
      create: { width: size, height: size, channels: 3, background: { r: 51, g: 102, b: 153 } },
    })
      .webp({ quality: 75 })
      .toBuffer();
  }
  return { id, kind: 'photo', w: size, h: size, takenAt: Date.now(), file: `p_${sha16(id)}.webp`, bytes: buf.length, buf };
}

function buildManifest({ title = '冒烟分享', sharer = 'u1', places, photos }) {
  const media = photos.map(({ buf, ...m }) => m);
  const counts = {
    places: places.length,
    visits: places.reduce((n, p) => n + (p.visits?.length || 0), 0),
    photos: media.length,
  };
  return {
    format: 'tread-horizon-share',
    formatVersion: 1,
    appVersion: '1.2.0',
    createdAt: Date.now(),
    title,
    sharer: { displayName: sharer },
    counts,
    places,
    media,
  };
}

async function makeZip(dir, name, manifest, photos, extraEntries = []) {
  const zipPath = join(dir, `${name}.zip`);
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'manifest.json');
  for (const p of photos) zip.addBuffer(p.buf, `media/${p.file}`);
  for (const e of extraEntries) zip.addBuffer(Buffer.from(e.data ?? ''), e.name);
  await new Promise((res, rej) => {
    const out = createWriteStream(zipPath);
    zip.outputStream.pipe(out);
    out.on('close', res);
    out.on('error', rej);
    zip.on('error', rej);
    zip.end();
  });
  return zipPath;
}

/** 手写最小 ZIP（store，不压缩）：只用于构造 yazl 拒绝生成的恶意条目名（如 ../evil.txt） */
function makeRawZip(zipPath, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(String(e.name), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  writeFileSync(zipPath, Buffer.concat([localBuf, centralBuf, eocd]));
  return zipPath;
}

function placeOf({ id = 'p_test1', name = '测试地点', home = false, secret = false, distance, visit, mediaIds }) {
  const p = {
    id,
    name,
    kind: 'visited',
    lng: 118.1,
    lat: 30.2,
    provinceCode: '340000',
    provinceName: '安徽省',
    city: '合肥市',
    district: '蜀山区',
    lastDate: '2026-10-02',
    visits: visit === false ? [] : [
      { id: `v_${id}`, date: '2026-10-02', title: '测试到访', note: '笔记', companions: ['阿岚'], media: mediaIds },
    ],
  };
  if (home) p.home = true;
  if (secret) p.secret = true;
  if (distance != null) p.homeDistanceKm = distance;
  return p;
}

function walk(root) {
  const out = [];
  const rec = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(join(abs, e.name), r);
      else out.push(r);
    }
  };
  if (existsSync(root)) rec(root, '');
  return out.sort();
}

/** 直接改隔离库（模拟时间流逝；服务端 WAL 允许另一连接写） */
function withDb(fn) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    return fn(db);
  } finally {
    db.close();
  }
}

const tokenFrom = (r) => r.body?.token || null;

// ───────────── 主流程 ─────────────

try {
  logFd = openSync(logPath, 'a');
  await startServer();

  const admin = new Jar();
  const u1 = new Jar();
  const u2 = new Jar();
  const u3 = new Jar();

  section('0) 初始状态 / 鉴权');
  const health = await req('/api/health');
  check('隔离实例在线', health.status === 200 && health.body?.ok === true);
  const noAuthImport = await importZip(new Jar(), await makeZip(tmp, 'noauth', buildManifest({ places: [], photos: [] }), []));
  eq('未登录导入 → 401', noAuthImport.status, 401);
  eq('未登录看我的分享 → 401', (await req('/api/shares')).status, 401);
  eq('未登录看用量 → 401', (await req('/api/shares/usage')).status, 401);
  eq('公开接口白名单不放行 /api/shares/import', noAuthImport.status, 401);

  section('1) 管理员 / 邀请码注册');
  const login = await postJson('/api/auth/login', { username: 'smokeadm', password: 'smokepass123' }, { jar: admin });
  eq('管理员登录', login.status, 200);
  const inv1 = await postJson('/api/admin/invites', { days: 1 }, { jar: admin });
  check('生成邀请码 1', typeof inv1.body?.code === 'string');
  const reg1 = await postJson(
    '/api/auth/register',
    { inviteCode: inv1.body.code, username: 'smokeu1', password: 'userpass123', displayName: '冒烟一' },
    { jar: u1 }
  );
  eq('邀请码注册 u1', reg1.status, 200);
  const inv2 = await postJson('/api/admin/invites', { days: 1 }, { jar: admin });
  const reg2 = await postJson(
    '/api/auth/register',
    { inviteCode: inv2.body.code, username: 'smokeu2', password: 'userpass123', displayName: '冒烟二' },
    { jar: u2 }
  );
  eq('邀请码注册 u2', reg2.status, 200);
  const inv3 = await postJson('/api/admin/invites', { days: 1 }, { jar: admin });
  const reg3 = await postJson(
    '/api/auth/register',
    { inviteCode: inv3.body.code, username: 'smokeu3', password: 'userpass123', displayName: '冒烟三' },
    { jar: u3 }
  );
  eq('邀请码注册 u3', reg3.status, 200);

  section('2) 合法包导入 + 公开读取');
  const pA = await makePhoto('mA');
  const zipA = await makeZip(
    tmp,
    'a',
    buildManifest({ title: 'A 分享', places: [placeOf({ id: 'pA', name: 'A 地点', mediaIds: ['mA'] })], photos: [pA] }),
    [pA]
  );
  const impA = await importZip(u1, zipA, { title: 'A 分享' });
  eq('导入合法包 → 200', impA.status, 200);
  const tokenA = tokenFrom(impA);
  check('token 22 字符', typeof tokenA === 'string' && tokenA.length === 22, tokenA || '');
  eq('返回 url 以 /s/ 结尾 token', String(impA.body?.url || '').endsWith('/s/' + tokenA), true);
  const dirA = join(sharesRoot, reg1.body.user.id, impA.body.id);
  eq('目录条目 = manifest + 1 张照片', walk(dirA).length, 2);
  const pubA = await req('/api/share/' + tokenA);
  eq('匿名 GET manifest → 200', pubA.status, 200);
  eq('manifest 地点数', pubA.body?.manifest?.counts?.places, 1);
  eq('manifest 照片数', pubA.body?.manifest?.counts?.photos, 1);
  eq('公开响应不含统计字段', ['viewCount', 'visitorCount', 'lastViewAt'].some((k) => k in (pubA.body || {})), false);
  const mediaA = await req('/api/share/' + tokenA + '/media/' + pA.file);
  eq('图片代理 → 200', mediaA.status, 200);
  eq('图片 Content-Type', mediaA.headers.get('content-type'), 'image/webp');
  eq('图片 Cache-Control', mediaA.headers.get('cache-control'), 'private, max-age=86400, immutable');
  eq('媒体路径穿越 → 404', (await req('/api/share/' + tokenA + '/media/' + encodeURIComponent('../../travel.db'))).status, 404);
  eq('未声明的图片文件 → 404', (await req('/api/share/' + tokenA + '/media/p_ffffffffffffffff.webp')).status, 404);
  const pageRes = await fetch(BASE + '/s/' + tokenA);
  // 2026-11-15 D-448：图片可缓存 24h；页面外壳可缓存，但数据 JSON 必须 no-store（撤销 / 统计实时）
  eq('分享 JSON Cache-Control', (await req('/api/share/' + tokenA)).headers.get('cache-control'), 'private, no-store');
  const pageHtml = await pageRes.text();
  check('只读页入口 200 且返回 share.html', pageRes.status === 200 && pageHtml.includes('id="root"'), pageRes.status);
  check('只读页 noindex / no-referrer', pageHtml.includes('name="robots"') && pageHtml.includes('noindex'));

  section('3) 十道校验 / 恶意包');
  const pBad = await makePhoto('mBad');
  const zipExtra = await makeZip(tmp, 'extra', buildManifest({ places: [placeOf({ id: 'pX', mediaIds: ['mBad'] })], photos: [pBad] }), [pBad], [
    { name: 'evil.txt', data: 'x' },
  ]);
  eq('多余文件 → 400', (await importZip(u1, zipExtra)).status, 400);
  eq('缺 manifest → 400', (await importZip(u1, await makeZip(tmp, 'nomanifest', { format: 'x' }, []))).status, 400);
  const pNonWebp = await makePhoto('mNon', { noise: false });
  const zipNonWebp = await makeZip(
    tmp,
    'nonwebp',
    buildManifest({ places: [placeOf({ id: 'pN', mediaIds: ['mNon'] })], photos: [{ ...pNonWebp }] }),
    [{ ...pNonWebp, buf: Buffer.from('not a webp') }]
  );
  eq('非 WebP → 400', (await importZip(u1, zipNonWebp)).status, 400);
  const zipTrav = makeRawZip(join(tmp, 'trav.zip'), [
    { name: '../evil.txt', data: 'x' },
    { name: 'manifest.json', data: JSON.stringify(buildManifest({ places: [], photos: [] })) },
  ]);
  eq('路径穿越条目 → 400', (await importZip(u1, zipTrav)).status, 400);
  const pVid = await makePhoto('mVid');
  const zipVideo = await makeZip(
    tmp,
    'video',
    buildManifest({
      places: [placeOf({ id: 'pV', mediaIds: ['mVid'] })],
      photos: [{ ...pVid, kind: 'video', file: 'v_1234567890abcdef.webp' }],
    }),
    [pVid]
  );
  eq('视频 kind → 400', (await importZip(u1, zipVideo)).status, 400);
  const zipVidName = await makeZip(
    tmp,
    'vidname',
    buildManifest({ places: [placeOf({ id: 'pV2', mediaIds: ['mVid2'] })], photos: [{ ...pVid, id: 'mVid2' }] }),
    [{ ...pVid, file: 'v_abcdef1234567890.webp' }]
  );
  eq('v_*.webp 文件名 → 400', (await importZip(u1, zipVidName)).status, 400);
  const badCounts = buildManifest({ places: [placeOf({ id: 'pC', mediaIds: ['mC'] })], photos: [pBad] });
  badCounts.counts.photos = 99;
  eq('counts 不一致 → 400', (await importZip(u1, await makeZip(tmp, 'badcounts', badCounts, [pBad]))).status, 400);

  section('4) 秘密基地不参与分享 / 分享密码');
  const pS = await makePhoto('mS');
  const zipSecretNoPw = await makeZip(
    tmp,
    'secret-nopw',
    buildManifest({ places: [placeOf({ id: 'pS', secret: true, mediaIds: ['mS'] })], photos: [pS] }),
    [pS]
  );
  eq('含秘密基地（未设密码）→ 400', (await importZip(u1, zipSecretNoPw)).status, 400);
  const zipSecret = await makeZip(
    tmp,
    'secret',
    buildManifest({ places: [placeOf({ id: 'pS', secret: true, mediaIds: ['mS'] })], photos: [pS] }),
    [pS]
  );
  // 2026-11-15 D-427：秘密基地一律不参与分享 —— 设了密码也不再放行
  eq('含秘密基地（设了密码）→ 仍 400', (await importZip(u1, zipSecret, { password: 'tread-4821' })).status, 400);

  // 分享密码本身仍是独立功能：拿普通包验解锁链路
  const zipPw = await makeZip(
    tmp,
    'pw-ok',
    buildManifest({ places: [placeOf({ id: 'pPw', mediaIds: ['mS'] })], photos: [pS] }),
    [pS]
  );
  const impPw = await importZip(u1, zipPw, { password: 'tread-4821' });
  eq('普通包 + 分享密码 → 200', impPw.status, 200);
  const tokenS = tokenFrom(impPw);
  const listPw = await req('/api/shares', { jar: u1 });
  const rowPw = listPw.body.items.find((x) => x.token === tokenS);
  eq('列表 hasPassword = true', rowPw?.hasPassword, true);
  eq('列表 hasSecret = false（新分享不含秘密基地）', rowPw?.hasSecret, false);
  eq('未解锁 GET → 401', (await req('/api/share/' + tokenS)).status, 401);
  eq('未解锁 media → 401', (await req('/api/share/' + tokenS + '/media/' + pS.file)).status, 401);
  eq('错密码 → 401', (await postJson('/api/share/' + tokenS + '/unlock', { password: 'wrong' })).status, 401);
  const unlockS = await postJson('/api/share/' + tokenS + '/unlock', { password: 'tread-4821' });
  eq('对密码 → 200', unlockS.status, 200);
  const unlockCookie = String(unlockS.headers.getSetCookie?.()[0] || '').split(';')[0];
  const pubS = await req('/api/share/' + tokenS, { cookie: unlockCookie });
  eq('解锁后 GET → 200', pubS.status, 200);
  eq('公开响应不带 secret 字段', Object.prototype.hasOwnProperty.call(pubS.body.manifest.places[0], 'secret'), false);

  section('5) 家与离家距离');
  const pH = await makePhoto('mH');
  const homeManifest = buildManifest({
    places: [
      placeOf({ id: 'pHome', name: '家', home: true, mediaIds: ['mH'] }),
      placeOf({ id: 'pFar', name: '远处', distance: 830.5, mediaIds: ['mH'] }),
    ],
    photos: [pH],
  });
  const impHome = await importZip(u1, await makeZip(tmp, 'home', homeManifest, [pH]));
  eq('含家分享 → 200', impHome.status, 200);
  const pubHome = await req('/api/share/' + tokenFrom(impHome));
  const ph = pubHome.body.manifest.places.find((x) => x.id === 'pHome');
  const pf = pubHome.body.manifest.places.find((x) => x.id === 'pFar');
  eq('home = true 保留', ph?.home, true);
  eq('离家距离保留', pf?.homeDistanceKm, 830.5);
  const noDist = buildManifest({
    places: [placeOf({ id: 'pHome', name: '家', home: true, mediaIds: ['mH'] }), placeOf({ id: 'pFar2', name: '远处2', mediaIds: ['mH'] })],
    photos: [pH],
  });
  eq('含家但缺距离 → 400', (await importZip(u1, await makeZip(tmp, 'home-nodist', noDist, [pH]))).status, 400);
  const distNoHome = buildManifest({
    places: [placeOf({ id: 'pFar3', name: '远处3', distance: 100, mediaIds: ['mH'] })],
    photos: [pH],
  });
  eq('不含家却带距离 → 400', (await importZip(u1, await makeZip(tmp, 'dist-nohome', distNoHome, [pH]))).status, 400);

  section('6) 打开次数 + 独立访客');
  const pStat = await makePhoto('mStat');
  const impStat = await importZip(
    u1,
    await makeZip(tmp, 'stat', buildManifest({ places: [placeOf({ id: 'pStat', mediaIds: ['mStat'] })], photos: [pStat] }), [pStat])
  );
  const tokenStat = tokenFrom(impStat);
  const list0 = await req('/api/shares', { jar: u1 });
  eq('新分享 viewCount = 0', list0.body.items.find((x) => x.token === tokenStat)?.viewCount, 0);
  const v1 = new Jar();
  await req('/api/share/' + tokenStat, { jar: v1 });
  await req('/api/share/' + tokenStat, { jar: v1 });
  const list1 = await req('/api/shares', { jar: u1 });
  const row1 = list1.body.items.find((x) => x.token === tokenStat);
  eq('刷新两次 viewCount = 2', row1?.viewCount, 2);
  eq('同一 cookie 独立访客 = 1', row1?.visitorCount, 1);
  await req('/api/share/' + tokenStat);
  const list2 = await req('/api/shares', { jar: u1 });
  eq('无 cookie 新访客 visitorCount = 2', list2.body.items.find((x) => x.token === tokenStat)?.visitorCount, 2);
  await req('/api/share/' + tokenStat, { method: 'HEAD' });
  const list3 = await req('/api/shares', { jar: u1 });
  eq('HEAD 不计打开次数', list3.body.items.find((x) => x.token === tokenStat)?.viewCount, 3);

  section('7) 不限时 / 撤销 / 越权');
  const pF = await makePhoto('mF');
  const impForever = await importZip(
    u1,
    await makeZip(tmp, 'forever', buildManifest({ places: [placeOf({ id: 'pF', mediaIds: ['mF'] })], photos: [pF] }), [pF]),
    { expiresIn: 'forever' }
  );
  eq('不限时导入 → 200', impForever.status, 200);
  eq('不限时 expiresAt = null', impForever.body?.expiresAt, null);
  await sleep(PRUNE_MS + 100);
  eq('不限时不参与到期清理', (await req('/api/share/' + tokenFrom(impForever))).status, 200);

  const beforeRevoke = await req('/api/shares', { jar: u1 });
  const curA = beforeRevoke.body.items.find((x) => x.token === tokenA);
  eq('撤销前 A 有效', curA?.status, 'ok');
  eq('越权撤销（u2 撤 u1）→ 404', (await postJson('/api/shares/' + impA.body.id + '/revoke', {}, { jar: u2 })).status, 404);
  // 2026-11-18 D-524：撤销 = 只下线（媒体保留，可在「我的分享」重新上线）；
  // 删除（DELETE）才是进回收站，彻底删除才删媒体。
  eq('撤销 A → 200', (await postJson('/api/shares/' + impA.body.id + '/revoke', {}, { jar: u1 })).status, 200);
  eq('撤销后 GET → 410', (await req('/api/share/' + tokenA)).status, 410);
  eq('撤销后目录保留', existsSync(dirA), true);
  const afterRevoke = await req('/api/shares', { jar: u1 });
  const revA = afterRevoke.body.items.find((x) => x.token === tokenA);
  eq('撤销后状态 revoked', revA?.status, 'revoked');
  eq('撤销后 bytes 保留（要手动彻底删除才释放）', (revA?.bytes ?? 0) > 0, true);
  eq('撤销后打开次数保留', revA?.viewCount, curA?.viewCount);
  eq('重新上线 → 200', (await postJson('/api/shares/' + impA.body.id + '/online', {}, { jar: u1 })).status, 200);
  eq('上线后 GET → 200', (await req('/api/share/' + tokenA)).status, 200);
  // 再撤销一次，供后面「9) 解锁 cookie」断言使用
  eq('再次撤销 → 200', (await postJson('/api/shares/' + impA.body.id + '/revoke', {}, { jar: u1 })).status, 200);

  section('8) 密码分享统计 / 限速');
  const pL = await makePhoto('mL');
  const impLimit = await importZip(
    u1,
    await makeZip(tmp, 'limit', buildManifest({ places: [placeOf({ id: 'pL', mediaIds: ['mL'] })], photos: [pL] }), [pL]),
    { password: 'p@ss-1234' }
  );
  const tokenL = tokenFrom(impLimit);
  eq('密码分享未解锁不计打开', (await req('/api/shares', { jar: u1 })).body.items.find((x) => x.token === tokenL)?.viewCount, 0);
  const unlockL = await postJson('/api/share/' + tokenL + '/unlock', { password: 'p@ss-1234' });
  const cookieL = String(unlockL.headers.getSetCookie?.()[0] || '').split(';')[0];
  await req('/api/share/' + tokenL, { cookie: cookieL });
  eq('解锁后打开计 1', (await req('/api/shares', { jar: u1 })).body.items.find((x) => x.token === tokenL)?.viewCount, 1);

  const pR = await makePhoto('mR');
  const impR = await importZip(
    u1,
    await makeZip(tmp, 'ratelimit', buildManifest({ places: [placeOf({ id: 'pR', mediaIds: ['mR'] })], photos: [pR] }), [pR]),
    { password: 'right-pass' }
  );
  const tokenR = tokenFrom(impR);
  let last = null;
  for (let i = 0; i < 10; i++) {
    last = await postJson('/api/share/' + tokenR + '/unlock', { password: 'wrong' + i });
    if (last.status !== 401) break;
  }
  eq('连续 10 次错密码仍是 401', last?.status, 401);
  eq('第 11 次 → 429', (await postJson('/api/share/' + tokenR + '/unlock', { password: 'wrong11' })).status, 429);

  section('9) 解锁 cookie 只绑单个 token');
  const pB = await makePhoto('mB');
  const impB = await importZip(
    u1,
    await makeZip(tmp, 'tokb', buildManifest({ places: [placeOf({ id: 'pB2', mediaIds: ['mB'] })], photos: [pB] }), [pB]),
    { password: 'same-pass' }
  );
  const tokenB = tokenFrom(impB);
  const unlockB = await postJson('/api/share/' + tokenB + '/unlock', { password: 'same-pass' });
  const cookieB = String(unlockB.headers.getSetCookie?.()[0] || '').split(';')[0];
  eq('B 的解锁 cookie 访问 A（已撤销）仍 410', (await req('/api/share/' + tokenA, { cookie: cookieB })).status, 410);
  const pC = await makePhoto('mC');
  const impC = await importZip(
    u1,
    await makeZip(tmp, 'tokc', buildManifest({ places: [placeOf({ id: 'pC2', mediaIds: ['mC'] })], photos: [pC] }), [pC]),
    { password: 'other-pass' }
  );
  const tokenC = tokenFrom(impC);
  eq('用 B 的 cookie 访问 C → 401', (await req('/api/share/' + tokenC, { cookie: cookieB })).status, 401);

  section('10) 到期删除 / 7 天墓碑 / 重启');
  const pE = await makePhoto('mE');
  const impE = await importZip(
    u1,
    await makeZip(tmp, 'expire', buildManifest({ places: [placeOf({ id: 'pE', mediaIds: ['mE'] })], photos: [pE] }), [pE])
  );
  const tokenE = tokenFrom(impE);
  const dirE = join(sharesRoot, reg1.body.user.id, impE.body.id);
  withDb((db) => db.prepare('UPDATE share SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, impE.body.id));
  eq('过期后 GET → 410', (await req('/api/share/' + tokenE)).status, 410);
  // 2026-11-18 D-524：过期不再自动删媒体（空间要手动彻底删除才释放）
  eq('过期后目录保留', existsSync(dirE), true);
  const usageAfterExpire = await req('/api/shares/usage', { jar: u1 });
  check('过期后 sharesBytes 仍计入该份', usageAfterExpire.body.sharesBytes >= 0);
  withDb((db) => db.prepare('UPDATE share SET purged_at = ? WHERE id = ?').run(Date.now() - 8 * 24 * 3600 * 1000, impE.body.id));
  await sleep(PRUNE_MS * 3);
  eq('墓碑 7 天后行被删 → 404', (await req('/api/share/' + tokenE)).status, 404);

  // 重启清理：再建一份、改成过期、重启后应 410
  const pE2 = await makePhoto('mE2');
  const impE2 = await importZip(
    u1,
    await makeZip(tmp, 'expire2', buildManifest({ places: [placeOf({ id: 'pE2', mediaIds: ['mE2'] })], photos: [pE2] }), [pE2])
  );
  const tokenE2 = tokenFrom(impE2);
  withDb((db) => db.prepare('UPDATE share SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, impE2.body.id));
  await stopServer();
  await startServer();
  eq('重启后过期分享仍 410', (await req('/api/share/' + tokenE2)).status, 410);

  section('11) 分享份数 / 单份上限 / 配额');
  const pTiny = await makePhoto('mTiny');
  const tinyZip = await makeZip(
    tmp,
    'tiny',
    buildManifest({ places: [placeOf({ id: 'pTiny', mediaIds: ['mTiny'] })], photos: [pTiny] }),
    [pTiny]
  );
  const beforeCount = (await req('/api/shares', { jar: u1 })).body.items.filter((x) => x.status === 'ok').length;
  let lastImport = null;
  for (let i = 0; i < 21 - beforeCount; i++) {
    lastImport = await importZip(u1, tinyZip, { expiresIn: '24h' });
  }
  eq('超过 20 份 → 400', lastImport?.status, 400);

  const pBig = await makePhoto('mBig', { noise: true });
  const bigZip = await makeZip(
    tmp,
    'big',
    buildManifest({ places: [placeOf({ id: 'pBig', mediaIds: ['mBig'] })], photos: [pBig] }),
    [pBig]
  );
  check('大包 zip 比测试配额大', statSync(bigZip).size > SHARE_MAX_ZIP, `${statSync(bigZip).size} B`);
  // 2026-11-19 D-543 起「单份上限」= 账号可用空间（写死的 MAX_SHARE_ZIP_BYTES / SHARE_MAX_BYTES 已作废），
  // 所以把 u3 的配额压到 20 KB 来验「单个包超配额 → 413」；下一项再压到 100 B 验「剩余不足」。
  await patchJson('/api/admin/users/' + reg3.body.user.id, { quotaBytes: SHARE_MAX_ZIP }, { jar: admin });
  const bigRes = await importZip(u3, bigZip);
  eq('单份超过账号配额 → 413', bigRes.status, 413);

  await patchJson('/api/admin/users/' + reg3.body.user.id, { quotaBytes: 100 }, { jar: admin });
  eq('配额不足 → 413', (await importZip(u3, tinyZip)).status, 413);

  section('12) 备份包不含 shares/');
  const exp = await postJson('/api/backup/export/start', { includeThumbs: false, includeMedia: false }, { jar: admin });
  check('备份导出 start 返回 jobId', !!exp.body?.jobId);
  let expDone = null;
  for (let i = 0; i < 100; i++) {
    expDone = await req('/api/backup/export/status/' + exp.body.jobId, { jar: admin });
    if (expDone.body?.state !== 'building' && expDone.body?.state !== 'running') break;
    await sleep(150);
  }
  eq('备份导出 done', expDone?.body?.state, 'done');
  const dl = await fetch(BASE + '/api/backup/export/download/' + exp.body.jobId, {
    headers: { cookie: admin.header() },
  });
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  writeFileSync(join(tmp, 'backup.zip'), dlBuf);
  const names = [];
  const zipfile = await openPromise(join(tmp, 'backup.zip'), { lazyEntries: true });
  for await (const e of zipfile.eachEntry()) names.push(String(e.fileName));
  await zipfile.close();
  eq('备份包没有 shares/ 条目', names.some((n) => n.startsWith('shares/')), false);

  section('13) 禁用账号 → 分享立即失效（彻底删除）');
  const pD = await makePhoto('mD');
  const impD = await importZip(
    u2,
    await makeZip(tmp, 'disable', buildManifest({ places: [placeOf({ id: 'pD', mediaIds: ['mD'] })], photos: [pD] }), [pD])
  );
  const tokenD = tokenFrom(impD);
  const dirD = join(sharesRoot, reg2.body.user.id, impD.body.id);
  eq('禁用前 D 可访问', (await req('/api/share/' + tokenD)).status, 200);
  const dis = await patchJson('/api/admin/users/' + reg2.body.user.id, { status: 'disabled' }, { jar: admin });
  eq('管理员禁用 u2', dis.status, 200);
  // 2026-11-18 D-524：禁用账号 = 彻底删除他的分享（所以是 404，不是撤销墓碑的 410）
  eq('禁用后 D → 404（分享已彻底删除）', (await req('/api/share/' + tokenD)).status, 404);
  eq('禁用后 D 目录已删', existsSync(dirD), false);

  section('14) 不会误删别人的分享');
  // 先清掉 u1 在份数测试里堆出来的分享，并恢复 u3 配额，避免影响本节导入
  for (const it of (await req('/api/shares', { jar: u1 })).body.items) {
    await del('/api/shares/' + it.id, { jar: u1 });
  }
  await patchJson('/api/admin/users/' + reg3.body.user.id, { quotaBytes: 100 * 1024 * 1024 }, { jar: admin });
  const pIso1 = await makePhoto('mIso1');
  const pIso2 = await makePhoto('mIso2');
  const pIso3 = await makePhoto('mIso3');
  const mkIso = (pid, photoId, photo) =>
    makeZip(
      tmp,
      pid,
      buildManifest({ places: [placeOf({ id: pid, name: pid, mediaIds: [photoId] })], photos: [photo] }),
      [photo]
    );
  const isoA = await importZip(u1, await mkIso('pIsoA', 'mIso1', pIso1));
  const isoB = await importZip(u1, await mkIso('pIsoB', 'mIso2', pIso2));
  const isoC = await importZip(u3, await mkIso('pIsoC', 'mIso3', pIso3));
  const dirIsoA = join(sharesRoot, reg1.body.user.id, isoA.body.id);
  const dirIsoB = join(sharesRoot, reg1.body.user.id, isoB.body.id);
  const dirIsoC = join(sharesRoot, reg3.body.user.id, isoC.body.id);
  withDb((db) => db.prepare('UPDATE share SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, isoA.body.id));
  await sleep(PRUNE_MS * 3);
  // 2026-11-18 D-524：过期不再自动删媒体，目录要等用户彻底删除
  eq('A 过期后目录保留（不自动删媒体）', existsSync(dirIsoA), true);
  eq('A 过期后 GET → 410', (await req('/api/share/' + tokenFrom(isoA))).status, 410);
  check('B 目录与文件完整', existsSync(dirIsoB) && walk(dirIsoB).length === 2);
  check('C（另一账号）目录与文件完整', existsSync(dirIsoC) && walk(dirIsoC).length === 2);
  eq('B 仍可访问', (await req('/api/share/' + tokenFrom(isoB))).status, 200);
  eq('C 仍可访问', (await req('/api/share/' + tokenFrom(isoC))).status, 200);
  const usageU1 = await req('/api/shares/usage', { jar: u1 });
  check('u1 配额只算存活分享', usageU1.body.sharesBytes > 0 && usageU1.body.shareCount > 0);
} catch (e) {
  console.error('\n💥', e?.stack || e);
  console.error('\n服务日志（末尾）：\n' + readLogs().slice(-4000));
  process.exitCode = 1;
} finally {
  try {
    await stopServer();
  } catch {
    /* ignore */
  }
  try {
    if (logFd != null) closeSync(logFd);
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  if (fail) {
    console.log('失败项：\n- ' + failures.join('\n- '));
    process.exitCode = 1;
  }
}
