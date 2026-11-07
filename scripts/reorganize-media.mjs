/**
 * 把素材库迁移到新结构：省 / 市 / 区县 / 日期_地点名（D-35）
 *
 *   node scripts/reorganize-media.mjs         # 预览，只列出会怎么移动
 *   node scripts/reorganize-media.mjs --yes   # 真正移动并更新数据库
 *   node scripts/reorganize-media.mjs --root=<素材库目录>
 *
 * 只处理数据库里还在用的媒体；素材库里未被数据库引用的文件不动。
 */
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  readdirSync,
  rmdirSync,
  readFileSync,
} from 'node:fs';
import { resolve, join, dirname, basename, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--yes');
const rootArg = process.argv.find((a) => a.startsWith('--root='));

try {
  if (existsSync(resolve(ROOT, '.env.local'))) process.loadEnvFile(resolve(ROOT, '.env.local'));
} catch {
  /* 忽略 */
}

let localRoot = null;
try {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'));
  if (cfg.mediaRoot) localRoot = resolve(cfg.mediaRoot);
} catch {
  /* 没有就算了 */
}

const db = new DatabaseSync(resolve(ROOT, 'data', 'travel.db'), { readOnly: !apply });

const safeName = (s) =>
  String(s || '地点').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '').slice(0, 60) || '地点';
const safeSeg = (s) =>
  String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 48) || '未标注';

function candidateRoots() {
  const list = [];
  const push = (p) => {
    if (!p) return;
    const abs = resolve(p);
    if (!list.includes(abs) && existsSync(abs)) list.push(abs);
  };
  if (rootArg) push(rootArg.slice('--root='.length));
  push(localRoot);
  push(resolve(ROOT, '.dev-media'));
  push(process.env.MEDIA_ROOT);
  push(process.env.MEDIA_ROOT_DEV);
  return list;
}

const allRows = db.prepare('SELECT id, rel_path FROM media').all();
const roots = candidateRoots();
let root = roots[0] || resolve(ROOT, '.dev-media');
let best = -1;
for (const r of roots) {
  const score = allRows.filter((m) => existsSync(resolve(r, m.rel_path))).length;
  if (score > best) {
    best = score;
    root = r;
  }
}
if (roots.length > 1) {
  console.log('候选素材库：');
  for (const r of roots) {
    const score = allRows.filter((m) => existsSync(resolve(r, m.rel_path))).length;
    console.log(`  ${r}  （命中 ${score}/${allRows.length} 个文件）${r === root ? ' ← 采用' : ''}`);
  }
}

const rows = db.prepare(`
  SELECT m.id, m.rel_path, v.date, p.name AS place_name, p.province, p.city, p.county
  FROM media m
  JOIN visit v ON v.id = m.visit_id
  JOIN place p ON p.id = v.place_id
  WHERE m.deleted_at IS NULL AND v.deleted_at IS NULL
`).all();

console.log(`\n待整理媒体：${rows.length} 条（${apply ? '执行模式' : '预览模式，加 --yes 才移动'}）`);
console.log('素材库:', root, '\n');

const update = db.prepare('UPDATE media SET rel_path = ? WHERE id = ?');
let moved = 0;
let skipped = 0;
let missing = 0;
const oldDirs = new Set();

for (const r of rows) {
  const src = resolve(root, r.rel_path);
  const targetRel = join(
    safeSeg(r.province),
    safeSeg(r.city),
    safeSeg(r.county),
    `${r.date}_${safeName(r.place_name)}`,
    basename(r.rel_path)
  );
  const dst = resolve(root, targetRel);

  if (!src.startsWith(root + sep) || !dst.startsWith(root + sep)) {
    console.log(`跳过（路径越界）：${r.rel_path}`);
    skipped += 1;
    continue;
  }
  if (r.rel_path === targetRel) {
    skipped += 1;
    continue;
  }
  if (!existsSync(src)) {
    console.log(`缺失文件：${r.rel_path}`);
    missing += 1;
    continue;
  }

  // 目标重名就加 -1/-2 后缀
  let finalDst = dst;
  if (existsSync(finalDst)) {
    const ext = extname(dst);
    const base = basename(dst, ext);
    let i = 1;
    do {
      finalDst = join(dirname(dst), `${base}-${i++}${ext}`);
    } while (existsSync(finalDst));
  }
  const finalRel = finalDst.slice(root.length + 1);

  console.log(`${r.rel_path}\n  → ${finalRel}`);
  if (!apply) {
    moved += 1;
    oldDirs.add(dirname(src));
    continue;
  }

  try {
    mkdirSync(dirname(finalDst), { recursive: true });
    try {
      renameSync(src, finalDst);
    } catch {
      // 跨盘或占用时退回复制+删除
      copyFileSync(src, finalDst);
      unlinkSync(src);
    }
    update.run(finalRel, r.id);
    moved += 1;
    oldDirs.add(dirname(src));
  } catch (e) {
    console.log(`  失败：${e.message}`);
    skipped += 1;
  }
}

// 清掉搬空的旧目录（只删素材库内、空着的）
function pruneEmpty(dir) {
  let cur = dir;
  while (cur.startsWith(root + sep) && cur !== root) {
    try {
      if (readdirSync(cur).length > 0) break;
      rmdirSync(cur);
      cur = dirname(cur);
    } catch {
      break;
    }
  }
}
if (apply) {
  for (const d of [...oldDirs].sort((a, b) => b.length - a.length)) pruneEmpty(d);
}

console.log('---');
console.log(
  `${apply ? '已移动' : '将移动'} ${moved} 个文件` +
    (skipped ? `，跳过 ${skipped} 个` : '') +
    (missing ? `，缺失 ${missing} 个` : '') +
    (apply ? '' : '（预览，未改动任何文件）')
);
