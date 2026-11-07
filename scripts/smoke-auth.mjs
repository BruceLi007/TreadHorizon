/**
 * M6 P2-1 账号体系（D-200）隔离冒烟测试
 *
 *   node scripts/smoke-auth.mjs          # 或 npm run smoke:auth
 *
 * 全隔离：临时 DATA_DIR + 临时 MEDIA_ROOT + 独立端口实例，跑完清理；
 * 不碰真实 data/、.dev-media、.env.local。
 *
 * 端口（SMOKE_AUTH_PORT 覆盖基准端口，默认 4199，本地模式 +1、init-admin 验证 +2）：
 * - 4199 多用户实例（AUTH_MODE=multi + ADMIN_USERNAME/ADMIN_PASSWORD，首次启动自动建管理员）
 * - 4200 本地模式实例（AUTH_MODE=local，不设 ADMIN_*）
 * - 4201 init-admin 验证实例（跑 scripts/init-admin.mjs 后起服务验证 root2 / --reset）
 *
 * 覆盖：
 * - /api/health.authMode、匿名 /api/auth/me、管理员登录、会话 Cookie 属性、登出
 * - 邀请码：生成（明文只返回一次）/ 列表 / 一次性 409 / 作废 / 过期 410 / 未登录 401 / 非管理员 403
 * - 邀请码注册、注册校验（弱密码 / 重复用户名 / 无效邀请码 / 非法用户名）、禁用账号
 * - 改密码（旧密码校验、旧密码失效、已登录会话仍有效）
 * - CSRF Origin 校验（跨站 403、同源通过）
 * - 登录限速（不存在的用户名 nobody 连错 5 次后第 6 次 429，管理员不受影响）
 * - AUTH_MODE=local：health.authMode / auth/me / 登录注册 400 / 旧接口无需登录
 * - scripts/init-admin.mjs：创建管理员 / --reset 重置密码 / 密码只存哈希、不打印明文
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawPort = Number(process.env.SMOKE_AUTH_PORT);
const BASE_PORT = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 4199;
const MULTI_PORT = BASE_PORT;
const LOCAL_PORT = BASE_PORT + 1;
const ADMIN_PORT = BASE_PORT + 2;
const URL_MULTI = `http://127.0.0.1:${MULTI_PORT}`;
const URL_LOCAL = `http://127.0.0.1:${LOCAL_PORT}`;
const URL_ADMIN = `http://127.0.0.1:${ADMIN_PORT}`;

const ADMIN_NAME = 'admin';
const ADMIN_PASSWORD = 'admin-pass-123';
const ADMIN2_NAME = 'root2';
const ADMIN2_PASSWORD = 'root2-pass-123';
const ADMIN2_NEW_PASSWORD = 'root2-new-pass-456';
const ALICE = { username: 'alice', password: 'alice-pass-123', displayName: 'Alice' };
const ALICE_NEW_PASSWORD = 'alice-new-pass-456';
const BOB = { username: 'bob', password: 'bob-pass-123', displayName: 'Bob' };
const EVIL_ORIGIN = 'http://evil.example';

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

/** 子进程日志（stdout/stderr 全部重定向到这里：沙箱不允许 pipe） */
let logPath = '';
const readLogs = () => {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
};

// ───────────── HTTP ─────────────

/**
 * 发一个请求并返回 { status, body, text, setCookies }；HTTP 非 2xx 不抛错（断言自己看 status）。
 * cookie 传 "th_session=..." 原始 Cookie 头；origin 用于 CSRF 测试。
 */
const call = async (base, path, { method = 'GET', body, cookie, origin, headers = {} } = {}) => {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  if (origin !== undefined) h.origin = origin;
  const r = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: r.status, ok: r.ok, body: json, text, setCookies: r.headers.getSetCookie?.() ?? [] };
};
const multi = (path, opts) => call(URL_MULTI, path, opts);
const local = (path, opts) => call(URL_LOCAL, path, opts);
const adminApi = (path, opts) => call(URL_ADMIN, path, opts);

const setCookieOf = (res, name = 'th_session') =>
  res.setCookies.find((c) => c.startsWith(name + '=')) ?? '';
const cookieOf = (res, name = 'th_session') => {
  const sc = setCookieOf(res, name);
  return sc ? sc.split(';')[0] : '';
};

const login = (base, username, password, opts = {}) =>
  call(base, '/api/auth/login', { method: 'POST', body: { username, password }, ...opts });
const register = (base, inviteCode, fields, opts = {}) =>
  call(base, '/api/auth/register', { method: 'POST', body: { inviteCode, ...fields }, ...opts });
const createInvite = (cookie, body) =>
  multi('/api/admin/invites', { method: 'POST', body, cookie });
const listInvites = (cookie) => multi('/api/admin/invites', { cookie });

/** 断言 HTTP 状态码；返回响应体（body 可能为 null） */
const expectStatus = async (label, expected, resultOrPromise) => {
  const res = await resultOrPromise;
  check(
    `${label} → HTTP ${expected}`,
    res.status === expected,
    res.status === expected
      ? ''
      : `实际=${res.status}${res.body?.error ? `（${String(res.body.error).slice(0, 120)}）` : ''}`
  );
  return res;
};

// ───────────── 子进程 / DB ─────────────

/** 构造子进程 env：清掉可能从开发环境带进来的账号相关变量，只留本次显式设置 */
const buildEnv = ({ port, dataDir, mediaRoot, authMode, adminUsername, adminPassword }) => {
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    MEDIA_ROOT: mediaRoot,
    MEDIA_ROOT_DEV: mediaRoot,
  };
  for (const key of ['AUTH_MODE', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'SESSION_DAYS', 'COOKIE_SECURE']) {
    delete env[key];
  }
  if (authMode) env.AUTH_MODE = authMode;
  if (adminUsername) env.ADMIN_USERNAME = adminUsername;
  if (adminPassword) env.ADMIN_PASSWORD = adminPassword;
  return env;
};

const waitHealth = async (base) => {
  let lastError = '';
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) {
        const body = await r.json();
        if (body?.ok) return body;
      }
    } catch (e) {
      lastError = e?.message || String(e);
    }
    await sleep(200);
  }
  throw new Error(`服务没起来（${base}）：${lastError || '无响应'}`);
};

/** 直接开临时 DATA_DIR 下的 travel.db 执行一条同步操作（WAL 下可与服务进程共存；busy 时重试） */
const dbExec = async (dataDir, fn) => {
  for (let attempt = 1; ; attempt++) {
    let db = null;
    try {
      db = new DatabaseSync(join(dataDir, 'travel.db'));
      return fn(db);
    } catch (e) {
      if (attempt >= 10 || !/busy|locked/i.test(String(e?.message || ''))) throw e;
      await sleep(100);
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }
};

// ───────────── 主流程 ─────────────

const run = async () => {
  console.log('\nM6 P2-1 账号体系冒烟（隔离实例 :' + [MULTI_PORT, LOCAL_PORT, ADMIN_PORT].join(' / :') + '）');
  console.log('─'.repeat(68));

  const tmp = mkdtempSync(join(ROOT, '.smoke-auth-'));
  logPath = join(tmp, 'server.log');
  console.log(`临时目录：${tmp}`);

  const dataMulti = join(tmp, 'data-multi');
  const mediaMulti = join(tmp, 'media-multi');
  const dataLocal = join(tmp, 'data-local');
  const mediaLocal = join(tmp, 'media-local');
  const dataAdmin = join(tmp, 'data-admin');
  const mediaAdmin = join(tmp, 'media-admin');
  for (const d of [dataMulti, mediaMulti, dataLocal, mediaLocal, dataAdmin, mediaAdmin]) {
    mkdirSync(d, { recursive: true });
  }

  const children = [];
  let logFd = null;
  const spawnServer = ({ port, dataDir, mediaRoot, authMode, adminUsername, adminPassword }) => {
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: ROOT,
      env: buildEnv({ port, dataDir, mediaRoot, authMode, adminUsername, adminPassword }),
      // 沙箱不允许 pipe：stdout/stderr 一律重定向到日志文件
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    children.push(child);
    return child;
  };
  const stopChild = async (child) => {
    if (!child || child.exitCode !== null) return;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
  };
  const runInitAdmin = (dataDir, mediaRoot, args) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, ['scripts/init-admin.mjs', ...args], {
        cwd: ROOT,
        env: buildEnv({ port: ADMIN_PORT, dataDir, mediaRoot, authMode: 'multi' }),
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        rejectPromise(new Error('scripts/init-admin.mjs 超时未退出'));
      }, 30_000);
      child.once('error', (e) => {
        clearTimeout(timer);
        rejectPromise(e);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal });
      });
    });

  let crashed = false;
  try {
    logFd = openSync(logPath, 'a');

    // ═════════════════════════════════════════════════════════════════
    // 1) 多用户实例启动 + 健康检查 / 匿名 me
    // ═════════════════════════════════════════════════════════════════
    section('1) 多用户实例：health.authMode / 自动建管理员 / 匿名 auth/me');
    let multiChild = spawnServer({
      port: MULTI_PORT,
      dataDir: dataMulti,
      mediaRoot: mediaMulti,
      authMode: 'multi',
      adminUsername: ADMIN_NAME,
      adminPassword: ADMIN_PASSWORD,
    });
    const health = await waitHealth(URL_MULTI);
    check('health.authMode = multi', health.authMode, 'multi');
    check('health.ok = true', health.ok === true);
    check(
      '匿名 health 不下发服务器路径（P2-4 D-205 按角色分层）',
      health.dataDir === undefined && health.mediaRoot === undefined
    );
    check('首次启动日志显示已自动创建管理员', readLogs().includes('已创建首个管理员账号'));

    let res = await multi('/api/auth/me');
    eq('匿名 auth/me = {mode:multi, user:null}', res.body, { mode: 'multi', user: null });
    res = await multi('/api/auth/me', { cookie: 'th_session=bogus-token' });
    eq('伪造 Cookie 的 auth/me → user:null', res.body?.user, null);

    // ═════════════════════════════════════════════════════════════════
    // 2) 管理员登录 / 会话 Cookie
    // ═════════════════════════════════════════════════════════════════
    section('2) 管理员登录 / 会话 Cookie / 带 Cookie 的 auth/me');
    await expectStatus('错误密码登录', 401, login(URL_MULTI, ADMIN_NAME, 'definitely-wrong'));
    let loginRes = await expectStatus('正确密码登录', 200, login(URL_MULTI, ADMIN_NAME, ADMIN_PASSWORD));
    eq('登录返回 user.username = admin', loginRes.body?.user?.username, ADMIN_NAME);
    eq('登录返回 user.role = admin', loginRes.body?.user?.role, 'admin');
    check(
      '登录返回 user 不含密码哈希 / 盐',
      loginRes.body?.user &&
        !('password_hash' in loginRes.body.user) &&
        !('salt' in loginRes.body.user) &&
        !('passwordHash' in loginRes.body.user)
    );
    check('登录返回 user.lastLoginAt 是数字', typeof loginRes.body?.user?.lastLoginAt === 'number');

    const adminSetCookie = setCookieOf(loginRes);
    const adminCookie = cookieOf(loginRes);
    check('登录下发 th_session Cookie', Boolean(adminSetCookie), adminSetCookie.split(';')[0]);
    check('会话 Cookie 带 HttpOnly', adminSetCookie.includes('HttpOnly'));
    check('会话 Cookie 带 SameSite=Lax', adminSetCookie.includes('SameSite=Lax'));
    check('会话 Cookie 带 Path=/', adminSetCookie.includes('Path=/'));
    check(
      '会话 Cookie 的 Max-Age > 0',
      /Max-Age=\d+/.test(adminSetCookie) && !adminSetCookie.includes('Max-Age=0'),
      adminSetCookie.match(/Max-Age=\d+/)?.[0] ?? ''
    );
    check('Cookie 头形如 th_session=<token>', /^th_session=\S+$/.test(adminCookie), adminCookie.slice(0, 16) + '…');
    await expectStatus('空用户名 / 密码登录', 400, multi('/api/auth/login', { method: 'POST', body: {} }));

    res = await multi('/api/auth/me', { cookie: adminCookie });
    eq('带 Cookie auth/me → admin', { mode: res.body?.mode, username: res.body?.user?.username }, { mode: 'multi', username: ADMIN_NAME });
    res = await multi('/api/auth/me');
    eq('不带 Cookie auth/me → user:null', res.body?.user, null);
    // P2-4（D-205）：管理员 health 才有服务器路径 / 全局数据
    res = await multi('/api/health', { cookie: adminCookie });
    check(
      '管理员 health 包含数据目录 / 素材库（按角色分层）',
      resolve(res.body?.dataDir) === resolve(dataMulti) &&
        resolve(res.body?.mediaRoot) === resolve(mediaMulti) &&
        Boolean(res.body?.globalStats)
    );

    // 密码只存哈希：直接查库确认（scrypt 128 hex + 16 字节盐）
    const adminRow = await dbExec(dataMulti, (db) =>
      db.prepare('SELECT password_hash, salt FROM user WHERE username = ?').get(ADMIN_NAME)
    );
    check(
      '管理员密码以 scrypt 哈希落库（128 hex），不是明文',
      /^[0-9a-f]{128}$/.test(String(adminRow?.password_hash ?? '')) &&
        adminRow?.password_hash !== ADMIN_PASSWORD
    );
    check('盐是 32 位 hex（16 字节）', /^[0-9a-f]{32}$/.test(String(adminRow?.salt ?? '')));

    // ═════════════════════════════════════════════════════════════════
    // 3) 邀请码：管理员生成 / 列表 / 权限
    // ═════════════════════════════════════════════════════════════════
    section('3) 邀请码：管理员生成 / 列表 / 未登录 401');
    await expectStatus('未登录 GET /api/admin/invites', 401, multi('/api/admin/invites'));
    await expectStatus(
      '未登录 POST /api/admin/invites',
      401,
      multi('/api/admin/invites', { method: 'POST', body: { days: 7 } })
    );

    res = await createInvite(adminCookie, { days: 7, note: 'smoke-7d' });
    eq('管理员生成邀请码 HTTP 200', res.status, 200);
    const invite1 = res.body?.invite;
    const code1 = res.body?.code;
    check(
      '返回明文 code 形如 XXXX-XXXX-XXXX-XXXX',
      /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(String(code1 ?? '')),
      String(code1 ?? '')
    );
    check('invite.id 非空', typeof invite1?.id === 'string' && invite1.id.length > 0);
    eq('invite.note = smoke-7d', invite1?.note, 'smoke-7d');
    eq('invite 初始 used=false / expired=false', { used: invite1?.used, expired: invite1?.expired }, { used: false, expired: false });
    eq('invite.createdBy = admin', invite1?.createdBy, ADMIN_NAME);
    check(
      'invite 有效期约 7 天',
      Math.abs(Number(invite1?.expiresAt) - Number(invite1?.createdAt) - 7 * 86400000) < 5000,
      String(Number(invite1?.expiresAt) - Number(invite1?.createdAt))
    );

    res = await listInvites(adminCookie);
    eq('管理员列出邀请码 HTTP 200', res.status, 200);
    check('邀请码列表包含刚生成的 id', Array.isArray(res.body?.items) && res.body.items.some((i) => i.id === invite1?.id));
    check(
      '邀请码列表不泄露明文 code / 哈希',
      !res.text.includes(String(code1)) &&
        !res.text.includes('code_hash') &&
        (res.body?.items ?? []).every((i) => !('code' in i) && !('code_hash' in i) && !('codeHash' in i))
    );
    const inviteRow = await dbExec(dataMulti, (db) =>
      db.prepare('SELECT code_hash FROM invite WHERE id = ?').get(invite1?.id)
    );
    check(
      '数据库只存邀请码 sha256，不存明文',
      /^[0-9a-f]{64}$/.test(String(inviteRow?.code_hash ?? '')) &&
        inviteRow?.code_hash !== String(code1 ?? '').replace(/-/g, '')
    );

    // ═════════════════════════════════════════════════════════════════
    // 4) 邀请码注册 / 一次性 / 非管理员 403
    // ═════════════════════════════════════════════════════════════════
    section('4) 邀请码注册 / 一次性 409 / 非管理员 403');
    res = await register(URL_MULTI, code1, { ...ALICE });
    eq('邀请码注册 alice HTTP 200', res.status, 200);
    eq('注册返回 user.role = user', res.body?.user?.role, 'user');
    eq('注册返回 user.username = alice', res.body?.user?.username, 'alice');
    check(
      '注册返回 user 不含密码哈希 / 盐',
      res.body?.user && !('password_hash' in res.body.user) && !('salt' in res.body.user)
    );
    const aliceSetCookie = setCookieOf(res);
    const aliceCookie = cookieOf(res);
    check('注册下发会话 Cookie（th_session + HttpOnly）', aliceSetCookie.startsWith('th_session=') && aliceSetCookie.includes('HttpOnly'));

    res = await multi('/api/auth/me', { cookie: aliceCookie });
    eq('注册后的 Cookie 可访问 auth/me → alice', res.body?.user?.username, 'alice');

    await expectStatus('同一邀请码再次注册', 409, register(URL_MULTI, code1, { ...BOB }));

    res = await listInvites(adminCookie);
    const usedRow = (res.body?.items ?? []).find((i) => i.id === invite1?.id);
    eq('已用邀请码 used=true / usedBy=alice', { used: usedRow?.used, usedBy: usedRow?.usedBy }, { used: true, usedBy: 'alice' });
    check('已用邀请码 usedAt 是数字', typeof usedRow?.usedAt === 'number' && usedRow.usedAt > 0);

    await expectStatus('非管理员 GET /api/admin/invites', 403, listInvites(aliceCookie));
    await expectStatus('非管理员 POST /api/admin/invites', 403, createInvite(aliceCookie, { days: 1 }));

    // ═════════════════════════════════════════════════════════════════
    // 5) 作废邀请码
    // ═════════════════════════════════════════════════════════════════
    section('5) 作废邀请码：DELETE 后该码不可注册');
    res = await createInvite(adminCookie, { days: 1, note: 'to-revoke' });
    const invite2 = res.body?.invite;
    const code2 = res.body?.code;
    check('生成第二个邀请码', Boolean(invite2?.id && code2));
    await expectStatus(
      '管理员 DELETE 作废邀请码',
      200,
      multi(`/api/admin/invites/${invite2?.id}`, { method: 'DELETE', cookie: adminCookie })
    );
    const revokedRes = await expectStatus(
      '用已作废邀请码注册',
      400,
      register(URL_MULTI, code2, { username: 'revoked-user', password: 'revoked-pass-123' })
    );
    check('作废码的错误提示 = 邀请码无效', revokedRes.body?.error === '邀请码无效', String(revokedRes.body?.error ?? '').slice(0, 60));
    await expectStatus(
      '再次 DELETE 同一邀请码',
      404,
      multi(`/api/admin/invites/${invite2?.id}`, { method: 'DELETE', cookie: adminCookie })
    );

    // ═════════════════════════════════════════════════════════════════
    // 6) 邀请码过期（直接改库 expires_at）
    // ═════════════════════════════════════════════════════════════════
    section('6) 邀请码过期：改库 expires_at → 注册 410');
    res = await createInvite(adminCookie, { days: 1, note: 'to-expire' });
    const invite3 = res.body?.invite;
    const code3 = res.body?.code;
    check('生成第三个邀请码', Boolean(invite3?.id && code3));
    const expiredChanges = await dbExec(dataMulti, (db) =>
      db.prepare('UPDATE invite SET expires_at = ? WHERE id = ?').run(Date.now() - 60_000, invite3?.id).changes
    );
    eq('改库让邀请码过期（影响 1 行）', expiredChanges, 1);
    await expectStatus(
      '用已过期邀请码注册',
      410,
      register(URL_MULTI, code3, { username: 'expired-user', password: 'expired-pass-123' })
    );
    res = await listInvites(adminCookie);
    const expiredRow = (res.body?.items ?? []).find((i) => i.id === invite3?.id);
    eq('列表里过期邀请码 expired=true / used=false', { expired: expiredRow?.expired, used: expiredRow?.used }, { expired: true, used: false });

    // ═════════════════════════════════════════════════════════════════
    // 7) 注册校验 + 第二个普通用户 bob
    // ═════════════════════════════════════════════════════════════════
    section('7) 注册校验：弱密码 / 非法用户名 / 无效邀请码 / 重复用户名');
    res = await createInvite(adminCookie, { days: 7, note: 'validation' });
    const invite4 = res.body?.invite;
    const code4 = res.body?.code;
    check('生成校验用邀请码', Boolean(invite4?.id && code4));

    await expectStatus(
      '弱密码（7 位）注册',
      400,
      register(URL_MULTI, code4, { username: 'weak-pass', password: '1234567' })
    );
    await expectStatus(
      '用户名非法（含空格）注册',
      400,
      register(URL_MULTI, code4, { username: 'bad name', password: 'valid-pass-123' })
    );
    await expectStatus(
      '不存在的邀请码注册',
      400,
      register(URL_MULTI, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', { username: 'no-invite', password: 'valid-pass-123' })
    );
    await expectStatus(
      '空邀请码注册',
      400,
      register(URL_MULTI, '', { username: 'empty-invite', password: 'valid-pass-123' })
    );

    res = await listInvites(adminCookie);
    const invite4Row = (res.body?.items ?? []).find((i) => i.id === invite4?.id);
    eq('失败的注册不消费邀请码（used=false）', invite4Row?.used, false);

    res = await register(URL_MULTI, code4, { ...BOB });
    eq('校验失败后同一邀请码仍能注册 bob HTTP 200', res.status, 200);
    eq('bob 注册返回 role=user', res.body?.user?.role, 'user');
    const bobCookie = cookieOf(res);
    check('bob 注册下发会话 Cookie', /^th_session=\S+$/.test(bobCookie));
    res = await multi('/api/auth/me', { cookie: bobCookie });
    eq('bob Cookie auth/me → bob', res.body?.user?.username, 'bob');

    res = await createInvite(adminCookie, { days: 7, note: 'duplicate' });
    const invite5 = res.body?.invite;
    const code5 = res.body?.code;
    check('生成重复用户名用邀请码', Boolean(invite5?.id && code5));
    await expectStatus(
      '已存在用户名（alice）注册',
      409,
      register(URL_MULTI, code5, { username: ALICE.username, password: 'another-pass-123' })
    );
    res = await listInvites(adminCookie);
    const invite5Row = (res.body?.items ?? []).find((i) => i.id === invite5?.id);
    eq('重复用户名失败不消费邀请码', invite5Row?.used, false);

    // ═════════════════════════════════════════════════════════════════
    // 8) 禁用账号：登录 401 / 已有会话失效
    // ═════════════════════════════════════════════════════════════════
    section('8) 禁用账号：登录 401 / 已有会话 auth/me → null');
    const disableChanges = await dbExec(dataMulti, (db) =>
      db.prepare("UPDATE user SET status = 'disabled' WHERE username = ?").run(BOB.username).changes
    );
    eq("改库禁用 bob（status='disabled'，影响 1 行）", disableChanges, 1);
    await expectStatus('被禁用账号登录', 401, login(URL_MULTI, BOB.username, BOB.password));
    res = await multi('/api/auth/me', { cookie: bobCookie });
    eq('被禁用账号的旧 Cookie → user:null', res.body?.user, null);

    await dbExec(dataMulti, (db) =>
      db.prepare("UPDATE user SET status = 'active' WHERE username = ?").run(BOB.username)
    );
    const bobLogin = await expectStatus('恢复 active 后可登录', 200, login(URL_MULTI, BOB.username, BOB.password));
    const bobCookie2 = cookieOf(bobLogin);
    check('恢复后重新登录拿到新 Cookie', /^th_session=\S+$/.test(bobCookie2));
    res = await multi('/api/auth/me', { cookie: bobCookie2 });
    eq('新 Cookie auth/me → bob', res.body?.user?.username, 'bob');

    // ═════════════════════════════════════════════════════════════════
    // 9) 改密码
    // ═════════════════════════════════════════════════════════════════
    section('9) 改密码：旧密码校验 / 旧密码失效 / 新密码生效 / 已有会话保留');
    await expectStatus(
      '未登录改密码',
      401,
      multi('/api/auth/password', {
        method: 'POST',
        body: { oldPassword: ALICE.password, newPassword: ALICE_NEW_PASSWORD },
      })
    );
    await expectStatus(
      '旧密码错误',
      400,
      multi('/api/auth/password', {
        method: 'POST',
        cookie: aliceCookie,
        body: { oldPassword: 'wrong-old-pass', newPassword: ALICE_NEW_PASSWORD },
      })
    );
    await expectStatus(
      '新密码过短',
      400,
      multi('/api/auth/password', {
        method: 'POST',
        cookie: aliceCookie,
        body: { oldPassword: ALICE.password, newPassword: 'short' },
      })
    );
    res = await expectStatus(
      '正确旧密码改密',
      200,
      multi('/api/auth/password', {
        method: 'POST',
        cookie: aliceCookie,
        body: { oldPassword: ALICE.password, newPassword: ALICE_NEW_PASSWORD },
      })
    );
    eq('改密返回 {ok:true}', res.body, { ok: true });

    await expectStatus('改密后旧密码登录', 401, login(URL_MULTI, ALICE.username, ALICE.password));
    const aliceLogin2 = await expectStatus(
      '改密后新密码登录',
      200,
      login(URL_MULTI, ALICE.username, ALICE_NEW_PASSWORD)
    );
    const aliceCookie2 = cookieOf(aliceLogin2);
    check('新密码登录下发新 Cookie', /^th_session=\S+$/.test(aliceCookie2));
    res = await multi('/api/auth/me', { cookie: aliceCookie });
    eq('改密不影响已有会话（auth.mjs 约定）', res.body?.user?.username, 'alice');

    // ═════════════════════════════════════════════════════════════════
    // 10) 登出
    // ═════════════════════════════════════════════════════════════════
    section('10) 登出：删会话 / 清 Cookie（Max-Age=0）');
    res = await expectStatus(
      '登出（JSON body {}）',
      200,
      multi('/api/auth/logout', { method: 'POST', body: {}, cookie: aliceCookie2 })
    );
    eq('登出返回 {ok:true}', res.body, { ok: true });
    const clearCookie = setCookieOf(res);
    check('登出 Set-Cookie 清空 th_session', /^th_session=(?:;|$)/.test(clearCookie), clearCookie.split(';')[0]);
    check('登出 Set-Cookie 带 Max-Age=0', clearCookie.includes('Max-Age=0'));
    res = await multi('/api/auth/me', { cookie: aliceCookie2 });
    eq('登出后旧 Cookie → user:null', res.body?.user, null);
    await expectStatus(
      '重复登出仍 200（幂等）',
      200,
      multi('/api/auth/logout', { method: 'POST', body: {}, cookie: aliceCookie2 })
    );
    await expectStatus('无 Cookie 登出仍 200', 200, multi('/api/auth/logout', { method: 'POST', body: {} }));

    // ═════════════════════════════════════════════════════════════════
    // 11) CSRF：Origin 校验
    // ═════════════════════════════════════════════════════════════════
    section('11) CSRF：跨站 Origin 403 / 同源 Origin 通过');
    await expectStatus(
      '跨站 Origin 登录',
      403,
      login(URL_MULTI, ADMIN_NAME, ADMIN_PASSWORD, { origin: EVIL_ORIGIN })
    );
    await expectStatus(
      '跨站 Origin 登出（带有效 Cookie）',
      403,
      multi('/api/auth/logout', { method: 'POST', body: {}, cookie: adminCookie, origin: EVIL_ORIGIN })
    );
    res = await multi('/api/auth/me', { cookie: adminCookie });
    eq('跨站登出被拒后管理员会话仍有效', res.body?.user?.username, ADMIN_NAME);

    await expectStatus(
      '跨站 Origin 改密码',
      403,
      multi('/api/auth/password', {
        method: 'POST',
        cookie: bobCookie2,
        origin: EVIL_ORIGIN,
        body: { oldPassword: BOB.password, newPassword: 'bob-hacked-pass-123' },
      })
    );
    await expectStatus('跨站改密被拒后 bob 原密码仍可登录', 200, login(URL_MULTI, BOB.username, BOB.password));

    await expectStatus(
      '跨站 Origin 注册',
      403,
      register(URL_MULTI, code5, { username: 'csrf-user', password: 'csrf-pass-123' }, { origin: EVIL_ORIGIN })
    );
    await expectStatus(
      '跨站 Origin 生成邀请码',
      403,
      multi('/api/admin/invites', { method: 'POST', body: { days: 1 }, cookie: adminCookie, origin: EVIL_ORIGIN })
    );
    await expectStatus(
      '非法 Origin 字符串登录',
      403,
      login(URL_MULTI, ADMIN_NAME, ADMIN_PASSWORD, { origin: 'not-a-valid-url' })
    );

    res = await expectStatus(
      '同源 Origin 登录',
      200,
      login(URL_MULTI, BOB.username, BOB.password, { origin: URL_MULTI })
    );
    const sameOriginCookie = cookieOf(res);
    check('同源登录下发 Cookie', /^th_session=\S+$/.test(sameOriginCookie));
    await expectStatus(
      '同源 Origin 登出',
      200,
      multi('/api/auth/logout', { method: 'POST', body: {}, cookie: sameOriginCookie, origin: URL_MULTI })
    );

    // ═════════════════════════════════════════════════════════════════
    // 12) 登录限速（不存在的用户名 nobody；不影响 admin）
    // ═════════════════════════════════════════════════════════════════
    section('12) 登录限速：nobody 连错 5 次 → 第 6 次 429');
    const failStatuses = [];
    for (let i = 1; i <= 5; i++) {
      const r = await login(URL_MULTI, 'nobody', `wrong-pass-${i}`);
      failStatuses.push(r.status);
    }
    check('前 5 次错误密码都是 401', failStatuses.every((s) => s === 401), failStatuses.join(','));
    res = await login(URL_MULTI, 'nobody', ADMIN_PASSWORD);
    eq('第 6 次（即使密码正确）→ 429', res.status, 429);
    check('429 响应带错误提示', typeof res.body?.error === 'string' && res.body.error.length > 0, String(res.body?.error ?? '').slice(0, 40));
    await expectStatus('nobody 被锁不影响管理员登录', 200, login(URL_MULTI, ADMIN_NAME, ADMIN_PASSWORD));

    // ── 收尾：停掉多用户实例 ──
    await stopChild(multiChild);
    multiChild = null;

    // ═════════════════════════════════════════════════════════════════
    // 13) 本地模式（AUTH_MODE=local）：旧行为不变
    // ═════════════════════════════════════════════════════════════════
    section('13) 本地模式（AUTH_MODE=local）：旧行为不变（无需登录）');
    const localChild = spawnServer({
      port: LOCAL_PORT,
      dataDir: dataLocal,
      mediaRoot: mediaLocal,
      authMode: 'local',
    });
    const healthLocal = await waitHealth(URL_LOCAL);
    eq('health.authMode = local', healthLocal.authMode, 'local');
    res = await local('/api/auth/me');
    eq('本地 auth/me = {mode:local, user:null}', res.body, { mode: 'local', user: null });
    await expectStatus('本地模式登录', 400, login(URL_LOCAL, ADMIN_NAME, ADMIN_PASSWORD));
    await expectStatus(
      '本地模式注册',
      400,
      register(URL_LOCAL, 'AAAA-AAAA-AAAA-AAAA', { username: 'local-user', password: 'local-pass-123' })
    );
    await expectStatus(
      '本地模式改密码',
      400,
      local('/api/auth/password', {
        method: 'POST',
        body: { oldPassword: 'x-old-pass', newPassword: 'x-new-pass-123' },
      })
    );
    res = await local('/api/places');
    check('本地模式 GET /api/places 无需登录 → 200 + 数组', res.status === 200 && Array.isArray(res.body));
    res = await local('/api/places', { method: 'POST', body: { name: '本地模式测试点', lng: 120.1, lat: 30.2 } });
    check('本地模式 POST /api/places → 200', res.status === 200 && Boolean(res.body?.id), String(res.body?.id ?? ''));
    res = await local('/api/stats');
    check('本地模式 GET /api/stats → 200', res.status === 200 && typeof res.body?.totals === 'object');
    await expectStatus('本地模式登出仍 200', 200, local('/api/auth/logout', { method: 'POST', body: {} }));

    // ── 收尾：停掉本地模式实例 ──
    await stopChild(localChild);

    // ═════════════════════════════════════════════════════════════════
    // 14) scripts/init-admin.mjs：创建管理员
    // ═════════════════════════════════════════════════════════════════
    section('14) scripts/init-admin.mjs：全新 DATA_DIR 创建 root2');
    let initRun = await runInitAdmin(dataAdmin, mediaAdmin, [ADMIN2_NAME, ADMIN2_PASSWORD]);
    eq('init-admin 首次运行退出码 0', { code: initRun.code, signal: initRun.signal }, { code: 0, signal: null });
    check('新 DATA_DIR 下已生成 travel.db', existsSync(join(dataAdmin, 'travel.db')), dataAdmin);
    check('init-admin 日志提示已创建管理员账号', readLogs().includes('已创建管理员账号'));
    check('日志不含明文密码', !readLogs().includes(ADMIN2_PASSWORD));

    const root2Row = await dbExec(dataAdmin, (db) =>
      db.prepare('SELECT * FROM user WHERE username = ?').get(ADMIN2_NAME)
    );
    check('DB 里有 root2 用户', Boolean(root2Row?.id));
    eq('root2 role=admin / status=active', { role: root2Row?.role, status: root2Row?.status }, { role: 'admin', status: 'active' });
    check(
      'root2 密码只存 scrypt 哈希（128 hex）',
      /^[0-9a-f]{128}$/.test(String(root2Row?.password_hash ?? '')) && root2Row?.password_hash !== ADMIN2_PASSWORD
    );

    let adminChild = spawnServer({
      port: ADMIN_PORT,
      dataDir: dataAdmin,
      mediaRoot: mediaAdmin,
      authMode: 'multi', // 不设 ADMIN_*：验证 init-admin 建好的账号能直接登录
    });
    const healthAdmin = await waitHealth(URL_ADMIN);
    eq('init-admin 数据目录起服务 authMode=multi', healthAdmin.authMode, 'multi');
    const userCount1 = await dbExec(dataAdmin, (db) => db.prepare('SELECT COUNT(*) AS n FROM user').get().n);
    eq('未设 ADMIN_* 时不会重复建管理员（用户数 1）', userCount1, 1);

    let root2Login = await expectStatus('root2 登录', 200, login(URL_ADMIN, ADMIN2_NAME, ADMIN2_PASSWORD));
    eq('root2 登录返回 role=admin', root2Login.body?.user?.role, 'admin');
    let root2Cookie = cookieOf(root2Login);
    res = await adminApi('/api/auth/me', { cookie: root2Cookie });
    eq('root2 的 Cookie auth/me → root2', res.body?.user?.username, ADMIN2_NAME);

    // ═════════════════════════════════════════════════════════════════
    // 15) scripts/init-admin.mjs --reset：重置密码
    // ═════════════════════════════════════════════════════════════════
    section('15) scripts/init-admin.mjs --reset：改密码后新密码可登录');
    await stopChild(adminChild);
    initRun = await runInitAdmin(dataAdmin, mediaAdmin, [ADMIN2_NAME, ADMIN2_NEW_PASSWORD, '--reset']);
    eq('--reset 退出码 0', { code: initRun.code, signal: initRun.signal }, { code: 0, signal: null });
    check('--reset 日志提示已重置管理员密码', readLogs().includes('已重置管理员密码'));
    check('日志仍不含明文新密码', !readLogs().includes(ADMIN2_NEW_PASSWORD));

    spawnServer({
      port: ADMIN_PORT,
      dataDir: dataAdmin,
      mediaRoot: mediaAdmin,
      authMode: 'multi',
    });
    await waitHealth(URL_ADMIN);
    await expectStatus('重置后旧密码登录', 401, login(URL_ADMIN, ADMIN2_NAME, ADMIN2_PASSWORD));
    root2Login = await expectStatus('重置后新密码登录', 200, login(URL_ADMIN, ADMIN2_NAME, ADMIN2_NEW_PASSWORD));
    eq('重置后 role 仍是 admin', root2Login.body?.user?.role, 'admin');
    const userCount2 = await dbExec(dataAdmin, (db) => db.prepare('SELECT COUNT(*) AS n FROM user').get().n);
    eq('--reset 不新增用户（用户数仍 1）', userCount2, 1);
  } catch (e) {
    crashed = true;
    console.error('\n❌ 冒烟执行中断：', e?.message || e);
    const logs = readLogs();
    if (logs) console.error('服务日志尾部：\n' + logs.slice(-4000));
  } finally {
    for (const child of children) await stopChild(child);
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
    }
    await sleep(150);
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.log(`  (临时目录清理失败，可手动删：${tmp} — ${e.message})`);
    }
  }

  console.log('\n' + '─'.repeat(68));
  console.log(`通过 ${pass} 项，失败 ${fail} 项${crashed ? '，执行中断' : ''} ${fail === 0 && !crashed ? '✅' : '❌'}`);
  process.exitCode = fail === 0 && !crashed ? 0 : 1;
};

run().catch((e) => {
  console.error('\n账号体系冒烟异常：', e?.message || e);
  process.exitCode = 1;
});
