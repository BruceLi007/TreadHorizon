#!/usr/bin/env node
/**
 * M6 P2-3 管理后台 / 配额 / 用户数据导出 隔离冒烟（D-204）
 *
 *   node scripts/smoke-admin.mjs
 *
 * 全隔离：临时 DATA_DIR / MEDIA_ROOT / 独立端口（默认 4208，SMOKE_ADMIN_PORT 覆盖），跑完清理；
 * 不碰真实 data/、.dev-media、.env.local。
 *
 * 覆盖：
 * 1) 管理员用户列表（角色 / 状态 / 已用空间 / 预留配额字段）与普通用户 403
 * 2) 账号用量汇总 GET /api/account/summary（用量统计 + 预留 quotaBytes 字段）
 * 3) **不限额（D-209）**：把预留配额改小后上传仍成功、用量照常增长（只统计不拦截）
 * 4) 管理员不能禁用自己；禁用 bob → 会话失效 / 登录 401；恢复后重登；重置密码 → 旧密码 401 新密码 200
 * 5) 普通用户导出自己的数据：zip 内容 / 数据只含自己 / 不含缩略图素材的选项 / 文件名
 * 6) **普通用户从自己的导出 zip 恢复（D-210）**：检查摘要 / 事务替换 / 其他账号的包被拒 / 最小包恢复
 * 7) local 模式：新接口 400（行为不变）
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
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
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { scanZip, readEntryBuffer } from '../server/zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_ADMIN_PORT || 4208);
const LOCAL_PORT = PORT + 1;
const S = (port) => `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
};
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? '' : `实际=${a} 期望=${b}`);
};
const section = (title) => console.log(`\n── ${title} ──`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jar = () => {
  const store = new Map();
  return {
    header: () => [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    capture(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) store.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    clear: () => store.clear(),
  };
};

const makeClient = (port) => {
  const cookies = jar();
  const call = async (method, path, body) => {
    const headers = {};
    if (cookies.header()) headers.cookie = cookies.header();
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(S(port) + path, { method, headers, body: payload });
    cookies.capture(res);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${json?.error || text.slice(0, 200)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  };
  return {
    cookies,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b ?? {}),
    patch: (p, b) => call('PATCH', p, b ?? {}),
    del: (p) => call('DELETE', p),
    rawGet: async (p) => {
      const headers = {};
      if (cookies.header()) headers.cookie = cookies.header();
      return fetch(S(port) + p, { headers });
    },
    statusOf: async (method, path, body) => {
      try {
        await call(method, path, body);
        return 200;
      } catch (e) {
        return e.status ?? null;
      }
    },
  };
};

/** 生成一张指定尺寸的 jpg（noise=true 用高斯噪声，文件更大） */
const makeJpg = async ({ width = 240, height = 180, noise = false } = {}) => {
  const img = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 90, b: 60 },
      ...(noise ? { noise: { type: 'gaussian', mean: 128, sigma: 40 } } : {}),
    },
  });
  return img.jpeg({ quality: noise ? 95 : 80 }).toBuffer();
};

const uploadOne = async (client, port, visitId, name, buf, type = 'image/jpeg') => {
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type }), name);
  const res = await fetch(S(port) + `/api/media/upload?visitId=${encodeURIComponent(visitId)}`, {
    method: 'POST',
    body: fd,
    headers: { cookie: client.cookies.header() },
  });
  client.cookies.capture(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error(`upload HTTP ${res.status}: ${json?.error || text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return json;
};

/** multipart 上传一个 zip（个人导出恢复检查用）；失败抛出带 body 的错误 */
const uploadZip = async (client, port, path, name, buf) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/zip' }), name);
  const res = await fetch(S(port) + path, {
    method: 'POST',
    body: fd,
    headers: { cookie: client.cookies.header() },
  });
  client.cookies.capture(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${json?.error || text.slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
};

const startServer = ({ port, dataDir, mediaRoot, authMode, adminUser, adminPwd }) => {
  const logPath = join(dirname(dataDir), `server-${port}.log`);
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      MEDIA_ROOT: mediaRoot,
      MEDIA_ROOT_DEV: mediaRoot,
      AUTH_MODE: authMode,
      ...(adminUser ? { ADMIN_USERNAME: adminUser, ADMIN_PASSWORD: adminPwd } : {}),
    },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  const readLogs = () => {
    try {
      return readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };
  return { child, logFd: fd, readLogs };
};

const waitUp = async (port, readLogs) => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(S(port) + '/api/health');
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error(`服务 ${port} 没起来：\n` + readLogs().slice(-2500));
};

const stopServer = async (srv) => {
  if (!srv) return;
  try {
    closeSync(srv.logFd);
  } catch {
    /* ignore */
  }
  if (!srv.child || srv.child.exitCode !== null) return;
  srv.child.kill();
  for (let i = 0; i < 50 && srv.child.exitCode === null; i++) await sleep(100);
};

const GB = 1024 ** 3;

const run = async () => {
  console.log(`\nM6 P2-3 管理后台 / 用量统计 / 用户导出与恢复冒烟（D-204 / D-209 / D-210，隔离实例 :${PORT}）`);
  console.log('─'.repeat(64));

  const tmp = mkdtempSync(join(ROOT, '.smoke-admin-'));
  const dataDir = join(tmp, 'data');
  const mediaRoot = join(tmp, 'media');
  const localData = join(tmp, 'data-local');
  const localMedia = join(tmp, 'media-local');
  for (const d of [dataDir, mediaRoot, localData, localMedia]) mkdirSync(d, { recursive: true });

  let srv = null;
  let local = null;
  try {
    // ══ 1) 启动 + 两账号 ══
    section('1) 多用户实例：admin / alice 两账号');
    srv = startServer({
      port: PORT,
      dataDir,
      mediaRoot,
      authMode: 'multi',
      adminUser: 'admin',
      adminPwd: 'admin-pass-123',
    });
    await waitUp(PORT, srv.readLogs);
    const admin = makeClient(PORT);
    const login = await admin.post('/api/auth/login', { username: 'admin', password: 'admin-pass-123' });
    eq('管理员登录 role=admin', login.user.role, 'admin');
    const adminId = login.user.id;
    const inv = await admin.post('/api/admin/invites', { days: 7 });
    const alice = makeClient(PORT);
    const reg = await alice.post('/api/auth/register', {
      inviteCode: inv.code,
      username: 'alice',
      password: 'alice-pass-123',
      displayName: 'Alice',
    });
    const aliceId = reg.user.id;
    check('alice 注册成功', Boolean(aliceId));

    // 各自造一个地点 + 到访（admin 也造，用于验证导出不串号）
    const adminPlace = await admin.post('/api/places', {
      name: '管理员的秘密地点',
      lng: 120.1,
      lat: 30.2,
      kind: 'visited',
      date: '2020-01-01',
      province: '浙江省',
      city: '杭州市',
    });
    const alicePlace = await alice.post('/api/places', {
      name: 'alice 的地点',
      lng: 104.06,
      lat: 30.67,
      kind: 'visited',
      date: '2021-01-01',
      province: '四川省',
      city: '成都市',
    });
    const aliceVisit = alicePlace.visits[0].id;
    const aliceMedia = await uploadOne(alice, PORT, aliceVisit, 'alice-1.jpg', await makeJpg());
    eq('alice 上传照片成功', Boolean(aliceMedia), true);

    // ══ 2) 管理员用户列表 / 普通用户 403 ══
    section('2) 管理员用户列表 / 权限');
    const list = await admin.get('/api/admin/users');
    eq('用户列表 2 人', list.items.length, 2);
    const rowAdmin = list.items.find((u) => u.id === adminId);
    const rowAlice = list.items.find((u) => u.id === aliceId);
    check('admin 行 role=admin / status=active', rowAdmin?.role === 'admin' && rowAdmin?.status === 'active');
    check('alice 行 role=user / status=active', rowAlice?.role === 'user' && rowAlice?.status === 'active');
    check('alice 行有 usedBytes > 0', Number(rowAlice?.usedBytes) > 0, String(rowAlice?.usedBytes));
    eq('alice 行用量照片=1', rowAlice?.usage?.photos, 1);
    eq('普通用户 GET 用户列表 → 403', await alice.statusOf('GET', '/api/admin/users'), 403);
    eq('普通用户 PATCH 用户 → 403', await alice.statusOf('PATCH', `/api/admin/users/${aliceId}`, { status: 'disabled' }), 403);

    // ══ 3) 账号用量汇总 ══
    section('3) GET /api/account/summary 用量（只统计）');
    const sum = await alice.get('/api/account/summary');
    eq('alice 用量：1 地点 / 1 到访 / 1 照片', [sum.usage.places, sum.usage.visits, sum.usage.photos], [1, 1, 1]);
    check('alice mediaBytes > 0', Number(sum.usage.mediaBytes) > 0, String(sum.usage.mediaBytes));
    check('预留 quotaBytes 字段仍在（默认 5 GiB）', sum.quotaBytes === 5 * GB, String(sum.quotaBytes));

    // ══ 4) 不限额（D-209，2026-11-07 用户验收反馈：本机磁盘副本不限制；只统计）══
    section('4) 不限额：配额改小后上传仍成功、用量照常增长');
    const overStats = await alice.get('/api/stats');
    const beforeBytes = (await alice.get('/api/account/summary')).usage.mediaBytes;
    // 预留配额字段仍可被管理员修改（为 P1 上云后启用），但现在只影响数字、不影响上传
    await admin.patch(`/api/admin/users/${aliceId}`, { quotaBytes: 60 * 1024 });
    eq('预留配额字段已改为 60 KB', (await alice.get('/api/account/summary')).quotaBytes, 60 * 1024);
    const bigJpg = await makeJpg({ width: 2600, height: 2000, noise: true });
    check('测试大图 > 60 KB', bigJpg.length > 60 * 1024, String(bigJpg.length));
    const over = await uploadOne(alice, PORT, aliceVisit, 'alice-big.jpg', bigJpg);
    eq('配额字段很小也上传成功（不拦截）', over.added?.length ?? 0, 1);
    check(
      '没有「配额不足」错误',
      !(over.errors || []).some((e) => String(e).includes('配额')),
      JSON.stringify(over.errors)
    );
    eq('上传后照片数 +1', (await alice.get('/api/stats')).totals.photos, overStats.totals.photos + 1);
    check(
      '上传后 mediaBytes 变大（统计在更新）',
      (await alice.get('/api/account/summary')).usage.mediaBytes > beforeBytes
    );
    // 预留字段恢复默认值（P1 上云前不改动真实数据语义）
    await admin.patch(`/api/admin/users/${aliceId}`, { quotaBytes: 0 });
    eq('预留配额恢复默认 5 GiB', (await alice.get('/api/account/summary')).quotaBytes, 5 * GB);

    // ══ 5) 禁用 / 启用 / 重置密码 ══
    section('5) 禁用 / 启用 / 重置密码');
    eq('管理员不能禁用自己', await admin.statusOf('PATCH', `/api/admin/users/${adminId}`, { status: 'disabled' }), 400);
    eq('禁用 alice 成功', await admin.statusOf('PATCH', `/api/admin/users/${aliceId}`, { status: 'disabled' }), 200);
    eq('alice 会话已失效（me.user=null）', (await alice.get('/api/auth/me')).user, null);
    const alice2 = makeClient(PORT);
    eq('禁用后登录 401', await alice2.statusOf('POST', '/api/auth/login', { username: 'alice', password: 'alice-pass-123' }), 401);
    eq('恢复 alice 成功', await admin.statusOf('PATCH', `/api/admin/users/${aliceId}`, { status: 'active' }), 200);
    const alice3 = makeClient(PORT);
    eq('恢复后可登录', (await alice3.post('/api/auth/login', { username: 'alice', password: 'alice-pass-123' })).user.username, 'alice');
    eq('重置 alice 密码成功', await admin.statusOf('POST', `/api/admin/users/${aliceId}/password`, { newPassword: 'alice-new-pass-456' }), 200);
    const alice4 = makeClient(PORT);
    eq('旧密码登录 401', await alice4.statusOf('POST', '/api/auth/login', { username: 'alice', password: 'alice-pass-123' }), 401);
    eq('新密码登录 200', (await alice4.post('/api/auth/login', { username: 'alice', password: 'alice-new-pass-456' })).user.username, 'alice');

    // ══ 6) 普通用户导出自己的数据 ══
    section('6) 普通用户导出自己的数据（zip 内容 / 只含自己）');
    const exportRes = await alice4.rawGet('/api/account/export?thumbs=1&media=1');
    eq('导出 HTTP 200', exportRes.status, 200);
    eq('导出 content-type=application/zip', exportRes.headers.get('content-type'), 'application/zip');
    const cd = exportRes.headers.get('content-disposition') || '';
    check('content-disposition 带 filename*（中文名）', cd.includes("filename*=UTF-8''"), cd);
    const zipPath = join(tmp, 'alice-export.zip');
    writeFileSync(zipPath, Buffer.from(await exportRes.arrayBuffer()));
    check('导出 zip 文件存在且非空', existsSync(zipPath) && readFileSync(zipPath).length > 0);
    const scanned = await scanZip(zipPath, { maxUncompressed: 2 * GB });
    for (const must of ['manifest.json', 'data.json', 'README.txt']) {
      check(`zip 包含 ${must}`, scanned.names.includes(must));
    }
    check('zip 含缩略图条目', scanned.names.some((n) => n.startsWith('thumbs/')));
    check('zip 含素材条目', scanned.names.some((n) => n.startsWith('media/')));
    const dataJson = JSON.parse((await readEntryBuffer(zipPath, 'data.json')).toString('utf8'));
    eq('data.json 用户 = alice', dataJson.user?.username, 'alice');
    check('data.json 地点只含 alice 的', dataJson.tables.place.length === 1 && dataJson.tables.place[0].name === 'alice 的地点');
    check('data.json 不含管理员地点', !JSON.stringify(dataJson).includes('管理员的秘密地点'));
    check(
      '所有 place / visit / media 行都属于 alice',
      [...dataJson.tables.place, ...dataJson.tables.visit, ...dataJson.tables.media].every((r) => r.user_id === aliceId)
    );
    check('data.json 不含秘密基地密码哈希', !JSON.stringify(dataJson).includes('password_hash'));
    const manifest = JSON.parse((await readEntryBuffer(zipPath, 'manifest.json')).toString('utf8'));
    eq('manifest format', manifest.format, 'travel-horizon-user-export');
    eq('manifest includeMedia', manifest.includes.media, true);

    // 不含缩略图 / 素材的导出
    const exportRes2 = await alice4.rawGet('/api/account/export?thumbs=0&media=0');
    eq('最小导出 HTTP 200', exportRes2.status, 200);
    const zipPath2 = join(tmp, 'alice-export-min.zip');
    writeFileSync(zipPath2, Buffer.from(await exportRes2.arrayBuffer()));
    const scanned2 = await scanZip(zipPath2, { maxUncompressed: 2 * GB });
    eq('最小导出只有 3 个条目', scanned2.names.length, 3);
    check('最小导出不含缩略图', !scanned2.names.some((n) => n.startsWith('thumbs/')));
    check('最小导出不含素材', !scanned2.names.some((n) => n.startsWith('media/')));

    // ══ 6b) 普通用户从自己的导出 zip 恢复（D-210，按账号范围）══
    section('6b) 普通用户从自己的导出 zip 恢复（只替换自己的数据）');
    const baseStats = await alice4.get('/api/stats');
    const baseMediaCount = (baseStats.totals.photos ?? 0) + (baseStats.totals.videos ?? 0);
    const basePlacesResp = await alice4.get('/api/places');
    const basePlaces = Array.isArray(basePlacesResp) ? basePlacesResp : basePlacesResp.places ?? [];
    const baseNames = basePlaces.map((p) => p.name).sort();
    // 先制造「恢复前和导出时不一样」：再加一个地点
    await alice4.post('/api/places', {
      name: '恢复时应被替换掉的地点',
      lng: 100.1,
      lat: 20.1,
      kind: 'visited',
      date: '2022-02-02',
    });
    eq(
      '恢复前地点数 = 基线 +1',
      (await alice4.get('/api/stats')).totals.places,
      baseStats.totals.places + 1
    );

    const exportBytes = readFileSync(zipPath); // 第 6 段生成的「含缩略图 + 原片」导出包
    const inspectedZip = await uploadZip(
      alice4,
      PORT,
      '/api/account/restore/inspect',
      'alice-export.zip',
      exportBytes
    );
    check('恢复检查返回 token', typeof inspectedZip.token === 'string' && inspectedZip.token.length > 10);
    eq('恢复摘要地点数 = 导出时', inspectedZip.summary.counts.places, baseStats.totals.places);
    eq('恢复摘要到访数 = 导出时', inspectedZip.summary.counts.visits, baseStats.totals.visits);
    eq('恢复摘要媒体数 = 导出时', inspectedZip.summary.counts.media, baseMediaCount);
    eq('恢复摘要包含素材', inspectedZip.summary.includes.media, true);
    eq('恢复摘要账号 = alice', inspectedZip.summary.username, 'alice');
    eq('恢复摘要无缺失素材文件', inspectedZip.summary.missingMedia, 0);

    eq(
      '不确认（confirm 缺失）→ 400',
      await alice4.statusOf('POST', '/api/account/restore/apply', { token: inspectedZip.token }),
      400
    );
    eq(
      '错误 token → 400',
      await alice4.statusOf('POST', '/api/account/restore/apply', { token: 'bad-token', confirm: true }),
      400
    );
    const restored = await alice4.post('/api/account/restore/apply', {
      token: inspectedZip.token,
      confirm: true,
    });
    eq('恢复成功 ok=true', restored.ok, true);
    eq('恢复返回地点数', restored.restored.places, baseStats.totals.places);
    check(
      '恢复前自动备份已生成',
      typeof restored.autoBackup?.name === 'string' && restored.autoBackup.name.startsWith('pre-user-restore-'),
      JSON.stringify(restored.autoBackup)
    );
    eq('恢复后地点数回到基线', (await alice4.get('/api/stats')).totals.places, baseStats.totals.places);
    const afterPlacesResp = await alice4.get('/api/places');
    const afterPlaces = Array.isArray(afterPlacesResp) ? afterPlacesResp : afterPlacesResp.places ?? [];
    eq('恢复后地点名与导出时一致', afterPlaces.map((p) => p.name).sort(), baseNames);
    check(
      '「恢复时应被替换掉的地点」已消失',
      !afterPlaces.some((p) => p.name === '恢复时应被替换掉的地点')
    );
    const afterStats = await alice4.get('/api/stats');
    eq(
      '恢复后媒体数回到基线',
      (afterStats.totals.photos ?? 0) + (afterStats.totals.videos ?? 0),
      baseMediaCount
    );
    const mediaFiles = [];
    const mediaOwnerDir = join(mediaRoot, aliceId);
    if (existsSync(mediaOwnerDir)) {
      for (const f of readdirSync(mediaOwnerDir, { recursive: true })) {
        const p = join(mediaOwnerDir, String(f));
        try {
          if (statSync(p).isFile()) mediaFiles.push(String(f));
        } catch {
          /* ignore */
        }
      }
    }
    eq('恢复后素材文件写回 alice 目录', mediaFiles.length, baseMediaCount);
    const thumbDir = join(dataDir, 'thumbs', aliceId);
    check('恢复后缩略图缓存存在', existsSync(thumbDir) && readdirSync(thumbDir).length > 0);

    // 其他账号的导出包不能恢复到 alice
    const adminExportRes = await admin.rawGet('/api/account/export?thumbs=0&media=0');
    const adminExportBuf = Buffer.from(await adminExportRes.arrayBuffer());
    let mismatchErr = null;
    try {
      await uploadZip(alice4, PORT, '/api/account/restore/inspect', 'admin-export.zip', adminExportBuf);
    } catch (e) {
      mismatchErr = e;
    }
    eq('恢复其他账号的导出包 → 400', mismatchErr?.status, 400);
    check(
      '错误提示说明属于其他账号',
      String(mismatchErr?.body?.error || '').includes('属于账号'),
      String(mismatchErr?.body?.error || '')
    );

    // 不含素材的「最小导出」也能恢复（素材文件仍在磁盘上，路径一致）
    const minBytes = readFileSync(zipPath2);
    const minInspected = await uploadZip(
      alice4,
      PORT,
      '/api/account/restore/inspect',
      'alice-export-min.zip',
      minBytes
    );
    eq('最小导出可被恢复检查通过', minInspected.summary.includes.media, false);
    const minRestored = await alice4.post('/api/account/restore/apply', {
      token: minInspected.token,
      confirm: true,
    });
    eq('最小导出恢复成功', minRestored.ok, true);
    eq('最小导出恢复后地点数不变', (await alice4.get('/api/stats')).totals.places, baseStats.totals.places);

    // ══ 6c) 每个账号自定义素材库路径 + 切换时自动同步（D-212 / D-213）══
    section('6c) 素材库路径按账号独立 + 切换时自动同步素材');
    // 当前 alice 在默认素材库 mediaRoot/<aliceId> 下有 2 个素材（6b 恢复回来的）
    const baseMediaCountBefore = 2;
    const customMedia = join(tmp, 'alice-custom-media');
    mkdirSync(customMedia, { recursive: true });
    const setRootRes = await alice4.post('/api/library/root', { root: customMedia });
    eq('普通用户切换自己的素材库路径 ok', setRootRes.ok, true);
    eq('切换路径时把已有素材同步过去', setRootRes.synced?.files, baseMediaCountBefore);
    const lib1 = await alice4.get('/api/library');
    eq('素材库状态 customized=true', lib1.customized, true);
    eq('素材库状态 root = 自定义路径', lib1.root.toLowerCase(), customMedia.toLowerCase());
    eq('切换后素材库不再缺失', lib1.missing, 0);
    const customUp = await uploadOne(alice4, PORT, aliceVisit, 'alice-custom-root.jpg', await makeJpg({ width: 300, height: 220 }));
    eq('自定义路径后上传成功', customUp.added?.length ?? 0, 1);
    eq('自定义路径后媒体可读（orig 200）', (await alice4.rawGet(`/api/media/${customUp.added[0].id}/orig`)).status, 200);
    const countFiles = (dir) => {
      if (!existsSync(dir)) return 0;
      let n = 0;
      for (const f of readdirSync(dir, { recursive: true })) {
        try {
          if (statSync(join(dir, String(f))).isFile()) n++;
        } catch {
          /* ignore */
        }
      }
      return n;
    };
    eq('文件落在自定义路径/<账号ID>/ 下', countFiles(join(customMedia, aliceId)), baseMediaCountBefore + 1);
    eq('默认素材库下该账号目录已清空', countFiles(join(mediaRoot, aliceId)), 0);

    // 再次切到另一个路径：素材继续自动同步过去（本次含刚上传的那张）
    const customMedia2 = join(tmp, 'alice-custom-media-2');
    mkdirSync(customMedia2, { recursive: true });
    const setRoot2 = await alice4.post('/api/library/root', { root: customMedia2 });
    eq('再次切换路径 ok', setRoot2.ok, true);
    eq('再次切换同步全部素材', setRoot2.synced?.files, baseMediaCountBefore + 1);
    eq('文件同步到第二个自定义路径', countFiles(join(customMedia2, aliceId)), baseMediaCountBefore + 1);
    eq('第一个自定义路径已清空', countFiles(join(customMedia, aliceId)), 0);
    eq(
      '切换后媒体仍可读（orig 200）',
      (await alice4.rawGet(`/api/media/${customUp.added[0].id}/orig`)).status,
      200
    );

    // 打开本地文件夹接口（dryRun，避免冒烟测试真的弹资源管理器）
    const reveal = await alice4.post('/api/library/reveal', { dryRun: true });
    eq('打开本地文件夹接口 ok（dryRun）', reveal.ok, true);

    // 其他账号不受影响：admin 自己的素材库统计仍是自己的（admin 本次没传媒体 = 0）
    const adminLib = await admin.get('/api/library');
    eq('管理员素材库统计不受 alice 自定义路径影响', adminLib.total, 0);

    // 管理员自己也是「按账号管理素材库路径」（D-213）：可切换自己的路径，不影响他人
    const adminCustom = join(tmp, 'admin-custom-media');
    mkdirSync(adminCustom, { recursive: true });
    const adminSet = await admin.post('/api/library/root', { root: adminCustom });
    eq('管理员也可切换自己账号的素材库路径', adminSet.ok, true);
    eq('管理员路径 customized=true', (await admin.get('/api/library')).customized, true);
    const adminReset = await admin.del('/api/library/root');
    eq('管理员恢复默认路径 ok', adminReset.ok, true);
    eq('管理员恢复默认后 customized=false', (await admin.get('/api/library')).customized, false);

    // 普通用户恢复默认路径：素材自动同步回默认素材库
    const resetRoot = await alice4.del('/api/library/root');
    eq('恢复默认路径 ok', resetRoot.ok, true);
    eq('恢复默认路径时把素材同步回默认位置', resetRoot.synced?.files, baseMediaCountBefore + 1);
    const lib2 = await alice4.get('/api/library');
    eq('恢复默认后 customized=false', lib2.customized, false);
    // D-215（用户要求）：当前路径直接显示本机文件夹（不再隐藏默认素材库路径）
    eq('未自定义时也直接显示素材库路径', lib2.root.toLowerCase(), resolve(mediaRoot).toLowerCase());
    eq('素材已同步回默认素材库', countFiles(join(mediaRoot, aliceId)), baseMediaCountBefore + 1);
    eq('第二个自定义路径已清空', countFiles(join(customMedia2, aliceId)), 0);
    eq(
      '恢复默认后媒体仍可读（orig 200）',
      (await alice4.rawGet(`/api/media/${customUp.added[0].id}/orig`)).status,
      200
    );

    // ══ 7) 管理员全量备份仍可用（multi 管理员）══
    section('7) 管理员全量备份 / 恢复入口保留');
    const job = await admin.post('/api/backup/export/start', { includeThumbs: false, includeMedia: false });
    check('管理员可启动全量导出任务', Boolean(job.jobId), JSON.stringify(job).slice(0, 120));
    await admin.del(`/api/backup/export/${job.jobId}`).catch(() => null);

    // ══ 7b) health / config 按角色分层（P2-4，D-205）══
    section('7b) health / config 按角色分层（P2-4）');
    const anonHealthRes = await fetch(S(PORT) + '/api/health');
    const anonHealth = await anonHealthRes.json();
    check(
      '匿名 health 只返回 ok/authMode（无服务器信息）',
      anonHealth.ok === true &&
        anonHealth.authMode === 'multi' &&
        anonHealth.mediaRoot === undefined &&
        anonHealth.dataDir === undefined &&
        anonHealth.stats === undefined,
      JSON.stringify(anonHealth).slice(0, 120)
    );
    const adminHealth = await admin.get('/api/health');
    check(
      '管理员 health 有服务器路径 / ffmpeg / 全局数据量',
      Boolean(adminHealth.mediaRoot) &&
        Boolean(adminHealth.dataDir) &&
        typeof adminHealth.ffmpeg === 'boolean' &&
        Boolean(adminHealth.globalStats) &&
        typeof adminHealth.globalStats.places === 'number'
    );
    eq('管理员 health 的 Key 状态（未配置自己的 Key）', adminHealth.hasTk, false);
    const aliceHealth = await alice4.get('/api/health');
    check(
      '普通用户 health 不下发服务器路径 / ffmpeg / 全局数据',
      aliceHealth.mediaRoot === undefined &&
        aliceHealth.dataDir === undefined &&
        aliceHealth.ffmpeg === undefined &&
        aliceHealth.globalStats === undefined
    );
    eq('普通用户 health 只含自己的数据量（places=1）', aliceHealth.stats?.places, 1);
    eq('普通用户 health.hasTk=false（未填自己的 Key）', aliceHealth.hasTk, false);
    eq('普通用户 config 不再回落服务器全局 Key', (await alice4.get('/api/config')).tdtTk, '');
    eq(
      '普通用户未填 Key 时搜索 → 400',
      await alice4.statusOf('GET', '/api/search?q=' + encodeURIComponent('杭州')),
      400
    );
    eq(
      '普通用户未填 Key 时逆地理 → 400',
      await alice4.statusOf('GET', '/api/reverse?lng=120&lat=30'),
      400
    );
    await admin.post('/api/config/tdt-key', { key: 'AAAAbbbbCCCCddddEEEEffffGGGG1111' });
    eq('管理员 config 返回自己的 Key', (await admin.get('/api/config')).tdtTk, 'AAAAbbbbCCCCddddEEEEffffGGGG1111');
    eq('管理员 health.hasTk=true', (await admin.get('/api/health')).hasTk, true);
    eq('普通用户仍看不到管理员的 Key', (await alice4.get('/api/config')).tdtTk, '');
    eq(
      '普通用户搜索仍 400（每个账号需要自己的 Key）',
      await alice4.statusOf('GET', '/api/search?q=' + encodeURIComponent('杭州')),
      400
    );

    await stopServer(srv);
    srv = null;

    // ══ 8) local 模式：新接口 400、旧行为不变 ══
    section('8) local 模式：新接口 400 / 旧接口不变');
    local = startServer({ port: LOCAL_PORT, dataDir: localData, mediaRoot: localMedia, authMode: 'local' });
    await waitUp(LOCAL_PORT, local.readLogs);
    const localClient = makeClient(LOCAL_PORT);
    eq('local /api/admin/users → 400', await localClient.statusOf('GET', '/api/admin/users'), 400);
    eq('local /api/account/summary → 400', await localClient.statusOf('GET', '/api/account/summary'), 400);
    eq('local /api/account/export → 400', await localClient.statusOf('GET', '/api/account/export'), 400);
    eq(
      'local /api/account/restore/inspect → 400',
      await localClient.statusOf('POST', '/api/account/restore/inspect'),
      400
    );
    eq(
      'local /api/account/restore/apply → 400',
      await localClient.statusOf('POST', '/api/account/restore/apply', { token: 'x', confirm: true }),
      400
    );
    // D-213：local 模式也能查素材库 / 打开文件夹（dryRun）
    eq('local /api/library → 200', await localClient.statusOf('GET', '/api/library'), 200);
    eq(
      'local /api/library/reveal（dryRun）→ ok',
      (await localClient.post('/api/library/reveal', { dryRun: true })).ok,
      true
    );
    const localHealth = await localClient.get('/api/health');
    eq('local health.authMode = local', localHealth.authMode, 'local');
    check(
      'local health 仍含数据目录 / 素材库（行为不变）',
      Boolean(localHealth.mediaRoot) && Boolean(localHealth.dataDir)
    );
    const localPlace = await localClient.post('/api/places', {
      name: '本地地点',
      lng: 116.4,
      lat: 39.9,
      kind: 'visited',
      date: '2019-05-05',
    });
    eq('local 建地点免登录仍可用', Boolean(localPlace.id), true);
    eq('local /api/places 免登录', (await localClient.get('/api/places')).length, 1);
    const localDb = new DatabaseSync(join(localData, 'travel.db'), { readOnly: true });
    eq('local 新写入 place.user_id 仍为 NULL', localDb.prepare('SELECT user_id FROM place WHERE id=?').get(localPlace.id).user_id ?? null, null);
    localDb.close();
    await stopServer(local);
    local = null;

    console.log('\n' + '─'.repeat(64));
    console.log(`通过 ${pass} 项，失败 ${fail} 项 ${fail === 0 ? '✅' : '❌'}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    await stopServer(srv);
    await stopServer(local);
    await sleep(150);
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.log(`  (临时目录清理失败，可手动删：${tmp} — ${e.message})`);
    }
  }
};

run().catch((e) => {
  console.error('\nP2-3 冒烟异常：', e?.message || e);
  process.exitCode = 1;
});
