#!/usr/bin/env node
/**
 * M6 P2-3 管理后台 / 配额 / 用户数据导出 隔离冒烟（D-204；配额拦截 + 扩容申请 D-310）
 *
 *   node scripts/smoke-admin.mjs
 *
 * 全隔离：临时 DATA_DIR / MEDIA_ROOT / 独立端口（默认 4208，SMOKE_ADMIN_PORT 覆盖），跑完清理；
 * 不碰真实 data/、.dev-media、.env.local。
 *
 * 覆盖：
 * 1) 管理员用户列表（角色 / 状态 / 已用空间 / 配额）与普通用户 403
 * 2) 账号用量汇总 GET /api/account/summary（用量统计 + 默认配额 1 GiB）
 * 3) **配额拦截 + 扩容申请（D-310）**：配额改小后上传被拒 → 用户申请扩容 → 管理员批准 → 上传恢复；
 *    重复申请被拒；恢复默认配额
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

const startServer = ({ port, dataDir, mediaRoot, authMode, adminUser, adminPwd }) => {
  const logPath = join(dirname(dataDir), `server-${port}.log`);
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      STARTER_DATA: '0',
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
    section('3) GET /api/account/summary 用量 + 默认配额 1 GiB');
    const sum = await alice.get('/api/account/summary');
    eq('alice 用量：1 地点 / 1 到访 / 1 照片', [sum.usage.places, sum.usage.visits, sum.usage.photos], [1, 1, 1]);
    check('alice mediaBytes > 0', Number(sum.usage.mediaBytes) > 0, String(sum.usage.mediaBytes));
    check('默认配额 1 GiB（D-310）', sum.quotaBytes === 1 * GB, String(sum.quotaBytes));
    check('默认没有待审批的扩容申请', sum.pendingQuotaRequest == null);

    // ══ 4) 配额拦截 + 扩容申请（D-310，2026-11-08 用户要求：默认 1 GB，可申请扩容）══
    section('4) 配额拦截 + 扩容申请（D-310）');
    const overStats = await alice.get('/api/stats');
    const beforeBytes = (await alice.get('/api/account/summary')).usage.mediaBytes;
    // 管理员把 alice 配额调到 60 KB → 再传大图应被拦截
    await admin.patch(`/api/admin/users/${aliceId}`, { quotaBytes: 60 * 1024 });
    eq('管理员把配额改为 60 KB', (await alice.get('/api/account/summary')).quotaBytes, 60 * 1024);
    const bigJpg = await makeJpg({ width: 2600, height: 2000, noise: true });
    check('测试大图 > 60 KB', bigJpg.length > 60 * 1024, String(bigJpg.length));
    const over = await uploadOne(alice, PORT, aliceVisit, 'alice-big.jpg', bigJpg);
    eq('超配额上传被拦截（added 0）', over.added?.length ?? 0, 0);
    check(
      '拒绝原因含「存储空间不足」',
      (over.errors || []).some((e) => String(e).includes('存储空间不足')),
      JSON.stringify(over.errors)
    );
    eq('被拦截后照片数不变', (await alice.get('/api/stats')).totals.photos, overStats.totals.photos);
    eq(
      '被拦截后 mediaBytes 不变',
      (await alice.get('/api/account/summary')).usage.mediaBytes,
      beforeBytes
    );

    // 用户申请扩容 120 KB → 管理员批准 → 上传恢复
    const quotaReq = await alice.post('/api/account/quota-requests', {
      requestedBytes: 120 * 1024,
      reason: '冒烟测试扩容',
    });
    check(
      'alice 提交扩容申请成功（pending）',
      quotaReq?.ok === true && quotaReq?.request?.status === 'pending',
      JSON.stringify(quotaReq)
    );
    eq(
      '同一账号重复申请被拒（409）',
      await alice.statusOf('POST', '/api/account/quota-requests', { requestedBytes: 200 * 1024 }),
      409
    );
    const adminPending = await admin.get('/api/admin/quota-requests?status=pending');
    check(
      '管理员能看到待审批申请',
      adminPending.items?.some((x) => x.id === quotaReq.request.id),
      JSON.stringify(adminPending.items?.length)
    );
    const approvedResp = await admin.patch(`/api/admin/quota-requests/${quotaReq.request.id}`, {
      action: 'approve',
    });
    check(
      '管理员批准扩容申请成功',
      approvedResp?.ok === true && approvedResp?.request?.status === 'approved',
      JSON.stringify(approvedResp?.request?.status)
    );
    eq(
      '批准后 alice 配额 = 120 KB',
      (await alice.get('/api/account/summary')).quotaBytes,
      120 * 1024
    );
    check(
      '批准后 pending 已清空',
      (await alice.get('/api/account/summary')).pendingQuotaRequest == null
    );
    const afterApprove = await uploadOne(
      alice,
      PORT,
      aliceVisit,
      'alice-after-approve.jpg',
      await makeJpg({ width: 320, height: 240 })
    );
    eq('扩容后上传恢复成功', afterApprove.added?.length ?? 0, 1);
    eq('扩容后照片数 +1', (await alice.get('/api/stats')).totals.photos, overStats.totals.photos + 1);

    // 恢复默认配额（quotaBytes=0 = 用服务端默认 1 GiB）
    await admin.patch(`/api/admin/users/${aliceId}`, { quotaBytes: 0 });
    eq('恢复默认配额 1 GiB', (await alice.get('/api/account/summary')).quotaBytes, 1 * GB);

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

    // ══ 6b) 云端普通用户不再有备份 / 恢复（2026-11-11 D-369 用户要求）══
    section('6b) 普通用户备份 / 恢复已取消（接口移除），只保留「下载我的数据」');
    eq(
      '普通用户 /api/account/restore/inspect 已移除 → 404',
      await alice4.statusOf('POST', '/api/account/restore/inspect'),
      404
    );
    eq(
      '普通用户 /api/account/restore/apply 已移除 → 404',
      await alice4.statusOf('POST', '/api/account/restore/apply', { token: 'x', confirm: true }),
      404
    );
    const readmeText = (await readEntryBuffer(zipPath, 'README.txt')).toString('utf8');
    check(
      '下载包 README 说明「下载到本地」且不再提示从备份恢复',
      readmeText.includes('下载到本地') && !readmeText.includes('从我的备份恢复'),
      readmeText.slice(0, 120)
    );
    check(
      '下载包 README 写明云端不提供自助恢复',
      readmeText.includes('云端不提供') && readmeText.includes('管理员'),
      readmeText.slice(0, 120)
    );
    check(
      '下载包 manifest 说明已改为下载到本地留档',
      String(manifest.note || '').includes('下载到本地'),
      String(manifest.note || '')
    );

    // ══ 6c) 云端素材库接口收紧（2026-11-11 D-370 用户要求：不暴露服务器路径、不能切路径）══
    section('6c) 云端素材库只读：不暴露路径 / 不能切路径 / 不能开服务器文件夹');
    eq('alice GET /api/library → 403（云端不下发服务器路径）', await alice4.statusOf('GET', '/api/library'), 403);
    eq(
      'alice POST /api/library/root → 403',
      await alice4.statusOf('POST', '/api/library/root', { root: join(tmp, 'alice-should-fail') }),
      403
    );
    eq('alice DELETE /api/library/root → 403', await alice4.statusOf('DELETE', '/api/library/root'), 403);
    eq(
      'alice POST /api/library/reveal → 403（不在服务器上开文件夹）',
      await alice4.statusOf('POST', '/api/library/reveal', { dryRun: true }),
      403
    );
    eq('alice POST /api/library/relink → 403（仅管理员）', await alice4.statusOf('POST', '/api/library/relink'), 403);
    eq('管理员 GET /api/library → 403（云端统一不显示路径）', await admin.statusOf('GET', '/api/library'), 403);
    eq(
      '管理员 POST /api/library/root → 403',
      await admin.statusOf('POST', '/api/library/root', { root: join(tmp, 'admin-should-fail') }),
      403
    );
    eq(
      '管理员 POST /api/library/reveal → 403',
      await admin.statusOf('POST', '/api/library/reveal', { dryRun: true }),
      403
    );
    const adminRelink = await admin.post('/api/library/relink');
    check('管理员可调用重新关联（接口保留作运维兜底）', typeof adminRelink.scanned === 'number', adminRelink);
    // 拒绝切路径不影响已有素材：仍在服务器默认素材库目录下、可读取
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
    const aliceStatsFinal = await alice4.get('/api/stats');
    const aliceMediaFinal = (aliceStatsFinal.totals.photos ?? 0) + (aliceStatsFinal.totals.videos ?? 0);
    check('alice 素材数仍为 2', aliceMediaFinal === 2, { aliceMediaFinal });
    eq('素材仍在服务器默认素材库（mediaRoot/<账号ID>）下', countFiles(join(mediaRoot, aliceId)), aliceMediaFinal);
    eq(
      '已有素材仍可读取（orig 200）',
      (await alice4.rawGet(`/api/media/${aliceMedia.added[0].id}/orig`)).status,
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

    // ══ 8) local 模式：账号接口 400、已移除接口 404、旧行为不变 ══
    section('8) local 模式：账号接口 400 / 已移除接口 404 / 旧行为不变');
    local = startServer({ port: LOCAL_PORT, dataDir: localData, mediaRoot: localMedia, authMode: 'local' });
    await waitUp(LOCAL_PORT, local.readLogs);
    const localClient = makeClient(LOCAL_PORT);
    eq('local /api/admin/users → 400', await localClient.statusOf('GET', '/api/admin/users'), 400);
    eq('local /api/account/summary → 400', await localClient.statusOf('GET', '/api/account/summary'), 400);
    eq('local /api/account/export → 400', await localClient.statusOf('GET', '/api/account/export'), 400);
    eq(
      'local /api/account/restore/inspect 已移除 → 404',
      await localClient.statusOf('POST', '/api/account/restore/inspect'),
      404
    );
    eq(
      'local /api/account/restore/apply 已移除 → 404',
      await localClient.statusOf('POST', '/api/account/restore/apply', { token: 'x', confirm: true }),
      404
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
