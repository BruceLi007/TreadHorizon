#!/usr/bin/env node
/**
 * M6 P2-2 旧数据迁移：把「本地单机数据」归到指定管理员账号（2026-11-06，D-202）
 *
 *   # 1) 先确保管理员账号存在（二选一）：
 *   #    npm run init:admin -- admin 你的密码
 *   #    或启动一次 AUTH_MODE=multi + ADMIN_USERNAME/ADMIN_PASSWORD 自动创建
 *   # 2) 停止服务后运行（默认只预演，不改任何东西）：
 *   node scripts/migrate-multiuser.mjs --admin admin
 *   # 3) 确认预演报告没问题后真正执行：
 *   node scripts/migrate-multiuser.mjs --admin admin --apply
 *
 * 做什么：
 * - 运行前把当前库用 `VACUUM INTO` 备份到 data/backups/pre-p2-2-migration-<时间>.db；
 * - 把 place / visit / media 里 user_id 为 NULL 的行全部归到管理员；
 * - 媒体原片从 mediaRoot/<省/市/…> **复制**到 mediaRoot/<管理员id>/<省/市/…>（不删原文件）；
 * - 缩略图 / 1600 预览 / 视频封面帧从 data/thumbs/ 复制到 data/thumbs/<管理员id>/；
 * - 校验行数与抽样文件，输出报告；任何冲突会中止（不会把库改到一半）。
 *
 * 安全：本脚本只复制文件、不移动 / 不删除；DB 修改在一个事务里；失败可回滚。
 * 幂等：可重复运行；没有 NULL owner 的行时直接退出。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONFIG } from '../server/config.mjs';
import { db, now } from '../server/db.mjs';
import { findUserByUsername } from '../server/auth.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const adminName = (() => {
  const i = args.indexOf('--admin');
  if (i >= 0 && args[i + 1]) return args[i + 1].trim();
  const positional = args.filter((a) => !a.startsWith('--'));
  return positional[0]?.trim() ?? '';
})();

const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};

if (!adminName) {
  fail(
    '缺少管理员用户名。用法：node scripts/migrate-multiuser.mjs --admin <用户名> [--apply]'
  );
}

const admin = findUserByUsername(adminName);
if (!admin) {
  fail(`找不到账号「${adminName}」。请先运行 npm run init:admin -- ${adminName} <密码> 创建管理员。`);
}
if (admin.role !== 'admin') {
  fail(`账号「${adminName}」不是管理员（role=${admin.role}），请用管理员账号迁移。`);
}

const adminId = admin.id;
const modeText = apply ? '执行迁移' : '预演（不改任何东西）';
console.log('─'.repeat(64));
console.log(`M6 P2-2 旧数据迁移 · ${modeText}`);
console.log(`  数据库：${join(CONFIG.dataDir, 'travel.db')}`);
console.log(`  素材库：${CONFIG.mediaRoot}`);
console.log(`  缓存：  ${CONFIG.thumbDir}`);
console.log(`  管理员：${admin.username}（${adminId}）`);
console.log('─'.repeat(64));

// ── 1) 统计待迁移行 ─────────────────────────────────────────
const counts = {
  place: db.prepare('SELECT COUNT(*) AS n FROM place WHERE user_id IS NULL').get().n,
  visit: db.prepare('SELECT COUNT(*) AS n FROM visit WHERE user_id IS NULL').get().n,
  media: db.prepare('SELECT COUNT(*) AS n FROM media WHERE user_id IS NULL').get().n,
};
const total = counts.place + counts.visit + counts.media;
if (total === 0) {
  console.log('✅ 没有 user_id 为 NULL 的数据行：已经是迁移后的状态，无需迁移。');
  process.exit(0);
}

const otherUsers = db
  .prepare("SELECT user_id, COUNT(*) AS n FROM place WHERE user_id IS NOT NULL GROUP BY user_id")
  .all();
console.log(
  `待迁移：地点 ${counts.place} · 到访 ${counts.visit} · 媒体 ${counts.media}` +
    (otherUsers.length ? `（另有 ${otherUsers.length} 个账号已有数据，只会迁移 NULL 行）` : '')
);

// ── 2) 媒体文件计划 ─────────────────────────────────────────
const mediaRows = db
  .prepare(
    `SELECT id, rel_path, thumb, poster FROM media WHERE user_id IS NULL ORDER BY created_at`
  )
  .all();

/** 把 owner 前缀加进相对路径（已经是 <adminId>/ 开头就不重复加） */
const withOwner = (relPath) => {
  const rel = String(relPath || '');
  if (!rel) return rel;
  return rel === adminId || rel.startsWith(`${adminId}/`) || rel.startsWith(`${adminId}\\`)
    ? rel
    : `${adminId}/${rel}`;
};

/** 收集要复制的文件：src 绝对路径 → dst 绝对路径 */
const copies = new Map(); // dst -> src
let missingSrc = 0;
let dstConflicts = 0;
let bytesToCopy = 0;

const planCopy = (src, dst) => {
  if (!src) return;
  if (!existsSync(src)) {
    missingSrc += 1;
    return;
  }
  if (existsSync(dst)) {
    try {
      if (statSync(dst).size === statSync(src).size) return; // 已复制过（幂等）
    } catch {
      /* fallthrough */
    }
    dstConflicts += 1;
    return;
  }
  copies.set(dst, src);
  try {
    bytesToCopy += statSync(src).size;
  } catch {
    /* ignore */
  }
};

for (const m of mediaRows) {
  const rel = withOwner(m.rel_path);
  planCopy(join(CONFIG.mediaRoot, m.rel_path), join(CONFIG.mediaRoot, rel));
  for (const cache of [m.thumb, m.poster]) {
    if (cache) planCopy(join(CONFIG.thumbDir, cache), join(CONFIG.thumbDir, adminId, cache));
  }
  // 1600px 预览缓存：<id>_p.webp（可能不存在）
  planCopy(
    join(CONFIG.thumbDir, `${m.id}_p.webp`),
    join(CONFIG.thumbDir, adminId, `${m.id}_p.webp`)
  );
}

const fmtMb = (n) => (n / 1024 ** 2).toFixed(1) + ' MB';
console.log(
  `媒体文件：需复制 ${copies.size} 个 / ${fmtMb(bytesToCopy)}；` +
    `源缺失 ${missingSrc} 个；目标已存在但大小不同 ${dstConflicts} 个`
);

if (dstConflicts > 0) {
  fail(
    `有 ${dstConflicts} 个目标文件已存在且大小不同（mediaRoot/<管理员>/… 或 data/thumbs/<管理员>/…）。` +
      '为避免覆盖，已中止。请先检查 / 清理目标目录后重试。'
  );
}

if (!apply) {
  console.log('');
  console.log('预演完成（未改任何东西）。确认上面数字无误后加 --apply 执行：');
  console.log(`  node scripts/migrate-multiuser.mjs --admin ${adminName} --apply`);
  console.log('⚠️ 执行前请先停止服务（避免数据库被写入）。');
  process.exit(0);
}

// ── 3) 备份数据库快照 ──────────────────────────────────────
const backupsDir = join(CONFIG.dataDir, 'backups');
mkdirSync(backupsDir, { recursive: true });
const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
const snapshot = resolve(backupsDir, `pre-p2-2-migration-${stamp}.db`);
db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
console.log(`✅ 迁移前数据库快照：${snapshot}`);

// ── 4) 复制素材文件（先复制、后改库；失败不改库） ───────────
let copied = 0;
try {
  for (const [dst, src] of copies) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied += 1;
  }
} catch (e) {
  fail(
    `复制素材失败：${e?.message || e}\n数据库未修改（快照在 ${snapshot}）。` +
      '可以清理已复制的部分文件后重试（脚本幂等，已存在且大小相同的会跳过）。'
  );
}
console.log(`✅ 已复制素材文件 ${copied} 个（原文件保留未动）`);

// ── 5) 数据库事务：更新 user_id + 媒体相对路径 ──────────────
const updateRelPath = db.prepare('UPDATE media SET rel_path = ? WHERE id = ? AND user_id IS NULL');
try {
  db.exec('BEGIN IMMEDIATE');
  const placeN = db.prepare('UPDATE place SET user_id = ? WHERE user_id IS NULL').run(adminId).changes;
  const visitN = db.prepare('UPDATE visit SET user_id = ? WHERE user_id IS NULL').run(adminId).changes;
  let pathN = 0;
  for (const m of mediaRows) {
    const rel = withOwner(m.rel_path);
    if (rel !== m.rel_path) pathN += updateRelPath.run(rel, m.id).changes;
  }
  const mediaN = db.prepare('UPDATE media SET user_id = ? WHERE user_id IS NULL').run(adminId).changes;
  db.exec('COMMIT');
  console.log(
    `✅ 数据库已更新：place +${placeN} · visit +${visitN} · media +${mediaN}（其中 rel_path 改写 ${pathN} 条）`
  );
} catch (e) {
  try {
    db.exec('ROLLBACK');
  } catch {
    /* ignore */
  }
  fail(
    `数据库更新失败，已回滚：${e?.message || e}\n` +
      `如需完全恢复：先停止服务，用快照覆盖回去：${snapshot}`
  );
}

// ── 6) 校验 ────────────────────────────────────────────────
const remain = {
  place: db.prepare('SELECT COUNT(*) AS n FROM place WHERE user_id IS NULL').get().n,
  visit: db.prepare('SELECT COUNT(*) AS n FROM visit WHERE user_id IS NULL').get().n,
  media: db.prepare('SELECT COUNT(*) AS n FROM media WHERE user_id IS NULL').get().n,
};
const owned = {
  place: db.prepare('SELECT COUNT(*) AS n FROM place WHERE user_id = ?').get(adminId).n,
  visit: db.prepare('SELECT COUNT(*) AS n FROM visit WHERE user_id = ?').get(adminId).n,
  media: db.prepare('SELECT COUNT(*) AS n FROM media WHERE user_id = ?').get(adminId).n,
};
const sample = db
  .prepare('SELECT id, rel_path FROM media WHERE user_id = ? LIMIT 5')
  .all(adminId);
let sampleOk = 0;
for (const s of sample) {
  if (existsSync(join(CONFIG.mediaRoot, s.rel_path))) sampleOk += 1;
}
const remainingNull = remain.place + remain.visit + remain.media;

console.log('');
console.log('─'.repeat(64));
console.log(
  `校验：管理员名下 place ${owned.place} / visit ${owned.visit} / media ${owned.media}；` +
    `剩余 NULL 行 ${remainingNull}；抽样原片 ${sampleOk}/${sample.length} 存在`
);
if (remainingNull !== 0) {
  fail('迁移后仍有 NULL owner 行，请检查。');
}
if (sample.length > 0 && sampleOk !== sample.length) {
  console.log('⚠️ 抽样有原片不存在（可能是素材库本来就缺文件），请到设置 → 素材库重新关联 / 核对。');
}
console.log('✅ 迁移完成。');
console.log('');
console.log('回滚方式（如确认要退回）：停止服务 → 把快照拷回 data/travel.db：');
console.log(`  copy "${snapshot}" "${join(CONFIG.dataDir, 'travel.db')}"`);
console.log('（迁移只复制了素材文件，未移动 / 未删除任何原文件；确认新目录没问题后可手动清理旧位置。）');
