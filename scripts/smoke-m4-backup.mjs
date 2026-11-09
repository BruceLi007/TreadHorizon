/**
 * M4 备份 / 恢复 / 提醒隔离冒烟测试（F-SYS-03 / F-SYS-04 / F-SYS-05）
 *
 *   node scripts/smoke-m4-backup.mjs
 *
 * 全隔离：空临时 DATA_DIR + 空临时 MEDIA_ROOT + 4202 端口独立实例（SMOKE_M4_PORT 可覆盖），跑完清理。
 * 不碰真实 data/travel.db、.dev-media、.env.local；测试前后校验真实 data/ 与 .dev-media 未变化。
 *
 * 覆盖：
 * - status：空库不 due / never；有数据 never→due；threshold / snooze / 逾期计算
 * - export：含/不含 thumbs、zip 结构 / manifest / 校验和 / 行数 / 无路径穿越、lastBackupAt 落 config.json
 * - inspect：正常摘要、mediaMissing、非法 zip / 缺文件 / 穿越 / 篡改 / 行数不一致 / DB 损坏 / 版本过新
 * - restore：事务替换、软删记录回来、额外数据消失、secret 恢复、B 文件不增不删、自动备份可再检查、
 *            保留 5 份、失败回滚（FK 违规 / 备份来自更新版本）、token 无效/过期/未确认
 * - settings / snooze：阈值白名单、稍后 24h、clamp、恢复后配置不被回退
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
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ZipFile } from 'yazl';
import { fromBufferPromise } from 'yauzl';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_M4_PORT || 4202);
const BASE = `http://127.0.0.1:${PORT}`;
/** 测试里把 token 有效期缩短到 5 秒，才能覆盖「过期 token」 */
const TOKEN_TTL_MS = 5000;
/** 两阶段导出任务 TTL（测试里调短，覆盖过期清理） */
const EXPORT_TTL_MS = 4000;
/** 导出任务在 building 状态停留的时间，保证能稳定覆盖进度/并发 409/取消 */
const JOB_DELAY_MS = 400;
const DAY = 86_400_000;
const APP_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

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
    const msg = body?.error || t.slice(0, 300);
    const err = new Error(`HTTP ${r.status}: ${msg}`);
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

const expect400 = async (label, fn, text) => {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  check(
    `${label} → 400`,
    err?.status === 400,
    err?.status === 400 ? '' : `实际=${err ? `HTTP ${err.status ?? '?'}` : '成功'}` +
      (err?.message ? `（${err.message.slice(0, 120)}）` : '')
  );
  if (text && err) check(`${label} 错误文案清晰`, String(err.message).includes(text), String(err.message).slice(0, 160));
};

// ───────────── 文件 / zip 工具 ─────────────

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

const listRelFiles = (dir) => walkFiles(dir).map((p) => relative(dir, p).split(sep).join('/')).sort();
const countFiles = (dir) => walkFiles(dir).length;
const dirBytes = (dir) => walkFiles(dir).reduce((n, p) => n + statSync(p).size, 0);

const sigOf = (p) => {
  try {
    const st = statSync(p);
    return `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    return 'absent';
  }
};

/** 递归目录签名：文件数 + 总字节（用来证明真实 .dev-media 没被动过） */
const dirSig = (dir) => `${countFiles(dir)}:${dirBytes(dir)}`;

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

const zipFromMap = (map) =>
  zipBuffer([...map.entries()].map(([name, data]) => ({ name, data })));

const getJsonEntry = (map, name) => JSON.parse(map.get(name).toString('utf8'));
const setJsonEntry = (map, name, obj) =>
  map.set(name, Buffer.from(JSON.stringify(obj, null, 2) + '\n'));

/** 等长 ASCII 替换：用来在 zip 里伪造非法条目名（local header + central directory 两处） */
function replaceAscii(buf, from, to) {
  const a = Buffer.byteLength(from);
  const b = Buffer.byteLength(to);
  if (a !== b) throw new Error(`等长替换失败：${from} / ${to}`);
  const out = Buffer.from(buf);
  const find = Buffer.from(from);
  const repl = Buffer.from(to);
  let idx = 0;
  let count = 0;
  while ((idx = out.indexOf(find, idx)) !== -1) {
    repl.copy(out, idx);
    idx += find.length;
    count++;
  }
  return { buf: out, count };
}

/** 通用等长 Buffer 替换：用来在 zip 里伪造非法条目名（local header + central directory 两处） */
function replaceSameLengthBuffer(buf, from, to) {
  if (from.length !== to.length) throw new Error('等长替换失败');
  const out = Buffer.from(buf);
  let idx = 0;
  let count = 0;
  while ((idx = out.indexOf(from, idx)) !== -1) {
    to.copy(out, idx);
    idx += from.length;
    count++;
  }
  return { buf: out, count };
}

/** DB rel_path（Windows 反斜杠）→ media/ 条目名里的 `a/b/c` 分段 */
const normRelKey = (rel) => String(rel ?? '').split(/[\\/]+/).filter(Boolean).join('/');
const mediaEntryName = (rel) => 'media/' + normRelKey(rel);

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

// ───────────── 业务请求 ─────────────

const createPlace = (name, extra = {}) =>
  postJson('/api/places', {
    name,
    lng: 120.1 + Math.random() * 0.1,
    lat: 30.2 + Math.random() * 0.1,
    kind: 'visited',
    ...extra,
  });
const addVisit = (placeId, body = {}) => postJson(`/api/places/${placeId}/visits`, body);
const findVisit = (detail, date) => (detail.visits || []).find((v) => v.date === date);

const makeJpg = (r, g, b) =>
  sharp({ create: { width: 240, height: 180, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 80 })
    .toBuffer();

const uploadOne = async (visitId, name, buf, type = 'image/jpeg') => {
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type }), name);
  return fetch(`${BASE}/api/media/upload?visitId=${encodeURIComponent(visitId)}`, {
    method: 'POST',
    body: fd,
  }).then(j);
};
const uploadPhoto = async (visitId, name, rgb = [120, 60, 30]) => {
  const up = await uploadOne(visitId, name, await makeJpg(...rgb));
  return up.added?.[0]?.id ?? null;
};
/** 假 mp4：能落一条 kind='video' 的媒体记录（ffmpeg 抽帧会失败 → 没有 poster，符合预期） */
const uploadVideo = async (visitId, name) => {
  const buf = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(64, 7)]);
  const up = await uploadOne(visitId, name, buf, 'video/mp4');
  return up.added?.[0]?.id ?? null;
};

const postExport = async (includeThumbs) => {
  const r = await fetch(`${BASE}/api/backup/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ includeThumbs }),
  });
  return {
    status: r.status,
    headers: Object.fromEntries(r.headers.entries()),
    buf: Buffer.from(await r.arrayBuffer()),
  };
};

const inspectZip = async (buf, fieldName = 'file') => {
  const fd = new FormData();
  fd.append(fieldName, new Blob([buf], { type: 'application/zip' }), 'backup.zip');
  return fetch(`${BASE}/api/backup/inspect`, { method: 'POST', body: fd }).then(j);
};

const restoreWith = (token, confirm = true) =>
  postJson('/api/backup/restore', { token, confirm });

// ───────────── 两阶段导出任务 ─────────────

const startJob = (body = {}) => postJson('/api/backup/export/start', body);
const jobStatus = (jobId) =>
  getJson(`/api/backup/export/status/${encodeURIComponent(jobId)}`);
const jobDelete = (jobId) =>
  fetch(`${BASE}/api/backup/export/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).then(j);
const jobDownload = async (jobId) => {
  const r = await fetch(`${BASE}/api/backup/export/download/${encodeURIComponent(jobId)}`);
  return {
    status: r.status,
    headers: Object.fromEntries(r.headers.entries()),
    buf: Buffer.from(await r.arrayBuffer()),
  };
};
const waitJobDone = async (jobId, timeout = 15000) => {
  const end = Date.now() + timeout;
  let last = null;
  while (Date.now() < end) {
    last = await jobStatus(jobId);
    if (last.state !== 'building') return last;
    await sleep(100);
  }
  throw new Error('等待导出任务超时：' + JSON.stringify(last));
};

const PLA = { province: '浙江省', city: '杭州市', county: '西湖区', province_code: '330000', city_code: '330100', county_code: '330106' };
const NBO = { province: '浙江省', city: '宁波市', county: '海曙区', province_code: '330000', city_code: '330200', county_code: '330203' };
const BJ = { province: '北京市', city: '北京市', county: '东城区', province_code: '110000', city_code: '110100', county_code: '110101' };

const readAppConfig = (dataDir) => JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
const writeAppConfig = (dataDir, cfg) =>
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');

const waitFor = async (fn, timeout = 3000, step = 100) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(step);
  }
  return fn();
};

// ───────────── 主流程 ─────────────

/** 从 content-disposition 取真实文件名（优先 RFC 5987 filename*） */
const dispositionName = (headers) => {
  const cd = String(headers['content-disposition'] || '');
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="([^"]+)"/i.exec(cd);
  const raw = star ? star[1] : plain ? plain[1] : '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};
/** 2026-11-06 用户指定：My旅迹素材备份-YYYY-MM-DD-（备份勿删）.zip */
const BACKUP_FILENAME_RE = /^My旅迹素材备份-\d{4}-\d{2}-\d{2}-（备份勿删）\.zip$/;

const run = async () => {
  console.log(`\nM4 备份 / 恢复 / 提醒冒烟（F-SYS-03/04/05，隔离实例 :${PORT}）`);
  console.log('─'.repeat(68));

  // 真实库 / 真实素材库签名：跑完必须一模一样
  const realDataDir = join(ROOT, 'data');
  const realDevMedia = join(ROOT, '.dev-media');
  const realSig = {
    db: sigOf(join(realDataDir, 'travel.db')),
    wal: sigOf(join(realDataDir, 'travel.db-wal')),
    shm: sigOf(join(realDataDir, 'travel.db-shm')),
    config: sigOf(join(realDataDir, 'config.json')),
    devMedia: dirSig(realDevMedia),
  };

  const tmp = mkdtempSync(join(ROOT, '.smoke-m4-backup-'));
  const dataDir = join(tmp, 'data');
  const mediaRoot = join(tmp, 'media');
  const thumbDir = join(dataDir, 'thumbs');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });
  mkdirSync(join(tmp, 'variants'), { recursive: true });
  // 两阶段导出任务：模拟上次进程崩溃留下的 export-*/ 目录，服务启动时应清理
  const staleExportDir = join(dataDir, 'tmp', 'export-stale-job-dir');
  mkdirSync(staleExportDir, { recursive: true });
  writeFileSync(join(staleExportDir, 'backup.zip'), Buffer.from('stale-export'));

  let child = null;
  let logFd = null;
  /** 磁盘检查等额外起的短命实例，统一在 finally 里杀掉 */
  const extraChildren = [];
  const logPath = join(tmp, 'server.log');
  const readLogs = () => {
    try {
      return readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };

  const mediaFiles = () => listRelFiles(mediaRoot);
  const backupFiles = () => {
    try {
      return readdirSync(join(dataDir, 'backups')).filter((n) => /^pre-restore-.+\.zip$/i.test(n));
    } catch {
      return [];
    }
  };

  try {
    logFd = openSync(logPath, 'a');
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        STARTER_DATA: '0',
        PORT: String(PORT),
        DATA_DIR: dataDir,
        MEDIA_ROOT: mediaRoot,
        MEDIA_ROOT_DEV: mediaRoot,
        // 测试要覆盖「条目数上限 / 解压大小上限 / token 过期 / 导出任务 TTL / 取消与并发」
        BACKUP_MAX_ENTRIES: '20',
        BACKUP_MAX_UNCOMPRESSED_BYTES: String(2 * 1024 * 1024),
        BACKUP_TOKEN_TTL_MS: String(TOKEN_TTL_MS),
        BACKUP_EXPORT_TTL_MS: String(EXPORT_TTL_MS),
        BACKUP_JOB_DELAY_MS: String(JOB_DELAY_MS),
        // 磁盘检查在独立实例里单独测，主实例跳过以免 CI 磁盘波动导致 flaky
        BACKUP_SKIP_DISK_CHECK: '1',
      },
      // 沙箱不允许 pipe：stdout/stderr 一律重定向到日志文件
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });

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
    if (!health?.ok) throw new Error('服务没起来：\n' + readLogs().slice(-3000));
    check('隔离实例在线且素材库指向临时目录', resolve(health.mediaRoot) === resolve(mediaRoot), health.mediaRoot);
    check('启动时清理上次残留的 export-* 目录', !existsSync(staleExportDir));

    // ═════════════ 1) 空库 status ═════════════
    section('1) 空库 status：不 due / reason=null / threshold=30');
    let st = await getJson('/api/backup/status');
    eq('空库 dataCounts 全 0', st.dataCounts, { places: 0, visits: 0, media: 0 });
    eq('空库 lastBackupAt = null', st.lastBackupAt, null);
    eq('空库 lastBackupAtISO = null', st.lastBackupAtISO, null);
    eq('空库 daysSinceBackup = null', st.daysSinceBackup, null);
    eq('默认 thresholdDays = 30', st.thresholdDays, 30);
    eq('空库 snoozeUntil = null', st.snoozeUntil, null);
    eq('空库不 due', st.due, false);
    eq('空库 reason = null', st.reason, null);
    eq('autoBackupDir = data/backups', resolve(st.autoBackupDir), resolve(dataDir, 'backups'));
    eq('空库 recentAutoBackups = []', st.recentAutoBackups, []);
    eq('空库 mediaFiles = 0', st.mediaFiles, 0);
    eq('空库 mediaBytes = 0', st.mediaBytes, 0);

    // ═════════════ 2) 造数据 ═════════════
    section('2) 造数据：4 地点 / 5 到访 / 7 媒体（含软删、秘密基地、secret）');
    const P1 = await createPlace('备份-西湖', { ...PLA, date: '2020-05-01' });
    const v1 = P1.visits[0].id;
    let d = await patchJson(`/api/visits/${v1}`, { title: '西湖春游', companions: ['小林'] });
    check('P1 到访写入标题/同行人', d.visits.some((v) => v.id === v1 && v.title === '西湖春游'));
    d = await addVisit(P1.id, { date: '2024-01-15', title: '西湖二刷' });
    const v2 = findVisit(d, '2024-01-15').id;

    const P2 = await createPlace('备份-天一阁', { ...NBO, date: '2022-08-08' });
    const v3 = P2.visits[0].id;
    const P3 = await createPlace('备份-故宫', { ...BJ, date: '2024-06-01' });
    const v4 = P3.visits[0].id;
    const P4 = await createPlace('备份-已删地点', { ...PLA, date: '2021-01-01' });
    const v5 = P4.visits[0].id;

    const a1 = await uploadPhoto(v1, 'bk-a1.jpg', [10, 20, 30]);
    const a2 = await uploadPhoto(v1, 'bk-a2.jpg', [40, 50, 60]);
    const vid1 = await uploadVideo(v1, 'bk-vid1.mp4');
    const b1 = await uploadPhoto(v2, 'bk-b1.jpg', [70, 80, 90]);
    const c1 = await uploadPhoto(v3, 'bk-c1.jpg', [11, 22, 33]);
    const d1 = await uploadPhoto(v4, 'bk-d1.jpg', [44, 55, 66]);
    const mE1 = await uploadPhoto(v5, 'bk-e1.jpg', [99, 99, 99]);
    eq('6 张照片上传成功', [a1, a2, b1, c1, d1, mE1].filter(Boolean).length, 6);
    eq('1 个视频上传成功', [vid1].filter(Boolean).length, 1);
    const mediaIds = [a1, a2, vid1, b1, c1, d1, mE1].map(String).sort();

    const secPlace = await patchJson(`/api/places/${P3.id}`, { secret: true });
    eq('P3 设为秘密基地', secPlace.secret, 1);
    await delJson(`/api/media/${a2}`);
    await delJson(`/api/places/${P4.id}`);
    const secSet = await postJson('/api/secret/password', { newPassword: 'm4-pass-1' });
    check('设置秘密基地密码', secSet.ok === true && secSet.configured === true);

    st = await getJson('/api/backup/status');
    eq('有数据后 dataCounts = 3/4/5（alive）', st.dataCounts, { places: 3, visits: 4, media: 5 });
    eq('status.mediaFiles = 7（含软删的全部 media 行）', st.mediaFiles, 7);
    check('status.mediaBytes > 0（素材体积预估）', st.mediaBytes > 0, `${st.mediaBytes} B`);
    eq('从未备份 → due = true', st.due, true);
    eq('从未备份 → reason = never', st.reason, 'never');
    eq('从未备份 → lastBackupAt 仍是 null', st.lastBackupAt, null);
    eq('从未备份 → daysSinceBackup = null', st.daysSinceBackup, null);
    const secretStatus = await getJson('/api/secret/status');
    eq('secret 已配置 + 1 个秘密基地', { configured: secretStatus.configured, places: secretStatus.places }, {
      configured: true,
      places: 1,
    });
    eq('媒体库原片文件数 = 7', mediaFiles().length, 7);
    const thumbsAfterUpload = countFiles(thumbDir);
    check('缩略图缓存已生成（6 张照片）', thumbsAfterUpload >= 6, `实际=${thumbsAfterUpload}`);

    // ═════════════ 3) 导出（不含缩略图）═════════════
    section('3) 导出备份 E1（不含缩略图）：zip 结构 / manifest / 校验和 / lastBackupAt');
    const e1 = await postExport(false);
    eq('导出 HTTP 200', e1.status, 200);
    eq('content-type = application/zip', String(e1.headers['content-type']).split(';')[0], 'application/zip');
    check(
      'content-disposition 文件名格式正确',
      BACKUP_FILENAME_RE.test(dispositionName(e1.headers)),
      String(e1.headers['content-disposition'])
    );
    eq('content-length 与实际字节一致', Number(e1.headers['content-length']), e1.buf.length);
    check('导出内容非空', e1.buf.length > 0, `${e1.buf.length} 字节`);

    const e1map = await readZipBuffer(e1.buf);
    const requiredNames = ['README.txt', 'data/config.json', 'data/travel.db', 'manifest.json', 'media-manifest.json'];
    eq('E1 条目 = 固定 5 个', [...e1map.keys()].sort(), requiredNames);
    const allNamesSafe = [...e1map.keys()].every(
      (n) => !n.split('/').includes('..') && !n.startsWith('/') && !/^[A-Za-z]:/.test(n) && !n.includes('\\')
    );
    check('E1 无路径穿越条目', allNamesSafe);
    const e1Manifest = getJsonEntry(e1map, 'manifest.json');
    eq('manifest.format', e1Manifest.format, 'travelmaps-backup');
    eq('manifest.formatVersion', e1Manifest.formatVersion, 2);
    eq('manifest.appVersion', e1Manifest.appVersion, APP_VERSION);
    check('manifest.createdAt 是数字', Number.isFinite(e1Manifest.createdAt) && e1Manifest.createdAt > 0);
    eq('manifest.createdAtISO 与 createdAt 一致', e1Manifest.createdAtISO, new Date(e1Manifest.createdAt).toISOString());
    eq('manifest.source.mediaRoot = 当前素材库', resolve(e1Manifest.source.mediaRoot), resolve(mediaRoot));
    eq('manifest.mediaManifest', e1Manifest.mediaManifest, 'media-manifest.json');
    eq('manifest.counts（含软删总行数）', e1Manifest.counts, { place: 4, visit: 5, media: 7 });
    eq('manifest.aliveCounts（存活行数）', e1Manifest.aliveCounts, { place: 3, visit: 4, media: 5 });
    eq('manifest.includes.thumbs', e1Manifest.includes.thumbs, false);
    eq('manifest.includes.thumbsCount', e1Manifest.includes.thumbsCount, 0);
    eq('manifest.includes.media = false（快速备份不带素材）', e1Manifest.includes.media, false);
    eq('manifest.includes.mediaCount = 0', e1Manifest.includes.mediaCount, 0);
    eq('manifest.includes.mediaBytes = 0', e1Manifest.includes.mediaBytes, 0);
    eq('manifest.includes.mediaMissingAtExport = 0', e1Manifest.includes.mediaMissingAtExport, 0);
    check('E1 不含 media/ 条目', ![...e1map.keys()].some((n) => n.startsWith('media/')));
    eq('data/travel.db sha256 正确', e1Manifest.checksums['data/travel.db'], sha256(e1map.get('data/travel.db')));
    eq('data/config.json sha256 正确', e1Manifest.checksums['data/config.json'], sha256(e1map.get('data/config.json')));
    check('manifest 有 README 说明 A/B', /A 原件/.test(e1map.get('README.txt').toString('utf8')) && /B 素材库/.test(e1map.get('README.txt').toString('utf8')));
    check('README 有恢复步骤 / 秘密基地说明', /恢复步骤/.test(e1map.get('README.txt').toString('utf8')) && /秘密基地/.test(e1map.get('README.txt').toString('utf8')));
    check('README 提到 zip 里只有你手动放（A 未包含）', /从来没有被读取/.test(e1map.get('README.txt').toString('utf8')));

    const e1MediaManifest = getJsonEntry(e1map, 'media-manifest.json');
    eq('media-manifest.total = 7', e1MediaManifest.total, 7);
    eq('media-manifest.items 长度 = 7', e1MediaManifest.items.length, 7);
    eq(
      'media-manifest id 集合 = 数据库 media id 集合',
      e1MediaManifest.items.map((m) => String(m.id)).sort(),
      mediaIds
    );
    const sampleItem = e1MediaManifest.items.find((m) => String(m.id) === String(b1));
    check(
      'media-manifest 条目字段完整',
      sampleItem &&
        typeof sampleItem.visit_id === 'string' &&
        sampleItem.kind === 'photo' &&
        typeof sampleItem.rel_path === 'string' &&
        !sampleItem.rel_path.split('/').includes('..'),
      JSON.stringify(sampleItem)
    );
    check(
      'media-manifest rel_path 全部相对安全',
      e1MediaManifest.items.every((m) => {
        const rel = String(m.rel_path ?? '');
        const segs = rel.split(/[\\/]/);
        return rel.length > 0 && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !segs.includes('..');
      })
    );
    const dbMediaBytesSum = e1MediaManifest.items.reduce((n, m) => n + (Number(m.bytes) || 0), 0);

    const e1Config = getJsonEntry(e1map, 'data/config.json');
    check('备份 config.json 含 secret 哈希', Boolean(e1Config.secret?.salt && e1Config.secret?.hash));
    eq('备份 config.json secret.algo = scrypt', e1Config.secret?.algo, 'scrypt');
    check('备份 config.json 不含明文密码', !e1map.get('data/config.json').toString('utf8').includes('m4-pass-1'));

    st = await getJson('/api/backup/status');
    check('导出成功后写 lastBackupAt', Number.isFinite(st.lastBackupAt) && st.lastBackupAt > 0, String(st.lastBackupAt));
    eq('导出后 daysSinceBackup = 0', st.daysSinceBackup, 0);
    eq('导出后 due = false', st.due, false);
    eq('导出后 reason = null', st.reason, null);
    eq('导出后 snoozeUntil = null', st.snoozeUntil, null);
    eq('status.mediaBytes = 全部 media 行 bytes 之和', st.mediaBytes, dbMediaBytesSum);
    eq('status.mediaFiles = 7 行（含软删）', st.mediaFiles, 7);
    const cfgAfterExport = readAppConfig(dataDir);
    eq('data/config.json 的 lastBackupAt 与 status 一致', cfgAfterExport.lastBackupAt, st.lastBackupAt);
    eq('导出后 lastBackupSnoozeUntil 清空', cfgAfterExport.lastBackupSnoozeUntil ?? null, null);
    check('导出临时文件已清理', await waitFor(() => !readdirSync(join(dataDir, 'tmp')).some((n) => n.startsWith('export-'))), '');

    // ═════════════ 4) 导出（含缩略图）═════════════
    section('4) 导出备份 E2（含缩略图）：includes.thumbs / thumbs 条目');
    const e2 = await postExport(true);
    eq('含缩略图导出 HTTP 200', e2.status, 200);
    const e2map = await readZipBuffer(e2.buf);
    const e2Manifest = getJsonEntry(e2map, 'manifest.json');
    eq('E2 manifest.includes.thumbs = true', e2Manifest.includes.thumbs, true);
    const thumbEntryNames = [...e2map.keys()].filter((n) => n.startsWith('thumbs/'));
    eq('E2 thumbsCount = 缩略图文件数', e2Manifest.includes.thumbsCount, thumbEntryNames.length);
    eq('E2 thumbsCount = 6', e2Manifest.includes.thumbsCount, 6);
    eq('E2 formatVersion = 2', e2Manifest.formatVersion, 2);
    eq('E2 includes.media = false', e2Manifest.includes.media, false);
    check('E2 不含 media/ 条目', ![...e2map.keys()].some((n) => n.startsWith('media/')));
    check(
      'E2 thumbs 条目只有一层（basename）',
      thumbEntryNames.every((n) => {
        const base = n.slice('thumbs/'.length);
        return base && !base.includes('/') && !base.includes('\\') && base !== '.' && base !== '..';
      })
    );
    check('E2 条目集合 = 固定 5 个 + thumbs', e2map.size === 5 + thumbEntryNames.length, `${e2map.size} 个`);
    eq('E2 manifest.counts 与 E1 相同', e2Manifest.counts, e1Manifest.counts);
    const stAfterE2 = await getJson('/api/backup/status');
    check('第二次导出刷新 lastBackupAt', stAfterE2.lastBackupAt >= st.lastBackupAt, `${stAfterE2.lastBackupAt} >= ${st.lastBackupAt}`);

    // ═════════════ 5) inspect 正常摘要 ═════════════
    section('5) inspect E1：摘要字段 / mediaMissing=0 / thumbsMissing=0');
    const ins1 = await inspectZip(e1.buf);
    check('inspect 返回 token', typeof ins1.token === 'string' && ins1.token.length > 0);
    check('inspect 返回 expiresAt', Number.isFinite(ins1.expiresAt) && ins1.expiresAt > Date.now());
    const ttlLeft = ins1.expiresAt - Date.now();
    check('token TTL 在 10 分钟量级（测试里 5 秒）', ttlLeft > 0 && ttlLeft <= TOKEN_TTL_MS + 1000, `剩余 ${ttlLeft}ms`);
    const s1 = ins1.summary;
    eq('summary.formatVersion', s1.formatVersion, 2);
    eq('summary.appVersion', s1.appVersion, APP_VERSION);
    eq('summary.zipBytes = 上传字节数', s1.zipBytes, e1.buf.length);
    eq('summary.includeThumbs = false', s1.includeThumbs, false);
    eq('summary.thumbsCount = 0', s1.thumbsCount, 0);
    eq('summary.includeMedia = false', s1.includeMedia, false);
    eq('summary.mediaCount = 0', s1.mediaCount, 0);
    eq('summary.mediaBytes = 0', s1.mediaBytes, 0);
    eq('summary.mediaMissingAtExport = 0', s1.mediaMissingAtExport, 0);
    eq('summary.counts', s1.counts, { place: 4, visit: 5, media: 7 });
    eq('summary.aliveCounts', s1.aliveCounts, { place: 3, visit: 4, media: 5 });
    eq('summary.createdAt 与 manifest 一致', s1.createdAt, e1Manifest.createdAt);
    eq('summary.createdAtISO 与 manifest 一致', s1.createdAtISO, e1Manifest.createdAtISO);
    eq('summary.secretConfigured = true', s1.secretConfigured, true);
    eq('summary.mediaMissing = 0（原片都在）', s1.mediaMissing, 0);
    eq('summary.thumbsMissing = 0（缩略图缓存都在）', s1.thumbsMissing, 0);
    check('summary.warnings 是非空字符串数组', Array.isArray(s1.warnings) && s1.warnings.length > 0 && s1.warnings.every((w) => typeof w === 'string'));
    check('warnings 提示不含缩略图', s1.warnings.some((w) => w.includes('不含缩略图')));
    check('warnings 提示 secret 会覆盖密码', s1.warnings.some((w) => w.includes('秘密基地密码')));

    section('6) inspect E2：含缩略图摘要');
    const s2 = (await inspectZip(e2.buf)).summary;
    eq('E2 includeThumbs = true', s2.includeThumbs, true);
    eq('E2 thumbsCount = 6', s2.thumbsCount, 6);
    eq('E2 includeMedia = false', s2.includeMedia, false);
    eq('E2 counts 一致', s2.counts, s1.counts);
    eq('E2 mediaMissing = 0', s2.mediaMissing, 0);
    check('E2 warnings 提示包含缩略图', s2.warnings.some((w) => w.includes('缩略图')));

    // ═════════════ 7) inspect mediaMissing ═════════════
    section('7) inspect mediaMissing：素材库原片不在时统计缺失数');
    // 沙箱里不能 rename 目录，改为把文件内容读进内存 → 删掉 → inspect → 原样写回
    const mediaSnapshot = new Map();
    for (const rel of mediaFiles()) mediaSnapshot.set(rel, readFileSync(join(mediaRoot, rel)));
    eq('临时素材库快照 7 个文件', mediaSnapshot.size, 7);
    for (const rel of mediaSnapshot.keys()) unlinkSync(join(mediaRoot, rel));
    const sMissing = (await inspectZip(e1.buf)).summary;
    eq('素材库原片全缺时 mediaMissing = 7（全部原片）', sMissing.mediaMissing, 7);
    check('warnings 提示原片缺失', sMissing.warnings.some((w) => w.includes('原片')));
    for (const [rel, buf] of mediaSnapshot) {
      const p = join(mediaRoot, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, buf);
    }
    eq('素材库恢复后文件数仍是 7', mediaFiles().length, 7);
    eq('素材库恢复后 mediaMissing = 0', (await inspectZip(e1.buf)).summary.mediaMissing, 0);

    // ═════════════ 8) inspect 非法包 → 400 ═════════════
    section('8) inspect 非法备份包全部 400（结构 / 穿越 / 炸弹 / 篡改 / 不一致 / 损坏 / 版本）');
    const variant = async (mutate) => {
      const map = new Map(e1map);
      await mutate(map);
      return zipFromMap(map);
    };

    await expect400('不是 zip 文件', () => inspectZip(Buffer.from('definitely not a zip file')));
    await expect400('zip 被截断', () => inspectZip(e1.buf.subarray(0, 500)));
    await expect400('缺少 manifest.json', async () => inspectZip(await variant((m) => m.delete('manifest.json'))));
    await expect400('缺少 media-manifest.json', async () =>
      inspectZip(await variant((m) => m.delete('media-manifest.json')))
    );
    await expect400('缺少 data/travel.db', async () => inspectZip(await variant((m) => m.delete('data/travel.db'))));
    await expect400('包含未知文件', async () =>
      inspectZip(await variant((m) => m.set('notes.txt', Buffer.from('x'))))
    );
    await expect400(
      '不支持的 format',
      async () => {
        const m = getJsonEntry(e1map, 'manifest.json');
        m.format = 'other-backup';
        return inspectZip(await variant((map) => setJsonEntry(map, 'manifest.json', m)));
      },
      '不是 TravelMaps 备份包'
    );
    await expect400(
      'formatVersion = 3（来自更新版本）',
      async () => {
        const m = getJsonEntry(e1map, 'manifest.json');
        m.formatVersion = 3;
        return inspectZip(await variant((map) => setJsonEntry(map, 'manifest.json', m)));
      },
      '更新版本'
    );
    await expect400(
      'manifest.counts 与数据库行数不一致',
      async () => {
        const m = getJsonEntry(e1map, 'manifest.json');
        m.counts.place += 1;
        return inspectZip(await variant((map) => setJsonEntry(map, 'manifest.json', m)));
      },
      '行数'
    );
    await expect400(
      'manifest.aliveCounts 与数据库不一致',
      async () => {
        const m = getJsonEntry(e1map, 'manifest.json');
        m.aliveCounts.media += 1;
        return inspectZip(await variant((map) => setJsonEntry(map, 'manifest.json', m)));
      },
      '存活行数'
    );
    await expect400(
      'data/travel.db 校验和被篡改',
      async () =>
        inspectZip(
          await variant((m) =>
            m.set('data/travel.db', Buffer.concat([m.get('data/travel.db'), Buffer.from('tamper')]))
          )
        ),
      'sha256'
    );
    await expect400('data/config.json 校验和被篡改', async () =>
      inspectZip(
        await variant((m) =>
          m.set('data/config.json', Buffer.concat([m.get('data/config.json'), Buffer.from(' ')]))
        )
      )
    );
    await expect400(
      'media-manifest id 集合与数据库不一致',
      async () => {
        const mm = getJsonEntry(e1map, 'media-manifest.json');
        mm.items.pop();
        mm.total -= 1;
        return inspectZip(await variant((map) => setJsonEntry(map, 'media-manifest.json', mm)));
      },
      '媒体清单'
    );
    await expect400('数据库损坏（sha256 同但 SQLite 打不开）', async () => {
      const badDb = randomBytes(8192);
      const m = getJsonEntry(e1map, 'manifest.json');
      m.checksums['data/travel.db'] = sha256(badDb);
      return inspectZip(
        await variant((map) => {
          setJsonEntry(map, 'manifest.json', m);
          map.set('data/travel.db', badDb);
        })
      );
    });
    await expect400(
      '条目数超过上限（测试上限 20）',
      async () => {
        const map = new Map(e1map);
        for (let i = 0; i < 20; i++) map.set(`thumbs/dummy-${String(i).padStart(2, '0')}.webp`, Buffer.from('x'));
        return inspectZip(await zipFromMap(map));
      },
      '条目'
    );
    await expect400(
      '解压后总大小超过上限（zip bomb，测试上限 2MB）',
      async () => {
        const map = new Map(e1map);
        map.set('thumbs/bomb.webp', Buffer.alloc(3 * 1024 * 1024, 0));
        return inspectZip(await zipFromMap(map));
      },
      '上限'
    );
    await expect400('路径穿越 ../（篡改条目名）', () => {
      const { buf, count } = replaceAscii(e1.buf, 'README.txt', '../evil.tx');
      check('篡改 README 条目名成功（2 处）', count === 2, `实际 ${count} 处`);
      return inspectZip(buf);
    });
    await expect400('绝对路径盘符 C:/', () => inspectZip(replaceAscii(e1.buf, 'README.txt', 'C:/evil.tx').buf));
    await expect400('反斜杠 ..\\', () => inspectZip(replaceAscii(e1.buf, 'README.txt', '..\\evil.tx').buf));
    await expect400('multipart 字段名不是 file', async () => {
      const fd = new FormData();
      fd.append('files', new Blob([e1.buf], { type: 'application/zip' }), 'backup.zip');
      return fetch(`${BASE}/api/backup/inspect`, { method: 'POST', body: fd }).then(j);
    }, 'file');
    await expect400('inspect 无文件上传', () =>
      fetch(`${BASE}/api/backup/inspect`, { method: 'POST', body: new FormData() }).then(j)
    );
    await expect400('inspect 非 multipart 请求', () =>
      fetch(`${BASE}/api/backup/inspect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).then(j)
    );

    // ═════════════ 9) 改数据 → 从 E1 恢复 ═════════════
    section('9) 改数据后从 E1 恢复：事务替换 / 软删回来 / secret 恢复 / B 不动');
    const P5 = await createPlace('备份-导出后新增', { ...PLA, date: '2025-07-01' });
    await delJson(`/api/places/${P2.id}`);
    await postJson('/api/secret/password', { oldPassword: 'm4-pass-1', newPassword: 'm4-pass-2' });
    await expectStatus('用新密码验证', 200, () => postJson('/api/secret/verify', { password: 'm4-pass-2' }));
    st = await getJson('/api/backup/status');
    eq('改数据后 dataCounts = 3/4/4', st.dataCounts, { places: 3, visits: 4, media: 4 });
    eq('改数据后回收站 = 2 个地点 + 1 个媒体', await getJson('/api/trash/count'), {
      total: 3,
      places: 2,
      visits: 0,
      media: 1,
    });
    const beforeRestoreStatus = await getJson('/api/backup/status');
    const beforeRestoreSnooze = await postJson('/api/backup/snooze', { days: 2 });
    const beforeRestoreThreshold = await postJson('/api/backup/settings', { reminderDays: 7 });
    eq('恢复前 threshold = 7', beforeRestoreThreshold.thresholdDays, 7);
    // 在 config.json 里写一个「本机路径」，恢复后必须保留（不能被备份里的 mediaRoot 覆盖）
    const keepMediaRoot = 'D:\\fake-media-root-keep';
    const cfgBeforeRestore = readAppConfig(dataDir);
    cfgBeforeRestore.mediaRoot = keepMediaRoot;
    writeAppConfig(dataDir, cfgBeforeRestore);
    const beforeRestoreFiles = mediaFiles();
    const beforeRestoreThumbs = countFiles(thumbDir);
    const beforeRestoreRoot = (await getJson('/api/library')).root;
    eq('恢复前 B 文件数 = 7', beforeRestoreFiles.length, 7);

    const insR1 = await inspectZip(e1.buf);
    const r1 = await restoreWith(insR1.token);
    eq('恢复 HTTP 200 且 ok', r1.ok, true);
    eq('恢复行数 = 备份清单（4/5/7）', r1.restored, { places: 4, visits: 5, media: 7 });
    eq('不含素材的恢复 media 计数全 0', r1.media, {
      packaged: 0,
      written: 0,
      skipped: 0,
      failed: 0,
    });
    eq('不含素材的恢复 orphans = 0（B 里文件都被引用）', r1.orphans, 0);
    check('返回自动备份文件名', /^pre-restore-\d{8}-\d{6}(-\d+)?\.zip$/.test(r1.autoBackup.name), r1.autoBackup.name);
    const autoPath = join(dataDir, 'backups', r1.autoBackup.name);
    check('自动备份文件存在且字节数一致', existsSync(autoPath) && statSync(autoPath).size === r1.autoBackup.bytes);
    check('自动备份字节数 > 0', r1.autoBackup.bytes > 0);
    eq('恢复后 missingMedia = 0', r1.missingMedia, 0);
    eq('恢复后 missingThumbs = 0', r1.missingThumbs, 0);
    check('恢复 warnings 是非空数组', Array.isArray(r1.warnings) && r1.warnings.length > 0);
    await expect400('token 用后即失效', () => restoreWith(insR1.token));

    const autoInspect = await inspectZip(readFileSync(autoPath));
    eq('自动备份可再次 inspect', autoInspect.summary.counts, { place: 5, visit: 6, media: 7 });
    eq('自动备份含缩略图（恢复前自动备份 = 元数据+缩略图）', autoInspect.summary.includeThumbs, true);
    eq('自动备份不含素材', autoInspect.summary.includeMedia, false);
    eq('自动备份素材库缺失 = 0（B 文件都在）', autoInspect.summary.mediaMissing, 0);

    const placesAfter = await getJson('/api/places');
    eq('恢复后存活地点数 = 3', placesAfter.length, 3);
    eq(
      '恢复后地点 = P1/P2/P3（P5 消失、P2 回来）',
      placesAfter.map((p) => p.name).sort(),
      ['备份-天一阁', '备份-西湖', '备份-故宫'].sort()
    );
    await expectStatus('导出后新增的 P5 已消失', 404, () => getJson(`/api/places/${P5.id}`));
    const p2After = await getJson(`/api/places/${P2.id}`);
    eq('被软删的 P2 恢复后回来了', { name: p2After.name, visits: p2After.visits.length }, {
      name: '备份-天一阁',
      visits: 1,
    });
    eq('回收站回到备份时的状态（P4 + 单独删的 a2）', await getJson('/api/trash/count'), {
      total: 2,
      places: 1,
      visits: 0,
      media: 1,
    });
    const tl = await getJson('/api/timeline');
    eq('时间轴首末日期恢复正确', { first: tl.first, last: tl.last }, {
      first: '2020-05-01',
      last: '2024-06-01',
    });
    eq('统计恢复到备份时（3 地点 / 4 到访 / 4 照片 / 1 视频）', (await getJson('/api/stats')).totals, {
      provinces: 2,
      cities: 3,
      places: 3,
      visits: 4,
      photos: 4,
      videos: 1,
    });
    const photosAfter = await getJson('/api/photos');
    eq('照片墙 alive 媒体 = 5', photosAfter.total, 5);
    const libAfter = await getJson('/api/library');
    eq('媒体库 total = 5 / deleted = 2', { total: libAfter.total, deleted: libAfter.deleted }, {
      total: 5,
      deleted: 2,
    });

    await expectStatus('恢复后旧密码可用', 200, () => postJson('/api/secret/verify', { password: 'm4-pass-1' }));
    await expectStatus('恢复后新密码失效', 403, () => postJson('/api/secret/verify', { password: 'm4-pass-2' }));
    const secAfterRestore = await getJson('/api/secret/status');
    eq('恢复后 secret 仍配置', secAfterRestore.configured, true);

    const afterRestoreStatus = await getJson('/api/backup/status');
    eq('恢复不回退 lastBackupAt', afterRestoreStatus.lastBackupAt, beforeRestoreStatus.lastBackupAt);
    eq('恢复不回退 snoozeUntil', afterRestoreStatus.snoozeUntil, beforeRestoreSnooze.snoozeUntil);
    eq('恢复不回退 thresholdDays', afterRestoreStatus.thresholdDays, 7);
    eq('恢复不回退素材库路径', (await getJson('/api/library')).root, beforeRestoreRoot);
    const cfgAfterRestore = readAppConfig(dataDir);
    eq('config.json 本机 mediaRoot 保留（不被备份回退）', cfgAfterRestore.mediaRoot, keepMediaRoot);
    eq('config.json lastBackupAt 保留', cfgAfterRestore.lastBackupAt, beforeRestoreStatus.lastBackupAt);
    eq('B 素材库文件清单未变（不删不增不移动）', mediaFiles(), beforeRestoreFiles);
    eq('缩略图文件数未变（E1 不含缩略图）', countFiles(thumbDir), beforeRestoreThumbs);
    // data/tmp 里只允许存在「检查令牌」还活着的 inspect-*.zip（TTL 到期自动清），
    // 导出临时文件 / VACUUM 快照必须在请求内清理干净
    eq(
      'data/tmp 无导出临时文件 / 数据库快照残留',
      readdirSync(join(dataDir, 'tmp')).filter((n) => n.startsWith('export-') || n.startsWith('snapshot-')),
      []
    );

    // ═════════════ 10) 自动备份保留 5 份 ═════════════
    section('10) 恢复前自动备份保留最近 5 份');
    const backupsDir = join(dataDir, 'backups');
    const fakeNames = Array.from({ length: 6 }, (_, i) => `pre-restore-20200101-00000${i + 1}.zip`);
    for (const n of fakeNames) writeFileSync(join(backupsDir, n), Buffer.from('fake'));
    eq('伪造历史自动备份后共 7 份', backupFiles().length, 7);
    const r2 = await restoreWith((await inspectZip(e1.buf)).token);
    eq('第二次恢复成功', r2.ok, true);
    eq('自动备份只保留 5 份', backupFiles().length, 5);
    check('最旧的伪造备份被删', !existsSync(join(backupsDir, fakeNames[0])));
    check('较新的伪造备份被保留', existsSync(join(backupsDir, fakeNames[5])));
    check('真实自动备份仍在', existsSync(join(backupsDir, r1.autoBackup.name)));

    // ═════════════ 11) 含缩略图恢复 ═════════════
    section('11) 恢复含缩略图的 E2：thumbs 写回缩略图目录');
    rmSync(thumbDir, { recursive: true, force: true });
    mkdirSync(thumbDir, { recursive: true });
    eq('先清空缩略图缓存', countFiles(thumbDir), 0);
    const insE2 = await inspectZip(e2.buf);
    eq('缩略图全缺时 inspect thumbsMissing = 6', insE2.summary.thumbsMissing, 6);
    const filesBeforeThumbRestore = mediaFiles();
    const r3 = await restoreWith(insE2.token);
    eq('E2 恢复成功', r3.ok, true);
    eq('E2 恢复行数 4/5/7', r3.restored, { places: 4, visits: 5, media: 7 });
    eq('恢复后缩略图缓存 = 6', countFiles(thumbDir), 6);
    eq('恢复后 missingThumbs = 0', r3.missingThumbs, 0);
    eq('恢复后 missingMedia = 0', r3.missingMedia, 0);
    eq('含缩略图恢复不动 B 素材库', mediaFiles(), filesBeforeThumbRestore);
    const autoAfterThumb = r3.autoBackup.name;

    // ═════════════ 12) 恢复失败回滚 ═════════════
    section('12) 恢复失败必须回滚：FK 违规 / 备份来自更新版本');
    const beforeBadStatus = await getJson('/api/backup/status');
    const beforeBadTrash = await getJson('/api/trash/count');
    const beforeBadFiles = mediaFiles();
    const beforeBadThumbs = countFiles(thumbDir);

    // 12.1 构造一个「检查能过、插入会违反外键」的备份：media 指向不存在的 visit
    const workVariants = join(tmp, 'variants');
    let variantSeq = 0;
    const mutateDb = async (dbBuf, fn) => {
      const p = join(workVariants, `db-${++variantSeq}.db`);
      writeFileSync(p, dbBuf);
      const h = new DatabaseSync(p);
      try {
        h.exec('PRAGMA foreign_keys = OFF');
        fn(h);
      } finally {
        h.close();
      }
      const out = readFileSync(p);
      unlinkSync(p);
      return out;
    };
    const buildFromBase = async ({ dbBuf, manifest: manifestFn, mediaManifest: mmFn }) => {
      const map = new Map(e1map);
      if (dbBuf) map.set('data/travel.db', dbBuf);
      const m = manifestFn ? manifestFn(getJsonEntry(map, 'manifest.json'), dbBuf) : getJsonEntry(map, 'manifest.json');
      setJsonEntry(map, 'manifest.json', m);
      if (mmFn) setJsonEntry(map, 'media-manifest.json', mmFn(getJsonEntry(map, 'media-manifest.json'), dbBuf));
      return zipFromMap(map);
    };

    const orphanId = 'orphan-media-0001';
    const fkDb = await mutateDb(e1map.get('data/travel.db'), (h) => {
      h.prepare(
        'INSERT INTO media (id, visit_id, kind, rel_path, created_at) VALUES (?,?,?,?,?)'
      ).run(orphanId, 'no-such-visit-id', 'photo', 'orphan/fk.jpg', Date.now());
    });
    const fkZip = await buildFromBase({
      dbBuf: fkDb,
      manifest: (m) => {
        m.counts.media += 1;
        m.aliveCounts.media += 1;
        m.checksums['data/travel.db'] = sha256(fkDb);
        return m;
      },
      mediaManifest: (mm) => {
        mm.total += 1;
        mm.items.push({
          id: orphanId,
          visit_id: 'no-such-visit-id',
          kind: 'photo',
          rel_path: 'orphan/fk.jpg',
          hash: null,
          bytes: null,
          thumb: null,
          poster: null,
        });
        return mm;
      },
    });
    const fkInspect = await inspectZip(fkZip);
    eq('FK 违规包能通过 inspect（完整性检查不查外键）', fkInspect.summary.counts.media, 8);
    await expectStatus('FK 违规恢复 → 500', 500, () => restoreWith(fkInspect.token));
    let fkErr = null;
    try {
      await restoreWith(fkInspect.token);
    } catch (e) {
      fkErr = e;
    }
    check('FK 违规返回 rolledBack=true', fkErr?.body?.rolledBack === true, JSON.stringify(fkErr?.body));
    eq('FK 违规后 dataCounts 未变', (await getJson('/api/backup/status')).dataCounts, beforeBadStatus.dataCounts);
    eq('FK 违规后回收站未变', await getJson('/api/trash/count'), beforeBadTrash);
    eq('FK 违规后 B 文件未变', mediaFiles(), beforeBadFiles);
    eq('FK 违规后缩略图未变', countFiles(thumbDir), beforeBadThumbs);

    // 12.2 备份数据库有当前没有的列 → 「备份来自更新版本」→ 500 回滚
    const newerDb = await mutateDb(e1map.get('data/travel.db'), (h) => {
      h.exec('ALTER TABLE place ADD COLUMN future_flag INTEGER');
    });
    const newerZip = await buildFromBase({
      dbBuf: newerDb,
      manifest: (m) => {
        m.checksums['data/travel.db'] = sha256(newerDb);
        return m;
      },
    });
    const newerInspect = await inspectZip(newerZip);
    check('新增列的包能通过 inspect', newerInspect.summary.formatVersion === 2);
    await expectStatus('备份来自更新版本 → 500', 500, () => restoreWith(newerInspect.token));
    let newerErr = null;
    try {
      await restoreWith(newerInspect.token);
    } catch (e) {
      newerErr = e;
    }
    check('更新版本错误文案清晰', String(newerErr?.message || '').includes('更新版本'), String(newerErr?.message || '').slice(0, 160));
    check('更新版本返回 rolledBack=true', newerErr?.body?.rolledBack === true);
    eq('更新版本失败后 dataCounts 未变', (await getJson('/api/backup/status')).dataCounts, beforeBadStatus.dataCounts);
    eq('更新版本失败后 B 文件未变', mediaFiles(), beforeBadFiles);

    // ═════════════ 13) token 校验 ═════════════
    section('13) restore 的 token 校验：无效 / 未确认 / 过期');
    await expect400('无效 token', () => restoreWith('not-a-real-token'));
    await expect400('恢复不带 confirm', async () => restoreWith((await inspectZip(e1.buf)).token, false));
    const insExp = await inspectZip(e1.buf);
    await sleep(TOKEN_TTL_MS + 800);
    await expect400('过期 token', () => restoreWith(insExp.token), '令牌');
    eq('过期 token 不会改数据', (await getJson('/api/backup/status')).dataCounts, beforeBadStatus.dataCounts);

    // ═════════════ 14) 提醒 / 稍后 / 阈值 ═════════════
    section('14) status / snooze / settings：逾期、稍后 24h、阈值白名单');
    let cfg = readAppConfig(dataDir);
    // 多留 60 秒缓冲：避免「恰好 40 天整」在进程间时钟/网络延迟下 floor 成 39 的边界抖动
    cfg.lastBackupAt = Date.now() - 40 * DAY - 60_000;
    cfg.lastBackupSnoozeUntil = null;
    cfg.backupReminderDays = 30;
    writeAppConfig(dataDir, cfg);
    st = await getJson('/api/backup/status');
    eq('40 天前备份 → daysSinceBackup = 40', st.daysSinceBackup, 40);
    eq('超过 30 天阈值 → due = true', st.due, true);
    eq('逾期 reason = overdue', st.reason, 'overdue');
    eq('thresholdDays = 30', st.thresholdDays, 30);

    const nowBeforeSnooze = Date.now();
    const sn1 = await postJson('/api/backup/snooze', {});
    eq('snooze 后 due = false', sn1.due, false);
    eq('snooze 后 reason = null', sn1.reason, null);
    const snoozeDelta1 = sn1.snoozeUntil - nowBeforeSnooze;
    check('默认稍后 1 天', snoozeDelta1 >= DAY - 5000 && snoozeDelta1 <= DAY + 5000, `${Math.round(snoozeDelta1 / DAY * 24)} 小时`);
    eq('snooze 不清 lastBackupAt', sn1.lastBackupAt, cfg.lastBackupAt);

    const nowBefore0 = Date.now();
    const sn0 = await postJson('/api/backup/snooze', { days: 0 });
    const snoozeDelta0 = sn0.snoozeUntil - nowBefore0;
    check('snooze days=0 clamp 到 1 天', snoozeDelta0 >= DAY - 5000 && snoozeDelta0 <= DAY + 5000, `${Math.round(snoozeDelta0 / DAY * 24)} 小时`);

    const nowBefore99 = Date.now();
    const sn99 = await postJson('/api/backup/snooze', { days: 99 });
    const snoozeDelta99 = sn99.snoozeUntil - nowBefore99;
    check('snooze days=99 clamp 到 30 天', snoozeDelta99 >= 30 * DAY - 5000 && snoozeDelta99 <= 30 * DAY + 5000, `${Math.round(snoozeDelta99 / DAY)} 天`);
    await expect400('snooze days 非数字', () => postJson('/api/backup/snooze', { days: 'abc' }));

    cfg = readAppConfig(dataDir);
    cfg.lastBackupSnoozeUntil = null;
    writeAppConfig(dataDir, cfg);
    eq('清掉 snooze 后重新 due', (await getJson('/api/backup/status')).due, true);

    const set90 = await postJson('/api/backup/settings', { reminderDays: 90 });
    eq('阈值改 90 → thresholdDays = 90', set90.thresholdDays, 90);
    eq('阈值 90 时 40 天不算逾期', set90.due, false);
    eq('改阈值不动 lastBackupAt', set90.lastBackupAt, cfg.lastBackupAt);
    const set7 = await postJson('/api/backup/settings', { reminderDays: 7 });
    eq('阈值改 7 → due = true', set7.due, true);
    eq('阈值 7 时 reason = overdue', set7.reason, 'overdue');
    eq('settings 写回 config.json', readAppConfig(dataDir).backupReminderDays, 7);
    await expect400('不支持的阈值 45', () => postJson('/api/backup/settings', { reminderDays: 45 }));
    await expect400('缺少 reminderDays', () => postJson('/api/backup/settings', {}));
    await expect400('reminderDays 字符串', () => postJson('/api/backup/settings', { reminderDays: '30' }));

    st = await getJson('/api/backup/status');
    eq('recentAutoBackups 保留 5 份', st.recentAutoBackups.length, 5);
    check(
      'recentAutoBackups 结构完整（name/bytes/createdAt）',
      st.recentAutoBackups.every(
        (b) => typeof b.name === 'string' && b.name.endsWith('.zip') && b.bytes > 0 && Number.isFinite(b.createdAt)
      )
    );
    check(
      'recentAutoBackups 按时间倒序',
      st.recentAutoBackups.every((b, i, arr) => i === 0 || arr[i - 1].createdAt >= b.createdAt)
    );
    check(
      'recentAutoBackups 名字都是 pre-restore-*',
      st.recentAutoBackups.every((b) => /^pre-restore-.+\.zip$/.test(b.name))
    );
    check('自动备份现在含刚才 E2 恢复生成的那份', st.recentAutoBackups.some((b) => b.name === autoAfterThumb));

    cfg = readAppConfig(dataDir);
    delete cfg.lastBackupAt;
    writeAppConfig(dataDir, cfg);
    st = await getJson('/api/backup/status');
    eq('删掉 lastBackupAt 后 lastBackupAt = null', st.lastBackupAt, null);
    eq('删掉 lastBackupAt 后 daysSinceBackup = null', st.daysSinceBackup, null);
    eq('有数据但没备份记录 → reason = never', st.reason, 'never');
    eq('有数据但没备份记录 → due = true', st.due, true);
    eq('lastBackupAtISO = null', st.lastBackupAtISO, null);

    // ═════════════ 15) 两阶段导出任务 ═════════════
    section('15) 两阶段导出任务：start / 进度 / download / 取消 / 并发 409 / TTL / 启动清理');
    check('启动时清理上次残留的 export-* 目录', !existsSync(staleExportDir));

    const stBeforeJobs = await getJson('/api/backup/status');
    const job1 = await startJob({ includeThumbs: false, includeMedia: false });
    check('start 返回 jobId', typeof job1.jobId === 'string' && job1.jobId.length > 0);
    check(
      'start 返回 filesTotal / bytesTotal / createdAt',
      job1.filesTotal > 0 && job1.bytesTotal > 0 && Number.isFinite(job1.createdAt)
    );
    eq('元数据 + 无缩略图 + 无素材 filesTotal = 5', job1.filesTotal, 5);
    const jobDir1 = join(dataDir, 'tmp', `export-${job1.jobId}`);
    check('任务 zip 目录在 data/tmp/export-<jobId>/', existsSync(jobDir1));
    await expectStatus('已有导出任务进行中 → 409', 409, () => startJob({}));
    const stBuilding = await jobStatus(job1.jobId);
    eq('任务初始状态 building', stBuilding.state, 'building');
    check(
      'building 进度字段完整',
      stBuilding.filesTotal === 5 && stBuilding.bytesTotal === job1.bytesTotal && stBuilding.filesDone === 0
    );

    const stDone1 = await waitJobDone(job1.jobId);
    eq('任务最终 state = done', stDone1.state, 'done');
    eq('done 后 filesDone = filesTotal', stDone1.filesDone, stDone1.filesTotal);
    eq('done 后 bytesDone = bytesTotal（进度 100%）', stDone1.bytesDone, stDone1.bytesTotal);
    check('done 后 zipBytes > 0', stDone1.zipBytes > 0, `${stDone1.zipBytes} B`);
    eq('done 后 error = null', stDone1.error, null);
    const stAfterJob = await getJson('/api/backup/status');
    check(
      '打包完成即写 lastBackupAt（不是下载时）',
      Number.isFinite(stAfterJob.lastBackupAt) &&
        stAfterJob.lastBackupAt > (stBeforeJobs.lastBackupAt ?? 0),
      String(stAfterJob.lastBackupAt)
    );

    const dl1 = await jobDownload(job1.jobId);
    eq('download HTTP 200', dl1.status, 200);
    eq('download content-type = application/zip', String(dl1.headers['content-type']).split(';')[0], 'application/zip');
    eq('download content-length = zipBytes', Number(dl1.headers['content-length']), stDone1.zipBytes);
    check(
      'download 文件名格式正确',
      BACKUP_FILENAME_RE.test(dispositionName(dl1.headers)),
      String(dl1.headers['content-disposition'])
    );
    eq('download 字节数一致', dl1.buf.length, stDone1.zipBytes);
    const dl1map = await readZipBuffer(dl1.buf);
    eq('job 导出的 zip 条目 = 5', [...dl1map.keys()].sort(), requiredNames);
    const dl1Manifest = getJsonEntry(dl1map, 'manifest.json');
    eq('job 导出 manifest.formatVersion = 2', dl1Manifest.formatVersion, 2);
    eq('job 导出 includes.media = false', dl1Manifest.includes.media, false);

    check('download 后任务目录仍保留（TTL / DELETE 才清理）', existsSync(jobDir1));
    await expectStatus('DELETE done 任务 → 200', 200, () => jobDelete(job1.jobId));
    await expectStatus('删除后 status → 404', 404, () => jobStatus(job1.jobId));
    check('删除后任务目录已清理', !existsSync(jobDir1));
    await expectStatus('未知 jobId status → 404', 404, () => jobStatus('no-such-job'));
    await expectStatus('未知 jobId DELETE → 404', 404, () => jobDelete('no-such-job'));
    const unknownDownload = await jobDownload('no-such-job');
    eq('未知 jobId download → 404', unknownDownload.status, 404);

    // 取消 building 任务
    const job2 = await startJob({ includeThumbs: false, includeMedia: false });
    const cancelRes = await jobDelete(job2.jobId);
    eq('取消 building 任务返回 ok', cancelRes.ok, true);
    let canceledState = null;
    try {
      canceledState = (await jobStatus(job2.jobId)).state;
    } catch {
      canceledState = 'gone';
    }
    check(
      '取消后状态为 canceled（或任务已清理）',
      canceledState === 'canceled' || canceledState === 'gone',
      canceledState
    );
    check('取消后临时目录已清理', !existsSync(join(dataDir, 'tmp', `export-${job2.jobId}`)));

    // TTL 到期清理
    const job3 = await startJob({ includeThumbs: false, includeMedia: false });
    const stDone3 = await waitJobDone(job3.jobId);
    eq('TTL 测试任务 done', stDone3.state, 'done');
    const jobDir3 = join(dataDir, 'tmp', `export-${job3.jobId}`);
    check('TTL 前任务目录存在', existsSync(jobDir3));
    await sleep(EXPORT_TTL_MS + 800);
    await expectStatus('TTL 到期后 status → 404', 404, () => jobStatus(job3.jobId));
    check('TTL 到期后临时目录已清理', !existsSync(jobDir3));

    // ═════════════ 15b) 磁盘空间检查（独立实例）═════════════
    section('15b) 磁盘空间检查：预留阈值调大时 start → 400');
    const diskTmp = join(tmp, 'disk-instance');
    const diskDataDir = join(diskTmp, 'data');
    const diskMediaDir = join(diskTmp, 'media');
    mkdirSync(diskDataDir, { recursive: true });
    mkdirSync(diskMediaDir, { recursive: true });
    const diskPort = PORT + 1;
    const diskLogFd = openSync(join(tmp, 'disk-server.log'), 'a');
    const diskChild = spawn(process.execPath, ['server/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        STARTER_DATA: '0',
        PORT: String(diskPort),
        DATA_DIR: diskDataDir,
        MEDIA_ROOT: diskMediaDir,
        MEDIA_ROOT_DEV: diskMediaDir,
        // 这个实例不跳过磁盘检查，并把预留调得极大，必然触发「磁盘空间不足」
        BACKUP_DISK_RESERVE_BYTES: String(10 ** 15),
      },
      stdio: ['ignore', diskLogFd, diskLogFd],
      windowsHide: true,
    });
    extraChildren.push(diskChild);
    let diskOnline = false;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${diskPort}/api/health`);
        if (r.ok) {
          diskOnline = true;
          break;
        }
      } catch {
        /* 还没起来 */
      }
      await sleep(200);
    }
    check('磁盘检查实例在线', diskOnline);
    if (diskOnline) {
      const diskRes = await fetch(`http://127.0.0.1:${diskPort}/api/backup/export/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      eq('磁盘空间不足 → 400', diskRes.status, 400);
      const diskBody = await diskRes.json();
      check(
        '磁盘空间不足文案清晰',
        /磁盘空间不足/.test(String(diskBody.error || '')),
        String(diskBody.error || '').slice(0, 120)
      );
      const diskTmpEntries = existsSync(join(diskDataDir, 'tmp'))
        ? readdirSync(join(diskDataDir, 'tmp')).filter((n) => n.startsWith('export-'))
        : [];
      eq('磁盘不足时不创建导出任务目录', diskTmpEntries, []);
    }
    try {
      diskChild.kill();
    } catch {
      /* ignore */
    }
    for (let i = 0; i < 50 && diskChild.exitCode === null; i++) await sleep(100);

    // ═════════════ 16) includeMedia 导出与 inspect ═════════════
    section('16) includeMedia 导出：media/ 条目 / manifest / inspect 摘要');
    const bSnapshot = new Map();
    for (const rel of mediaFiles()) bSnapshot.set(rel, readFileSync(join(mediaRoot, rel)));
    eq('当前 B 素材文件 7 个', bSnapshot.size, 7);

    const jobMedia = await startJob({ includeThumbs: false, includeMedia: true });
    eq('includeMedia filesTotal = 5 + 7', jobMedia.filesTotal, 12);
    check(
      'includeMedia bytesTotal ≥ 素材字节数',
      jobMedia.bytesTotal >= dbMediaBytesSum,
      `${jobMedia.bytesTotal} >= ${dbMediaBytesSum}`
    );
    const stMediaDone = await waitJobDone(jobMedia.jobId);
    eq('素材导出任务 done', stMediaDone.state, 'done');
    const dlMedia = await jobDownload(jobMedia.jobId);
    eq('素材包 download 200', dlMedia.status, 200);
    eq('素材包 content-length = zipBytes', Number(dlMedia.headers['content-length']), stMediaDone.zipBytes);

    const mediaMap = await readZipBuffer(dlMedia.buf);
    const mediaEntryNames = [...mediaMap.keys()].filter((n) => n.startsWith('media/')).sort();
    eq('media/ 条目数 = 7', mediaEntryNames.length, 7);
    const expectedMediaEntries = e1MediaManifest.items.map((m) => mediaEntryName(m.rel_path)).sort();
    eq('media/ 条目名 = DB rel_path 分段（反斜杠规范化）', mediaEntryNames, expectedMediaEntries);
    check(
      'media 条目按 / 分段、无 .. 段',
      mediaEntryNames.every((n) => !n.split('/').includes('..') && !n.includes('\\'))
    );
    const mediaZipManifest = getJsonEntry(mediaMap, 'manifest.json');
    eq('素材包 formatVersion = 2', mediaZipManifest.formatVersion, 2);
    eq('素材包 includes.media = true', mediaZipManifest.includes.media, true);
    eq('素材包 includes.mediaCount = 7', mediaZipManifest.includes.mediaCount, 7);
    eq('素材包 includes.mediaBytes = DB 素材字节和', mediaZipManifest.includes.mediaBytes, dbMediaBytesSum);
    eq('素材包 includes.mediaMissingAtExport = 0', mediaZipManifest.includes.mediaMissingAtExport, 0);
    check('素材包没有 thumbs/ 条目', ![...mediaMap.keys()].some((n) => n.startsWith('thumbs/')));
    const insMedia = await inspectZip(dlMedia.buf);
    eq('inspect 素材包 includeMedia = true', insMedia.summary.includeMedia, true);
    eq('inspect 素材包 mediaCount = 7', insMedia.summary.mediaCount, 7);
    eq('inspect 素材包 mediaBytes 与 manifest 一致', insMedia.summary.mediaBytes, mediaZipManifest.includes.mediaBytes);
    eq('inspect 素材包 mediaMissingAtExport = 0', insMedia.summary.mediaMissingAtExport, 0);
    eq('inspect 素材包 mediaMissing（当前 B）= 0', insMedia.summary.mediaMissing, 0);
    check('inspect 素材包警告提示会写回素材库', insMedia.summary.warnings.some((w) => w.includes('素材')));
    await expectStatus('下载后删除素材任务 → 200', 200, () => jobDelete(jobMedia.jobId));

    // 导出时缺 1 个 B 文件 → mediaMissingAtExport = 1，只打包 6 个
    const missingRel = mediaFiles().find((r) => bSnapshot.has(r));
    const missingBuf = readFileSync(join(mediaRoot, missingRel));
    unlinkSync(join(mediaRoot, missingRel));
    const jobMissing = await startJob({ includeThumbs: false, includeMedia: true });
    eq('缺 1 个原片时 filesTotal = 5 + 6', jobMissing.filesTotal, 11);
    const stMissingDone = await waitJobDone(jobMissing.jobId);
    eq('缺原片任务 done', stMissingDone.state, 'done');
    const dlMissing = await jobDownload(jobMissing.jobId);
    const missingManifest = getJsonEntry(await readZipBuffer(dlMissing.buf), 'manifest.json');
    eq('includes.mediaCount = 6', missingManifest.includes.mediaCount, 6);
    eq('includes.mediaMissingAtExport = 1', missingManifest.includes.mediaMissingAtExport, 1);
    const insMissing = await inspectZip(dlMissing.buf);
    eq('inspect mediaCount = 6', insMissing.summary.mediaCount, 6);
    eq('inspect mediaMissingAtExport = 1', insMissing.summary.mediaMissingAtExport, 1);
    eq('inspect 该包 mediaMissing（当前 B）= 1', insMissing.summary.mediaMissing, 1);
    writeFileSync(join(mediaRoot, missingRel), missingBuf); // 还原 B
    await expectStatus('删除缺原片导出任务 → 200', 200, () => jobDelete(jobMissing.jobId));

    // ═════════════ 16b) 素材包安全校验 ═════════════
    section('16b) 素材包安全校验：未引用 / 大小不符 / 路径穿越 / 内容篡改');
    const mediaBaseMap = await readZipBuffer(dlMedia.buf);
    const firstMediaEntry = mediaEntryNames[0];
    const firstMediaData = mediaBaseMap.get(firstMediaEntry);

    const unreferenced = new Map(mediaBaseMap);
    unreferenced.delete(firstMediaEntry);
    unreferenced.set('media/zzz-not-referenced/evil.jpg', firstMediaData);
    await expect400('DB 未引用的 media 条目', async () => inspectZip(await zipFromMap(unreferenced)), '未引用');

    const sizeMismatch = new Map(mediaBaseMap);
    sizeMismatch.set(firstMediaEntry, Buffer.concat([firstMediaData, Buffer.from('xx')]));
    await expect400('素材大小与清单/DB 不一致', async () => inspectZip(await zipFromMap(sizeMismatch)), '大小');

    const victimName = Buffer.from(firstMediaEntry);
    const evilName = Buffer.concat([
      Buffer.from('media/../'),
      Buffer.alloc(Math.max(0, victimName.length - 'media/../'.length), 0x78),
    ]);
    if (evilName.length === victimName.length && victimName.length > 'media/../'.length) {
      const { buf: traversalZip, count: traversalCount } = replaceSameLengthBuffer(
        dlMedia.buf,
        victimName,
        evilName
      );
      check('篡改 media 条目名成功（local + central 两处）', traversalCount === 2, `实际 ${traversalCount} 处`);
      await expect400('media/../ 路径穿越 → 400', () => inspectZip(traversalZip));
    } else {
      check('media 条目名长度足够构造穿越用例', false, `${victimName.length} 字节`);
    }

    // 内容被篡改但大小不变：inspect 只读元数据（通过），restore 时 sha256 校验失败 → 500 回滚
    const tamperedMap = new Map(mediaBaseMap);
    tamperedMap.set(firstMediaEntry, randomBytes(firstMediaData.length));
    const tamperedZip = await zipFromMap(tamperedMap);
    const tamperedInspect = await inspectZip(tamperedZip);
    eq('同大小篡改的包 inspect 仍通过（不真正解压素材）', tamperedInspect.summary.mediaCount, 7);
    const beforeTamperStatus = await getJson('/api/backup/status');
    const beforeTamperTrash = await getJson('/api/trash/count');
    const beforeTamperFiles = mediaFiles();
    await expectStatus('篡改素材内容的恢复 → 500', 500, () => restoreWith(tamperedInspect.token));
    let tamperErr = null;
    try {
      tamperErr = null;
      await restoreWith((await inspectZip(tamperedZip)).token);
    } catch (e) {
      tamperErr = e;
    }
    check('篡改素材恢复返回 rolledBack=true', tamperErr?.body?.rolledBack === true, JSON.stringify(tamperErr?.body));
    eq('篡改素材失败后 DB 行数未变', (await getJson('/api/backup/status')).dataCounts, beforeTamperStatus.dataCounts);
    eq('篡改素材失败后回收站未变', await getJson('/api/trash/count'), beforeTamperTrash);
    eq('篡改素材失败后 B 文件未变', mediaFiles(), beforeTamperFiles);
    eq(
      '篡改素材失败后无 .restore-* 暂存目录残留',
      readdirSync(mediaRoot).filter((n) => n.startsWith('.restore-')).length,
      0
    );

    // ═════════════ 17) 含素材恢复到空 B（模拟新电脑）═════════════
    section('17) 含素材恢复到空素材库：落盘 / 跳过 / 孤儿 / 覆盖');
    for (const rel of mediaFiles()) unlinkSync(join(mediaRoot, rel));
    eq('先清空 B 原片', mediaFiles().length, 0);
    const insNewPc = await inspectZip(dlMedia.buf);
    eq('新电脑上 inspect mediaMissing = 7', insNewPc.summary.mediaMissing, 7);
    const restoreNewPc = await restoreWith(insNewPc.token);
    eq('新电脑恢复 ok', restoreNewPc.ok, true);
    eq('新电脑恢复 media 计数 written=7', restoreNewPc.media, {
      packaged: 7,
      written: 7,
      skipped: 0,
      failed: 0,
    });
    eq('新电脑恢复后 missingMedia = 0', restoreNewPc.missingMedia, 0);
    eq('新电脑恢复后 B 文件数 = 7', mediaFiles().length, 7);
    check(
      '新电脑恢复后每个文件字节与备份一致',
      mediaFiles().every((rel) => bSnapshot.has(rel) && readFileSync(join(mediaRoot, rel)).equals(bSnapshot.get(rel)))
    );
    eq(
      '恢复后无 .restore-* 暂存目录',
      readdirSync(mediaRoot).filter((n) => n.startsWith('.restore-')).length,
      0
    );
    eq('新电脑恢复后 orphans = 0', restoreNewPc.orphans, 0);

    const insAgain = await inspectZip(dlMedia.buf);
    const restoreAgain = await restoreWith(insAgain.token);
    eq('重复恢复 media 计数 skipped=7', restoreAgain.media, {
      packaged: 7,
      written: 0,
      skipped: 7,
      failed: 0,
    });
    eq('重复恢复后 B 文件数仍 7', mediaFiles().length, 7);

    const orphanRel = 'orphan/keep-me.txt';
    mkdirSync(join(mediaRoot, 'orphan'), { recursive: true });
    writeFileSync(join(mediaRoot, orphanRel), Buffer.from('do-not-delete-me'));
    const insOrphan = await inspectZip(dlMedia.buf);
    const restoreOrphan = await restoreWith(insOrphan.token);
    eq('有孤儿文件时恢复 media skipped=7', restoreOrphan.media, {
      packaged: 7,
      written: 0,
      skipped: 7,
      failed: 0,
    });
    eq('恢复不删除备份外的 B 文件', existsSync(join(mediaRoot, orphanRel)), true);
    eq('orphans 统计 = 1', restoreOrphan.orphans, 1);
    eq('恢复后 B 文件数 = 8（7 + 孤儿）', mediaFiles().length, 8);

    const overwriteRel = mediaFiles().find((r) => bSnapshot.has(r));
    const originalBuf = bSnapshot.get(overwriteRel);
    writeFileSync(join(mediaRoot, overwriteRel), Buffer.alloc(originalBuf.length + 64, 0x41));
    const insOverwrite = await inspectZip(dlMedia.buf);
    const restoreOverwrite = await restoreWith(insOverwrite.token);
    eq('同名不同内容时 media written=1 / skipped=6', restoreOverwrite.media, {
      packaged: 7,
      written: 1,
      skipped: 6,
      failed: 0,
    });
    eq('被覆盖文件恢复为备份内容', readFileSync(join(mediaRoot, overwriteRel)).equals(originalBuf), true);
    eq('覆盖后 B 文件数仍 8（含孤儿）', mediaFiles().length, 8);
    eq('覆盖后 orphans 仍 = 1', restoreOverwrite.orphans, 1);
    eq('DB 行数未变（3/4/5 alive）', (await getJson('/api/backup/status')).dataCounts, {
      places: 3,
      visits: 4,
      media: 5,
    });

    // ═════════════ 18) v1 兼容 / 不含素材恢复不写 B ═════════════
    section('18) v1 兼容：无素材旧包可 inspect/restore；不含素材恢复不写 B');
    const v1Map = new Map(await readZipBuffer(e1.buf));
    const v1Manifest = getJsonEntry(v1Map, 'manifest.json');
    v1Manifest.formatVersion = 1;
    v1Manifest.includes = { thumbs: false, thumbsCount: 0 };
    setJsonEntry(v1Map, 'manifest.json', v1Manifest);
    const v1Zip = await zipFromMap(v1Map);
    const v1Inspect = await inspectZip(v1Zip);
    eq('v1 包 formatVersion = 1', v1Inspect.summary.formatVersion, 1);
    eq('v1 包 includeMedia = false', v1Inspect.summary.includeMedia, false);
    eq('v1 包 mediaCount = 0', v1Inspect.summary.mediaCount, 0);
    eq('v1 包 mediaMissingAtExport = 0', v1Inspect.summary.mediaMissingAtExport, 0);
    eq('v1 包 counts 与 E1 一致', v1Inspect.summary.counts, { place: 4, visit: 5, media: 7 });
    const bBeforeV1 = mediaFiles();
    const v1Restore = await restoreWith(v1Inspect.token);
    eq('v1 包可恢复', v1Restore.ok, true);
    eq('v1 恢复行数 4/5/7', v1Restore.restored, { places: 4, visits: 5, media: 7 });
    eq('v1 恢复 media 计数全 0', v1Restore.media, { packaged: 0, written: 0, skipped: 0, failed: 0 });
    eq('v1/不含素材恢复不写 B（文件清单不变）', mediaFiles(), bBeforeV1);
    const v1WithMedia = new Map(v1Map);
    v1WithMedia.set(mediaEntryName(e1MediaManifest.items[0].rel_path), Buffer.from('x'));
    await expect400('v1 包不允许 media/ 条目', async () => inspectZip(await zipFromMap(v1WithMedia)), '素材');

    // ═════════════ 19) 真实数据未被写 ═════════════
    section('19) 真实 data/ 与 .dev-media 全程未变');
    eq(
      'data/tmp 无导出任务残留目录',
      readdirSync(join(dataDir, 'tmp')).filter((n) => n.startsWith('export-')),
      []
    );
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
    check('服务日志无未捕获异常', !/UnhandledPromiseRejection|Unhandled 'error' event/.test(readLogs()));

    console.log('\n' + '─'.repeat(68));
    console.log(`通过 ${pass} 项，失败 ${fail} 项 ${fail === 0 ? '✅' : '❌'}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    for (const extra of extraChildren) {
      try {
        if (extra.exitCode === null) extra.kill();
      } catch {
        /* ignore */
      }
    }
    if (child && child.exitCode === null) {
      child.kill();
      for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
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
  console.error('\nM4 备份冒烟异常：', e?.message || e);
  process.exitCode = 1;
});
