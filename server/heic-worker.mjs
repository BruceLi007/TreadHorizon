/**
 * HEIC 解码 worker（D-548，2026-11-20）
 *
 * 为什么需要独立线程：`heic-decode` 底层是 `libheif-js/wasm-bundle` 的**单例 WASM**，
 * `decoder.decode()` 是同步调用，会把 JS 主线程整个占住 —— 在同一个线程里用 Promise
 * 并发只是排队（D-547 实测 1/2/3 路无差异）。只有 worker_threads 才能让多个 WASM
 * 实例真正并行（每个线程一份独立 WASM 堆，内存 ×N，所以主线程按内存决定开几个）。
 *
 * 协议：主线程 postMessage `{ id, buffer, quality }`（buffer 的所有权随消息转移），
 * 这里解成 JPEG 后把结果 transfer 回去：`{ id, jpeg, threadId }` 或 `{ id, error }`。
 */
import { parentPort, threadId } from 'node:worker_threads';
import convert from 'heic-convert';

parentPort.on('message', async (msg) => {
  const { id, buffer, quality } = msg || {};
  try {
    const jpeg = await convert({ buffer: Buffer.from(buffer), format: 'JPEG', quality });
    const out = Buffer.from(jpeg);
    // 把结果的所有权转回主线程，避免再复制一次（12MP 的 JPEG 约 2–4 MB）
    parentPort.postMessage({ id, jpeg: out, threadId }, [out.buffer]);
  } catch (e) {
    parentPort.postMessage({ id, error: e?.message || String(e), threadId });
  }
});
