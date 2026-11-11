#!/usr/bin/env node
/**
 * M6 P2-2 隔离冒烟测试（多用户数据隔离 + 旧数据迁移）
 *
 *   node scripts/smoke-multiuser.mjs
 *
 * 全隔离：临时 DATA_DIR / MEDIA_ROOT / 独立端口（默认 4199，SMOKE_MULTIUSER_PORT 覆盖），跑完清理；
 * 不碰真实 data/、.dev-media、.env.local。
 *
 * 覆盖（P2-2，D-202）：
 * 1) 邀请码注册 + 两账号各自数据互不可见（places / stats / photos / timeline / companions / trash / 搜索）
 * 2) 跨用户 id 访问一律 404（place / visit / media / reveal / trash restore / 媒体文件 URL）
 * 3) 上传落 mediaRoot/<uid>/…、缩略图落 data/thumbs/<uid>/…、rel_path 带 owner 前缀
 * 4) 每用户独立：家 / 秘密基地密码 / 天地图 Key / 备份提醒（数据量只算自己）
 * 5) 多用户权限：普通用户 403（邀请码 / 备份导出）、素材库按账号可用（D-212），未登录 401
 * 6) 回收站隔离
 * 7) local 模式回归：免登录、写入 user_id 为 NULL
 * 8) 迁移脚本：旧 NULL owner 数据归管理员（媒体复制、rel_path 前缀、可重复执行）
 */
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_MULTIUSER_PORT || 4199);
const LOCAL_PORT = PORT + 1;
const MIGRATE_PORT = PORT + 2;
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

/** 手写 Cookie 桶（Node fetch 没有内置 cookie jar） */
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

const makeJpg = (rgb = [80, 60, 30]) =>
  sharp({
    create: { width: 200, height: 150, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();

const uploadPhoto = async (client, port, visitId, name, rgb) => {
  const fd = new FormData();
  fd.append('files', new Blob([await makeJpg(rgb)], { type: 'image/jpeg' }), name);
  const res = await fetch(S(port) + `/api/media/upload?visitId=${encodeURIComponent(visitId)}`, {
    method: 'POST',
    body: fd,
    headers: { cookie: client.cookies.header() },
  });
  client.cookies.capture(res);
  if (!res.ok) throw new Error(`upload HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  return body.added?.[0]?.id ?? null;
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
    // 沙箱不允许 pipe：stdout / stderr 重定向到日志文件
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

/** 用 node:sqlite（只读）读多用户实例的库 */
const readDb = (dataDir, fn) => {
  const conn = new DatabaseSync(join(dataDir, 'travel.db'), { readOnly: true });
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
};

const run = async () => {
  console.log(`\nM6 P2-2 多用户隔离冒烟（D-202，隔离实例 :${PORT}）`);
  console.log('─'.repeat(64));

  const tmp = mkdtempSync(join(ROOT, '.smoke-multiuser-'));
  const multiData = join(tmp, 'data-multi');
  const multiMedia = join(tmp, 'media-multi');
  const localData = join(tmp, 'data-local');
  const localMedia = join(tmp, 'media-local');
  const migrateData = join(tmp, 'data-migrate');
  const migrateMedia = join(tmp, 'media-migrate');
  for (const d of [multiData, multiMedia, localData, localMedia, migrateData, migrateMedia]) {
    mkdirSync(d, { recursive: true });
  }

  let multi = null;
  let local = null;
  let migrateSrv = null;
  try {
    // ══ 1) 多用户实例：登录 + 邀请码注册 ══
    section('1) 多用户实例：管理员登录 + 邀请码注册 alice');
    multi = startServer({
      port: PORT,
      dataDir: multiData,
      mediaRoot: multiMedia,
      authMode: 'multi',
      adminUser: 'admin',
      adminPwd: 'admin-pass-123',
    });
    await waitUp(PORT, multi.readLogs);
    const admin = makeClient(PORT);
    eq('初始 me = multi / 未登录', await admin.get('/api/auth/me'), { mode: 'multi', user: null });
    const login = await admin.post('/api/auth/login', { username: 'admin', password: 'admin-pass-123' });
    eq('管理员登录 role=admin', login.user.role, 'admin');
    const inv = await admin.post('/api/admin/invites', { days: 7, note: 'smoke alice' });
    check('邀请码格式 XXXX-XXXX-XXXX-XXXX', /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(inv.code), inv.code);
    const alice = makeClient(PORT);
    const reg = await alice.post('/api/auth/register', {
      inviteCode: inv.code,
      username: 'alice',
      password: 'alice-pass-123',
      displayName: 'Alice',
    });
    eq('alice 注册成功 role=user', reg.user.role, 'user');

    // ══ 2) 两人各自数据互不可见 ══
    section('2) 两人各自建地点 / 到访 / 上传照片，数据互不可见');
    const adminPlace = await admin.post('/api/places', {
      name: '管理员的地点',
      lng: 120.15,
      lat: 30.25,
      kind: 'visited',
      date: '2020-01-01',
      province: '浙江省',
      city: '杭州市',
    });
    const adminVisit = adminPlace.visits[0].id;
    const adminMedia = await uploadPhoto(admin, PORT, adminVisit, 'admin.jpg', [20, 80, 20]);
    check('管理员上传照片成功', Boolean(adminMedia));

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
    const aliceMedia = await uploadPhoto(alice, PORT, aliceVisit, 'alice.jpg', [80, 20, 20]);
    check('alice 上传照片成功', Boolean(aliceMedia));

    eq('管理员 places 只有自己的', (await admin.get('/api/places')).map((p) => p.name), ['管理员的地点']);
    eq('alice places 只有自己的', (await alice.get('/api/places')).map((p) => p.name), ['alice 的地点']);
    const adminStats = await admin.get('/api/stats');
    const aliceStats = await alice.get('/api/stats');
    eq('管理员 stats 只有自己（places=1 / photos=1）', [adminStats.totals.places, adminStats.totals.photos], [1, 1]);
    eq('alice stats 只有自己（places=1 / photos=1）', [aliceStats.totals.places, aliceStats.totals.photos], [1, 1]);
    const [adminPhotos, alicePhotos] = [await admin.get('/api/photos'), await alice.get('/api/photos')];
    eq('两人照片墙各 1 张', [adminPhotos.total, alicePhotos.total], [1, 1]);
    check(
      '照片墙 id 不交叉',
      !adminPhotos.items.some((p) => p.id === aliceMedia) &&
        !alicePhotos.items.some((p) => p.id === adminMedia)
    );
    eq('管理员 timeline first', (await admin.get('/api/timeline')).first, '2020-01-01');
    eq('alice timeline first', (await alice.get('/api/timeline')).first, '2021-01-01');
    eq('管理员搜索 alice 地点无结果', (await admin.get('/api/places?q=' + encodeURIComponent('alice'))).length, 0);
    eq('管理员回收站为空', (await admin.get('/api/trash')).total, 0);

    // 跨用户媒体 URL
    const asAlice = (path) => fetch(S(PORT) + path, { headers: { cookie: alice.cookies.header() } });
    const asAdmin = (path) => fetch(S(PORT) + path, { headers: { cookie: admin.cookies.header() } });
    eq('alice 访问管理员 thumb → 404', (await asAlice(`/api/media/${adminMedia}/thumb`)).status, 404);
    eq('管理员访问 alice thumb → 404', (await asAdmin(`/api/media/${aliceMedia}/thumb`)).status, 404);
    eq('管理员访问 alice orig → 404', (await asAdmin(`/api/media/${aliceMedia}/orig`)).status, 404);

    // 跨用户 id 访问
    section('2b) 跨用户 id 访问一律 404');
    eq('alice GET 管理员地点', await alice.statusOf('GET', `/api/places/${adminPlace.id}`), 404);
    eq('alice PATCH 管理员地点', await alice.statusOf('PATCH', `/api/places/${adminPlace.id}`, { name: 'hack' }), 404);
    eq('alice DELETE 管理员地点', await alice.statusOf('DELETE', `/api/places/${adminPlace.id}`), 404);
    eq('alice PATCH 管理员到访', await alice.statusOf('PATCH', `/api/visits/${adminVisit}`, { title: 'hack' }), 404);
    eq('alice DELETE 管理员到访', await alice.statusOf('DELETE', `/api/visits/${adminVisit}`), 404);
    eq('alice DELETE 管理员媒体', await alice.statusOf('DELETE', `/api/media/${adminMedia}`), 404);
    eq('alice reveal 管理员媒体', await alice.statusOf('POST', `/api/media/${adminMedia}/reveal`, {}), 404);
    eq(
      'alice 恢复管理员地点',
      await alice.statusOf('POST', '/api/trash/restore', { items: [{ type: 'place', id: adminPlace.id }] }),
      404
    );

    // ══ 3) 媒体文件按用户分目录 ══
    section('3) 媒体文件 / 缩略图按用户分目录、rel_path 带 owner 前缀');
    const mediaRows = readDb(multiData, (c) => c.prepare('SELECT id, user_id, rel_path FROM media').all());
    const adminRow = mediaRows.find((r) => r.id === adminMedia);
    const aliceRow = mediaRows.find((r) => r.id === aliceMedia);
    check('管理员 rel_path 带自己 id 前缀', adminRow.rel_path.startsWith(`${adminRow.user_id}/`), adminRow.rel_path);
    check('alice rel_path 带自己 id 前缀', aliceRow.rel_path.startsWith(`${aliceRow.user_id}/`), aliceRow.rel_path);
    check('管理员原片在 mediaRoot/<adminId>/…', existsSync(join(multiMedia, adminRow.rel_path)));
    check('alice 缩略图在 data/thumbs/<aliceId>/…', existsSync(join(multiData, 'thumbs', aliceRow.user_id, `${aliceMedia}.webp`)));

    // ══ 4) 每用户独立设置 ══
    section('4) 每用户独立：家 / 秘密基地密码 / 天地图 Key / 备份提醒');
    await admin.patch(`/api/places/${adminPlace.id}`, { home: 1 });
    check('管理员设家不影响 alice', !(await alice.get('/api/places')).some((p) => p.home === 1));
    await alice.patch(`/api/places/${alicePlace.id}`, { home: 1 });
    const adminHome = (await admin.get('/api/places')).filter((p) => p.home === 1);
    check('alice 设家不影响管理员', adminHome.length === 1 && adminHome[0].name === '管理员的地点');
    eq('管理员设置秘密基地密码', (await admin.post('/api/secret/password', { newPassword: 'secret-admin-1' })).configured, true);
    eq('alice 秘密基地密码仍为未设置', (await alice.get('/api/secret/status')).configured, false);
    await admin.post('/api/config/tdt-key', { key: 'AAAAbbbbCCCCddddEEEEffffGGGG1111' });
    eq('管理员 config 返回自己的 Key', (await admin.get('/api/config')).tdtTk, 'AAAAbbbbCCCCddddEEEEffffGGGG1111');
    check('alice 看不到管理员的 Key', (await alice.get('/api/config')).tdtTk !== 'AAAAbbbbCCCCddddEEEEffffGGGG1111');
    const adminBackup = await admin.get('/api/backup/status');
    eq('管理员备份数据量只算自己 places=1', adminBackup.dataCounts.places, 1);
    eq('alice 备份数据量只算自己 places=1', (await alice.get('/api/backup/status')).dataCounts.places, 1);

    // ══ 5) 权限 ══
    section('5) 多用户模式权限（普通用户 403 / 未登录 401）');
    eq('alice GET 邀请码列表', await alice.statusOf('GET', '/api/admin/invites'), 403);
    eq('alice 备份导出', await alice.statusOf('POST', '/api/backup/export/start', { includeThumbs: false }), 403);
    // 2026-11-11 D-370（用户要求）：云端素材库只读化——普通用户不能查看服务器路径、
    // 不能切路径 / 打开服务器文件夹 / 重新关联；邀请码、管理员备份导出等仍是管理员专属。
    eq('alice GET /api/library → 403（云端不下发路径）', await alice.statusOf('GET', '/api/library'), 403);
    eq(
      'alice POST /api/library/root → 403',
      await alice.statusOf('POST', '/api/library/root', { root: '/tmp/should-fail' }),
      403
    );
    eq(
      'alice POST /api/library/reveal → 403',
      await alice.statusOf('POST', '/api/library/reveal', { dryRun: true }),
      403
    );
    eq(
      'alice POST /api/library/relink → 403（仅管理员）',
      await alice.statusOf('POST', '/api/library/relink'),
      403
    );
    eq('未登录 GET places', await makeClient(PORT).statusOf('GET', '/api/places'), 401);

    // ══ 6) 回收站隔离 ══
    section('6) 回收站隔离');
    await alice.del(`/api/places/${alicePlace.id}`);
    eq('管理员回收站仍为空', (await admin.get('/api/trash')).total, 0);
    const aliceTrash = await alice.get('/api/trash');
    check('alice 回收站只有自己的地点', aliceTrash.items.length === 1 && aliceTrash.items[0].name === 'alice 的地点');

    await stopServer(multi);
    multi = null;

    // ══ 7) local 模式回归 ══
    section('7) local 模式（AUTH_MODE=local）行为不变');
    local = startServer({ port: LOCAL_PORT, dataDir: localData, mediaRoot: localMedia, authMode: 'local' });
    await waitUp(LOCAL_PORT, local.readLogs);
    const localClient = makeClient(LOCAL_PORT);
    eq('local me', await localClient.get('/api/auth/me'), { mode: 'local', user: null });
    const localPlace = await localClient.post('/api/places', {
      name: '本地地点',
      lng: 116.4,
      lat: 39.9,
      kind: 'visited',
      date: '2019-05-05',
    });
    eq('local /api/places 免登录可用', (await localClient.get('/api/places')).length, 1);
    eq(
      'local 写入的 place.user_id 为 NULL',
      readDb(localData, (c) => c.prepare('SELECT user_id FROM place WHERE id = ?').get(localPlace.id)?.user_id ?? null),
      null
    );
    eq('local /api/stats 免登录可用', (await localClient.get('/api/stats')).totals.places, 1);
    await stopServer(local);
    local = null;

    // ══ 8) 迁移脚本 ══
    section('8) 迁移脚本：local 旧数据归到管理员（复制媒体 / rel_path 前缀 / 幂等）');
    // 8.1 先在 multi 实例里建管理员并造「旧数据」
    migrateSrv = startServer({
      port: MIGRATE_PORT,
      dataDir: migrateData,
      mediaRoot: migrateMedia,
      authMode: 'multi',
      adminUser: 'admin',
      adminPwd: 'admin-pass-123',
    });
    await waitUp(MIGRATE_PORT, migrateSrv.readLogs);
    const migAdmin = makeClient(MIGRATE_PORT);
    await migAdmin.post('/api/auth/login', { username: 'admin', password: 'admin-pass-123' });
    const migPlace = await migAdmin.post('/api/places', {
      name: '迁移前数据',
      lng: 121.47,
      lat: 31.23,
      kind: 'visited',
      date: '2018-08-08',
      province: '上海市',
      city: '上海市',
    });
    const migVisit = migPlace.visits[0].id;
    const migPhoto = await uploadPhoto(migAdmin, MIGRATE_PORT, migVisit, 'before-migrate.jpg', [30, 30, 200]);
    check('迁移前上传一张照片', Boolean(migPhoto));
    await stopServer(migrateSrv);
    migrateSrv = null;

    // 8.2 退化成旧库形态：user_id 置 NULL、rel_path 去前缀，并把原片复制回旧位置
    {
      const adminId = readDb(migrateData, (c) => c.prepare("SELECT id FROM user WHERE username='admin'").get().id);
      const rel = readDb(migrateData, (c) => c.prepare('SELECT rel_path FROM media WHERE id=?').get(migPhoto).rel_path);
      const stripped = rel.startsWith(`${adminId}/`) ? rel.slice(adminId.length + 1) : rel;
      const conn = new DatabaseSync(join(migrateData, 'travel.db'));
      conn.exec('BEGIN IMMEDIATE');
      conn.prepare('UPDATE place SET user_id = NULL').run();
      conn.prepare('UPDATE visit SET user_id = NULL').run();
      conn.prepare('UPDATE media SET user_id = NULL, rel_path = ?').run(stripped);
      conn.exec('COMMIT');
      conn.close();
      const oldAbs = join(migrateMedia, stripped);
      mkdirSync(dirname(oldAbs), { recursive: true });
      copyFileSync(join(migrateMedia, rel), oldAbs);
    }

    // 8.3 预演 + 执行
    const runScript = (args) => {
      const logPath = join(tmp, 'migrate.log');
      const fd = openSync(logPath, 'a');
      const child = spawn(process.execPath, ['scripts/migrate-multiuser.mjs', ...args], {
        cwd: ROOT,
        env: { ...process.env, DATA_DIR: migrateData, MEDIA_ROOT_DEV: migrateMedia, MEDIA_ROOT: migrateMedia },
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
      return { child, logPath, logFd: fd };
    };
    const exitOf = (p) => new Promise((r) => p.child.on('exit', (code) => r(code)));
    const dry = runScript(['--admin', 'admin']);
    eq('迁移预演退出码 0', await exitOf(dry), 0);
    closeSync(dry.logFd);
    const dryLog = readFileSync(dry.logPath, 'utf8');
    check('迁移预演提示待迁移 1 个地点', /待迁移：地点 1/.test(dryLog), dryLog.slice(0, 200));
    const applyRun = runScript(['--admin', 'admin', '--apply']);
    eq('迁移执行退出码 0', await exitOf(applyRun), 0);
    closeSync(applyRun.logFd);
    check('迁移输出「迁移完成」', /迁移完成/.test(readFileSync(applyRun.logPath, 'utf8')));

    // 8.4 重新启动 multi 实例验证迁移结果
    const after = startServer({ port: MIGRATE_PORT, dataDir: migrateData, mediaRoot: migrateMedia, authMode: 'multi' });
    try {
      await waitUp(MIGRATE_PORT, after.readLogs);
      const afterClient = makeClient(MIGRATE_PORT);
      await afterClient.post('/api/auth/login', { username: 'admin', password: 'admin-pass-123' });
      const placesAfter = await afterClient.get('/api/places');
      check('迁移后管理员能看到旧地点', placesAfter.some((p) => p.name === '迁移前数据'), JSON.stringify(placesAfter.map((p) => p.name)));
      eq('迁移后管理员能看到旧照片', (await afterClient.get('/api/photos')).total, 1);
      eq('迁移后旧照片缩略图可读', (await fetch(S(MIGRATE_PORT) + `/api/media/${migPhoto}/thumb`, { headers: { cookie: afterClient.cookies.header() } })).status, 200);
      const migDb = readDb(migrateData, (c) => c.prepare('SELECT COUNT(*) AS n FROM place WHERE user_id IS NULL').get().n);
      eq('迁移后没有 NULL owner 地点', migDb, 0);
      const adminId = readDb(migrateData, (c) => c.prepare("SELECT id FROM user WHERE username='admin'").get().id);
      const newRel = readDb(migrateData, (c) => c.prepare('SELECT rel_path FROM media WHERE id=?').get(migPhoto).rel_path);
      check('迁移后 rel_path 带管理员前缀', newRel.startsWith(`${adminId}/`), newRel);
      check('迁移后文件复制到新位置', existsSync(join(migrateMedia, newRel)));
      const oldRel = newRel.slice(adminId.length + 1);
      check('迁移保留旧位置原文件（只复制不移动）', existsSync(join(migrateMedia, oldRel)));
      // 幂等：再跑一次 --apply 应该退出码 0 且不改动
      const again = runScript(['--admin', 'admin', '--apply']);
      eq('再次迁移幂等退出码 0', await exitOf(again), 0);
      closeSync(again.logFd);
      check('再次迁移提示无需迁移', /无需迁移/.test(readFileSync(again.logPath, 'utf8')));
    } finally {
      await stopServer(after);
    }

    console.log('\n' + '─'.repeat(64));
    console.log(`通过 ${pass} 项，失败 ${fail} 项 ${fail === 0 ? '✅' : '❌'}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    await stopServer(multi);
    await stopServer(local);
    await stopServer(migrateSrv);
    await sleep(150);
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.log(`  (临时目录清理失败，可手动删：${tmp} — ${e.message})`);
    }
  }
};

run().catch((e) => {
  console.error('\nP2-2 冒烟异常：', e?.message || e);
  process.exitCode = 1;
});
