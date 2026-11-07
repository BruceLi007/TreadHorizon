/**
 * M4 备份 ZIP 读写工具（F-SYS-03 导出 / F-SYS-04 恢复）
 *
 * 写：yazl（流式写临时文件，不在内存里攒整个包；支持逐文件进度 / 取消 / store 不压缩）
 * 读：yauzl（Promise API，逐条目校验，防路径穿越 / 防 zip bomb）
 *
 * 安全约定（恢复是不可逆操作，校验必须严）：
 * - 条目名不允许 `..` 路径段、绝对路径、Windows 盘符、反斜杠、NUL、空路径段；
 * - 不允许目录条目、重复条目；
 * - 条目数、解压后总大小各有上限（可用环境变量在测试里调小）；
 * - 解压目标路径由调用方自己拼（只认包内白名单文件名），绝不拿条目名当磁盘路径；
 * - 素材解压时逐条校验「声明大小 / zip CRC / 内容 sha256 前 16 位」。
 *
 * 注意：本模块不认识数据库/配置，只做 zip 层；业务校验在 server/backup.mjs。
 */
import { createReadStream, createWriteStream, statSync, mkdirSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { ZipFile } from 'yazl';
import { openPromise, validateFileName } from 'yauzl';

/**
 * 单次备份最多多少条目（缩略图 / 素材也算），默认 20 万；测试可用 BACKUP_MAX_ENTRIES 调小。
 * 素材备份时每个媒体行最多 1 个 media/ 条目 + 1~2 个缩略图条目，个人库几万张照片也够用。
 */
export const MAX_ENTRIES = Number(process.env.BACKUP_MAX_ENTRIES || 200_000);
/**
 * 解压后总大小上限，默认 100GB；测试可用 BACKUP_MAX_UNCOMPRESSED_BYTES 调小。
 * 素材是 store（不压缩）的，这里主要防「声明大小巨大」的恶意 zip bomb；正常照片/视频备份会超过 8GB。
 */
export const MAX_UNCOMPRESSED_BYTES = Number(
  process.env.BACKUP_MAX_UNCOMPRESSED_BYTES || 100 * 1024 ** 3
);

/** zip 层的可预期错误（消息直接给用户看，路由层映射成 400） */
export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/** 导出任务被用户取消（不是真错误，上层据此把任务标成 canceled） */
export class ZipCanceledError extends Error {
  constructor(message = '导出已取消') {
    super(message);
    this.name = 'ZipCanceledError';
  }
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${v} B`;
}

// ───────────── 校验和 ─────────────

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export async function sha256File(path) {
  const buf = await readFile(path);
  return sha256Buffer(buf);
}

// ───────────── 写 zip ─────────────

/**
 * 把一组条目写成 zip 文件（流式，带进度 / 取消）。
 *
 * entries: [{
 *   name: string,
 *   data?: Buffer|string,        // 内存里的小文件（manifest / config / README）
 *   path?: string,               // 磁盘文件（DB 快照 / 缩略图 / 素材），流式读
 *   compress?: boolean,          // false = store（素材不压缩，提速）
 * }]
 * opts.onProgress({ bytesDone, filesDone })：实时进度（小 JSON 按 buffer 长度计）
 * opts.shouldCancel()：每次数据块前检查，返回 true 立即中止并抛 ZipCanceledError
 *
 * 返回 { size, bytesDone, filesDone }。
 */
export async function writeZip(zipPath, entries, opts = {}) {
  const { onProgress, shouldCancel } = opts;
  let bytesDone = 0;
  let filesDone = 0;
  const report = () => {
    if (onProgress) onProgress({ bytesDone, filesDone });
  };
  const checkCancel = () => {
    if (shouldCancel && shouldCancel()) throw new ZipCanceledError();
  };

  await mkdir(dirname(zipPath), { recursive: true });
  const zip = new ZipFile();
  const streams = [];
  try {
    for (const e of entries) {
      checkCancel();
      if (!e || !e.name) throw new ZipError('内部错误：zip 条目缺少名称');
      const options = {};
      if (e.compress === false) options.compress = false;

      if (e.path) {
        let size = 0;
        try {
          size = statSync(e.path).size;
        } catch (err) {
          throw new ZipError(`读取文件失败（${e.name}）：${err?.message || err}`);
        }
        if (e.compress === false) options.size = size;
        const src = createReadStream(e.path);
        const counter = new Transform({
          transform(chunk, _enc, cb) {
            if (shouldCancel && shouldCancel()) return cb(new ZipCanceledError());
            bytesDone += chunk.length;
            report();
            cb(null, chunk);
          },
        });
        counter.once('end', () => {
          filesDone += 1;
          report();
        });
        src.once('error', (err) => counter.destroy(err));
        streams.push(src, counter);
        zip.addReadStream(src.pipe(counter), e.name, options);
      } else {
        const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '');
        zip.addBuffer(data, e.name, options);
        bytesDone += data.length;
        filesDone += 1;
        report();
      }
    }

    const out = createWriteStream(zipPath);
    const closed = new Promise((res, rej) => {
      out.once('close', res);
      out.once('error', rej);
      zip.once('error', rej);
    });
    zip.end();
    try {
      await pipeline(zip.outputStream, out);
    } finally {
      // 无论成功还是中断，都收掉 closed 的 rejection，避免 unhandled rejection
      await closed.catch(() => {});
    }
    return { size: statSync(zipPath).size, bytesDone, filesDone };
  } finally {
    for (const s of streams) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

// ───────────── 读 zip ─────────────

/**
 * 只读中央目录：逐条校验条目名 / 数量 / 解压总大小，不读文件内容。
 * 返回 { names, entries, totalUncompressed, size }。
 * entries: [{ name, size, crc32 }]（素材校验要用 crc32；不在这里读数据）
 */
export async function scanZip(zipPath, opts = {}) {
  const maxEntries = Number.isFinite(opts.maxEntries) ? opts.maxEntries : MAX_ENTRIES;
  const maxUncompressed = Number.isFinite(opts.maxUncompressed)
    ? opts.maxUncompressed
    : MAX_UNCOMPRESSED_BYTES;
  const names = [];
  const entries = [];
  const seen = new Set();
  let total = 0;

  let zipfile;
  try {
    zipfile = await openPromise(zipPath, { lazyEntries: true });
  } catch (e) {
    throw new ZipError('无法解析备份 zip（文件可能损坏或不是 zip）：' + (e?.message || e));
  }
  try {
    for await (const entry of zipfile.eachEntry()) {
      const name = String(entry.fileName ?? '');
      if (name.endsWith('/')) throw new ZipError(`备份包包含目录条目：${name}`);
      // yauzl 自带校验（decodeStrings 时也会自动跑一遍），这里再显式跑一次拿清晰中文
      const invalid = validateFileName(name);
      if (invalid) throw new ZipError(`备份包内含非法路径：${name}（${invalid}）`);
      if (name.includes('\\')) throw new ZipError(`备份包内含非法路径：${name}（不允许反斜杠）`);
      if (/^[A-Za-z]:/.test(name)) throw new ZipError(`备份包内含非法路径：${name}（不允许盘符）`);
      if (name.startsWith('/')) throw new ZipError(`备份包内含非法路径：${name}（不允许绝对路径）`);
      if (name.includes('\0')) throw new ZipError(`备份包内含非法路径：${name}（包含 NUL）`);
      if (name.split('/').some((seg) => seg === '')) {
        throw new ZipError(`备份包内含非法路径：${name}（存在空路径段）`);
      }
      if (seen.has(name)) throw new ZipError(`备份包内含重复文件：${name}`);
      seen.add(name);
      if (names.length >= maxEntries) {
        throw new ZipError(`备份包文件条目过多（最多 ${maxEntries} 个）`);
      }
      const size = Number(entry.uncompressedSize) || 0;
      total += size;
      if (total > maxUncompressed) {
        throw new ZipError(
          `备份包解压后总大小超过上限（${formatBytes(maxUncompressed)}），可能不是正常备份`
        );
      }
      names.push(name);
      entries.push({ name, size, crc32: Number(entry.crc32) >>> 0 });
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError('无法读取备份 zip：' + (e?.message || e));
  } finally {
    try {
      await zipfile.close();
    } catch {
      /* 已关闭就算了 */
    }
  }

  return { names, entries, totalUncompressed: total, size: statSync(zipPath).size };
}

/** 读取单个条目的内容（有内存上限，只用于 manifest / config 这类小文件） */
export async function readEntryBuffer(zipPath, entryName, { maxBytes = 16 * 1024 * 1024 } = {}) {
  const zipfile = await openPromise(zipPath, { lazyEntries: true });
  try {
    for await (const entry of zipfile.eachEntry()) {
      if (entry.fileName !== entryName) continue;
      if (Number(entry.uncompressedSize) > maxBytes) {
        throw new ZipError(`${entryName} 解压后过大（超过 ${formatBytes(maxBytes)}）`);
      }
      const stream = await zipfile.openReadStreamPromise(entry);
      const chunks = [];
      let total = 0;
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > maxBytes) throw new ZipError(`${entryName} 解压后过大（超过 ${formatBytes(maxBytes)}）`);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    throw new ZipError(`备份包缺少 ${entryName}`);
  } finally {
    try {
      await zipfile.close();
    } catch {
      /* ignore */
    }
  }
}

/** 把指定条目解压到目标文件（目标路径由调用方给定，不拼接包内路径） */
export async function extractEntry(zipPath, entryName, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  const zipfile = await openPromise(zipPath, { lazyEntries: true });
  try {
    for await (const entry of zipfile.eachEntry()) {
      if (entry.fileName !== entryName) continue;
      const stream = await zipfile.openReadStreamPromise(entry);
      await pipeline(stream, createWriteStream(destPath));
      return destPath;
    }
    throw new ZipError(`备份包缺少 ${entryName}`);
  } finally {
    try {
      await zipfile.close();
    } catch {
      /* ignore */
    }
  }
}

/** 缩略图条目名是否安全（只允许 `thumbs/<basename>`，不允许子目录） */
export function isSafeThumbName(base) {
  if (!base || base.length > 255) return false;
  if (base.includes('/') || base.includes('\\') || base.includes('\0')) return false;
  if (base === '.' || base === '..') return false;
  if (/^[A-Za-z]:/.test(base)) return false;
  return true;
}

/** 素材条目名是否安全（`media/<seg>/<seg>/...`，每段非空且不是 . / ..） */
export function isSafeMediaEntryName(name) {
  if (!name.startsWith('media/')) return false;
  const rest = name.slice('media/'.length);
  if (!rest || rest.length > 2048) return false;
  if (rest.includes('\\') || rest.includes('\0')) return false;
  const segs = rest.split('/');
  return segs.every((s) => s && s !== '.' && s !== '..' && !/^[A-Za-z]:/.test(s));
}

/**
 * 把包内 `thumbs/` 下的文件写进 destDir（只取 basename，禁止子目录穿越）。
 * 单条失败不抛错（恢复已经提交，缩略图只是缓存），写进 warnings。
 * 返回 { written, failed, warnings }。
 */
export async function extractThumbs(zipPath, destDir, { maxFileBytes = 64 * 1024 * 1024 } = {}) {
  mkdirSync(destDir, { recursive: true });
  const out = { written: 0, failed: 0, warnings: [] };
  const zipfile = await openPromise(zipPath, { lazyEntries: true });
  try {
    for await (const entry of zipfile.eachEntry()) {
      const name = String(entry.fileName ?? '');
      if (!name.startsWith('thumbs/')) continue;
      const base = name.slice('thumbs/'.length);
      if (!isSafeThumbName(base)) {
        out.failed++;
        out.warnings.push(`缩略图路径异常，已跳过：${name}`);
        continue;
      }
      if (Number(entry.uncompressedSize) > maxFileBytes) {
        out.failed++;
        out.warnings.push(`缩略图过大，已跳过：${base}`);
        continue;
      }
      try {
        const stream = await zipfile.openReadStreamPromise(entry);
        await pipeline(stream, createWriteStream(join(destDir, base)));
        out.written++;
      } catch (e) {
        out.failed++;
        out.warnings.push(`写入缩略图失败（${base}）：${e?.message || e}`);
      }
    }
  } finally {
    try {
      await zipfile.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * 恢复素材：把包里 `media/` 条目流式解压到 staging 目录，逐条校验
 * 「声明大小 / zip CRC / sha256 前 16 位 == 备份 DB 的 media.hash」。
 *
 * expectations: Map<entryName, { size:number, hash:string|null, segments:string[] }>
 * 返回 [{ entryName, segments, stagedPath, size, relPath }]；任何一条不对就抛 ZipError，
 * 调用方负责删除 staging 目录（本函数不清理，避免删到一半状态不明）。
 */
export async function stageMediaEntries(zipPath, stageDir, expectations) {
  const expected = expectations instanceof Map ? expectations : new Map(Object.entries(expectations || {}));
  if (!expected.size) return [];
  const root = resolve(stageDir);
  mkdirSync(root, { recursive: true });

  const out = [];
  const zipfile = await openPromise(zipPath, { lazyEntries: true });
  try {
    for await (const entry of zipfile.eachEntry()) {
      const name = String(entry.fileName ?? '');
      if (!name.startsWith('media/')) continue;
      if (!isSafeMediaEntryName(name)) throw new ZipError(`备份包内含非法素材路径：${name}`);
      const expect = expected.get(name);
      if (!expect) throw new ZipError(`备份包包含未预期的素材文件：${name}`);

      const dest = resolve(root, ...expect.segments);
      if (dest === root || !dest.startsWith(root + sep)) {
        throw new ZipError(`素材路径越界：${name}`);
      }
      mkdirSync(dirname(dest), { recursive: true });

      const hasher = createHash('sha256');
      let size = 0;
      let crc = 0;
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          crc = crc32(chunk, crc);
          hasher.update(chunk);
          cb(null, chunk);
        },
      });
      const stream = await zipfile.openReadStreamPromise(entry);
      try {
        await pipeline(stream, meter, createWriteStream(dest));
      } catch (e) {
        throw new ZipError(`解压素材失败（${name}）：${e?.message || e}`);
      }

      if (Number(expect.size) >= 0 && size !== Number(expect.size)) {
        throw new ZipError(`素材大小不一致（${name}）：备份记录 ${expect.size} 字节，实际 ${size} 字节`);
      }
      const expectCrc = Number(entry.crc32) >>> 0;
      if (((crc >>> 0) ^ expectCrc) >>> 0 !== 0) {
        throw new ZipError(`素材 CRC 校验失败（${name}），文件可能损坏`);
      }
      if (expect.hash) {
        const got = hasher.digest('hex').slice(0, 16);
        if (got !== String(expect.hash).toLowerCase()) {
          throw new ZipError(`素材内容校验失败（${name}）：与备份数据库记录的哈希不一致`);
        }
      }
      out.push({
        entryName: name,
        segments: expect.segments,
        stagedPath: dest,
        size,
        relPath: expect.segments.join('/'),
      });
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError('解压素材失败：' + (e?.message || e));
  } finally {
    try {
      await zipfile.close();
    } catch {
      /* ignore */
    }
  }

  if (out.length !== expected.size) {
    throw new ZipError(`备份包素材数量不符：应为 ${expected.size} 个，实际 ${out.length} 个`);
  }
  return out;
}
