/**
 * M3 秘密基地（F-PLC-11）隔离冒烟测试
 *
 *   node scripts/smoke-m3-secret.mjs
 *
 * 全隔离：空临时 DATA_DIR + 空临时素材库 + 4201 端口独立实例（SMOKE_M3_SECRET_PORT 可覆盖），跑完清理。
 * 不碰真实 data/travel.db、.dev-media、.env.local。
 *
 * 覆盖：未设/已设密码的状态、设置/修改/清除、reset:true 重置（不需要旧密码）、PATCH place.secret、
 * 列表/详情带 secret、合并继承（OR）、软删地点不计入 status.places、密码哈希存储（config.json 无明文）、
 * 验证限速 429。
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_M3_SECRET_PORT || 4201);
const BASE = `http://127.0.0.1:${PORT}`;

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

const j = async (r) => {
  const t = await r.text();
  if (!r.ok) {
    let msg = `HTTP ${r.status}: ${t.slice(0, 300)}`;
    try {
      const b = JSON.parse(t);
      if (b?.error) msg = `HTTP ${r.status}: ${b.error}`;
    } catch {
      /* keep */
    }
    const err = new Error(msg);
    err.status = r.status;
    err.body = (() => {
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    })();
    throw err;
  }
  return JSON.parse(t);
};

const getJson = (path) => fetch(BASE + path).then(j);
const postJson = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);
const patchJson = (path, body) =>
  fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);
const delJson = (path) => fetch(BASE + path, { method: 'DELETE' }).then(j);

/** 断言请求失败：HTTP 状态 + 错误文案 */
const expectError = async (label, status, errorText, fn) => {
  let actual = null;
  let text = '';
  try {
    await fn();
    actual = 200;
  } catch (e) {
    actual = e.status ?? null;
    text = e.body?.error ?? '';
  }
  check(
    `${label} → HTTP ${status}`,
    actual === status,
    actual === status ? '' : `实际=${actual ?? '无'}`
  );
  if (errorText) check(`${label} → 错误文案`, text === errorText, text === errorText ? '' : `实际=${text}`);
};

const status = () => getJson('/api/secret/status');
const verify = (password) => postJson('/api/secret/verify', { password });
const setPwd = (body) => postJson('/api/secret/password', body);
const createPlace = (name, extra = {}) =>
  postJson('/api/places', {
    name,
    lng: 120.1 + Math.random() * 0.1,
    lat: 30.2 + Math.random() * 0.1,
    province: '浙江省',
    city: '杭州市',
    county: '西湖区',
    province_code: '330000',
    city_code: '330100',
    kind: 'visited',
    date: '2024-01-01',
    ...extra,
  });
const placeSecret = (places, id) => places.find((p) => p.id === id)?.secret;

const run = async () => {
  console.log(`\nM3 秘密基地冒烟（F-PLC-11，隔离实例 :${PORT}）`);
  console.log('─'.repeat(64));

  const tmp = mkdtempSync(join(ROOT, '.smoke-m3-secret-'));
  const dataDir = join(tmp, 'data');
  const mediaRoot = join(tmp, 'media');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));

  let child = null;
  let logFd = null;
  const logPath = join(tmp, 'server.log');
  const readLogs = () => {
    try {
      return readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };

  try {
    logFd = openSync(logPath, 'a');
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        MEDIA_ROOT: mediaRoot,
        MEDIA_ROOT_DEV: mediaRoot,
      },
      // 沙箱不允许 pipe：stdout/stderr 一律重定向到日志文件
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });

    let health = null;
    for (let i = 0; i < 60; i++) {
      try {
        health = await getJson('/api/health');
        if (health?.ok) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!health?.ok) throw new Error('服务没起来：\n' + readLogs().slice(-2000));
    check('隔离实例在线且素材库指向临时目录', resolve(health.mediaRoot) === resolve(mediaRoot), health.mediaRoot);

    // ── 1) 未设置密码 ─────────────────────────────────────────
    section('1) 未设置密码：status / verify 无门禁 / 参数校验');
    eq('status 未设置', await status(), { configured: false, places: 0 });
    eq('verify 无门禁 → ok, configured=false', await verify('随便什么'), { ok: true, configured: false });
    await expectError('未设置时清除密码', 400, null, () => setPwd({ newPassword: '' }));
    await expectError('newPassword 缺失', 400, null, () => setPwd({}));
    await expectError('newPassword 非字符串', 400, null, () => setPwd({ newPassword: 123 }));
    eq('设置失败后仍是未设置', (await status()).configured, false);

    // ── 2) 设置密码 + 哈希存储 ────────────────────────────────
    section('2) 设置密码：status / config.json 只存盐与哈希');
    eq('设置密码', await setPwd({ newPassword: 'hunter2' }), { ok: true, configured: true });
    eq('status configured=true', (await status()).configured, true);

    const cfg = readConfig();
    check('config.json 有 secret 对象', cfg.secret && typeof cfg.secret === 'object');
    eq('algo = scrypt', cfg.secret.algo, 'scrypt');
    check('salt 是十六进制字符串', /^[0-9a-f]+$/.test(cfg.secret.salt) && cfg.secret.salt.length >= 16);
    check('hash 是 64 字节的十六进制（128 字符）', /^[0-9a-f]+$/.test(cfg.secret.hash) && cfg.secret.hash.length === 128);
    check('updatedAt 是数字', typeof cfg.secret.updatedAt === 'number');
    const cfgText = readFileSync(configPath, 'utf8');
    check('config.json 不含明文密码', !cfgText.includes('hunter2'));
    check('hash 不等于密码', cfg.secret.hash !== 'hunter2');
    check('salt 不等于密码', cfg.secret.salt !== 'hunter2');

    const statusText = JSON.stringify(await status());
    check('status 不下发哈希', !statusText.includes(cfg.secret.hash));
    check('status 不下发盐', !statusText.includes(cfg.secret.salt));

    eq('verify 正确密码', await verify('hunter2'), { ok: true, configured: true });
    await expectError('verify 错误密码', 403, '密码不正确', () => verify('wrong-pass'));
    eq('一次错误后仍可用正确密码', await verify('hunter2'), { ok: true, configured: true });

    // ── 3) PATCH place.secret / 列表详情 / status.places ───────
    section('3) PATCH place.secret / 列表与详情带 secret / status.places');
    const A = await createPlace('秘密-甲');
    const B = await createPlace('秘密-乙');
    eq('新建地点 secret=0', A.secret, 0);

    eq('PATCH secret=true → 1', (await patchJson(`/api/places/${A.id}`, { secret: true })).secret, 1);
    eq('PATCH secret=1 → 1', (await patchJson(`/api/places/${A.id}`, { secret: 1 })).secret, 1);
    eq('PATCH secret=false → 0', (await patchJson(`/api/places/${A.id}`, { secret: false })).secret, 0);
    eq('PATCH secret=0 → 0', (await patchJson(`/api/places/${A.id}`, { secret: 0 })).secret, 0);
    eq('事件后重新标为秘密基地', (await patchJson(`/api/places/${A.id}`, { secret: true })).secret, 1);

    const list = await getJson('/api/places');
    eq('/api/places 列表 A.secret=1', placeSecret(list, A.id), 1);
    eq('/api/places 列表 B.secret=0', placeSecret(list, B.id), 0);
    eq('/api/places/:id 详情 A.secret=1', (await getJson(`/api/places/${A.id}`)).secret, 1);
    eq('status.places = 1', (await status()).places, 1);
    eq('PATCH 其他字段不影响 secret', (await patchJson(`/api/places/${A.id}`, { name: '秘密-甲改名' })).secret, 1);

    const merged = await postJson('/api/places/merge', { fromId: A.id, intoId: B.id, force: false });
    eq('合并返回 ok', merged.ok, true);
    eq('合并后目标 secret=1（from OR into）', merged.place.secret, 1);
    eq('合并后 B 详情 secret=1', (await getJson(`/api/places/${B.id}`)).secret, 1);
    eq('来源 A 已软删不在列表', placeSecret(await getJson('/api/places'), A.id), undefined);
    eq('status.places 合并后仍是 1', (await status()).places, 1);

    const C = await createPlace('秘密-丙');
    await patchJson(`/api/places/${C.id}`, { secret: true });
    eq('新增秘密地点后 status.places = 2', (await status()).places, 2);
    await delJson(`/api/places/${C.id}`);
    eq('软删秘密地点不计入 status.places', (await status()).places, 1);
    await delJson(`/api/places/${B.id}`);
    eq('软删全部秘密地点后 status.places = 0', (await status()).places, 0);

    // ── 4) 修改密码需要旧密码 ─────────────────────────────────
    section('4) 修改密码必须校验旧密码');
    await expectError('修改密码不给旧密码', 403, '旧密码不正确', () => setPwd({ newPassword: 'newpass' }));
    await expectError('修改密码旧密码错误', 403, '旧密码不正确', () =>
      setPwd({ oldPassword: 'nope', newPassword: 'newpass' })
    );
    eq('旧密码正确才能改', await setPwd({ oldPassword: 'hunter2', newPassword: 'newpass' }), {
      ok: true,
      configured: true,
    });
    await expectError('旧密码已失效', 403, '密码不正确', () => verify('hunter2'));
    eq('新密码可验证', await verify('newpass'), { ok: true, configured: true });
    const cfg2 = readConfig();
    check('改密码后 config.json 不含明文 newpass', !readFileSync(configPath, 'utf8').includes('newpass'));
    check('改密码后哈希已变化', cfg2.secret.hash !== cfg.secret.hash);
    check('改密码后盐已变化', cfg2.secret.salt !== cfg.secret.salt);

    // ── 5) 清除密码 ───────────────────────────────────────────
    section('5) 清除密码需旧密码；清除后恢复无门禁');
    await expectError('清除密码旧密码错误', 403, '旧密码不正确', () =>
      setPwd({ oldPassword: 'wrong', newPassword: '' })
    );
    eq('清除密码（旧密码正确）', await setPwd({ oldPassword: 'newpass', newPassword: '' }), {
      ok: true,
      configured: false,
    });
    eq('status configured=false', (await status()).configured, false);
    eq('清除后 verify 无门禁', await verify('随便什么'), { ok: true, configured: false });
    const cfg3 = readConfig();
    check('清除后 config.json 里 secret 为空', cfg3.secret == null || typeof cfg3.secret !== 'object');
    check('清除后 config.json 不再含哈希', !readFileSync(configPath, 'utf8').includes(cfg2.secret.hash));

    // ── 6) 设置页「重置密码」：reset:true 不需要旧密码 ─────────
    section('6) reset:true：重置密码 / 重置清除都不需要旧密码');
    eq('重新设置密码', await setPwd({ newPassword: 'hunter2' }), { ok: true, configured: true });
    eq('reset:true + 新密码（不带 oldPassword）', await setPwd({ reset: true, newPassword: 'resetpw' }), {
      ok: true,
      configured: true,
    });
    await expectError('重置后旧密码失效', 403, '密码不正确', () => verify('hunter2'));
    eq('重置后的新密码可用', await verify('resetpw'), { ok: true, configured: true });
    await expectError(
      'reset:true 新密码超长仍 400',
      400,
      null,
      () => setPwd({ reset: true, newPassword: 'x'.repeat(129) })
    );
    eq('reset:true + 空串（不带 oldPassword）直接清除', await setPwd({ reset: true, newPassword: '' }), {
      ok: true,
      configured: false,
    });
    eq('重置清除后 status configured=false', (await status()).configured, false);
    eq('重置清除后 verify 无门禁', await verify('x'), { ok: true, configured: false });

    // ── 7) 验证限速 ───────────────────────────────────────────
    section('7) verify 限速：60 秒窗口内 8 次错误后 429');
    eq('为限速测试设置密码', await setPwd({ newPassword: 'secret123' }), { ok: true, configured: true });
    for (let i = 1; i <= 3; i++) {
      await expectError(`第 ${i} 次错误`, 403, '密码不正确', () => verify('bad-' + i));
    }
    eq('验证成功清空失败计数', await verify('secret123'), { ok: true, configured: true });
    for (let i = 1; i <= 8; i++) {
      await expectError(`重置计数后第 ${i} 次错误`, 403, '密码不正确', () => verify('bad2-' + i));
    }
    await expectError('第 9 次错误 → 429', 429, '尝试次数过多，请稍后再试', () => verify('bad3-9'));
    await expectError('继续请求 → 仍 429', 429, '尝试次数过多，请稍后再试', () => verify('bad3-10'));
    await expectError('限速期间正确密码也 429', 429, '尝试次数过多，请稍后再试', () => verify('secret123'));

    console.log('\n' + '─'.repeat(64));
    console.log(`通过 ${pass} 项，失败 ${fail} 项 ${fail === 0 ? '✅' : '❌'}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(100);
    }
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
};

run().catch((e) => {
  console.error('\nM3 秘密基地冒烟异常：', e?.message || e);
  process.exitCode = 1;
});
