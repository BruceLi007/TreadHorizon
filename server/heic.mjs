/**
 * HEIC / HEIF 真实支持（D-307，2026-11-08 用户要求「真正支持 HEIC」）
 *
 * 背景：sharp 预编译版里的 libheif 只编进了 AVIF 解码，没有 HEVC 解码插件
 * （libde265），所以 iPhone 的 .heic / .heif 一走 sharp 就报：
 *   `heif: Error while loading plugin: Support for this compression format has
 *    not been built in: HEVC (a suitable decoder plugin is libde265)`
 * 表现是：上传能入库（按扩展名收），但缩略图 / 1600 预览 / 头像全部生成失败，
 * 照片墙上破图、灯箱打不开。
 *
 * 方案：用 heic-convert（底层 libheif-js，纯 WebAssembly）把 HEIC/HEIF 解成
 * JPEG buffer，再交给 sharp 生成缩略图 / 预览 / 头像。wasm 解码与平台无关，
 * Windows 本机和云端 Linux（Docker + node:24）都能用；原始 .heic 文件仍原样
 * 保存在素材库里（不动原件、不改上传/备份/导出语义）。
 *
 * 并发（2026-11-20 D-548，**这块的结论别推翻，有实测**）：
 *   `heic-decode` 用的是 `libheif-js/wasm-bundle` **单例 WASM**，`decoder.decode()`
 *   是同步调用，会把 JS 主线程整个占住 —— 同一线程里用 Promise 并发只是排队。
 *   D-547 实测 3 张真实 HEIC（4.1 / 2.9 / 2.2 MB）1 / 2 / 3 路「并发」=
 *   5164 / 5106 / 5018 ms（噪声内），16 核机器 CPU 只跑到 ~40%。
 *
 *   所以要真并行只有 worker_threads：每个线程一份独立 WASM 堆、真正同时解码
 *   （内存 ≈ 200~245MB/线程）。按内存自适应：
 *     · < 6GB（云端 2GiB 容器就在这档）→ **0 个 worker**，走下面原来的主线程串行队列，
 *       行为与内存峰值逐字不变；
 *     · 6~12GB → 最多 2 个；≥ 12GB → 最多 4 个（核数 − 1 参与上限）。
 *   环境变量 HEIC_DECODE_WORKERS 可强制指定（0 = 强制串行），上限 8。
 *   worker 池按需创建、空闲 60 秒自动回收；任何一个 worker 挂了就退回串行，不影响出图。
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import convert from 'heic-convert';

/** 需要走 wasm 解码的扩展名（sharp 自带的 HEIF 解码只支持 AVIF） */
const HEIC_EXT = new Set(['.heic', '.heif']);

/** 扩展名（带点、大小写不敏感）是否 HEIC / HEIF */
export const isHeicExt = (ext) => HEIC_EXT.has(String(ext || '').toLowerCase());

/** 路径是否 HEIC / HEIF 文件 */
export const isHeicFile = (filePath) => isHeicExt(extname(String(filePath || '')));

/**
 * 允许同时解码的线程数（0 = 不开 worker，主线程串行）。
 * 默认按物理内存：<6GB → 0；6~12GB → 2；≥12GB → min(4, 核数-1)。
 */
export const HEIC_WORKERS = (() => {
  const raw = process.env.HEIC_DECODE_WORKERS;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(8, Math.floor(n));
  }
  const gb = os.totalmem() / 1024 ** 3;
  if (gb < 6) return 0; // 云端 2GiB 容器：保持串行
  const cores =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : Math.max(1, os.cpus()?.length || 1);
  const cap = gb >= 12 ? 4 : 2;
  return Math.max(1, Math.min(cap, Math.max(1, cores - 1)));
})();

/** 没有 worker（云端 / 小内存 / 强制串行）时的老路径：一条 Promise 链，一次解一张 */
let chain = Promise.resolve();
const enqueueInline = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
};

/* ───────────── worker 池（D-548） ───────────── */

const IDLE_SHUTDOWN_MS = 60_000;

/** @type {null | {workers:Worker[], idle:Worker[], queue:any[], created:number, broken:boolean, threadIds:Set<number>, seq:number, timer:NodeJS.Timeout|null}} */
let pool = null;
let jobSeq = 0;

function spawnWorker(state) {
  const w = new Worker(new URL('./heic-worker.mjs', import.meta.url));
  w.unref(); // 空闲时不阻止进程退出；有任务时会 ref()
  w.on('message', (msg) => onWorkerMessage(state, w, msg));
  w.on('error', (err) => onWorkerDown(state, w, err));
  w.on('exit', (code) => {
    if (state.closing) return; // 空闲回收 / 主动 terminate 时的退出不算故障
    if (code !== 0) onWorkerDown(state, w, new Error(`HEIC 解码线程退出（code ${code}）`));
    else dropWorker(state, w);
  });
  state.workers.push(w);
  state.idle.push(w);
  state.created += 1;
  return w;
}

function dropWorker(state, w) {
  const i = state.workers.indexOf(w);
  if (i >= 0) state.workers.splice(i, 1);
  const j = state.idle.indexOf(w);
  if (j >= 0) state.idle.splice(j, 1);
}

function onWorkerDown(state, w, err) {
  const job = w.__job || null;
  w.__job = null;
  dropWorker(state, w);
  // 池空了就标记坏掉：后续请求退回主线程串行，不影响出图
  if (!state.workers.length) {
    state.broken = true;
    // 还在排队的请求全部拒绝，让调用方退到串行，别挂死
    while (state.queue.length) state.queue.shift().reject(err);
  }
  if (job) job.reject(err);
  dispatch(state);
}

function onWorkerMessage(state, w, msg) {
  const job = w.__job || null;
  w.__job = null;
  if (typeof msg?.threadId === 'number') state.threadIds.add(msg.threadId);
  if (!state.idle.includes(w)) state.idle.push(w);
  w.unref();
  if (!job) return;
  if (msg && msg.error) job.reject(new Error(msg.error));
  else {
    // 结果 buffer 的所有权已经转移过来，直接包成 Buffer（零拷贝）
    const u8 = msg?.jpeg;
    job.resolve(u8 ? Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength) : Buffer.alloc(0));
  }
  dispatch(state);
}

function dispatch(state) {
  while (state.queue.length && state.idle.length) {
    const w = state.idle.pop();
    const job = state.queue.shift();
    w.__job = job;
    w.ref();
    // ArrayBuffer 复制一份再转移：绝不 detach 调用方给进来的 buffer
    const payload = job.buffer.buffer.slice(job.buffer.byteOffset, job.buffer.byteOffset + job.buffer.byteLength);
    w.postMessage({ id: job.id, buffer: payload, quality: job.quality }, [payload]);
  }
  // 队列里还有活就先别回收
  if (state.queue.length || state.workers.some((w) => w.__job)) {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    return;
  }
  if (!state.timer && state.workers.length) {
    state.timer = setTimeout(() => shutdownPool(state), IDLE_SHUTDOWN_MS);
    state.timer.unref?.();
  }
}

function shutdownPool(state) {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.closing = true;
  for (const w of state.workers) {
    try {
      w.terminate();
    } catch {
      /* ignore */
    }
  }
  state.workers.length = 0;
  state.idle.length = 0;
  if (pool === state) pool = null;
}

function getPool() {
  if (!HEIC_WORKERS) return null;
  if (pool?.broken) return null;
  if (!pool) {
    pool = { workers: [], idle: [], queue: [], created: 0, broken: false, threadIds: new Set(), seq: 0, timer: null };
  }
  return pool;
}

/** 给单测 / 诊断用：当前池状态 */
export function heicPoolInfo() {
  return {
    workers: HEIC_WORKERS,
    live: pool ? pool.workers.length : 0,
    created: pool ? pool.created : 0,
    busy: pool ? pool.workers.filter((w) => !!w.__job).length : 0,
    queued: pool ? pool.queue.length : 0,
    threadIds: pool ? [...pool.threadIds] : [],
    broken: pool ? pool.broken : false,
  };
}

/* ───────────── 对外接口 ───────────── */

async function decodeInline(buffer, quality) {
  return enqueueInline(async () => {
    const jpeg = await convert({ buffer, format: 'JPEG', quality });
    return Buffer.from(jpeg);
  });
}

/**
 * 把 HEIC / HEIF 解码成 JPEG buffer（主图）。
 * 有 worker 池就丢给池子（真并行）；池不可用 / 出过错就退回主线程串行。
 * @param {string | Buffer} input 文件路径或文件内容
 * @param {number} [quality] JPEG 质量 0~1（默认 0.92，缩略图/预览还会再转 webp）
 * @returns {Promise<Buffer>} JPEG 内容
 */
export async function decodeHeicToJpeg(input, quality = 0.92) {
  const buffer = typeof input === 'string' ? await readFile(input) : Buffer.from(input);
  const state = getPool();
  if (state) {
    try {
      // 按需扩到「正在解 + 排队 + 这一张」那么多线程（一次只解一张时不额外开线程）
      const busy = state.workers.filter((w) => !!w.__job).length;
      const need = Math.min(HEIC_WORKERS, busy + state.queue.length + 1);
      while (state.workers.length < need) spawnWorker(state);
      return await new Promise((resolve, reject) => {
        state.queue.push({ id: ++jobSeq, buffer, quality, resolve, reject });
        dispatch(state);
      });
    } catch {
      /* 池出问题 → 落到下面的串行，保证不影响出图 */
    }
  }
  return decodeInline(buffer, quality);
}
