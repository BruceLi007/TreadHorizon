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
 * 内存 / 并发：一张 iPhone 12MP HEIC 解码实测峰值 rss ≈ 200~245MB、约 1.1~1.3s。
 * 云端服务器只有 2GiB 内存，所以 wasm 解码统一走「串行队列」——同一时刻只解
 * 一张，避免多张 HEIC 同时上传时把内存打爆；解完就释放，缩略图/img 请求会排队
 * 稍等（前端本来就有上传 / 加载状态）。
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import convert from 'heic-convert';

/** 需要走 wasm 解码的扩展名（sharp 自带的 HEIF 解码只支持 AVIF） */
const HEIC_EXT = new Set(['.heic', '.heif']);

/** 扩展名（带点、大小写不敏感）是否 HEIC / HEIF */
export const isHeicExt = (ext) => HEIC_EXT.has(String(ext || '').toLowerCase());

/** 路径是否 HEIC / HEIF 文件 */
export const isHeicFile = (filePath) => isHeicExt(extname(String(filePath || '')));

/** 串行队列：把并发解码排成一个接一个，控制 wasm 内存峰值 */
let chain = Promise.resolve();
const enqueue = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
};

/**
 * 把 HEIC / HEIF 解码成 JPEG buffer（主图）。
 * @param {string | Buffer} input 文件路径或文件内容
 * @param {number} [quality] JPEG 质量 0~1（默认 0.92，缩略图/预览还会再转 webp）
 * @returns {Promise<Buffer>} JPEG 内容
 */
export function decodeHeicToJpeg(input, quality = 0.92) {
  const load = typeof input === 'string' ? () => readFile(input) : async () => input;
  return enqueue(async () => {
    const buffer = await load();
    // heic-convert 返回 ArrayBuffer，统一转成 Node Buffer 交给 sharp
    const jpeg = await convert({ buffer, format: 'JPEG', quality });
    return Buffer.from(jpeg);
  });
}
