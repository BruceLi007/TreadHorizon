/**
 * 历史路径启动自愈（2026-11-11 D-388 / backup/LOCAL-CROSSPLATFORM-BRIEF.md §3.4）
 *
 * 背景：本地版旧库里 `media.rel_path` / `media.thumb` / `media.poster` 曾按本机分隔符存
 * （Windows 是 `\`）。从本版起数据库里的路径一律 POSIX `/`（见 server/paths.mjs 文件头约定），
 * 所以启动时（以及备份恢复落库后）要把历史值就地归一化，否则换到 macOS 上会把整串
 * `a\b\c` 当成一个文件名，素材全部找不到。
 *
 * 契约（backup.mjs 恢复流程 / scripts 工具会直接 import 本文件）：
 *
 *   import { healStoredPaths } from './path-heal.mjs';
 *   const result = healStoredPaths(db, { log = () => {}, dryRun = false });
 *   // result = {
 *   //   media:  { normalized: 0, conflicts: [] },   // rel_path
 *   //   thumb:  { normalized: 0 },
 *   //   poster: { normalized: 0 },
 *   // }
 *
 * 约定：
 * - 幂等：已经全是 `/` 的库再跑返回全 0，不写任何行；
 * - 事务：真正 UPDATE 在一个事务里完成，失败整体回滚（dryRun 不写库，只统计）；
 * - UNIQUE 冲突不静默覆盖：`media.rel_path` 有唯一约束，若某行归一化后与另一行现有值相同
 *   （理论上不应该出现），跳过该行、保留原值，并把 `{ id, from, to }` 记进 `media.conflicts`，
 *   由调用方决定人工处理（migrate-paths 会给出提示）；
 * - `thumb` / `poster` 是可空列：NULL / 空串保持原样不写入；本地模式这两列是裸文件名
 *   （如 `<id>.webp`），没有分隔符时不会产生更新；
 * - 只依赖 `node:sqlite` 的 db 对象（由调用方传入）+ server/paths.mjs，不 import db.mjs，
 *   避免循环依赖，也方便脚本对临时库单独调用。
 */
import { normalizeRel } from './paths.mjs';

/**
 * 把一批 UPDATE 写进事务（dryRun 时调用方不会传 updates）。
 * 小细节：如果调用方（例如 backup.mjs 的恢复流程）已经在自己的事务里，`BEGIN` 会报
 * 「cannot start a transaction within a transaction」——这时跟随调用方事务、不再自己 BEGIN/COMMIT
 * （失败由调用方的 ROLLBACK 兜底），这样本函数既能独立用、也能被包在别人的事务里调用。
 */
function applyUpdates(db, updates) {
  if (!updates.length) return;
  let ownTx = false;
  try {
    db.exec('BEGIN');
    ownTx = true;
  } catch (e) {
    if (!/transaction/i.test(String(e?.message || e))) throw e;
  }
  try {
    for (const u of updates) u.stmt.run(u.to, u.id);
    if (ownTx) db.exec('COMMIT');
  } catch (e) {
    if (ownTx) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 事务可能已经结束，忽略 */
      }
    }
    throw e;
  }
}

/**
 * 归一化库里历史路径的分隔符（`\` → `/`），幂等、事务、可 dryRun。
 *
 * @param {import('node:sqlite').DatabaseSync} db 打开着的 SQLite 库（media 表已存在）
 * @param {{ log?: (message: string) => void, dryRun?: boolean }} [options]
 *   - log：诊断输出（默认静默；db.mjs 传 console.log 打 `[paths]` 日志）
 *   - dryRun：只统计不写库（迁移工具 / 排查用）
 * @returns {{
 *   media: { normalized: number, conflicts: Array<{id:string, from:string, to:string}> },
 *   thumb: { normalized: number },
 *   poster: { normalized: number },
 * }}
 */
export function healStoredPaths(db, { log = () => {}, dryRun = false } = {}) {
  const out = {
    media: { normalized: 0, conflicts: [] },
    thumb: { normalized: 0 },
    poster: { normalized: 0 },
  };

  // rel_path NOT NULL；thumb / poster 可空（M4 建表起就一直有这三列，老库也不会缺）
  const rows = db.prepare('SELECT id, rel_path, thumb, poster FROM media').all();
  if (!rows.length) return out;

  // 现有全部 rel_path：用于判断「归一化后是否撞上另一行的现有值」
  const taken = new Set(rows.map((r) => String(r.rel_path ?? '')));
  const mediaUpdates = [];
  const thumbUpdates = [];
  const posterUpdates = [];

  for (const r of rows) {
    const id = String(r.id);

    const current = String(r.rel_path ?? '');
    const next = normalizeRel(current);
    if (next !== current) {
      if (taken.has(next)) {
        // 唯一约束冲突：不覆盖任何一行（保留原值，人工处理）
        out.media.conflicts.push({ id, from: current, to: next });
      } else {
        taken.delete(current);
        taken.add(next);
        mediaUpdates.push({ id, to: next });
      }
    }

    for (const [column, list] of [
      ['thumb', thumbUpdates],
      ['poster', posterUpdates],
    ]) {
      const value = r[column];
      if (value == null) continue;
      const raw = String(value);
      if (!raw) continue;
      const normalized = normalizeRel(raw);
      if (normalized && normalized !== raw) list.push({ id, to: normalized });
    }
  }

  const total = mediaUpdates.length + thumbUpdates.length + posterUpdates.length;
  if (total > 0 && !dryRun) {
    const mediaStmt = db.prepare('UPDATE media SET rel_path = ? WHERE id = ?');
    const thumbStmt = db.prepare('UPDATE media SET thumb = ? WHERE id = ?');
    const posterStmt = db.prepare('UPDATE media SET poster = ? WHERE id = ?');
    mediaUpdates.forEach((u) => (u.stmt = mediaStmt));
    thumbUpdates.forEach((u) => (u.stmt = thumbStmt));
    posterUpdates.forEach((u) => (u.stmt = posterStmt));
    // 三列可能同时命中同一行（rel_path + thumb + poster）：同一事务里依次 UPDATE 没问题
    applyUpdates(db, [...mediaUpdates, ...thumbUpdates, ...posterUpdates]);
  }

  out.media.normalized = mediaUpdates.length;
  out.thumb.normalized = thumbUpdates.length;
  out.poster.normalized = posterUpdates.length;

  if (out.media.conflicts.length) {
    const samples = out.media.conflicts
      .slice(0, 3)
      .map((c) => `${c.id}（${c.from} → ${c.to}）`)
      .join('、');
    log(
      `[paths] ⚠️ ${out.media.conflicts.length} 条 media.rel_path 归一化后会与现有路径冲突，已跳过（保留原值）：${samples}${
        out.media.conflicts.length > 3 ? ' …' : ''
      }`
    );
  }
  if (dryRun && total > 0) {
    log(
      `[paths] dry-run：将归一化 ${total} 条历史路径（rel_path ${mediaUpdates.length} / thumb ${thumbUpdates.length} / poster ${posterUpdates.length}）`
    );
  }

  return out;
}
