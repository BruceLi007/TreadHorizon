/**
 * 回收站后台任务冒烟测试（2026-11-12 D-400）：
 * 批量恢复 / 彻底删除改成服务端任务（start → 轮询 status），关掉设置 / 刷新页面不中断，
 * 重开回收站可以从 /api/trash/jobs 接回。旧的同步接口保留（旧客户端 / 既有测试）。
 *
 *   node scripts/smoke-trash-jobs.mjs
 *
 * 全隔离：临时 DATA_DIR + 临时素材库 + 4198 端口独立实例（SMOKE_TRASH_JOBS_PORT 可覆盖）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_TRASH_JOBS_PORT || 4198);
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
  const text = await r.text();
  if (!r.ok) {
    let msg = `HTTP ${r.status}: ${text.slice(0, 300)}`;
    try {
      const b = JSON.parse(text);
      if (b?.error) msg = `HTTP ${r.status}: ${b.error}`;
    } catch {
      /* keep */
    }
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return JSON.parse(text);
};

const getJson = (path) => fetch(BASE + path).then(j);
const postJson = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);
const delJson = (path) => fetch(BASE + path, { method: 'DELETE' }).then(j);

const expectError = async (label, status, fn) => {
  let actual = null;
  let msg = '';
  try {
    await fn();
    actual = 200;
  } catch (e) {
    actual = e.status ?? null;
    msg = e.message;
  }
  check(
    `${label} → HTTP ${status}`,
    actual === status,
    actual === status ? '' : `实际=${actual ?? '无'}${msg ? `（${msg.slice(0, 120)}）` : ''}`
  );
};

const createPlace = (name) =>
  postJson('/api/places', {
    name,
    lng: 118.1,
    lat: 30.2,
    province: '浙江省',
    city: '杭州市',
    county: '西湖区',
    province_code: '156330000',
    city_code: '156330100',
    county_code: '156330105',
    kind: 'visited',
    date: '2024-01-01',
  });

const deletePlace = (id) => delJson(`/api/places/${id}`);
const deleteVisit = (id) => delJson(`/api/visits/${id}`);
const deleteMedia = (id) => delJson(`/api/media/${id}`);

const makeJpg = (r, g, b) =>
  sharp({ create: { width: 120, height: 90, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 80 })
    .toBuffer();

const uploadOne = async (visitId, name, buf) => {
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: 'image/jpeg' }), name);
  return fetch(`${BASE}/api/media/upload?visitId=${encodeURIComponent(visitId)}`, {
    method: 'POST',
    body: fd,
  }).then(j);
};

function walkFiles(root) {
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

const cacheNamesFor = (id) => new Set([`${id}.webp`, `${id}_p.webp`, `${id}_poster.webp`]);

const waitJob = async (jobId, timeoutMs = 15000) => {
  const started = Date.now();
  let job = null;
  while (Date.now() - started < timeoutMs) {
    job = await getJson(`/api/trash/jobs/${jobId}`);
    if (job.state !== 'running') return job;
    await sleep(120);
  }
  throw new Error('任务超时未结束：' + JSON.stringify(job));
};

const tmp = mkdtempSync(join(tmpdir(), 'th-trash-jobs-'));
const dataDir = join(tmp, 'data');
const mediaRoot = join(tmp, 'media');
const thumbDir = join(dataDir, 'thumbs');
mkdirSync(dataDir, { recursive: true });
mkdirSync(mediaRoot, { recursive: true });
const logPath = join(tmp, 'server.log');
const readLogs = () => {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
};

let child = null;
let logFd = null;
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
    },
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
  if (!health?.ok) throw new Error('服务没起来：\n' + readLogs().slice(-2000));

  section('0) 初始状态');
  check('隔离实例在线', health.ok === true);
  check('素材库指向临时目录', resolve(health.mediaRoot) === resolve(mediaRoot), health.mediaRoot);
  eq('初始后台任务为空', await getJson('/api/trash/jobs'), []);
  eq('初始回收站为空', (await getJson('/api/trash')).items.length, 0);

  section('1) 启动参数校验（旧同步接口保留）');
  await expectError('start restore 缺 items', 400, () => postJson('/api/trash/restore/start', {}));
  await expectError('start restore 类型无效', 400, () =>
    postJson('/api/trash/restore/start', { items: [{ type: 'nope', id: 'x' }] })
  );
  await expectError('start purge 缺 confirm', 400, () =>
    postJson('/api/trash/purge/start', { items: [{ type: 'place', id: 'x' }] })
  );
  await expectError('旧 restore 缺 items 仍 400', 400, () => postJson('/api/trash/restore', {}));
  await expectError('旧 purge 缺 confirm 仍 400', 400, () =>
    postJson('/api/trash/purge', { items: [{ type: 'place', id: 'x' }] })
  );

  section('2) 后台恢复：地点 + 到访 + 照片');
  const A = await createPlace('后台任务-A');
  const va = A.visits[0].id;
  const upA = await uploadOne(va, 'a.jpg', await makeJpg(200, 30, 30));
  const mediaA = upA.added[0].id;
  eq('A 上传 1 张照片', walkFiles(mediaRoot).length, 1);
  await deleteMedia(mediaA);
  await deleteVisit(va);
  await deletePlace(A.id);
  const trashA = await getJson('/api/trash');
  check('A 删除后回收站有 1 个地点', trashA.items.some((it) => it.type === 'place' && it.id === A.id));

  const startRestore = await postJson('/api/trash/restore/start', {
    items: [{ type: 'place', id: A.id, restoreEarlier: true }],
  });
  check('start restore 返回 jobId', typeof startRestore.jobId === 'string' && startRestore.jobId.length > 8);
  eq('start restore kind=restore', startRestore.kind, 'restore');
  await sleep(500);
  check(
    '任务列表能查到该恢复任务',
    (await getJson('/api/trash/jobs')).some((it) => it.jobId === startRestore.jobId)
  );
  const doneRestore = await waitJob(startRestore.jobId);
  eq('恢复任务 done', doneRestore.state, 'done');
  eq('恢复 1 个地点', doneRestore.result.restoredPlaces, 1);
  eq('连带恢复此前单独删除的 1 次到访', doneRestore.result.restoredEarlierVisits, 1);
  eq('连带恢复此前单独删除的 1 张照片', doneRestore.result.restoredEarlierMedia, 1);
  eq('恢复后回收站为空', doneRestore.result.remaining.total, 0);
  const backA = await getJson(`/api/places/${A.id}`);
  eq('地点回到地图（GET 200）', backA?.id, A.id);
  check('照片回到到访', JSON.stringify(backA).includes(mediaA));
  await expectError('不存在的任务 → 404', 404, () => getJson('/api/trash/jobs/nope'));

  section('3) 后台彻底删除：删原片 + 缓存 + 记录');
  const B = await createPlace('后台任务-B');
  const vb = B.visits[0].id;
  const upB = await uploadOne(vb, 'b.jpg', await makeJpg(30, 30, 200));
  const mediaB = upB.added[0].id;
  await fetch(`${BASE}/api/media/${mediaB}/preview`).then(() => undefined);
  const origB = walkFiles(mediaRoot).find((f) => f.includes('b.jpg')) || null;
  check('B 原片已落盘', !!origB, origB || '(未找到)');
  const cacheB = cacheNamesFor(mediaB);
  const thumbsBefore = (() => {
    try {
      return readdirSync(thumbDir);
    } catch {
      return [];
    }
  })();
  check('B 缩略图缓存存在', thumbsBefore.includes(`${mediaB}.webp`));
  await deletePlace(B.id);
  check(
    'B 删除后回收站有 1 个地点',
    (await getJson('/api/trash')).items.some((it) => it.type === 'place' && it.id === B.id)
  );

  const startPurge = await postJson('/api/trash/purge/start', {
    items: [{ type: 'place', id: B.id }],
    confirm: true,
  });
  check('start purge 返回 jobId', typeof startPurge.jobId === 'string' && startPurge.jobId.length > 8);
  eq('start purge kind=purge', startPurge.kind, 'purge');
  await sleep(500);
  const donePurge = await waitJob(startPurge.jobId);
  eq('彻底删除任务 done', donePurge.state, 'done');
  eq('永久删除 1 个地点', donePurge.result.purgedPlaces, 1);
  eq('purgedMedia 只计显式选中的媒体（地点子项走级联）', donePurge.result.purgedMedia, 0);
  eq('彻底删除后回收站 mediaTotal=0', donePurge.result.remaining.media, 0);
  check(
    '删掉至少 1 个文件',
    (donePurge.result.files?.deleted ?? 0) >= 1,
    JSON.stringify(donePurge.result.files)
  );
  check('没有删文件失败', (donePurge.result.files?.errors ?? []).length === 0);
  eq('彻底删除后回收站为空', donePurge.result.remaining.total, 0);
  await expectError('地点记录已删除（GET 404）', 404, () => getJson(`/api/places/${B.id}`));
  const mediaThumbStatus = await fetch(`${BASE}/api/media/${mediaB}/thumb`).then((r) => r.status);
  eq('媒体缩略图接口已 404', mediaThumbStatus, 404);
  check('原片文件已从素材库删除', !!origB && !existsSync(join(mediaRoot, origB)), origB || '');
  const thumbsAfter = (() => {
    try {
      return readdirSync(thumbDir);
    } catch {
      return [];
    }
  })();
  check(
    '缩略图 / 预览缓存已删除',
    [...cacheB].every((n) => !thumbsAfter.includes(n)),
    [...cacheB].filter((n) => thumbsAfter.includes(n)).join(',')
  );

  section('4) 旧同步接口回归（旧客户端 / smoke-m3 仍在用）');
  const C = await createPlace('同步-C');
  await deletePlace(C.id);
  const syncRestore = await postJson('/api/trash/restore', {
    items: [{ type: 'place', id: C.id }],
  });
  eq('同步恢复仍 1 个地点', syncRestore.restoredPlaces, 1);
  const D = await createPlace('同步-D');
  await deletePlace(D.id);
  const syncPurge = await postJson('/api/trash/purge', {
    items: [{ type: 'place', id: D.id }],
    confirm: true,
  });
  eq('同步彻底删除仍 1 个地点', syncPurge.purgedPlaces, 1);
  await expectError('同步恢复不存在的条目 → 404', 404, () =>
    postJson('/api/trash/restore', { items: [{ type: 'place', id: 'missing' }] })
  );

  section('5) 任务失败路径：错误信息留给客户端');
  const bad = await postJson('/api/trash/restore/start', {
    items: [{ type: 'place', id: 'not-in-trash' }],
  });
  const badJob = await waitJob(bad.jobId);
  eq('非法恢复任务 state=error', badJob.state, 'error');
  check('非法恢复任务带可读错误', /不存在|回收站/.test(badJob.error || ''), badJob.error || '');

  section('6) 任务列表 / 状态接口形状');
  const list = await getJson('/api/trash/jobs');
  check(
    '列表按 createdAt 倒序',
    list.every((it, i) => i === 0 || list[i - 1].createdAt >= it.createdAt)
  );
  check('列表项字段齐全', list.every((it) => it.jobId && it.kind && it.state && 'error' in it));
  check('done 任务带 result', list.filter((it) => it.state === 'done').every((it) => !!it.result));

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  if (fail) {
    console.log('\n服务日志（末尾）：\n' + readLogs().slice(-4000));
    process.exitCode = 1;
  }
} catch (e) {
  console.error('\n💥', e?.stack || e);
  console.log('\n服务日志（末尾）：\n' + readLogs().slice(-4000));
  process.exitCode = 1;
} finally {
  if (child) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    await sleep(300);
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
