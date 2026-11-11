#!/usr/bin/env node
/**
 * 跨平台（Windows / macOS）备份 & 恢复回归冒烟 —— 不需要 Chrome，纯 Node（fetch + node:sqlite）。
 *
 *   node scripts/smoke-crossplatform.mjs
 *
 * 覆盖（backup/LOCAL-CROSSPLATFORM-BRIEF.md §3 Phase 2 第 9 / 11 项，D-385）：
 * 1) 造「Windows 风格旧库」：临时 DATA_DIR + STARTER_DATA=1 起隔离实例生成数据 → 关服务 →
 *    用 node:sqlite 把 media.rel_path 改回 Windows 反斜杠 → 写「异平台绝对路径」的 config.json
 *    （Windows 上写 POSIX 路径、macOS 上写 `D:\旧电脑\...`，两者都是当前平台无法使用的写法）；
 * 2) 重启同一实例断言启动自愈：config 回落（mediaRoot/backupDir 指回临时目录）+ config.json.bak-* 存在
 *    + DB 里 rel_path 全部是 `/` + /api/media/:id/orig|thumb|preview 200；
 * 3) 通过 API 导出备份（start → 轮询 status → download）：local 模式还应返回 D-386 的 savedPath
 *    （备份目录里真实存在的同名文件），并核对下载字节数；
 * 4) 把导出包里的 DB 改成「Windows 旧库」反斜杠（重算 manifest sha256）→ 换全新 DATA_DIR/MEDIA_ROOT
 *    起第二个隔离实例 → POST /api/backup/inspect → POST /api/backup/restore/start → 轮询 →
 *    断言恢复后：missingMedia=0、素材 200、DB 里 rel_path 全部 `/`、恢复流程确实归一化过（pathsHealed）；
 * 5) 不改真实 data/、.dev-media/；结束杀掉所有子进程、清理临时目录；任何断言失败 exit 1。
 *
 * 注意：脚本会自己 spawn `node server/index.mjs`（用随机的空闲端口 + 临时目录），
 * 同时适用于本机 Windows 与 GitHub Actions 的 macOS runner（.github/workflows/macos-ci.yml）。
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ZipFile } from 'yazl';
import { fromBufferPromise } from 'yauzl';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// ───────────── 结果统计 ─────────────

let pass = 0;
const failures = [];
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`);
  } else {
    failures.push({ label, extra });
    console.log(`  ❌ ${label}${extra ? '  ' + extra : ''}`);
  }
};
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? '' : `实际=${a} 期望=${b}`);
};
const section = (title) => console.log(`\n── ${title} ──`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ───────────── Node / 环境检查 ─────────────

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `[smoke-crossplatform] ❌ Node ${process.versions.node} 太旧：node:sqlite 在 22.13 以下需要 --experimental-sqlite，\n` +
      '  请升级到 Node 24 LTS（本项目 engines >=22.13）。'
  );
  process.exit(1);
}

// ───────────── 真实数据保护（必须与跑前完全一致）─────────────

const sigOf = (p) => {
  try {
    const st = statSync(p);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return 'absent';
  }
};
const dirSig = (dir) => {
  try {
    const names = readdirSync(dir);
    return `${names.length}:${names.sort().join('|')}`;
  } catch {
    return 'absent';
  }
};
const realDataDir = join(ROOT, 'data');
const realSig = {
  db: sigOf(join(realDataDir, 'travel.db')),
  wal: sigOf(join(realDataDir, 'travel.db-wal')),
  config: sigOf(join(realDataDir, 'config.json')),
  devMedia: dirSig(join(ROOT, '.dev-media')),
};

// ───────────── HTTP / 进程工具 ─────────────

async function getJson(url) {
  const r = await fetch(url);
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}: ${body?.error || text.slice(0, 300)}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  if (body === null) throw new Error('返回不是 JSON：' + text.slice(0, 200));
  return body;
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}: ${parsed?.error || text.slice(0, 300)}`);
    err.status = r.status;
    err.body = parsed;
    throw err;
  }
  if (parsed === null) throw new Error('返回不是 JSON：' + text.slice(0, 200));
  return parsed;
}

/** 找一个空闲端口（listen 0 拿系统分配，再关掉） */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const children = [];

/**
 * 起一个隔离实例：DATA_DIR / MEDIA_ROOT / PORT / AUTH_MODE 全部显式传，
 * 不读写真实 data/、.dev-media/。stdio 重定向到日志文件（沙箱不允许 pipe）。
 */
function spawnInstance(name, { dataDir, mediaRoot, port, starterData, tmpDir }) {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });
  const logPath = join(tmpDir, `server-${name}.log`);
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      MEDIA_ROOT: mediaRoot,
      MEDIA_ROOT_DEV: mediaRoot,
      AUTH_MODE: 'local',
      STARTER_DATA: starterData ? '1' : '0',
      // CI 磁盘波动时不要让导出/恢复因为「预留空间不足」假失败
      BACKUP_SKIP_DISK_CHECK: '1',
    },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  const inst = {
    name,
    child,
    port,
    dataDir,
    mediaRoot,
    base: `http://127.0.0.1:${port}`,
    logPath,
    readLogs() {
      try {
        return readFileSync(logPath, 'utf8');
      } catch {
        return '';
      }
    },
    exited: null,
  };
  child.once('exit', (code, signal) => {
    inst.exited = { code, signal };
  });
  children.push(inst);
  return inst;
}

async function waitHealthy(inst, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < end) {
    if (inst.exited) throw new Error(`[${inst.name}] 服务提前退出：${JSON.stringify(inst.exited)}\n${inst.readLogs().slice(-3000)}`);
    try {
      const health = await getJson(`${inst.base}/api/health`);
      if (health?.ok) return health;
    } catch (e) {
      lastErr = e?.message || String(e);
    }
    await sleep(200);
  }
  throw new Error(`[${inst.name}] 服务 ${timeoutMs}ms 内没起来（最后错误：${lastErr}）\n${inst.readLogs().slice(-4000)}`);
}

/** 优雅停掉实例并等端口释放 */
async function stopInstance(inst, timeoutMs = 15_000) {
  if (!inst || inst.exited) return;
  try {
    inst.child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !inst.exited) await sleep(100);
  if (!inst.exited) {
    try {
      inst.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    const end2 = Date.now() + 5000;
    while (Date.now() < end2 && !inst.exited) await sleep(100);
  }
  // 等 health 真正不可达（端口释放），避免下一个实例抢不到端口
  const end3 = Date.now() + 5000;
  while (Date.now() < end3) {
    try {
      await getJson(`${inst.base}/api/health`);
      await sleep(100);
    } catch {
      return;
    }
  }
}

// ───────────── DB 工具（直接读写隔离实例的 travel.db）─────────────

/** 打开隔离库；readOnly 在 WAL 上偶发失败时回落到可写打开 */
function openDb(dbPath, { readOnly = false } = {}) {
  if (readOnly) {
    try {
      return new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      /* 回落 */
    }
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 10000');
  } catch {
    /* ignore */
  }
  return db;
}

function queryAll(dbPath, sql, params = []) {
  const db = openDb(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

const listMedia = (dbPath) =>
  queryAll(dbPath, 'SELECT id, rel_path, thumb, poster, bytes FROM media ORDER BY created_at, id');

// ───────────── zip 工具（改写导出包里的 DB，模拟 Windows 旧库）─────────────

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

/**
 * 把导出包改成「Windows 旧库备份」：
 * - data/travel.db 里的 media.rel_path / thumb / poster 改成反斜杠；
 * - media-manifest.json 的 rel_path 同步改；
 * - manifest.json 的 data/travel.db sha256 重算（否则 inspect 会判定包被改过）。
 * 返回新的 zip Buffer。
 */
async function makeWindowsStyleZip(zipBuf) {
  const map = await readZipBuffer(zipBuf);
  const dbBuf = map.get('data/travel.db');
  const tmpDb = join(TMP, 'zip-db-edit.db');
  writeFileSync(tmpDb, dbBuf);

  const db = openDb(tmpDb);
  let rows;
  try {
    rows = db.prepare('SELECT id, rel_path, thumb, poster FROM media').all();
    const update = db.prepare('UPDATE media SET rel_path = ?, thumb = ?, poster = ? WHERE id = ?');
    const toWin = (v) => (v == null || v === '' ? v : String(v).replace(/\//g, '\\'));
    db.exec('BEGIN');
    for (const r of rows) update.run(toWin(r.rel_path), toWin(r.thumb), toWin(r.poster), r.id);
    db.exec('COMMIT');
    rows = db.prepare('SELECT id, rel_path, thumb, poster FROM media').all();
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  const newDbBuf = readFileSync(tmpDb);
  map.set('data/travel.db', newDbBuf);

  // media-manifest 的 rel_path 同步成反斜杠（inspect 用 normalizeRelKey 比较，两种都认，这里保持真实）
  const mediaManifest = JSON.parse(map.get('media-manifest.json').toString('utf8'));
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const item of mediaManifest.items || []) {
    const row = byId.get(String(item.id));
    if (row) {
      item.rel_path = row.rel_path;
      item.thumb = row.thumb ?? null;
      item.poster = row.poster ?? null;
    }
  }
  map.set('media-manifest.json', Buffer.from(JSON.stringify(mediaManifest, null, 2) + '\n'));

  const manifest = JSON.parse(map.get('manifest.json').toString('utf8'));
  manifest.checksums = manifest.checksums || {};
  manifest.checksums['data/travel.db'] = sha256(newDbBuf);
  map.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));

  return zipBuffer([...map.entries()].map(([name, data]) => ({ name, data })));
}

// ───────────── 断言辅助 ─────────────

async function httpStatus(url, init) {
  try {
    const r = await fetch(url, init);
    if (r.body) {
      try {
        await r.arrayBuffer();
      } catch {
        /* ignore */
      }
    }
    return r.status;
  } catch (e) {
    return `ERR(${e?.message || e})`;
  }
}

/** 轮询导出 / 恢复任务直到结束 */
async function pollJob(inst, kind, jobId, { timeoutMs = 240_000 } = {}) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await getJson(`${inst.base}/api/backup/${kind}/status/${encodeURIComponent(jobId)}`);
    if (last.state !== 'building' && last.state !== 'running') return last;
    await sleep(200);
  }
  throw new Error(`[${inst.name}] ${kind} 任务 ${jobId} 超时（最后状态：${JSON.stringify(last)}）`);
}

// ───────────── 主流程 ─────────────

const TMP = resolve(ROOT, '.tmp', `smoke-crossplatform-${Date.now()}-${randomBytes(3).toString('hex')}`);
let instA = null;
let instB = null;

/** 关服务后把 media.rel_path 改回 Windows 反斜杠（模拟从 Windows 拷过来的旧库） */
function corruptDbToWindowsStyle(dbPath) {
  const db = openDb(dbPath);
  try {
    const rows = db.prepare('SELECT id, rel_path FROM media').all();
    if (!rows.length) throw new Error('隔离库里没有 media 记录，STARTER_DATA 没生成？');
    const update = db.prepare('UPDATE media SET rel_path = ? WHERE id = ?');
    db.exec('BEGIN');
    for (const r of rows) update.run(String(r.rel_path).replace(/\//g, '\\'), r.id);
    db.exec('COMMIT');
    return rows.length;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

async function run() {
  console.log(`\n跨平台备份 / 恢复冒烟（Windows | macOS 通用，${process.platform}，Node ${process.versions.node}，app ${APP_VERSION}）`);
  console.log('─'.repeat(76));
  mkdirSync(TMP, { recursive: true });
  console.log(`临时目录：${TMP}`);

  const dataA = join(TMP, 'A', 'data');
  const mediaA = join(TMP, 'A', 'media');
  // 异平台绝对路径：当前平台一定用不了（Windows 上给 POSIX；macOS/Linux 上给 Win 盘符）
  const foreign =
    process.platform === 'win32'
      ? { mediaRoot: '/Users/old-mac/TreadHorizon/素材库', backupDir: '/Users/old-mac/TreadHorizon/备份' }
      : { mediaRoot: 'D:\\旧电脑\\TreadHorizon\\素材库', backupDir: 'D:\\旧电脑\\TreadHorizon\\备份' };

  // ═══════ 1) 起实例 A 生成「Windows 风格旧库」的起点数据 ═══════
  section('1) 起隔离实例 A（STARTER_DATA=1）生成示例数据');
  const portA = await freePort();
  instA = spawnInstance('A', { dataDir: dataA, mediaRoot: mediaA, port: portA, starterData: true, tmpDir: TMP });
  let healthA = await waitHealthy(instA);
  check('实例 A 在线', healthA.ok === true);
  eq('authMode = local（local 实例）', healthA.authMode, 'local');
  eq('素材库指向临时目录', resolve(healthA.mediaRoot), resolve(mediaA));
  eq('数据目录指向临时目录', resolve(healthA.dataDir), resolve(dataA));

  let st = await getJson(`${instA.base}/api/backup/status`);
  check('示例数据已生成（media > 0）', st.dataCounts.media > 0, `places=${st.dataCounts.places} media=${st.dataCounts.media}`);
  const rowsBefore = listMedia(join(dataA, 'travel.db'));
  check('DB 里能读到 media 记录', rowsBefore.length === st.dataCounts.media, `rows=${rowsBefore.length}`);
  const mediaIds = rowsBefore.map((r) => String(r.id));
  const base = `${instA.base}/api/media/${mediaIds[0]}`;
  check('/api/media/:id/orig 正常（自愈前基线）', (await httpStatus(`${base}/orig`)) === 200);
  check('/api/media/:id/thumb 正常（自愈前基线）', (await httpStatus(`${base}/thumb`)) === 200);
  check('/api/media/:id/preview 正常（自愈前基线）', (await httpStatus(`${base}/preview`)) === 200);

  // ═══════ 2) 关服务 → 改造成 Windows 旧库 + 异平台 config.json ═══════
  section('2) 关服务 → 造 Windows 反斜杠旧库 + 异平台 config.json');
  await stopInstance(instA);
  instA = null;

  const corrupted = corruptDbToWindowsStyle(join(dataA, 'travel.db'));
  check(`DB 已改造成 Windows 风格（${corrupted} 条 rel_path 含 \\）`, corrupted === rowsBefore.length);
  const configPathA = join(dataA, 'config.json');
  const foreignConfig = { ...foreign, lastBackupAt: 1234567890 };
  writeFileSync(configPathA, JSON.stringify(foreignConfig, null, 2), 'utf8');
  check(
    '已写入异平台 config.json（mediaRoot/backupDir 指向另一系统绝对路径）',
    JSON.parse(readFileSync(configPathA, 'utf8')).mediaRoot === foreign.mediaRoot
  );

  // ═══════ 3) 重启 A：启动自愈 ═══════
  section('3) 重启实例 A：启动自愈（config 回落 + DB 路径归一化）');
  instA = spawnInstance('A2', { dataDir: dataA, mediaRoot: mediaA, port: portA, starterData: true, tmpDir: TMP });
  healthA = await waitHealthy(instA);
  check('启动成功（旧库不需要迁移也能启动）', healthA.ok === true);
  eq('config.mediaRoot 回落为临时素材库（MEDIA_ROOT）', resolve(healthA.mediaRoot), resolve(mediaA));
  eq('config.backupDir 回落为默认 data/backups', resolve(healthA.backupDir), resolve(dataA, 'backups'));
  const bakNames = readdirSync(dataA).filter((n) => /^config\.json\.bak-/.test(n));
  check('config.json.bak-* 已生成（原配置留档）', bakNames.length === 1, bakNames.join(', '));
  if (bakNames.length) {
    const bak = JSON.parse(readFileSync(join(dataA, bakNames[0]), 'utf8'));
    check('备份文件保留了异平台原值（可人工回滚 / 重新映射）', bak.mediaRoot === foreign.mediaRoot);
  }
  const cfgNow = JSON.parse(readFileSync(configPathA, 'utf8'));
  check(
    '当前 config.json 不再保留不可用的异平台路径',
    !cfgNow.mediaRoot && !cfgNow.backupDir,
    `mediaRoot=${JSON.stringify(cfgNow.mediaRoot)} backupDir=${JSON.stringify(cfgNow.backupDir)}`
  );

  const rowsHealed = listMedia(join(dataA, 'travel.db'));
  const backslashRows = rowsHealed.filter((r) => String(r.rel_path).includes('\\'));
  eq('DB 里 rel_path 已全部归一化为 /', backslashRows.length, 0);
  const thumbBackslash = rowsHealed.filter((r) => String(r.thumb ?? '').includes('\\') || String(r.poster ?? '').includes('\\'));
  eq('DB 里 thumb/poster 也没有反斜杠', thumbBackslash.length, 0);

  // 素材接口：自愈后（DB 里 rel_path 是 `/`，素材文件是启动时写入的）应该 200
  let variantsOk = 0;
  let variantsTotal = 0;
  const variantIds = mediaIds.slice(0, 3);
  for (const id of variantIds) {
    for (const variant of ['orig', 'thumb', 'preview']) {
      variantsTotal++;
      const status = await httpStatus(`${instA.base}/api/media/${id}/${variant}`);
      if (status === 200) variantsOk++;
      else failures.push({ label: `自愈后 /api/media/${id}/${variant} → 200`, extra: `实际=${status}` });
    }
  }
  check(`自愈后素材接口原片/缩略图/预览全部 200（${variantsOk}/${variantsTotal}）`, variantsOk === variantsTotal);

  // ═══════ 4) 导出备份（两阶段）+ D-386 已存备份目录 ═══════
  section('4) API 导出备份（start → 轮询 → download）+ D-386 备份目录落盘');
  const startExport = await postJson(`${instA.base}/api/backup/export/start`, {
    includeThumbs: true,
    includeMedia: true,
  });
  check('导出任务已启动', typeof startExport.jobId === 'string' && startExport.jobId.length > 0);
  const doneExport = await pollJob(instA, 'export', startExport.jobId);
  eq('导出任务最终 state = done', doneExport.state, 'done');
  check('导出 zip 字节 > 0', Number(doneExport.zipBytes) > 0, `${doneExport.zipBytes} B`);
  // D-386：local 模式导出完成后另存一份到备份目录
  check('D-386 getExportStatus 返回 savedPath', typeof doneExport.savedPath === 'string' && doneExport.savedPath.length > 0, String(doneExport.savedPath || ''));
  check('D-386 savedPath 文件真实存在', Boolean(doneExport.savedPath) && existsSync(doneExport.savedPath));
  if (doneExport.savedPath && existsSync(doneExport.savedPath)) {
    eq('D-386 备份目录文件大小 = 导出 zip 大小', statSync(doneExport.savedPath).size, doneExport.zipBytes);
    check(
      'D-386 备份文件名符合下载命名（My旅迹素材备份-…-（备份勿删）.zip）',
      /^My旅迹素材备份-\d{4}-\d{2}-\d{2}-（备份勿删）\.zip$/.test(doneExport.savedName || ''),
      String(doneExport.savedName || '')
    );
    eq('D-386 saveError = null', doneExport.saveError, null);
    const backupDirAbs = resolve(healthA.backupDir);
    eq('D-386 savedPath 位于 CONFIG.backupDir 内', resolve(dirname(doneExport.savedPath)), backupDirAbs);
  } else {
    failures.push({ label: 'D-386 备份目录文件存在', extra: 'savedPath 缺失' });
  }

  const dl = await fetch(`${instA.base}/api/backup/export/download/${encodeURIComponent(startExport.jobId)}`);
  check('下载接口 HTTP 200', dl.status === 200, `实际=${dl.status}`);
  const exportZip = Buffer.from(await dl.arrayBuffer());
  eq('下载 zip 大小 = status.zipBytes', exportZip.length, doneExport.zipBytes);
  const cd = String(dl.headers.get('content-disposition') || '');
  const fnStar = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  let dlName = '';
  try {
    dlName = fnStar ? decodeURIComponent(fnStar[1]) : '';
  } catch {
    /* ignore */
  }
  check(
    '下载文件名格式正确（My旅迹素材备份-YYYY-MM-DD-（备份勿删）.zip）',
    /^My旅迹素材备份-\d{4}-\d{2}-\d{2}-（备份勿删）\.zip$/.test(dlName),
    dlName || cd
  );

  // D-386：备份目录里同名文件已存在时加 (2) 序号，绝不覆盖上一次的导出
  const secondExport = await postJson(`${instA.base}/api/backup/export/start`, {
    includeThumbs: false,
    includeMedia: false,
  });
  const secondDone = await pollJob(instA, 'export', secondExport.jobId);
  eq('第二次导出任务 state = done', secondDone.state, 'done');
  check(
    'D-386 同名备份自动加 (2) 序号',
    /\(2\)\.zip$/.test(secondDone.savedName || ''),
    String(secondDone.savedName || '')
  );
  check(
    'D-386 第二个备份文件真实存在（没有覆盖旧备份）',
    Boolean(secondDone.savedPath) && existsSync(secondDone.savedPath)
  );
  eq('D-386 第一个备份文件仍在（没被覆盖）', Boolean(doneExport.savedPath) && existsSync(doneExport.savedPath), true);

  // zip 基本结构：manifest / DB / media-manifest 都在
  const exportEntries = await readZipBuffer(exportZip);
  check('导出包包含 manifest.json', exportEntries.has('manifest.json'));
  check('导出包包含 data/travel.db', exportEntries.has('data/travel.db'));
  check('导出包包含 media/ 素材条目', [...exportEntries.keys()].some((n) => n.startsWith('media/')));
  check('导出包包含 thumbs/ 缩略图条目', [...exportEntries.keys()].some((n) => n.startsWith('thumbs/')));
  const exportManifest = JSON.parse(exportEntries.get('manifest.json').toString('utf8'));
  eq('导出包 includes.media = true', exportManifest.includes?.media, true);

  // ═══════ 5) 把导出包改造成 Windows 旧库备份 → 全新实例 B 恢复 ═══════
  section('5) 导出包 →「Windows 旧库备份」→ 全新实例 B inspect + restore');
  const windowsZip = await makeWindowsStyleZip(exportZip);
  const windowsZipPath = join(TMP, 'windows-style-backup.zip');
  writeFileSync(windowsZipPath, windowsZip);
  // 自检：改完的 DB 里确实有反斜杠（证明恢复流程真的需要归一化）
  const editDbPath = join(TMP, 'zip-db-edit.db');
  const editedRows = listMedia(editDbPath);
  check('改造后的备份包 DB 里 rel_path 含反斜杠', editedRows.some((r) => String(r.rel_path).includes('\\')));
  const mediaRowCount = editedRows.length;

  const dataB = join(TMP, 'B', 'data');
  const mediaB = join(TMP, 'B', 'media');
  const portB = await freePort();
  instB = spawnInstance('B', { dataDir: dataB, mediaRoot: mediaB, port: portB, starterData: false, tmpDir: TMP });
  const healthB = await waitHealthy(instB);
  eq('实例 B 素材库指向自己的临时目录', resolve(healthB.mediaRoot), resolve(mediaB));
  let stB = await getJson(`${instB.base}/api/backup/status`);
  eq('实例 B 是空库（恢复前）', stB.dataCounts, { places: 0, visits: 0, media: 0 });

  // inspect：multipart 上传 zip（字段名 file）
  const fd = new FormData();
  fd.append('file', new Blob([windowsZip], { type: 'application/zip' }), 'windows-style-backup.zip');
  const inspectResp = await fetch(`${instB.base}/api/backup/inspect`, { method: 'POST', body: fd });
  const inspectText = await inspectResp.text();
  let inspected = null;
  try {
    inspected = JSON.parse(inspectText);
  } catch {
    inspected = null;
  }
  check('POST /api/backup/inspect → 200', inspectResp.status === 200, `实际=${inspectResp.status} ${inspectResp.status === 200 ? '' : inspectText.slice(0, 300)}`);
  check('inspect 返回检查令牌', typeof inspected?.token === 'string' && inspected.token.length > 0);
  eq('inspect 摘要 includes.media = true', inspected?.summary?.includeMedia, true);
  eq('inspect 摘要媒体数 = 备份包媒体数', inspected?.summary?.mediaCount, mediaRowCount);
  check('inspect 不因原分隔符报错（只是提示当前素材库缺失）', Number(inspected?.summary?.mediaMissing) >= 0);

  // restore/start
  const startedRestore = await postJson(`${instB.base}/api/backup/restore/start`, { token: inspected.token });
  check('恢复任务已启动', typeof startedRestore.jobId === 'string' && startedRestore.jobId.length > 0);
  const restoredJob = await pollJob(instB, 'restore', startedRestore.jobId);
  eq('恢复任务最终 state = done', restoredJob.state, 'done');
  check(
    '恢复返回 ok（无 rolledBack）',
    restoredJob.result?.ok === true,
    `error=${restoredJob.error || ''} rolledBack=${restoredJob.rolledBack}`
  );
  const restored = restoredJob.result || {};
  eq('恢复后 missingMedia = 0（不因分隔符误报）', restored.missingMedia, 0);
  eq('恢复后缺失缩略图 = 0', restored.missingThumbs, 0);
  eq('恢复后素材写入失败 = 0', restored.media?.failed, 0);
  eq('恢复后素材全部写入（written + skipped = 备份素材数）', (restored.media?.written || 0) + (restored.media?.skipped || 0), mediaRowCount);
  check('恢复流程确实做了路径归一化（pathsHealed.mediaNormalized > 0）', Number(restored.pathsHealed?.mediaNormalized) > 0, JSON.stringify(restored.pathsHealed || {}));
  eq('恢复后路径归一化冲突 = 0', restored.pathsHealed?.conflicts, 0);
  check('恢复前自动备份（pre-restore-*.zip）已生成', readdirSync(join(dataB, 'backups')).some((n) => /^pre-restore-.+\.zip$/.test(n)));

  // 恢复后断言：DB rel_path 全 `/`、素材接口 200
  const rowsRestored = listMedia(join(dataB, 'travel.db'));
  eq('恢复后 DB media 行数 = 备份行数', rowsRestored.length, mediaRowCount);
  eq('恢复后 DB 里 rel_path 全部是 POSIX /', rowsRestored.filter((r) => String(r.rel_path).includes('\\')).length, 0);
  let restoredVariantsOk = 0;
  let restoredVariantsTotal = 0;
  for (const row of rowsRestored.slice(0, 3)) {
    for (const variant of ['orig', 'thumb', 'preview']) {
      restoredVariantsTotal++;
      const status = await httpStatus(`${instB.base}/api/media/${row.id}/${variant}`);
      if (status === 200) restoredVariantsOk++;
      else failures.push({ label: `恢复后 /api/media/${row.id}/${variant} → 200`, extra: `实际=${status}` });
    }
  }
  check(
    `恢复后素材接口原片/缩略图/预览全部 200（${restoredVariantsOk}/${restoredVariantsTotal}）`,
    restoredVariantsOk === restoredVariantsTotal
  );
  stB = await getJson(`${instB.base}/api/backup/status`);
  eq('恢复后 dataCounts.media = 备份行数', stB.dataCounts.media, mediaRowCount);
  check('恢复后 places > 0', stB.dataCounts.places > 0, `places=${stB.dataCounts.places}`);

  // ═══════ 6) 真实数据未被写入 ═══════
  section('6) 真实 data/ 与 .dev-media/ 未被写入');
  const realSigAfter = {
    db: sigOf(join(realDataDir, 'travel.db')),
    wal: sigOf(join(realDataDir, 'travel.db-wal')),
    config: sigOf(join(realDataDir, 'config.json')),
    devMedia: dirSig(join(ROOT, '.dev-media')),
  };
  eq('真实 data/travel.db 未变化', realSigAfter.db, realSig.db);
  eq('真实 data/config.json 未变化', realSigAfter.config, realSig.config);
  eq('真实 .dev-media/ 未变化', realSigAfter.devMedia, realSig.devMedia);
}

try {
  await run();
} catch (e) {
  failures.push({ label: '未捕获异常', extra: e?.stack || String(e) });
  console.error('\n[smoke-crossplatform] 异常：', e?.stack || e);
  for (const inst of children) {
    const logs = inst?.readLogs?.() || '';
    if (logs) console.error(`\n─── ${inst.name} 服务日志（末尾 2500 字）───\n${logs.slice(-2500)}`);
  }
} finally {
  for (const inst of children) {
    try {
      await stopInstance(inst);
    } catch (e) {
      console.error(`[smoke-crossplatform] 停止实例 ${inst?.name} 失败：`, e?.message || e);
    }
  }
  try {
    rmSync(TMP, { recursive: true, force: true });
    console.log(`\n已清理临时目录：${TMP}`);
  } catch (e) {
    console.error('[smoke-crossplatform] 清理临时目录失败：', e?.message || e);
  }
}

// ───────────── 结果 ─────────────
if (failures.length) {
  console.error(`\n❌ FAIL：${failures.length} 条失败 / ${pass + failures.length} 条断言`);
  for (const f of failures) console.error(`  - ${f.label}${f.extra ? `  ${f.extra}` : ''}`);
  process.exit(1);
}
console.log(`\n✅ PASS：跨平台备份 / 恢复冒烟全部 ${pass} 条断言通过（${process.platform} / Node ${process.versions.node}）`);
