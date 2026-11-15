/**
 * 本地分享包导出冒烟（F-SHR-01 / 2026-11-14 D-416，P4）
 *
 *   node scripts/smoke-share-export.mjs
 *
 * 隔离 local 实例（默认端口 4196）：建地点 / 上传照片 → 导出 zip → 校验 manifest / 预览尺寸 /
 * 文件名 / 重复导出不覆盖 / 秘密基地服务端兜底。不碰真实 data/ 与 .dev-media/。
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
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { openPromise } from 'yauzl';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_SHARE_EXPORT_PORT || 4196);
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label + (extra ? `（${extra}）` : ''));
  }
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
};
const eq = (label, a, b) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  check(label, x === y, x === y ? '' : `实际=${x} 期望=${y}`);
};
const section = (t) => console.log(`\n── ${t} ──`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), 'th-share-export-'));
const dataDir = join(tmp, 'data');
const mediaRoot = join(tmp, 'media');
const outDir = join(tmp, 'out');
mkdirSync(dataDir, { recursive: true });
mkdirSync(mediaRoot, { recursive: true });
mkdirSync(outDir, { recursive: true });
const logPath = join(tmp, 'server.log');

let child = null;
let logFd = null;

async function req(path, opts) {
  const r = await fetch(BASE + path, opts);
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}
const post = (path, body) =>
  req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const patch = (path, body) =>
  req(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function uploadPhoto(visitId, name, buf) {
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: 'image/jpeg' }), name);
  return req(`/api/media/upload?visitId=${encodeURIComponent(visitId)}`, { method: 'POST', body: fd });
}

async function zipEntries(zipPath) {
  const names = [];
  const zf = await openPromise(zipPath, { lazyEntries: true });
  try {
    for await (const e of zf.eachEntry()) names.push(e.fileName);
  } finally {
    try {
      await zf.close();
    } catch {
      /* ignore */
    }
  }
  return names;
}

async function zipManifest(zipPath) {
  const zf = await openPromise(zipPath, { lazyEntries: true });
  try {
    for await (const e of zf.eachEntry()) {
      if (e.fileName !== 'manifest.json') continue;
      const s = await zf.openReadStreamPromise(e);
      const chunks = [];
      for await (const c of s) chunks.push(c);
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
  } finally {
    try {
      await zf.close();
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function waitJob(jobId, timeout = 60000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await req(`/api/share/export/status/${jobId}`);
    if (last.body?.state !== 'running') return last;
    await sleep(200);
  }
  throw new Error('导出超时：' + JSON.stringify(last));
}

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

  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const h = await req('/api/health');
      if (h.status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(200);
  }
  if (!ready) throw new Error('隔离 local 实例没起来：\n' + readFileSync(logPath, 'utf8').slice(-3000));

  section('1) 准备地点与照片');
  const place = await post('/api/places', {
    name: '导出测试点',
    lng: 114.5,
    lat: 22.5,
    province: '广东省',
    city: '深圳市',
    county: '龙岗区',
    province_code: '440000',
    kind: 'visited',
    date: '2026-10-02',
  });
  eq('建地点 → 200', place.status, 200);
  const placeId = place.body.id;
  const visitId = place.body.visits[0].id;

  const big = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#336699' } })
    .jpeg({ quality: 90 })
    .toBuffer();
  const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#993366' } })
    .jpeg({ quality: 85 })
    .toBuffer();
  const up1 = await uploadPhoto(visitId, 'big.jpg', big);
  const up2 = await uploadPhoto(visitId, 'small.jpg', small);
  eq('上传 2 张照片', (up1.body?.added?.length || 0) + (up2.body?.added?.length || 0), 2);
  const ids = [up1.body.added[0].id, up2.body.added[0].id];

  section('2) 导出 zip');
  const start = await post('/api/share/export/start', {
    placeIds: [placeId],
    mediaIds: ids,
    dir: outDir,
    title: '导出测试',
    displayName: '本地测试',
    includeNotes: true,
    includeCompanions: true,
  });
  eq('start → 200', start.status, 200);
  const done = await waitJob(start.body.jobId);
  eq('导出 done', done.body?.state, 'done');
  const savedPath = done.body?.savedPath || '';
  check('文件落在选定目录', savedPath.startsWith(outDir) && existsSync(savedPath), savedPath);
  check('文件名含张数与日期', /tread-horizon-share-\d{8}-\d{4}-2张\.zip$/.test(savedPath), savedPath);
  check('完成字节数 == 磁盘大小', done.body?.bytes === statSync(savedPath).size, `${done.body?.bytes} / ${statSync(savedPath).size}`);

  const entries = await zipEntries(savedPath);
  eq('zip 条目 = manifest + 2 张照片', entries.length, 3);
  check('zip 条目白名单', entries.every((n) => n === 'manifest.json' || /^media\/p_[a-z0-9_]{3,40}\.webp$/.test(n)));
  const manifest = await zipManifest(savedPath);
  eq('manifest 标题', manifest?.title, '导出测试');
  eq('manifest counts', manifest?.counts, { places: 1, visits: 1, photos: 2 });
  eq('manifest 没有视频', manifest?.media.every((m) => m.kind === 'photo'), true);
  eq('manifest 不含 user_id / 绝对路径', JSON.stringify(manifest).includes('user_id') || JSON.stringify(manifest).includes(':\\'), false);
  const maxW = Math.max(...manifest.media.map((m) => m.w));
  check('预览长边 ≤ 1280', maxW <= 1280, String(maxW));
  const firstBytes = manifest.media.find((m) => m.id === ids[0])?.bytes;
  check('manifest bytes > 0', firstBytes > 0);

  section('3) 重复导出不覆盖 + 目录外不写');
  const start2 = await post('/api/share/export/start', {
    placeIds: [placeId],
    mediaIds: ids,
    dir: outDir,
    title: '导出测试 2',
  });
  const done2 = await waitJob(start2.body.jobId);
  eq('第二次导出 done', done2.body?.state, 'done');
  check('同名不覆盖（-2）', done2.body.savedPath !== savedPath && done2.body.savedPath.endsWith('-2.zip'));
  check('outDir 只有两个 zip', readdirSync(outDir).filter((n) => n.endsWith('.zip')).length === 2);
  const tmpDir = join(dataDir, 'tmp');
  check(
    'data/tmp 无残留 zip',
    !existsSync(tmpDir) || !readdirSync(tmpDir).some((n) => n.endsWith('.zip'))
  );

  section('4) 秘密基地不参与分享（服务端兜底）');
  await patch(`/api/places/${placeId}`, { secret: true });
  await post('/api/secret/password', { newPassword: '12345678' });
  const noPw = await post('/api/share/export/start', { placeIds: [placeId], mediaIds: ids, dir: outDir });
  // 2026-11-15 D-427：含秘密基地一律拒绝（不再有「输密码就放行」）
  eq('含秘密基地（无密码）→ 400', noPw.status, 400);
  check('拒绝理由提到秘密基地', String(noPw.body?.error || '').includes('秘密基地'));
  const wrongPw = await post('/api/share/export/start', {
    placeIds: [placeId],
    mediaIds: ids,
    dir: outDir,
    secretPassword: 'wrong-pass',
  });
  eq('含秘密基地（错密码）→ 400', wrongPw.status, 400);
  const okPw = await post('/api/share/export/start', {
    placeIds: [placeId],
    mediaIds: ids,
    dir: outDir,
    secretPassword: '12345678',
  });
  eq('含秘密基地（对密码也拒）→ 400', okPw.status, 400);

  section('5) 勾家 → home + 离家距离');
  await patch(`/api/places/${placeId}`, { secret: false, home: true });
  const placeB = await post('/api/places', {
    name: '导出测试点 B',
    lng: 113.9,
    lat: 22.8,
    province: '广东省',
    city: '东莞市',
    kind: 'visited',
    date: '2026-10-03',
  });
  const visitB = placeB.body.visits[0].id;
  const bBuf = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#228844' } })
    .jpeg({ quality: 85 })
    .toBuffer();
  const upB = await uploadPhoto(visitB, 'b.jpg', bBuf);
  eq('B 上传 1 张照片', upB.body?.added?.length, 1);
  const mediaB = upB.body.added[0].id;
  const homeStart = await post('/api/share/export/start', {
    placeIds: [placeId, placeB.body.id],
    mediaIds: [ids[0], mediaB],
    dir: outDir,
    title: '含家导出',
  });
  eq('含家导出 → 200', homeStart.status, 200);
  const homeDone = await waitJob(homeStart.body.jobId);
  eq('含家导出 done', homeDone.body?.state, 'done');
  const hm = await zipManifest(homeDone.body.savedPath);
  const homePlace = hm?.places?.find((p) => p.home === true);
  const other = hm?.places?.find((p) => !p.home);
  eq('manifest 家里标记 home=true', homePlace?.id, placeId);
  check('其它地点带 homeDistanceKm', typeof other?.homeDistanceKm === 'number' && other.homeDistanceKm > 0, String(other?.homeDistanceKm));
  check('家本身不写距离', other?.homeDistanceKm !== 0);
} catch (e) {
  console.error('\n💥', e?.stack || e);
  try {
    console.error(readFileSync(logPath, 'utf8').slice(-3000));
  } catch {}
  process.exitCode = 1;
} finally {
  if (child) {
    try {
      child.kill();
    } catch {}
    await sleep(300);
  }
  try {
    if (logFd != null) closeSync(logFd);
  } catch {}
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  if (fail) {
    console.log('失败项：\n- ' + failures.join('\n- '));
    process.exitCode = 1;
  }
}
