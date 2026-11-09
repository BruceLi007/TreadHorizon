/**
 * M5 设置冒烟测试（天地图 Key 写入 + 家的位置 + 遗留 place.home 兼容）
 *
 *   node scripts/smoke-settings.mjs
 *
 * 全隔离：临时 DATA_DIR + 临时 MEDIA_ROOT + 4206 端口独立实例，跑完清理。
 * 不碰真实 data/travel.db、.dev-media、.env.local；测试前后校验真实 data/ 与 .dev-media 未变化。
 *
 * 覆盖：
 * - 天地图 Key 优先级（data/config.json > .env.local）、POST /api/config/tdt-key 校验/写入/持久化/重启后生效
 * - 安全：备份 zip 的 data/config.json 不含 tdtTk / key 字符串；服务日志不含 key；错误信息不回显 key
 * - 家的位置（M5.1）：GET /api/config.home、POST /api/config/home 校验/落盘/唯一/重启持久化、
 *   备份 config 含家、恢复后家的位置回到备份时；旧备份没有 home 时保留当前家
 * - place.home（M5 遗留字段，UI 已不用）：默认 0、PATCH true/false/1/0、非法值 400、合并 OR、旧备份补 0
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ZipFile } from 'yazl';
import { fromBufferPromise } from 'yauzl';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_SETTINGS_PORT || 4206);
const BASE = `http://127.0.0.1:${PORT}`;
/** 测试用的假天地图 key（32 位字母数字，不是真实 key） */
const NEW_KEY = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
const KEY_ERROR = '天地图 Key 必须是 32 位字母或数字';
const HOME_ERROR = '家的位置需要有效的经纬度';

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

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ───────────── HTTP ─────────────

const j = async (r) => {
  const t = await r.text();
  let body = null;
  try {
    body = JSON.parse(t);
  } catch {
    body = null;
  }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}: ${body?.error || t.slice(0, 300)}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  if (body === null) throw new Error('返回不是 JSON：' + t.slice(0, 200));
  return body;
};

const getJson = (path) => fetch(BASE + path).then(j);
const postJson = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(j);
const patchJson = (path, body) =>
  fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(j);
const delJson = (path) => fetch(BASE + path, { method: 'DELETE' }).then(j);

const expectStatus = async (label, status, fn) => {
  let actual = null;
  let message = '';
  try {
    await fn();
    actual = 200;
  } catch (e) {
    actual = e.status ?? null;
    message = e.message;
  }
  check(
    `${label} → HTTP ${status}`,
    actual === status,
    actual === status ? '' : `实际=${actual ?? '无'}${message ? `（${message.slice(0, 140)}）` : ''}`
  );
};

// ───────────── zip 工具 ─────────────

const zipBuffer = (entries) => {
  const zip = new ZipFile();
  for (const e of entries) {
    zip.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), e.name);
  }
  const chunks = [];
  const done = new Promise((res, rej) => {
    zip.outputStream.on('data', (c) => chunks.push(c));
    zip.outputStream.on('end', res);
    zip.outputStream.on('error', rej);
    zip.on('error', rej);
  });
  zip.end();
  return done.then(() => Buffer.concat(chunks));
};

const readZipBuffer = async (buf) => {
  const zip = await fromBufferPromise(buf);
  const map = new Map();
  try {
    for await (const entry of zip.eachEntry()) {
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      map.set(entry.fileName, Buffer.concat(chunks));
    }
  } finally {
    try {
      await zip.close();
    } catch {
      /* ignore */
    }
  }
  return map;
};

const zipFromMap = (map) => zipBuffer([...map.entries()].map(([name, data]) => ({ name, data })));
const getJsonEntry = (map, name) => JSON.parse(map.get(name).toString('utf8'));
const setJsonEntry = (map, name, obj) =>
  map.set(name, Buffer.from(JSON.stringify(obj, null, 2) + '\n'));

// ───────────── 文件 / 真实库签名 ─────────────

function walkFiles(dir, acc = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}
const dirSig = (dir) => {
  const files = walkFiles(dir);
  return `${files.length}:${files.reduce((n, p) => n + statSync(p).size, 0)}`;
};
const sigOf = (p) => {
  try {
    const st = statSync(p);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return 'absent';
  }
};

const readAppConfig = (dataDir) => {
  const p = join(dataDir, 'config.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

// ───────────── 主流程 ─────────────

const run = async () => {
  console.log(`\nM5 设置冒烟（天地图 Key + 家的位置 + 遗留 place.home，隔离实例 :${PORT}）`);
  console.log('─'.repeat(68));

  const realDataDir = join(ROOT, 'data');
  const realDevMedia = join(ROOT, '.dev-media');
  const realSig = {
    db: sigOf(join(realDataDir, 'travel.db')),
    wal: sigOf(join(realDataDir, 'travel.db-wal')),
    shm: sigOf(join(realDataDir, 'travel.db-shm')),
    config: sigOf(join(realDataDir, 'config.json')),
    devMedia: dirSig(realDevMedia),
  };

  const tmp = mkdtempSync(join(ROOT, '.smoke-settings-'));
  const dataDir = join(tmp, 'data');
  const mediaRoot = join(tmp, 'media');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });

  const logPath = join(tmp, 'server.log');
  let logFd = null;
  let child = null;
  const readLogs = () => {
    try {
      return readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };

  const spawnServer = () => {
    const c = spawn(process.execPath, ['server/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        STARTER_DATA: '0',
        PORT: String(PORT),
        DATA_DIR: dataDir,
        MEDIA_ROOT: mediaRoot,
        MEDIA_ROOT_DEV: mediaRoot,
        // 测试只走 one-shot 导出，不关心磁盘余量，避免环境噪声
        BACKUP_SKIP_DISK_CHECK: '1',
      },
      // 沙箱不允许 pipe：stdout/stderr 一律重定向到日志文件
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    return c;
  };

  const waitHealth = async () => {
    let health = null;
    for (let i = 0; i < 80; i++) {
      try {
        health = await getJson('/api/health');
        if (health?.ok) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    return health;
  };

  const stopChild = async (c) => {
    if (!c || c.exitCode !== null) return;
    try {
      c.kill();
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 50 && c.exitCode === null; i++) await sleep(100);
  };

  try {
    logFd = openSync(logPath, 'a');
    child = spawnServer();
    let health = await waitHealth();
    if (!health?.ok) throw new Error('服务没起来：\n' + readLogs().slice(-3000));
    check('隔离实例在线且素材库指向临时目录', resolve(health.mediaRoot) === resolve(mediaRoot), health.mediaRoot);
    check('health.hasTk 是布尔值', typeof health.hasTk === 'boolean');

    // ═════════════ 1) 初始 Key 状态 ═════════════
    section('1) 初始 Key 状态（.env.local 可能有、也可能没有真实 key）');
    let cfgResp = await getJson('/api/config');
    const initialKey = typeof cfgResp.tdtTk === 'string' ? cfgResp.tdtTk : '';
    check('GET /api/config 返回 tdtTk 字符串', typeof cfgResp.tdtTk === 'string');
    check('health.hasTk 与 tdtTk 是否为空一致', health.hasTk === (initialKey.length > 0));
    if (initialKey) {
      check('初始 key 来自 .env.local（32 位）', /^[A-Za-z0-9]{32}$/.test(initialKey));
      check('初始 data/config.json 里还没有 tdtTk（来自 env）', !readAppConfig(dataDir)?.tdtTk);
    } else {
      check('测试环境没有初始 key（hasTk=false，后续写入不依赖它）', health.hasTk === false);
    }

    // ═════════════ 2) POST /api/config/tdt-key 参数校验 ═════════════
    section('2) POST /api/config/tdt-key 校验：空 / 短 / 长 / 带符号 / 非字符串 → 400');
    const badBodies = [
      ['空 body', {}],
      ['空字符串', { key: '' }],
      ['短 key（3 位）', { key: 'abc' }],
      ['31 位', { key: 'a'.repeat(31) }],
      ['33 位', { key: 'a'.repeat(33) }],
      ['32 位但带符号', { key: 'a'.repeat(30) + '!!' }],
      ['null', { key: null }],
      ['数字', { key: 123 }],
      ['带空格填充（trim 后仍 33 位）', { key: ' ' + 'b'.repeat(33) + ' ' }],
    ];
    for (const [label, body] of badBodies) {
      let err = null;
      try {
        await postJson('/api/config/tdt-key', body);
      } catch (e) {
        err = e;
      }
      check(`${label} → 400`, err?.status === 400, err ? '' : '实际=成功');
      check(`${label} 错误文案`, err?.body?.error === KEY_ERROR, String(err?.body?.error || '').slice(0, 120));
    }
    check('非法请求不回显 key（错误体里没有 key 字段）', !JSON.stringify(badBodies).includes('"key":"A1b2'));
    // ═════════════ 3) 写入有效 key ═════════════
    section('3) 写入 32 位字母数字 key：保存 / 生效 / 落盘 / 不回显 / 不写日志');
    const saveResp = await postJson('/api/config/tdt-key', { key: NEW_KEY });
    eq('保存返回 {ok:true,hasTk:true}', saveResp, { ok: true, hasTk: true });
    check('响应体不回显 key', !JSON.stringify(saveResp).includes(NEW_KEY));
    cfgResp = await getJson('/api/config');
    check('GET /api/config 返回新 key', cfgResp.tdtTk === NEW_KEY);
    eq('health.hasTk = true', (await getJson('/api/health')).hasTk, true);
    const localCfg = readAppConfig(dataDir);
    check('data/config.json 写入 tdtTk', typeof localCfg?.tdtTk === 'string' && localCfg.tdtTk === NEW_KEY);
    check('服务日志不含新 key 字符串', !readLogs().includes(NEW_KEY));
    const writeResp = await fetch(`${BASE}/api/config/tdt-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'x'.repeat(10) }),
    });
    check('非法 key 不会改掉已保存的 key', (await getJson('/api/config')).tdtTk === NEW_KEY);
    eq('非法 key 的响应 status = 400', writeResp.status, 400);

    // ═════════════ 4) 重启后持久化（local config 优先于 .env.local）═════════════
    section('4) 重启后 key 持久化：data/config.json > .env.local');
    await stopChild(child);
    child = spawnServer();
    health = await waitHealth();
    if (!health?.ok) throw new Error('重启后服务没起来：\n' + readLogs().slice(-3000));
    check('重启后实例在线', health.hasTk === true);
    const cfgAfterRestart = await getJson('/api/config');
    check('重启后 GET /api/config 仍是新 key（local config 优先）', cfgAfterRestart.tdtTk === NEW_KEY);
    check('重启后日志仍不含 key', !readLogs().includes(NEW_KEY));

    // ═════════════ 5) 备份 zip 不含天地图 Key ═════════════
    section('5) 导出备份：data/config.json 精简快照不含 tdtTk / key 字符串');
    const exportRes = await fetch(`${BASE}/api/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeThumbs: false }),
    });
    const backupBuf = Buffer.from(await exportRes.arrayBuffer());
    eq('导出备份 HTTP 200', exportRes.status, 200);
    check('导出 zip 非空', backupBuf.length > 0, `${backupBuf.length} 字节`);
    check('整个备份 zip 不含新 key 字符串', !backupBuf.includes(Buffer.from(NEW_KEY)));
    if (initialKey) {
      check('整个备份 zip 不含 .env.local 的初始 key', !backupBuf.includes(Buffer.from(initialKey)));
    }
    const backupMap = await readZipBuffer(backupBuf);
    const backupConfigRaw = backupMap.get('data/config.json').toString('utf8');
    const backupConfig = JSON.parse(backupConfigRaw);
    check('备份 data/config.json 不含 tdtTk 字段', !Object.prototype.hasOwnProperty.call(backupConfig, 'tdtTk'));
    check('备份 data/config.json 文本不含 tdtTk', !backupConfigRaw.includes('tdtTk'));
    check('备份 data/config.json 文本不含 key 字符串', !backupConfigRaw.includes(NEW_KEY));
    const backupManifestRaw = backupMap.get('manifest.json').toString('utf8');
    check('备份 manifest 不含 key 字符串', !backupManifestRaw.includes(NEW_KEY));

    // ═════════════ 6) 家的位置（M5.1：独立点位，data/config.json.home）═════════════
    section('6) 家的位置：GET/POST /api/config/home 校验 / 落盘 / 唯一 / 重启持久化');
    const HOME_PT = { lng: 120.155123, lat: 30.274149 };
    eq('初始 home 未设置（null）', (await getJson('/api/config')).home, null);

    const badHomeBodies = [
      ['空 body', {}],
      ['字符串经纬度', { lng: '120.1', lat: '30.2' }],
      ['null 经纬度', { lng: null, lat: null }],
      ['经度越界', { lng: 181, lat: 30 }],
      ['纬度越界', { lng: 120, lat: -91 }],
      ['缺 lat', { lng: 120 }],
      ['NaN 序列化成 null', { lng: Number.NaN, lat: 30 }],
    ];
    for (const [label, body] of badHomeBodies) {
      let err = null;
      try {
        await postJson('/api/config/home', body);
      } catch (e) {
        err = e;
      }
      check(`${label} → 400`, err?.status === 400, err ? '' : '实际=成功');
      check(`${label} 错误文案`, err?.body?.error === HOME_ERROR, String(err?.body?.error || '').slice(0, 120));
    }
    eq('非法请求不改数据（home 仍是 null）', (await getJson('/api/config')).home, null);

    const savedHome = await postJson('/api/config/home', HOME_PT);
    eq('保存家返回归一化坐标', savedHome, { ok: true, home: HOME_PT });
    eq('GET /api/config 返回家', (await getJson('/api/config')).home, HOME_PT);
    eq('data/config.json 写入 home', readAppConfig(dataDir)?.home, HOME_PT);
    check('保存家的响应不回显 key', !JSON.stringify(savedHome).includes(NEW_KEY));

    const HOME_PT2 = { lng: 121.4737, lat: 31.2304 };
    const savedHome2 = await postJson('/api/config/home', HOME_PT2);
    eq('再次保存 = 覆盖（只有一个家）', savedHome2.home, HOME_PT2);
    eq('GET 返回新的家', (await getJson('/api/config')).home, HOME_PT2);

    // 家存在 data/config.json 里 → 重启后仍在
    await stopChild(child);
    child = spawnServer();
    health = await waitHealth();
    if (!health?.ok) throw new Error('重启后服务没起来：\n' + readLogs().slice(-3000));
    eq('重启后家的位置仍是最后保存的点', (await getJson('/api/config')).home, HOME_PT2);

    // ═════════════ 7) place.home（2026-11-04 起家 = 普通地点，唯一 home=1）═════════════
    section('7) place.home：默认 0 / PATCH true/false/1/0 / 唯一性 / 移动坐标 / 非法值 400 / 列表透出');
    const HOME = { province: '浙江省', city: '杭州市', county: '西湖区', province_code: '330000', city_code: '330100', county_code: '330106' };
    const OTHER = { province: '浙江省', city: '宁波市', county: '海曙区', province_code: '330000', city_code: '330200', county_code: '330203' };
    const createPlace = (name, extra = {}) =>
      postJson('/api/places', { name, lng: 120.1 + Math.random() * 0.1, lat: 30.2 + Math.random() * 0.1, kind: 'visited', ...extra });
    const P1 = await createPlace('家-测试A', { ...HOME, date: '2020-05-01' });
    const P2 = await createPlace('家-测试B', { ...HOME, date: '2022-08-08' });
    const P3 = await createPlace('家-测试C', { ...OTHER, date: '2023-09-09' });
    eq('新地点 home 默认 0', P1.home, 0);
    let list = await getJson('/api/places');
    eq('列表条目都带 home', list.every((p) => p.home === 0), true);
    eq('列表里 P1.home = 0', list.find((p) => p.id === P1.id).home, 0);

    let d = await patchJson(`/api/places/${P1.id}`, { home: true });
    eq('PATCH home:true → detail.home = 1', d.home, 1);
    eq('GET detail home = 1', (await getJson(`/api/places/${P1.id}`)).home, 1);
    eq('列表里 home = 1', (await getJson('/api/places')).find((p) => p.id === P1.id).home, 1);
    eq('PATCH home:1 → 1', (await patchJson(`/api/places/${P1.id}`, { home: 1 })).home, 1);
    eq('PATCH home:false → 0', (await patchJson(`/api/places/${P1.id}`, { home: false })).home, 0);
    eq('PATCH home:0 → 0', (await patchJson(`/api/places/${P1.id}`, { home: 0 })).home, 0);
    let homeErr = null;
    try {
      await patchJson(`/api/places/${P1.id}`, { home: 'yes' });
    } catch (e) {
      homeErr = e;
    }
    check('PATCH home:"yes" → 400', homeErr?.status === 400, homeErr ? '' : '实际=成功');
    eq('非法 home 错误文案', homeErr?.body?.error, 'home 必须是布尔值');
    eq('非法 home 不改数据（仍为 0）', (await getJson(`/api/places/${P1.id}`)).home, 0);
    await expectStatus('PATCH home:null → 400', 400, () => patchJson(`/api/places/${P1.id}`, { home: null }));
    // 只改其它字段时 home 保留
    await patchJson(`/api/places/${P1.id}`, { home: true });
    d = await patchJson(`/api/places/${P1.id}`, { name: '家-测试A（改名）' });
    eq('只改名时 home 保持 1', { name: d.name, home: d.home }, { name: '家-测试A（改名）', home: 1 });

    // 「家」只能有一个：把 P2 设为家 → P1 的 home 自动清零
    await patchJson(`/api/places/${P2.id}`, { home: true });
    eq('家只能有一个：P2 设为家后 P1 home = 0', (await getJson(`/api/places/${P1.id}`)).home, 0);
    eq('P2 设为家后 home = 1', (await getJson(`/api/places/${P2.id}`)).home, 1);

    // 顶栏「家」重新打点 = 移动家：PATCH lng/lat 改坐标，其它字段保留
    const moved = await patchJson(`/api/places/${P2.id}`, { lng: 120.5, lat: 30.5 });
    eq('PATCH lng/lat 移动家', { lng: moved.lng, lat: moved.lat }, { lng: 120.5, lat: 30.5 });
    eq(
      '移动坐标不影响 home / 名称',
      { home: moved.home, name: moved.name },
      { home: 1, name: moved.name }
    );
    await expectStatus('PATCH 非法 lng（181）→ 400', 400, () =>
      patchJson(`/api/places/${P2.id}`, { lng: 181 })
    );
    eq('非法 lng 不改坐标', (await getJson(`/api/places/${P2.id}`)).lng, 120.5);

    // ═════════════ 8) 合并时的 home OR 语义 ═════════════
    section('8) 合并地点：目标 home = from.home || into.home');
    await patchJson(`/api/places/${P2.id}`, { home: false });
    await patchJson(`/api/places/${P1.id}`, { home: true });
    const merged = await postJson('/api/places/merge', { fromId: P1.id, intoId: P2.id });
    eq('合并返回目标地点 home = 1', merged.place.home, 1);
    eq('合并目标 id 正确', merged.place.id, P2.id);
    await expectStatus('来源地点已软删（404）', 404, () => getJson(`/api/places/${P1.id}`));
    eq('合并后列表里 P2 home = 1', (await getJson('/api/places')).find((p) => p.id === P2.id).home, 1);
    // 反方向：from.home=0 合入 into.home=1，目标保持 1
    await patchJson(`/api/places/${P3.id}`, { home: false });
    const merged2 = await postJson('/api/places/merge', {
      fromId: P3.id,
      intoId: P2.id,
      force: true, // P3 在宁波、P2 在杭州：跨市合并需要 force 二次确认
    });
    eq('from.home=0 合入 home=1 → 目标仍 1', merged2.place.home, 1);
    eq('合并后目标 home 仍为 1', (await getJson(`/api/places/${P2.id}`)).home, 1);

    // ═════════════ 9) 备份 + 恢复：place.home 保留 + 家的位置随包恢复 ═════════════
    section('9) 备份 + 恢复：place.home 保留、家的位置回到备份时');
    const export2 = await fetch(`${BASE}/api/backup/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ includeThumbs: false }),
    });
    const backup2Buf = Buffer.from(await export2.arrayBuffer());
    eq('第二次导出 HTTP 200', export2.status, 200);
    const backup2Map = await readZipBuffer(backup2Buf);
    const backup2Config = JSON.parse(backup2Map.get('data/config.json').toString('utf8'));
    eq('备份 data/config.json 含家的位置', backup2Config.home, HOME_PT2);
    check('备份 data/config.json 仍不含 tdtTk', !Object.prototype.hasOwnProperty.call(backup2Config, 'tdtTk'));

    // 恢复前把家改到别处：恢复后应回到备份时的位置
    const HOME_PT3 = { lng: 113.2644, lat: 23.1291 };
    await postJson('/api/config/home', HOME_PT3);
    eq('恢复前家已被改到别处', (await getJson('/api/config')).home, HOME_PT3);

    const fd = new FormData();
    fd.append('file', new Blob([backup2Buf], { type: 'application/zip' }), 'travel-backup.zip');
    const inspected = await fetch(`${BASE}/api/backup/inspect`, { method: 'POST', body: fd }).then(j);
    check('inspect 返回 token', typeof inspected.token === 'string' && inspected.token.length > 0);
    const restored = await postJson('/api/backup/restore', { token: inspected.token, confirm: true });
    eq('恢复 ok', restored.ok, true);
    eq('恢复后家的位置回到备份时', (await getJson('/api/config')).home, HOME_PT2);
    eq('恢复后目标地点 home = 1', (await getJson(`/api/places/${P2.id}`)).home, 1);
    const listAfterRestore = await getJson('/api/places');
    check('恢复后所有地点 home 都是 0/1', listAfterRestore.every((p) => p.home === 0 || p.home === 1));
    check('恢复后 home 值原样保留（至少一个 1）', listAfterRestore.some((p) => p.home === 1));
    await expectStatus('恢复后被合并的 P1 仍是 404', 404, () => getJson(`/api/places/${P1.id}`));

    // ═════════════ 10) 兼容：无 home 列的旧备份仍可恢复（home 补 0）═════════════
    section('10) 兼容：M5 之前「无 home 列」的 v2 / v1 备份可 inspect+restore，home 补 0');
    const oldMap = new Map(await readZipBuffer(backup2Buf));
    const dbTmpPath = join(tmp, 'old-backup.db');
    writeFileSync(dbTmpPath, oldMap.get('data/travel.db'));
    const oldDb = new DatabaseSync(dbTmpPath);
    let dropOk = true;
    try {
      oldDb.exec('ALTER TABLE place DROP COLUMN home');
    } catch (e) {
      dropOk = false;
      check('可从备份 DB 移除 home 列（构造旧备份）', false, e?.message || String(e));
    } finally {
      try {
        oldDb.close();
      } catch {
        /* ignore */
      }
    }
    if (dropOk) {
      const oldDbBuf = readFileSync(dbTmpPath);
      unlinkSync(dbTmpPath);
      const oldManifest = getJsonEntry(oldMap, 'manifest.json');
      oldManifest.checksums['data/travel.db'] = sha256(oldDbBuf);
      const v2OldMap = new Map(oldMap);
      v2OldMap.set('data/travel.db', oldDbBuf);
      setJsonEntry(v2OldMap, 'manifest.json', oldManifest);
      const v2OldZip = await zipFromMap(v2OldMap);
      const v2OldInspect = await inspectZipZipBuffer(v2OldZip);
      eq('无 home 列的旧 v2 备份 inspect 通过', v2OldInspect.ok, true);
      const v2OldRestore = await postJson('/api/backup/restore', {
        token: v2OldInspect.inspect.token,
        confirm: true,
      });
      eq('旧 v2 备份 restore 成功', v2OldRestore.ok, true);
      const homesV2 = (await getJson('/api/places')).map((p) => p.home);
      check('旧 v2 备份恢复后 home 全部补 0', homesV2.every((h) => h === 0), JSON.stringify(homesV2));
      eq('旧 v2 备份恢复后家的位置仍来自备份 config', (await getJson('/api/config')).home, HOME_PT2);

      // v1 旧包（formatVersion 1、无 media 字段）同样补 home=0
      const v1Manifest = { ...oldManifest, formatVersion: 1, includes: { thumbs: false, thumbsCount: 0 } };
      const v1OldMap = new Map(oldMap);
      v1OldMap.set('data/travel.db', oldDbBuf);
      setJsonEntry(v1OldMap, 'manifest.json', v1Manifest);
      const v1OldInspect = await inspectZipZipBuffer(await zipFromMap(v1OldMap));
      eq('无 home 列的旧 v1 备份 inspect 通过', v1OldInspect.ok, true);
      eq('旧 v1 备份 formatVersion = 1', v1OldInspect.inspect.summary.formatVersion, 1);
      const v1OldRestore = await postJson('/api/backup/restore', {
        token: v1OldInspect.inspect.token,
        confirm: true,
      });
      eq('旧 v1 备份 restore 成功', v1OldRestore.ok, true);
      const homesV1 = (await getJson('/api/places')).map((p) => p.home);
      check('旧 v1 备份恢复后 home 全部补 0', homesV1.every((h) => h === 0), JSON.stringify(homesV1));
      eq('旧 v1 备份恢复后家的位置仍来自备份 config', (await getJson('/api/config')).home, HOME_PT2);

      // M5.1 之前的备份 config 里没有 home 字段 → 恢复时保留当前家的位置
      const noHomeConfig = JSON.parse(oldMap.get('data/config.json').toString('utf8'));
      delete noHomeConfig.home;
      const noHomeText = JSON.stringify(noHomeConfig, null, 2) + '\n';
      const noHomeManifest = getJsonEntry(oldMap, 'manifest.json');
      noHomeManifest.checksums['data/config.json'] = sha256(Buffer.from(noHomeText));
      const noHomeMap = new Map(oldMap);
      noHomeMap.set('data/config.json', Buffer.from(noHomeText));
      setJsonEntry(noHomeMap, 'manifest.json', noHomeManifest);
      await postJson('/api/config/home', HOME_PT3);
      const noHomeInspect = await inspectZipZipBuffer(await zipFromMap(noHomeMap));
      eq('无 home 字段的旧备份 inspect 通过', noHomeInspect.ok, true);
      const noHomeRestore = await postJson('/api/backup/restore', {
        token: noHomeInspect.inspect.token,
        confirm: true,
      });
      eq('无 home 字段的旧备份 restore 成功', noHomeRestore.ok, true);
      eq('旧备份没有家 → 恢复后保留当前家', (await getJson('/api/config')).home, HOME_PT3);
    }

    // ═════════════ 11) 补全地区（2026-11-04：修复「未标注」）═════════════
    section('11) 补全地区：PATCH 省/市/区 + 代码 写回、缺省保留、非法值 400');
    const RP = await createPlace('补全测试', {
      province: null,
      city: null,
      county: null,
      province_code: null,
      city_code: null,
      county_code: null,
      date: '2021-01-01',
    });
    eq(
      '新地点无省市区（模拟「未标注」）',
      { province: RP.province, city: RP.city, county: RP.county },
      { province: null, city: null, county: null }
    );
    let pf = await patchJson(`/api/places/${RP.id}`, {
      province: '青海省',
      city: '海北藏族自治州',
      county: '刚察县',
      province_code: '156630000',
      city_code: '156632200',
      county_code: '156632224',
    });
    eq(
      'PATCH 写回省/市/区',
      { province: pf.province, city: pf.city, county: pf.county },
      { province: '青海省', city: '海北藏族自治州', county: '刚察县' }
    );
    eq(
      'PATCH 写回省/市/区代码',
      [pf.province_code, pf.city_code, pf.county_code],
      ['156630000', '156632200', '156632224']
    );
    eq(
      '列表里同步（My旅迹分组用）',
      (await getJson('/api/places')).find((p) => p.id === RP.id).province,
      '青海省'
    );
    pf = await patchJson(`/api/places/${RP.id}`, { city: '海北州' });
    eq(
      '只改 city 时 province/county 保留',
      { province: pf.province, city: pf.city, county: pf.county },
      { province: '青海省', city: '海北州', county: '刚察县' }
    );
    await expectStatus('PATCH province:数字 → 400', 400, () =>
      patchJson(`/api/places/${RP.id}`, { province: 123 })
    );
    await expectStatus('PATCH city 超长 → 400', 400, () =>
      patchJson(`/api/places/${RP.id}`, { city: 'x'.repeat(65) })
    );
    eq('非法地区值不改数据', (await getJson(`/api/places/${RP.id}`)).province, '青海省');
    pf = await patchJson(`/api/places/${RP.id}`, { city: null });
    eq('city:null 可清空（但通常不需要）', pf.city, null);
    eq('补全/清空不影响名称', pf.name, '补全测试');

    // ═════════════ 12) 真实数据未被写 ═════════════
    section('12) 真实 data/ 与 .dev-media 全程未变');
    const realSigAfter = {
      db: sigOf(join(realDataDir, 'travel.db')),
      wal: sigOf(join(realDataDir, 'travel.db-wal')),
      shm: sigOf(join(realDataDir, 'travel.db-shm')),
      config: sigOf(join(realDataDir, 'config.json')),
      devMedia: dirSig(realDevMedia),
    };
    eq('真实 data/travel.db 未变', realSigAfter.db, realSig.db);
    eq('真实 data/travel.db-wal 未变', realSigAfter.wal, realSig.wal);
    eq('真实 data/travel.db-shm 未变', realSigAfter.shm, realSig.shm);
    eq('真实 data/config.json 未变', realSigAfter.config, realSig.config);
    eq('真实 .dev-media 未变（文件数+字节）', realSigAfter.devMedia, realSig.devMedia);
    check('全程服务日志不含测试 key', !readLogs().includes(NEW_KEY));

    console.log('\n' + '─'.repeat(68));
    console.log(`通过 ${pass} 项，失败 ${fail} 项 ${fail === 0 ? '✅' : '❌'}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    await stopChild(child);
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

/** 上传 zip 到 inspect；返回 { ok, inspect }（ok=false 时 inspect 是抛出错误信息） */
async function inspectZipZipBuffer(buf) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/zip' }), 'old-backup.zip');
  try {
    const r = await fetch(`${BASE}/api/backup/inspect`, { method: 'POST', body: fd });
    const body = await r.json();
    return { ok: r.ok, inspect: body };
  } catch (e) {
    return { ok: false, inspect: { error: e?.message || String(e) } };
  }
}

run().catch((e) => {
  console.error('\nM5 设置冒烟异常：', e?.message || e);
  process.exitCode = 1;
});
