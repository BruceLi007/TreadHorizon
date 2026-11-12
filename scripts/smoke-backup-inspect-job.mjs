/**
 * 备份包检查（上传 + 校验）后台任务冒烟测试（2026-11-12 D-401）
 *
 *   node scripts/smoke-backup-inspect-job.mjs
 *
 * 隔离实例（4199）：先用两阶段导出生成一个真备份 zip → start 检查任务 → 上传 → 轮询校验结果；
 * 同时验证旧同步接口 /api/backup/inspect 仍可用、background-tasks 能接回检查任务、错误路径。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_BACKUP_INSPECT_PORT || 4199);
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

const req = async (p, opts) => {
  const r = await fetch(BASE + p, opts);
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { status: r.status, body };
};
const postJson = (p, body) =>
  req(p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const waitJob = async (fn, timeoutMs = 20000) => {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    const state = last?.body?.state;
    if (state !== 'building' && state !== 'running' && state !== 'uploading' && state !== 'validating') {
      return last;
    }
    await sleep(150);
  }
  throw new Error('任务超时：' + JSON.stringify(last));
};

const tmp = mkdtempSync(join(tmpdir(), 'th-inspect-job-'));
const dataDir = join(tmp, 'data');
const mediaRoot = join(tmp, 'media');
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
try {
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
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });

  let health = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await req('/api/health');
      if (r.status === 200) {
        health = r.body;
        break;
      }
    } catch {}
    await sleep(200);
  }
  if (!health?.ok) throw new Error('服务没起来');

  section('0) 初始状态');
  check('隔离实例在线', health.version === '1.1.1' || /^\d+\.\d+\.\d+/.test(health.version || ''), {
    version: health.version,
  });
  const bg0 = await req('/api/background-tasks');
  eq('background-tasks 含 inspectJobs 数组', Array.isArray(bg0.body?.inspectJobs), true);
  eq('初始检查任务为空', bg0.body?.inspectJobs?.length, 0);

  section('1) 生成一个真实备份 zip（两阶段导出，仅元数据）');
  const exp = await postJson('/api/backup/export/start', {
    includeThumbs: false,
    includeMedia: false,
  });
  check('导出任务 start 返回 jobId', !!exp.body?.jobId);
  const expDone = await waitJob(() => req(`/api/backup/export/status/${exp.body.jobId}`));
  eq('导出任务 done', expDone.body?.state, 'done');
  const dl = await fetch(`${BASE}/api/backup/export/download/${exp.body.jobId}`);
  const zipBuf = Buffer.from(await dl.arrayBuffer());
  check('下载到备份 zip', dl.ok && zipBuf.length > 100, { bytes: zipBuf.length });

  section('2) 检查任务：start → 上传 → 后台校验');
  const start = await postJson('/api/backup/inspect/start', {});
  check('start 返回 jobId', !!start.body?.jobId);
  const fd = new FormData();
  fd.append('file', new Blob([zipBuf], { type: 'application/zip' }), 'smoke-backup.zip');
  const up = await fetch(`${BASE}/api/backup/inspect/upload/${start.body.jobId}`, {
    method: 'POST',
    body: fd,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  eq('上传接口 200', up.status, 200);
  eq('上传后进入 validating', up.body?.state, 'validating');
  check('上传字节数 > 0', (up.body?.bytes ?? 0) > 0, { bytes: up.body?.bytes });

  const done = await waitJob(() => req(`/api/backup/inspect/status/${start.body.jobId}`));
  eq('检查任务 done', done.body?.state, 'done');
  check('返回 token', typeof done.body?.token === 'string' && done.body.token.length > 8);
  check('返回 expiresAt', Number.isFinite(done.body?.expiresAt));
  check('返回摘要', !!done.body?.summary && typeof done.body.summary === 'object');
  eq('摘要 zipBytes = 上传 zip 大小', done.body?.summary?.zipBytes, zipBuf.length);
  eq('任务列表能查到（重开设置接回）', (await req('/api/background-tasks')).body?.inspectJobs?.[0]?.jobId, start.body.jobId);

  section('3) 旧同步接口 /api/backup/inspect 仍可用');
  const fd2 = new FormData();
  fd2.append('file', new Blob([zipBuf], { type: 'application/zip' }), 'legacy.zip');
  const legacy = await fetch(`${BASE}/api/backup/inspect`, { method: 'POST', body: fd2 }).then(
    async (r) => ({ status: r.status, body: await r.json().catch(() => null) })
  );
  eq('旧接口 200', legacy.status, 200);
  check('旧接口仍返回 token', typeof legacy.body?.token === 'string');

  section('4) 错误路径');
  const badStart = await postJson('/api/backup/inspect/start', {});
  const fdBad = new FormData();
  fdBad.append('file', new Blob([Buffer.from('not a zip')], { type: 'application/zip' }), 'bad.zip');
  const badUp = await fetch(`${BASE}/api/backup/inspect/upload/${badStart.body.jobId}`, {
    method: 'POST',
    body: fdBad,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  eq('上传非 zip 也 200（校验阶段才失败）', badUp.status, 200);
  const badDone = await waitJob(() => req(`/api/backup/inspect/status/${badStart.body.jobId}`));
  eq('非法 zip → state=error', badDone.body?.state, 'error');
  check('错误信息可读', typeof badDone.body?.error === 'string' && badDone.body.error.length > 0, {
    error: badDone.body?.error?.slice(0, 80),
  });
  eq('未知任务 → 404', (await req('/api/backup/inspect/status/nope')).status, 404);
  const upAgain = await fetch(`${BASE}/api/backup/inspect/upload/${start.body.jobId}`, {
    method: 'POST',
    body: fd,
  });
  eq('已完成任务再上传 → 409', upAgain.status, 409);

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  if (fail) {
    console.log('\n服务日志（末尾）：\n' + readLogs().slice(-3000));
    process.exitCode = 1;
  }
} catch (e) {
  console.error('\n💥', e?.stack || e);
  console.log('\n服务日志（末尾）：\n' + readLogs().slice(-3000));
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
