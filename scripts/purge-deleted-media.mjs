/**
 * 清理「旧版软删」遗留的媒体文件
 *
 * ⚠️ 2026-11-02 起（D-56）删除照片/视频改为**软删进回收站**，正常请用界面
 *    「顶栏 → 回收站 → 彻底删除」来释放空间；这个脚本绕过了回收站，不再建议使用。
 *    只有清理 2026-11-02 之前旧版软删遗留时才用它，且必须显式加 `--legacy`。
 *
 *   node scripts/purge-deleted-media.mjs --legacy          # 预览，不删
 *   node scripts/purge-deleted-media.mjs --legacy --yes    # 真正删除
 *   node scripts/purge-deleted-media.mjs --legacy --root=<素材库目录>  # 手动指定素材库
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, unlinkSync, statSync, readFileSync } from 'node:fs';
import { resolve, join, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--yes');
const rootArg = process.argv.find((a) => a.startsWith('--root='));

if (!process.argv.includes('--legacy')) {
  console.log(
    '这个脚本会绕过回收站直接物理删除媒体。\n' +
      '正常请用界面「回收站 → 彻底删除」；如确需清理旧版软删遗留，请加 --legacy 再运行。'
  );
  process.exit(0);
}

// 读 .env.local（只用来找素材库路径，不关心其它变量）
try {
  if (existsSync(resolve(ROOT, '.env.local'))) process.loadEnvFile(resolve(ROOT, '.env.local'));
} catch {
  /* 忽略 */
}

// 运行期覆盖：data/config.json
let localRoot = null;
try {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, 'data', 'config.json'), 'utf8'));
  if (cfg.mediaRoot) localRoot = resolve(cfg.mediaRoot);
} catch {
  /* 没有就算了 */
}

const db = new DatabaseSync(resolve(ROOT, 'data', 'travel.db'), { readOnly: !apply });

/** 候选素材库根目录（去重、只保留存在的） */
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

const allMedia = db.prepare('SELECT rel_path FROM media').all();
const roots = candidateRoots();

// 自动识别：哪个根目录下实际存在的文件最多，就用哪个
let root = roots[0] || resolve(ROOT, '.dev-media');
let best = -1;
for (const r of roots) {
  const score = allMedia.filter((m) => existsSync(resolve(r, m.rel_path))).length;
  if (score > best) {
    best = score;
    root = r;
  }
}
if (roots.length > 1) {
  console.log('候选素材库：');
  for (const r of roots) {
    const score = allMedia.filter((m) => existsSync(resolve(r, m.rel_path))).length;
    console.log(`  ${r}  （命中 ${score}/${allMedia.length} 个文件）${r === root ? ' ← 采用' : ''}`);
  }
}

const rows = db.prepare(`
  SELECT m.id, m.rel_path, m.thumb, m.poster, m.kind
  FROM media m
  JOIN visit v ON v.id = m.visit_id
  WHERE m.deleted_at IS NOT NULL AND v.deleted_at IS NULL
`).all();

if (!rows.length) {
  console.log('没有需要清理的软删媒体。');
  process.exit(0);
}

console.log(`\n软删遗留：${rows.length} 条（${apply ? '删除模式' : '预览模式，加 --yes 才会真删'}）`);
console.log('素材库:', root, '\n');

let freed = 0;
let removed = 0;
const removeCache = db.prepare('DELETE FROM media WHERE id = ?');
const clearCover = db.prepare('UPDATE place SET cover_media_id = NULL WHERE cover_media_id = ?');

for (const r of rows) {
  const abs = resolve(root, r.rel_path);
  const inRoot = abs.startsWith(root + sep);
  const exists = existsSync(abs);
  const size = exists ? statSync(abs).size : 0;
  console.log(
    `- [${r.kind}] ${r.rel_path}${exists ? `  ${(size / 1024 / 1024).toFixed(1)}MB` : '  (文件已不在)'}`
  );
  if (!inRoot) {
    console.log('  跳过：路径不在素材库内');
    continue;
  }
  freed += size;
  removed += 1;
  if (!apply) continue;

  if (exists) {
    try {
      unlinkSync(abs);
    } catch (e) {
      console.log('  文件删除失败，保留记录：', e.message);
      removed -= 1;
      freed -= size;
      continue;
    }
  }
  for (const f of [r.thumb, r.poster, `${r.id}_p.webp`]) {
    if (!f) continue;
    try {
      unlinkSync(join(resolve(ROOT, 'data', 'thumbs'), f));
    } catch {
      /* 没缓存就算了 */
    }
  }
  clearCover.run(r.id);
  removeCache.run(r.id);
}

console.log('---');
console.log(
  apply
    ? `已删除 ${removed} 条记录，释放 ${(freed / 1024 / 1024).toFixed(1)}MB`
    : `可释放 ${(freed / 1024 / 1024).toFixed(1)}MB（预览，未改动任何文件）`
);
