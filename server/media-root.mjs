/**
 * 每个账号的「素材库根目录」解析 + 切换时的素材同步（2026-11-07，D-212 / D-213）
 *
 * 背景：用户验收时要求「不管普通用户还是管理员，都能在素材库当前路径边上打开本地文件夹、
 * 修改地址，并且修改路径后默认把素材同步过去；这些都是对各自账号的管理」——
 * 所以素材库根目录做成**按账号独立**（含管理员）：
 * - multi：每个账号可以把自己的素材库根目录设成自己的路径（`user_setting.media_root`），
 *   文件在 `<该根目录>/<账号 id>/省/市/区县/日期_地点名`（rel_path 已经是 `<账号 id>/…`）；
 *   没设置 = 用服务器默认 `CONFIG.mediaRoot`（行为与 D-202 一致）。
 * - local（owner = null）：永远用 `CONFIG.mediaRoot`，切换路径时同步整个默认素材库。
 *
 * 切换路径时默认同步素材（D-213）：把旧根目录下属于该账号的文件搬到新根目录下同结构位置
 * （同盘优先 rename；跨盘复制并校验大小后删旧文件）。失败时给出明确错误、设置不落库，
 * 已搬过的文件下次继续（幂等）。
 *
 * 已知边界：管理员整库备份 / 恢复、scan 目录扫描、迁移 / 清理脚本仍只认服务器默认路径；
 * 自定义路径的账号请用「导出我的数据 / 从我的备份恢复」（记录在 D-212）。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { CONFIG } from './config.mjs';
import { getUserSetting } from './auth.mjs';
import { formatBytes } from './zip.mjs';

/** 某账号的素材库根目录（multi）；local（ownerId 为空）返回服务器默认路径 */
export function mediaBaseFor(ownerId) {
  if (!ownerId) return CONFIG.mediaRoot;
  const custom = getUserSetting(ownerId)?.media_root;
  const s = typeof custom === 'string' ? custom.trim() : '';
  return s ? resolve(s) : CONFIG.mediaRoot;
}

/** 该账号是否自定义过素材库路径（普通用户页用来显示「默认位置 / 自定义路径」） */
export function mediaBaseCustomized(ownerId) {
  if (!ownerId) return false;
  const custom = getUserSetting(ownerId)?.media_root;
  return typeof custom === 'string' && custom.trim() !== '';
}

/** 递归列出目录下所有文件（返回 [{ abs, rel, size }]） */
function walkFiles(root) {
  const out = [];
  const visit = (dir, relBase) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relBase ? join(relBase, ent.name) : ent.name;
      if (ent.isDirectory()) {
        visit(abs, rel);
      } else if (ent.isFile()) {
        try {
          out.push({ abs, rel, size: statSync(abs).size });
        } catch {
          /* 读不到的文件跳过 */
        }
      }
    }
  };
  visit(root, '');
  return out;
}

/** 删掉 srcRoot 下已经空了的目录（自底向上；删不掉就留着，不影响数据） */
function removeEmptyDirs(root) {
  try {
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (ent.isDirectory()) removeEmptyDirs(join(root, ent.name));
    }
    const left = readdirSync(root);
    if (left.length === 0) rmdirSync(root);
  } catch {
    /* ignore */
  }
}

/**
 * 切换素材库根目录时把该账号的素材同步过去（D-213）：
 * - multi（ownerId 非空）：`<旧根>/<owner>/…` → `<新根>/<owner>/…`；
 * - local（ownerId 空）：`<旧根>/…` → `<新根>/…`。
 * 同盘用 rename（快、占空间少）；跨盘 copy + 大小校验 + 删旧文件。
 * 对「目标已存在同大小文件」视为已同步（跳过并清理旧文件），可重复执行。
 *
 * @returns {{files:number, moved:number, skipped:number, bytes:number, mode:'same'|'empty'|'move'|'copy'}}
 */
export function migrateMediaRoot(ownerId, fromBase, toBase) {
  const from = resolve(fromBase);
  const to = resolve(toBase);
  if (from === to) return { files: 0, moved: 0, skipped: 0, bytes: 0, mode: 'same' };
  const srcRoot = ownerId ? join(from, ownerId) : from;
  const dstRoot = ownerId ? join(to, ownerId) : to;
  if (!existsSync(srcRoot)) {
    mkdirSync(dstRoot, { recursive: true });
    return { files: 0, moved: 0, skipped: 0, bytes: 0, mode: 'empty' };
  }

  const files = walkFiles(srcRoot);
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const sameVolume = parse(from).root.toLowerCase() === parse(to).root.toLowerCase();

  // 跨盘复制前先检查新位置磁盘空间（同盘 rename 不需要额外空间）
  if (!sameVolume && files.length > 0) {
    try {
      const st = statfsSync(to);
      const avail = Number(st.bavail) * Number(st.bsize);
      const reserve = 100 * 1024 * 1024;
      if (Number.isFinite(avail) && avail < totalBytes + reserve) {
        throw new Error(
          `新位置磁盘空间不足：需要约 ${formatBytes(totalBytes)}（另需预留 100 MB），当前可用 ${formatBytes(avail)}`
        );
      }
    } catch (e) {
      // 只是「磁盘空间不足」这一条需要抛；statfs 不支持就忽略，交给复制失败兜底
      if (String(e?.message || '').startsWith('新位置磁盘空间不足')) throw e;
    }
  }

  mkdirSync(dstRoot, { recursive: true });
  let moved = 0;
  let skipped = 0;
  let bytes = 0;
  for (const f of files) {
    const dest = join(dstRoot, f.rel);
    mkdirSync(dirname(dest), { recursive: true });

    // 目标已有同大小文件：视为已同步，删掉旧文件即可
    if (existsSync(dest)) {
      try {
        if (statSync(dest).size === f.size) {
          try {
            unlinkSync(f.abs);
          } catch {
            /* ignore */
          }
          skipped += 1;
          continue;
        }
      } catch {
        /* 目标读不到：按覆盖处理 */
      }
      try {
        unlinkSync(dest);
      } catch {
        /* ignore */
      }
    }

    try {
      if (sameVolume) {
        renameSync(f.abs, dest);
        moved += 1;
        bytes += f.size;
      } else {
        copyFileSync(f.abs, dest);
        const st = statSync(dest);
        if (st.size !== f.size) {
          throw new Error(`复制后大小不一致（${f.size} → ${st.size}）`);
        }
        try {
          unlinkSync(f.abs);
        } catch {
          /* 旧文件删不掉也不影响新位置使用 */
        }
        moved += 1;
        bytes += f.size;
      }
    } catch (e) {
      throw new Error(`素材同步失败（${f.rel}）：${e?.message || e}`);
    }
  }
  removeEmptyDirs(srcRoot);
  return { files: moved + skipped, moved, skipped, bytes, mode: sameVolume ? 'move' : 'copy' };
}
