/**
 * M2 功能冒烟测试（F-MED-10 服务端 / F-MED-07 上传查重 / F-MED-09 reveal / F-PLC-08 合并）
 *
 *   node scripts/smoke-m2b.mjs
 *
 * 全隔离：空 data 目录 + 空临时素材库 + 4196 端口独立实例，跑完清理。
 * 不碰真实 data/travel.db、.dev-media、.env.local。
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
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_M2B_PORT || 4196);
const BASE = `http://127.0.0.1:${PORT}`;

let fail = 0;
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? '' : `实际=${a} 期望=${b}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const j = async (r) => {
  const t = await r.text();
  if (!r.ok) {
    let msg = `HTTP ${r.status}: ${t.slice(0, 300)}`;
    try {
      const b = JSON.parse(t);
      if (b?.error) msg = `HTTP ${r.status}: ${b.error}${b.needConfirm ? '（needConfirm）' : ''}`;
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

const postJson = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);

const createPlace = (name, extra = {}) =>
  postJson('/api/places', {
    name,
    lng: 120.1 + Math.random() * 0.1,
    lat: 30.2 + Math.random() * 0.1,
    province: '浙江省',
    city: '杭州市',
    county: '西湖区',
    province_code: '156330000',
    city_code: '156330100',
    county_code: '156330105',
    kind: 'visited',
    date: '2024-01-01',
    ...extra,
  });

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

const run = async () => {
  console.log(`\nM2 功能冒烟（隔离实例 :${PORT}）`);
  console.log('─'.repeat(60));

  const tmp = mkdtempSync(join(ROOT, '.smoke-m2b-'));
  const dataDir = join(tmp, 'data');
  const mediaRoot = join(tmp, 'media');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });

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
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });

    let health = null;
    for (let i = 0; i < 60; i++) {
      try {
        health = await fetch(`${BASE}/api/health`).then(j);
        if (health?.ok) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!health?.ok) throw new Error('服务没起来：\n' + readLogs().slice(-2000));
    check('隔离实例在线', resolve(health.mediaRoot) === resolve(mediaRoot), health.mediaRoot);

    const img1 = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 120, b: 60 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer();
    const img2 = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: 40, g: 100, b: 180 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    // ── 1) F-MED-07 上传查重（同一到访内）──
    const a = await createPlace('冒烟 A');
    const va = a.visits[0].id;
    const up1 = await uploadOne(va, 'a.jpg', img1);
    eq('第一次上传：新增 1', up1.added.length, 1);
    eq('第一次上传：没有跳过', up1.skipped.length, 0);
    const up2 = await uploadOne(va, 'a-copy.jpg', img1);
    eq('同一内容再传同一到访：新增 0', up2.added.length, 0);
    eq('同一内容再传同一到访：跳过 1', up2.skipped.length, 1);
    eq('跳过原因是 duplicate', up2.skipped[0]?.reason, 'duplicate');
    const detailA = await fetch(`${BASE}/api/places/${a.id}`).then(j);
    eq('A 的相册只有 1 张（没有重复入库）', detailA.visits[0].media.length, 1);
    const lib = await fetch(`${BASE}/api/library`).then(j);
    eq('素材库记录数 1', lib.total, 1);
    eq('磁盘上只有 1 个上传文件', walkFiles(mediaRoot).length, 1, walkFiles(mediaRoot).join(','));

    // 同一内容传到另一个到访：按 D-46 允许（跨到访去重只提示不拦）
    const b = await createPlace('冒烟 B', { province_code: '156330000', city_code: '156330100' });
    const vb = b.visits[0].id;
    const up3 = await uploadOne(vb, 'a.jpg', img1);
    eq('同一内容传到另一个到访：仍新增', up3.added.length, 1);
    const lib2 = await fetch(`${BASE}/api/library`).then(j);
    eq('素材库记录数 2（两个到访各一份）', lib2.total, 2);

    // 不同内容正常新增
    const up4 = await uploadOne(va, 'b.jpg', img2);
    eq('不同内容：新增 1', up4.added.length, 1);

    // ── 2) F-MED-09 reveal ──
    const mediaId = up1.added[0].id;
    const reveal = await postJson(`/api/media/${mediaId}/reveal`, { dryRun: true });
    eq('reveal 返回 ok', reveal.ok, true);
    eq('reveal 选中文件', reveal.opened, 'select');
    eq('reveal 不返回绝对路径', reveal.path, undefined);
    let notFound = null;
    try {
      await postJson('/api/media/not-exist/reveal', { dryRun: true });
    } catch (e) {
      notFound = e.status;
    }
    eq('reveal 不存在的媒体 → 404', notFound, 404);

    // 文件被删掉 → 退化为打开父目录（missing=true）
    const allMedia = await fetch(`${BASE}/api/places/${a.id}`).then(j);
    const delTarget = allMedia.visits[0].media[0];
    const files = walkFiles(mediaRoot).filter((p) => p.startsWith('浙江省'));
    const targetRel = files.find((p) => p.includes('冒烟A') && p.endsWith('a.jpg')) || files[0];
    unlinkSync(join(mediaRoot, targetRel));
    const revealMissing = await postJson(`/api/media/${delTarget.id}/reveal`, { dryRun: true });
    eq('文件不在时 reveal 返回 missing', revealMissing.missing, true);
    eq('文件不在时退化为打开父目录', revealMissing.opened, 'folder');

    // ── 3) F-PLC-08 合并 ──
    const aDetailBefore = await fetch(`${BASE}/api/places/${a.id}`).then(j);
    const dup = await createPlace('冒烟 A 重复');
    const dupVisit = dup.visits[0].id;
    await uploadOne(dupVisit, 'dup.jpg', img2); // 让重复地点有媒体
    const dupDetail = await fetch(`${BASE}/api/places/${dup.id}`).then(j);
    eq('重复地点有 1 次到访', dupDetail.visits.length, 1);

    const mergeErr = await (async () => {
      try {
        await postJson('/api/places/merge', { fromId: dup.id, intoId: a.id, force: true });
        return null;
      } catch (e) {
        return e;
      }
    })();
    eq('同省市合并成功', mergeErr, null);
    const mergedA = await fetch(`${BASE}/api/places/${a.id}`).then(j);
    eq(
      '合并后到访数 = 2',
      mergedA.visits.length,
      aDetailBefore.visits.length + 1,
      JSON.stringify(mergedA.visits.map((v) => v.date))
    );
    const listAfter = await fetch(`${BASE}/api/places`).then(j);
    check('来源地点已从列表消失', !listAfter.some((p) => p.id === dup.id));
    let dupStatus = 200;
    try {
      await fetch(`${BASE}/api/places/${dup.id}`).then(j);
    } catch (e) {
      dupStatus = e.status;
    }
    eq('来源地点详情 404', dupStatus, 404);
    // 重复地点合并后，媒体记录还挂在迁过来的到访上
    check(
      '合并后媒体仍在（总数不变）',
      mergedA.visits.reduce((n, v) => n + v.media.length, 0) >= 2,
      String(mergedA.visits.reduce((n, v) => n + v.media.length, 0))
    );

    // 省市不一致 → 409 需要二次确认；force=true 才合并
    const far = await createPlace('冒烟 远方', {
      province: '西藏自治区',
      city: '拉萨市',
      county: '城关区',
      province_code: '156540000',
      city_code: '156540100',
      county_code: '156540102',
    });
    let conflict = null;
    try {
      await postJson('/api/places/merge', { fromId: far.id, intoId: a.id });
    } catch (e) {
      conflict = e;
    }
    eq('省市不一致 → 409', conflict?.status, 409);
    eq('409 带 needConfirm', conflict?.body?.needConfirm, true);
    const forced = await postJson('/api/places/merge', {
      fromId: far.id,
      intoId: a.id,
      force: true,
    });
    check('force=true 后合并成功', forced.ok === true);

    // 类型不同不许合并
    const wish = await createPlace('冒烟 想去', { kind: 'wishlist', date: undefined });
    let kindErr = null;
    try {
      await postJson('/api/places/merge', { fromId: wish.id, intoId: a.id, force: true });
    } catch (e) {
      kindErr = e;
    }
    eq('类型不同（想去→去过）→ 400', kindErr?.status, 400);

    // 自己合并自己 → 400
    let selfErr = null;
    try {
      await postJson('/api/places/merge', { fromId: a.id, intoId: a.id, force: true });
    } catch (e) {
      selfErr = e;
    }
    eq('合并自己 → 400', selfErr?.status, 400);

    // ── 4) 清理数据量检查 ──
    const finalLib = await fetch(`${BASE}/api/library`).then(j);
    check('最终素材库记录数合理（>=2）', finalLib.total >= 2, String(finalLib.total));
    check('没有残留的 0 字节 .part 文件', walkFiles(mediaRoot).every((p) => !p.endsWith('.part')));
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

  console.log('─'.repeat(60));
  console.log(fail === 0 ? '全部通过 ✅' : `${fail} 项失败 ❌`);
  process.exitCode = fail === 0 ? 0 : 1;
};

run().catch((e) => {
  console.error('\nM2 功能冒烟异常：', e?.message || e);
  process.exitCode = 1;
});
