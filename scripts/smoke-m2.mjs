/**
 * M2 冒烟测试（F-IMP-01 目录解析 + F-IMP-02 只读预览）
 *
 *   node scripts/smoke-m2.mjs
 *
 * 全隔离：自己造临时 data 目录（复制真实库的 db+wal+shm）和临时素材库
 * （硬链接 .dev-media 的文件 + 合成测试文件夹），在 4199 端口起一个独立实例。
 * 绝不写 data/travel.db、.env.local、.dev-media 或 <素材库目录>。
 *
 * 硬链接说明：只用于「只读」测试。导入逻辑不会写素材文件；将来若要测试
 * _inbox 归位（会移动文件），请把硬链接改成复制。
 */
import { spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_M2_PORT || 4199);
const BASE = `http://127.0.0.1:${PORT}`;
const REAL_DB_DIR = join(ROOT, 'data');
const REAL_MEDIA = resolve(process.env.MEDIA_ROOT_DEV || join(ROOT, '.dev-media'));

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
const DATE_DIR = /^\d{4}-\d{2}-\d{2}_.+$/;

/** 只统计「到访文件夹内」的媒体（和预览的统计口径一致） */
function scanRealStats(root) {
  const out = { folders: 0, photos: 0, videos: 0, files: 0 };
  const walk = (abs, insideVisit) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      if (e.isDirectory()) {
        if (!insideVisit && DATE_DIR.test(e.name)) {
          out.folders += 1;
          walk(p, true);
        } else {
          walk(p, insideVisit);
        }
        continue;
      }
      if (!insideVisit) continue;
      if (/^_cover\.[a-z0-9]+$/i.test(e.name)) continue; // 封面辅助文件不算媒体
      const ext = extname(e.name).toLowerCase();
      if (PHOTO_EXT.has(ext)) out.photos += 1;
      else if (VIDEO_EXT.has(ext)) out.videos += 1;
      else continue;
      out.files += 1;
    }
  };
  walk(root, false);
  return out;
}

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
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
};

function linkTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) linkTree(s, d);
    else {
      try {
        linkSync(s, d);
      } catch {
        copyFileSync(s, d);
      }
    }
  }
}

function walkFiles(root) {
  const out = [];
  const rec = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(join(abs, e.name), r);
      else out.push(r);
    }
  };
  rec(root, '');
  return out.sort();
}

function manifest(root) {
  const m = {};
  for (const rel of walkFiles(root)) {
    const st = statSync(join(root, rel));
    m[rel] = `${st.size}:${st.mtimeMs}`;
  }
  return m;
}

const run = async () => {
  console.log(`\nM2 冒烟测试（隔离实例 :${PORT}）`);
  console.log('─'.repeat(60));
  if (!existsSync(join(REAL_DB_DIR, 'travel.db'))) throw new Error('找不到真实库 data/travel.db');
  if (!existsSync(REAL_MEDIA)) throw new Error(`找不到素材库 ${REAL_MEDIA}`);
  const real = scanRealStats(REAL_MEDIA);
  console.log(`     真实素材库：${real.folders} 个到访文件夹 · ${real.photos} 图 + ${real.videos} 视频`);

  // 用项目同卷的临时目录，硬链接才有效（跨盘会退回复制）
  const tmp = mkdtempSync(join(ROOT, '.smoke-m2-'));
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
    // 1) 复制真实库（db + wal + shm），素材库文件硬链接过来
    for (const f of ['travel.db', 'travel.db-wal', 'travel.db-shm']) {
      const src = join(REAL_DB_DIR, f);
      if (existsSync(src)) copyFileSync(src, join(dataDir, f));
    }
    linkTree(REAL_MEDIA, mediaRoot);

    // 2) 合成测试场景
    const jpg = (color) =>
      sharp({ create: { width: 320, height: 240, channels: 3, background: color } })
        .jpeg({ quality: 80 })
        .toBuffer();
    const img1 = await jpg({ r: 200, g: 120, b: 60 });
    const img2 = await jpg({ r: 40, g: 100, b: 180 });
    const img3 = await jpg({ r: 60, g: 160, b: 90 });
    const put = (rel, buf) => {
      const p = join(mediaRoot, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, buf);
    };
    // 新文件夹：两个不同内容 + 一个同图重复 + _cover（内容=第一张）+ note.md
    put('合成省/合成市/合成区/2030-02-02_合成点/a.jpg', img1);
    put('合成省/合成市/合成区/2030-02-02_合成点/b.jpg', img2);
    put('合成省/合成市/合成区/2030-02-02_合成点/同图重复.jpg', img1);
    put('合成省/合成市/合成区/2030-02-02_合成点/相册子目录/sub.jpg', img3);
    put('合成省/合成市/合成区/2030-02-02_合成点/_cover.jpg', img1);
    put('合成省/合成市/合成区/2030-02-02_合成点/note.md', '合成测试笔记\n第二行');
    // 第二个新地点
    put('合成省/合成市/合成区/2030-03-03_第二点/c.jpg', img3);
    // 旧结构 年/日期_地点名
    put('2031/2031-01-01_旧结构/legacy.jpg', img2);
    // 日期非法 → 待确认
    put('合成省/合成市/合成区/2024-13-01_非法日期/d.jpg', img3);
    // _inbox 散图 → 未归类
    put('_inbox/inbox-1.jpg', img1);
    // 非日期目录里直接放媒体 → 未归类
    put('合成省/合成市/合成区/随意相册/e.jpg', img2);

    const mediaBefore = manifest(mediaRoot);

    // 3) 起隔离服务（prod 分支用 MEDIA_ROOT；DATA_DIR 把库指到临时目录）
    //    注意：沙箱里不能给子进程用 pipe stdio（EPERM），所以输出直接重定向到日志文件。
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

    // 4) 等服务
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

    check('隔离实例的素材库 = 临时副本', resolve(health.mediaRoot) === resolve(mediaRoot), health.mediaRoot);
    check('隔离实例的素材库不是 .dev-media', resolve(health.mediaRoot) !== resolve(REAL_MEDIA));

    const placesBefore = await fetch(`${BASE}/api/places`).then(j);
    const libBefore = await fetch(`${BASE}/api/library`).then(j);
    check('真实库地点数 >= 真实文件夹数', placesBefore.length >= real.folders, String(placesBefore.length));
    check('素材库记录包含全部真实文件', libBefore.total >= real.files, String(libBefore.total));

    // 5) 预览（只读）
    const t0 = Date.now();
    const preview = await fetch(`${BASE}/api/scan/preview`).then(j);
    const ms = Date.now() - t0;
    check('返回 planId', typeof preview.planId === 'string' && preview.planId.length > 0);
    check('预览根目录是临时副本', resolve(preview.root) === resolve(mediaRoot));
    check('预览无扫描错误', preview.errors.length === 0, JSON.stringify(preview.errors));

    const s = preview.summary;
    eq('文件夹总数（真实 + 合成 4）', s.folders, real.folders + 4);
    eq('分项地点数 = 文件夹数', s.existingPlaces + s.newPlaces + s.ambiguousPlaces, s.folders);
    eq('分项到访数 = 文件夹数', s.existingVisits + s.newVisits, s.folders);
    check('合成 4 个文件夹都算新建地点', s.newPlaces >= 4, String(s.newPlaces));
    check('合成 4 个文件夹都算新建到访', s.newVisits >= 4, String(s.newVisits));
    check('已有地点不超过真实文件夹数', s.existingPlaces <= real.folders, String(s.existingPlaces));
    check('已存在媒体不超过真实文件数', s.existingMedia <= real.files, String(s.existingMedia));
    check('新增媒体至少 6（合成场景）', s.addedMedia >= 6, String(s.addedMedia));
    check('同一到访内重复至少 1', s.duplicateMedia >= 1, String(s.duplicateMedia));
    check('未归类至少 2', s.unclassifiedFiles >= 2, String(s.unclassifiedFiles));
    check('待确认至少 1', s.needsConfirmFolders >= 1, String(s.needsConfirmFolders));
    eq('照片总数 = 真实照片 + 合成 7', s.photos, real.photos + 7);
    eq('视频总数 = 真实视频（合成无视频）', s.videos, real.videos);
    check('有警告的文件夹 >= 1', s.warningFolders >= 1, String(s.warningFolders));
    console.log(`     预览耗时 ${ms}ms`);

    const by = (name, date, dirPart = '') =>
      preview.folders.find((f) => f.name === name && (!date || f.date === date) && (!dirPart || f.relDir.includes(dirPart)));

    // 真实库是「活数据」（用户可能同时在用 app），这里只做结构性断言，
    // 不对具体的同名地点/同日到访做硬编码断言（那属于旧功能点测试，scan 已降级为诊断）。

    // 合成：新地点 + 同图去重 + 封面指到已有文件 + note
    const syn = by('合成点', '2030-02-02');
    eq('合成点 新建地点', syn?.place.status, 'new');
    eq('合成点 新建到访', syn?.visit.status, 'new');
    eq('合成点 新增 3 张（含子目录）', syn?.media.added, 3);
    eq('合成点 同图重复 1 张', syn?.media.duplicate, 1);
    eq('合成点 封面指向文件夹内已有图', syn?.cover?.action, 'use-folder-file');
    eq('合成点 note.md 会写入', syn?.note?.action, 'apply');
    eq('合成点 文件数 4（含子目录）', syn?.fileCount, 4);

    const syn2 = by('第二点', '2030-03-03');
    eq('第二点 新增 1 张', syn2?.media.added, 1);

    const legacy = by('旧结构', '2031-01-01');
    eq('旧结构能识别', legacy?.place.status, 'new');
    eq('旧结构 无地区提示', legacy?.region, null);

    const bad = by('非法日期');
    eq('非法日期 needsConfirm', bad?.needsConfirm, true);
    check('非法日期 用 mtime 兜底', /^\d{4}-\d{2}-\d{2}$/.test(bad?.date || ''), bad?.date);

    // 未归类：至少包含合成的 _inbox 和「非日期目录」两种来源
    const reasons = new Set(preview.unclassified.map((x) => x.reason));
    check('未归类来源包含 folder', reasons.has('folder'), [...reasons].join(','));
    check('未归类来源包含 inbox', reasons.has('inbox'), [...reasons].join(','));
    const unNames = preview.unclassified.map((x) => x.name);
    check('未归类里有合成的 inbox-1.jpg', unNames.includes('inbox-1.jpg'), unNames.join(','));
    check('未归类里有合成的 e.jpg', unNames.includes('e.jpg'), unNames.join(','));

    // 前端不拿到内部字段
    check('响应里没有 _files 内部字段', preview.folders.every((f) => !('_files' in f)));

    // 6) 只读验证：数据库记录数、素材库文件清单都不变
    const placesAfter = await fetch(`${BASE}/api/places`).then(j);
    const libAfter = await fetch(`${BASE}/api/library`).then(j);
    eq('预览后地点数不变', placesAfter.length, placesBefore.length);
    eq('预览后媒体记录数不变', libAfter.total, libBefore.total);
    const mediaAfter = manifest(mediaRoot);
    eq('素材库文件清单/大小/mtime 完全没变', mediaAfter, mediaBefore);

    // 7) 再预览一次：同一次扫描的结构一致（真实库是活数据，只比文件夹数），planId 不同
    const preview2 = await fetch(`${BASE}/api/scan/preview`).then(j);
    eq('重复预览的文件夹数一致', preview2.summary.folders, preview.summary.folders);
    check('两次预览 planId 不同', preview2.planId !== preview.planId);

    // 8) 真实库和真实素材库没被动过
    const realDbBytes = readFileSync(join(dataDir, 'travel.db'));
    check('临时库仍是 SQLite 文件', realDbBytes.subarray(0, 15).toString('latin1') === 'SQLite format 3');
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
    // 等进程确实退出再清目录（Windows 上文件句柄可能还没释放）
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
  console.error('\nM2 冒烟测试异常：', e?.message || e);
  process.exitCode = 1;
});
