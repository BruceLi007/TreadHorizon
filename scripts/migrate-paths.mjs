#!/usr/bin/env node
/**
 * 数据迁移工具：修正 data/config.json 里的素材库 / 备份目录路径，以及 media 表里的相对路径。
 *
 * 为什么需要它（backup/LOCAL-CROSSPLATFORM-BRIEF.md §3 Phase 2 第 10 项 / docs/DECISIONS.md D-385）：
 * - 本地版以前把 `media.rel_path` 按本机分隔符入库（Windows `\`），config.json 里存绝对路径（含盘符）；
 *   从 Windows 换到 macOS（或反过来）后，旧路径在新机器上不存在 → 素材全部找不到。
 * - 新版启动时会自动做一次「能自动判定」的修复（反斜杠归一化 / 异平台 config 回落）；
 *   但「素材库搬到了新位置」「相对路径前缀变了」这类只有用户知道，所以提供本脚本手动迁移。
 * - 新版存储统一为 POSIX `/`，因此**同一个脚本双向可用**（Windows → macOS / macOS → Windows）。
 *
 * 用法：
 *   node scripts/migrate-paths.mjs --dry-run                     # 先看会改什么（不写盘）
 *   node scripts/migrate-paths.mjs --media-root=/新/素材库        # 改 config.json 的素材库路径
 *   node scripts/migrate-paths.mjs --media-root="D:\旧素材库=E:\新素材库"  # 仅当当前值匹配旧路径时改
 *   node scripts/migrate-paths.mjs --backup-dir=/新/备份目录       # 改 config.json 的备份目录
 *   node scripts/migrate-paths.mjs --remap="旧前缀=新前缀"         # 改 media.rel_path 的路径前缀（可多次）
 *   node scripts/migrate-paths.mjs --data-dir=<数据目录>           # 默认 <程序目录>/data（或 $DATA_DIR）
 *
 * 说明：
 * - `--media-root` / `--backup-dir` 可以写成 `<新>`（直接设置）或 `<旧>=<新>`（匹配旧值才改），均可多次；
 * - `--remap` 只改 media.rel_path 的前缀（按 `/` 分段匹配，兼容旧库里的 `\`），可多次、按顺序应用；
 * - 改前自动备份：travel.db 用 `VACUUM INTO` 生成 `travel.db.bak-<时间>`（失败回落复制），
 *   config.json 复制成 `config.json.bak-<时间>`；`--dry-run` 全程只读、不写任何文件；
 * - 归一化后若出现「两条记录的 rel_path 撞成同一个值」（UNIQUE 冲突），脚本**报错并中止**、不写盘，
 *   并给人工处理提示（不静默覆盖）。
 *
 * 退出码：0 = 成功 / 无改动 / dry-run 完成；1 = 参数错误、读写失败或路径冲突。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeRel,
  portableConfigPath,
  resolveConfigPath,
} from '../server/paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `用法：node scripts/migrate-paths.mjs [选项]

选项：
  --dry-run                 只列出将要修改的 DB 行 / config 项，不写盘（推荐先跑）
  --data-dir=<路径>         数据目录（默认 <程序目录>/data，也可用环境变量 DATA_DIR）
  --media-root=<新>          设置 config.json 的素材库根目录（写回时自动转成可移植形式）
  --media-root=<旧>=<新>     仅当当前素材库路径等于「旧」时才改成「新」（可多次）
  --backup-dir=<新>          设置 config.json 的备份目录（同样支持 <旧>=<新>，可多次）
  --remap=<旧前缀>=<新前缀>  把 media.rel_path 里以「旧前缀」开头的行替换成「新前缀」（可多次）
  -h, --help                显示本帮助

示例：
  node scripts/migrate-paths.mjs --dry-run
  node scripts/migrate-paths.mjs --media-root=/Users/me/Pictures/TreadHorizon
  node scripts/migrate-paths.mjs --remap="D:/旅行素材=旅行素材" --dry-run
`;

/** 解析命令行；未知参数直接报错（避免用户拼错却以为生效） */
function parseArgs(argv) {
  const opt = {
    dryRun: false,
    help: false,
    dataDir: '',
    mediaRoots: [], // { from: string|null, to: string }  from=null 表示直接设置
    backupDirs: [],
    remaps: [], // { from, to }
  };
  const take = (arg, name) => {
    const prefix = `--${name}=`;
    return arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
  };
  /** `<新>` 或 `<旧>=<新>`（第一个 `=` 是分隔符；路径里的盘符/反斜杠原样保留） */
  const pair = (raw) => {
    const s = String(raw ?? '');
    const eq = s.indexOf('=');
    if (eq < 0) return { from: null, to: s };
    return { from: s.slice(0, eq), to: s.slice(eq + 1) };
  };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      opt.dryRun = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      opt.help = true;
      continue;
    }
    let v;
    if ((v = take(arg, 'data-dir')) !== null) {
      opt.dataDir = v;
      continue;
    }
    if ((v = take(arg, 'media-root')) !== null) {
      opt.mediaRoots.push(pair(v));
      continue;
    }
    if ((v = take(arg, 'backup-dir')) !== null) {
      opt.backupDirs.push(pair(v));
      continue;
    }
    if ((v = take(arg, 'remap')) !== null) {
      const p = pair(v);
      if (p.from === null || !p.from) throw new Error(`--remap 需要 <旧前缀>=<新前缀> 形式：${arg}`);
      opt.remaps.push({ from: normalizeRel(p.from), to: normalizeRel(p.to) });
      continue;
    }
    throw new Error(`未知参数：${arg}（用 --help 查看用法）`);
  }
  return opt;
}

const pad2 = (n) => String(n).padStart(2, '0');
/** 本地时间戳 YYYYMMDD-HHmmss（备份文件名用） */
function fileStamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

/** 拍一个不存在的备份文件名（同一秒内多次运行也不覆盖旧备份） */
function uniquePath(path) {
  if (!existsSync(path)) return path;
  for (let seq = 2; seq < 10_000; seq++) {
    const p = `${path}-${seq}`;
    if (!existsSync(p)) return p;
  }
  throw new Error(`无法生成备份文件名：${path}`);
}

/** 比较两个绝对路径是否「同一个」（Windows 大小写不敏感、分隔符不敏感） */
function pathKey(abs) {
  const s = resolve(String(abs ?? '')).replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** 绝对路径 → 展示用（保留本机形式） */
const show = (p) => String(p ?? '');

/**
 * 计算 config.json 的修改计划。
 * @returns {{changes:Array<{key:string,fromRaw:string,fromAbs:string,toAbs:string,stored:string}>, notes:string[]}}
 */
function planConfig(rawConfig, dataDir, opt) {
  const changes = [];
  const notes = [];
  const config = { ...rawConfig };
  // 当前生效值的默认值（config.json 没写时 config.mjs 用的默认）
  const currentAbs = (key) => {
    const raw = config[key];
    if (typeof raw === 'string' && raw.trim()) return resolveConfigPath(ROOT, raw);
    if (key === 'mediaRoot') {
      return process.env.MEDIA_ROOT ? resolve(process.env.MEDIA_ROOT) : resolve(ROOT, '.dev-media');
    }
    return resolve(dataDir, 'backups');
  };

  const apply = (key, list) => {
    if (!list.length) return;
    for (const item of list) {
      const fromRaw = typeof config[key] === 'string' ? config[key] : '';
      const before = currentAbs(key); // 每次都按最新 config 计算（多次设置时顺序生效）
      if (item.from !== null) {
        const oldAbs = resolveConfigPath(ROOT, item.from) || resolve(item.from);
        if (pathKey(before) !== pathKey(oldAbs)) {
          notes.push(
            `[config] ${key}：当前 ${show(before)} 与「旧」${show(oldAbs)} 不匹配，跳过` +
              (fromRaw ? `（config.json 里存的是 ${JSON.stringify(fromRaw)}）` : '（config.json 里没有该项，使用默认值）')
          );
          continue;
        }
      }
      if (!String(item.to).trim()) throw new Error(`--${key === 'mediaRoot' ? 'media-root' : 'backup-dir'} 的新路径不能为空`);
      const toAbs = resolve(ROOT, String(item.to).trim());
      const stored = portableConfigPath(ROOT, toAbs); // 程序目录内 → 相对 POSIX；目录外 → 绝对
      if (pathKey(before) === pathKey(toAbs)) {
        notes.push(`[config] ${key}：已经是目标路径 ${show(toAbs)}，无需修改`);
        config[key] = stored;
        continue;
      }
      config[key] = stored;
      changes.push({ key, fromRaw, fromAbs: before, toAbs, stored });
    }
  };

  apply('mediaRoot', opt.mediaRoots);
  apply('backupDir', opt.backupDirs);
  return { changes, notes, config };
}

/**
 * 计算 media 表的修改计划。
 * @returns {{changes:Array<{id:string,column:string,from:string,to:string}>, conflicts:Array<object>, total:number}}
 */
function planDb(rows, opt) {
  const changes = [];
  const conflicts = [];
  /** 最终值 → 该值的所有行（用来检测 UNIQUE 冲突；UNIQUE 约束不分列，rel_path 唯一） */
  const finalRel = new Map();

  for (const row of rows) {
    const id = String(row.id);
    const original = String(row.rel_path ?? '');
    let next = normalizeRel(original); // 先把旧库的 `\` 归一成 `/`（与启动自愈一致）
    for (const r of opt.remaps) {
      const prefix = r.from;
      if (!prefix) continue;
      if (next === prefix) next = r.to;
      else if (next.startsWith(prefix + '/')) {
        next = r.to ? `${r.to}/${next.slice(prefix.length + 1)}` : next.slice(prefix.length + 1);
      }
    }
    if (!next) {
      throw new Error(`媒体 ${id} 的 rel_path 迁移后为空，已中止（原值：${JSON.stringify(original)}）`);
    }
    if (next !== original) changes.push({ id, column: 'rel_path', from: original, to: next });
    // thumb / poster 在本地模式是 `<id>.webp` / `<id>_poster.webp`，multi 在 `<owner>/` 下；
    // 含旧分隔符时一并归一化（不改前缀，不套 --remap）
    for (const column of ['thumb', 'poster']) {
      const raw = row[column];
      if (raw == null || raw === '') continue;
      const norm = normalizeRel(raw);
      if (norm !== String(raw)) changes.push({ id, column, from: String(raw), to: norm });
    }
    finalRel.set(String(row.id), { id, rel: next, original });
  }

  // UNIQUE 冲突检测：归一化 / 前缀替换后不允许两行 rel_path 撞成同一个值
  const byTarget = new Map();
  for (const { id, rel, original } of finalRel.values()) {
    const arr = byTarget.get(rel);
    if (arr) arr.push({ id, original });
    else byTarget.set(rel, [{ id, original }]);
  }
  for (const [rel, arr] of byTarget) {
    if (arr.length > 1) conflicts.push({ target: rel, rows: arr });
  }
  return { changes, conflicts, total: rows.length };
}

function formatChange(c) {
  return `  media[${c.id}].${c.column}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`;
}

function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[migrate-paths] ${e.message}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (opt.help) {
    console.log(USAGE);
    return;
  }

  const envDataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : '';
  const dataDir = opt.dataDir ? resolve(opt.dataDir) : envDataDir || resolve(ROOT, 'data');
  const dbPath = resolve(dataDir, 'travel.db');
  const configPath = resolve(dataDir, 'config.json');
  const hasDb = existsSync(dbPath);
  const hasConfig = existsSync(configPath);

  const mode = opt.dryRun ? 'DRY-RUN（不写盘）' : '执行模式';
  console.log(`\n[migrate-paths] ${mode}`);
  console.log(`  程序目录：${ROOT}`);
  console.log(`  数据目录：${dataDir}`);
  console.log(`  travel.db：${hasDb ? dbPath : '（不存在，跳过 DB 迁移）'}`);
  console.log(`  config.json：${hasConfig ? configPath : '（不存在，跳过 config 迁移）'}`);

  if (!hasDb && !hasConfig) {
    console.error(`\n[migrate-paths] ❌ 数据目录里既没有 travel.db 也没有 config.json：${dataDir}`);
    console.error('  确认 --data-dir 指向 TravelMaps 的 data 目录（默认 <程序目录>/data）。');
    process.exit(1);
  }

  // ── 1) config.json 计划 ──
  let rawConfig = {};
  if (hasConfig) {
    try {
      rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
        throw new Error('不是 JSON 对象');
      }
    } catch (e) {
      console.error(`\n[migrate-paths] ❌ 读取 config.json 失败：${e.message}`);
      process.exit(1);
    }
  }
  let configPlan;
  try {
    configPlan = planConfig(rawConfig, dataDir, opt);
  } catch (e) {
    console.error(`\n[migrate-paths] ❌ ${e.message}`);
    process.exit(1);
  }

  // ── 2) DB 计划（只读打开：db 不存在 / 打开失败都明确报错）──
  let dbPlan = { changes: [], conflicts: [], total: 0 };
  let db = null;
  if (hasDb) {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const hasMedia = Boolean(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media'")
          .get()
      );
      if (!hasMedia) {
        console.log('\n  · travel.db 里还没有 media 表（空库 / 未初始化），跳过 DB 迁移');
      } else {
        const columns = new Set(
          db
            .prepare('PRAGMA table_info(media)')
            .all()
            .map((c) => String(c.name))
        );
        if (!columns.has('id') || !columns.has('rel_path')) {
          throw new Error('media 表缺少 id / rel_path 列（数据库结构过旧，请先启动一次新版应用完成建表/补列）');
        }
        // thumb / poster 是老版本之后才有的列：有就一起检查，没有就跳过
        const wanted = ['id', 'rel_path', 'thumb', 'poster'].filter((c) => columns.has(c));
        const selectCols = wanted.map((c) => `"${c}"`).join(', ');
        const rows = db.prepare(`SELECT ${selectCols} FROM media ORDER BY rowid`).all();
        dbPlan = planDb(rows, opt);
      }
    } catch (e) {
      console.error(`\n[migrate-paths] ❌ 读取 travel.db 失败：${e?.message || e}`);
      console.error('  如果 TravelMaps 正在运行，请先停止服务再运行迁移（避免读到一半被改）。');
      process.exit(1);
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  // ── 3) 打印计划 ──
  console.log('\n── config.json ──');
  if (!hasConfig) {
    console.log('  （没有 config.json，跳过）');
  } else if (!configPlan.changes.length) {
    console.log('  无需修改');
  } else {
    for (const c of configPlan.changes) {
      console.log(
        `  [config] ${c.key}: ${JSON.stringify(c.fromRaw || '（默认）')} → ${JSON.stringify(c.stored)}` +
          `（生效路径 ${show(c.toAbs)}）`
      );
    }
  }
  for (const n of configPlan.notes) console.log(`  · ${n}`);

  console.log('\n── travel.db / media 路径 ──');
  if (!hasDb) {
    console.log('  （没有 travel.db，跳过）');
  } else {
    const relChanges = dbPlan.changes.filter((c) => c.column === 'rel_path');
    const cacheChanges = dbPlan.changes.filter((c) => c.column !== 'rel_path');
    console.log(`  媒体记录：${dbPlan.total} 行；需要修改：${relChanges.length + cacheChanges.length} 项` +
      `（rel_path ${relChanges.length} 项 / thumb·poster ${cacheChanges.length} 项）`);
    const MAX_SHOW = 20;
    for (const c of relChanges.slice(0, MAX_SHOW)) console.log(formatChange(c));
    if (relChanges.length > MAX_SHOW) console.log(`  … 另有 ${relChanges.length - MAX_SHOW} 项 rel_path 修改未逐条列出`);
    const cacheShown = cacheChanges.slice(0, 5);
    for (const c of cacheShown) console.log(formatChange(c));
    if (cacheChanges.length > cacheShown.length) {
      console.log(`  … 另有 ${cacheChanges.length - cacheShown.length} 项 thumb/poster 归一化`);
    }
    if (dbPlan.conflicts.length) {
      console.error('\n[migrate-paths] ❌ 发现 UNIQUE 冲突：归一化后有多条记录的 rel_path 撞成同一个值。');
      for (const c of dbPlan.conflicts) {
        console.error(`  目标：${JSON.stringify(c.target)}`);
        for (const r of c.rows) console.error(`    - media.id=${r.id}  原 rel_path=${JSON.stringify(r.original)}`);
      }
      console.error(
        '\n  这是旧库里「同一文件有两种分隔符写法」造成的，脚本不会静默覆盖任何一行。\n' +
          '  人工处理提示：\n' +
          '  1) 启动一次新版 TravelMaps（旧库启动自愈会尝试归一化，冲突行会被跳过并打日志）；\n' +
          '  2) 或用 DB 工具（DB Browser for SQLite 等）先确认哪一行是有效记录、把另一行的 rel_path\n' +
          '     重命名/合并后再跑本脚本；\n' +
          '  3) 处理前可以先备份：复制 travel.db（连 -wal/-shm）或本脚本非 dry-run 时会自动备份。'
      );
      process.exit(1);
    }
  }

  const hasChanges = configPlan.changes.length > 0 || dbPlan.changes.length > 0;
  if (!hasChanges) {
    console.log('\n[migrate-paths] ✅ 没有需要修改的内容。');
    return;
  }
  if (opt.dryRun) {
    console.log('\n[migrate-paths] 以上为 --dry-run 预览，未写任何文件；去掉 --dry-run 执行。');
    return;
  }

  // ── 4) 执行：先备份，再改 config，最后改 DB（事务）──
  const stamp = fileStamp();
  try {
    mkdirSync(dataDir, { recursive: true });
    if (configPlan.changes.length && hasConfig) {
      const bak = uniquePath(resolve(dataDir, `config.json.bak-${stamp}`));
      copyFileSync(configPath, bak);
      writeFileSync(configPath, JSON.stringify(configPlan.config, null, 2), 'utf8');
      console.log(`\n[config] 已修改并备份原文件：${bak}`);
    }
    if (dbPlan.changes.length) {
      // 备份 travel.db：优先 VACUUM INTO（WAL 里的数据也会进快照），失败回落文件复制
      const bak = uniquePath(resolve(dataDir, `travel.db.bak-${stamp}`));
      let backedUp = false;
      try {
        const snapDb = new DatabaseSync(dbPath);
        try {
          snapDb.prepare('VACUUM INTO ?').run(bak);
          backedUp = true;
        } finally {
          try {
            snapDb.close();
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        console.warn(`  （VACUUM INTO 备份失败：${e?.message || e}，改用文件复制）`);
      }
      if (!backedUp) {
        copyFileSync(dbPath, bak);
        // WAL 模式下还有未 checkpoint 的数据：一并复制，保证备份可打开
        for (const ext of ['-wal', '-shm']) {
          const p = dbPath + ext;
          if (existsSync(p)) copyFileSync(p, bak + ext);
        }
      }
      if (!backedUp && !existsSync(bak)) throw new Error('备份 travel.db 失败');
      console.log(`[db] 已备份数据库：${bak}`);

      const wdb = new DatabaseSync(dbPath);
      try {
        wdb.exec('PRAGMA busy_timeout = 5000');
        wdb.exec('BEGIN IMMEDIATE');
        try {
          const byColumn = { rel_path: [], thumb: [], poster: [] };
          for (const c of dbPlan.changes) byColumn[c.column]?.push(c);
          for (const [column, list] of Object.entries(byColumn)) {
            const stmt = wdb.prepare(`UPDATE media SET ${column} = ? WHERE id = ?`);
            for (const c of list) stmt.run(c.to, c.id);
          }
          wdb.exec('COMMIT');
        } catch (e) {
          try {
            wdb.exec('ROLLBACK');
          } catch {
            /* ignore */
          }
          const msg = String(e?.message || e);
          if (/UNIQUE|constraint/i.test(msg)) {
            throw new Error(
              `数据库 UNIQUE 约束冲突，已回滚（没有写任何行）：${msg}\n` +
                '  请按上面「人工处理提示」先解决 rel_path 重复，再重新运行本脚本。'
            );
          }
          throw e;
        }
      } finally {
        try {
          wdb.close();
        } catch {
          /* ignore */
        }
      }
      console.log(
        `[db] 已更新 ${dbPlan.changes.length} 项（rel_path ${dbPlan.changes.filter((c) => c.column === 'rel_path').length} 项）`
      );
    }
  } catch (e) {
    console.error(`\n[migrate-paths] ❌ 迁移失败：${e?.message || e}`);
    console.error('  已备份的原文件在 data 目录（travel.db.bak-* / config.json.bak-*），可人工恢复。');
    process.exit(1);
  }

  // ── 5) 迁移后自检：不应再有 `\`；config 能被解析 ──
  try {
    if (hasConfig) JSON.parse(readFileSync(configPath, 'utf8'));
    const vdb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const left = Number(
        vdb.prepare("SELECT COUNT(*) AS n FROM media WHERE rel_path LIKE '%\\%'").get()?.n || 0
      );
      const rows = Number(vdb.prepare('SELECT COUNT(*) AS n FROM media').get()?.n || 0);
      console.log(`\n[check] media 共 ${rows} 行，rel_path 仍含反斜杠：${left} 行`);
    } finally {
      try {
        vdb.close();
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    console.warn(`\n[check] 迁移后自检失败（不影响已完成的修改）：${e?.message || e}`);
  }
  console.log('[migrate-paths] ✅ 完成。建议启动一次 TravelMaps 确认素材能正常显示。');
}

main();
