/**
 * 上传队列持久化（2026-11-12 D-402）。
 *
 * 目标：刷新 / 关页后，未完成的上传队列不丢——重新打开应用时恢复队列并继续上传。
 * 实现：把未完成项（含 File 字节）存进 IndexedDB；恢复时重新上传（服务端按 sha256 全库去重，
 * 已完成 / 半途完成的文件不会被重复入库）。
 *
 * 边界：
 * - 这是「队列级恢复 + 重新上传」，不是字节级断点续传（服务端 upload 仍是整文件 multipart）。
 * - 单个文件超过 PERSIST_FILE_MAX_BYTES 不缓存（避免把几 GB 文件复制进浏览器存储），刷新后需重新添加。
 * - IndexedDB 不可用 / 配额不足时静默降级：队列只存在内存里，行为与旧版一致。
 */
import type { UploadItem } from './types';

const DB_NAME = 'tread-horizon';
const DB_VERSION = 1;
const STORE = 'uploadQueue';
const OWNER_INDEX = 'owner';

/** 超过这个大小的文件不写入浏览器存储（避免副本过大 / 配额失败） */
export const PERSIST_FILE_MAX_BYTES = 1024 ** 3; // 1 GiB

export interface StoredUploadItem {
  key: string;
  owner: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  visitId: string;
  status: 'queued' | 'uploading' | 'error';
  progress: number;
  placeId?: string;
  placeName?: string;
  visitDate?: string;
  error?: string;
  file: File;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex(OWNER_INDEX, 'owner', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('打开 IndexedDB 失败'));
  });
  return dbPromise;
}

const requestToPromise = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
  });

/** 读取某个账号（local 用空串）未完成的上传队列，按入队顺序返回 */
export async function loadUploadQueue(owner: string): Promise<StoredUploadItem[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const idx = tx.objectStore(STORE).index(OWNER_INDEX);
  const rows = await requestToPromise(idx.getAll(owner) as IDBRequest<StoredUploadItem[]>);
  await txDone(tx);
  return rows.sort((a, b) => a.savedAt - b.savedAt);
}

/**
 * 覆盖保存某个账号的未完成队列（queued / uploading / error）。
 * 返回 { saved, skippedLarge }：skippedLarge = 因超过单文件缓存上限而没存的文件数。
 */
export async function saveUploadQueue(
  owner: string,
  items: UploadItem[]
): Promise<{ saved: number; skippedLarge: number }> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const idx = store.index(OWNER_INDEX);
  const oldKeys = await requestToPromise(idx.getAllKeys(owner) as IDBRequest<IDBValidKey[]>);
  for (const key of oldKeys) store.delete(key);

  let saved = 0;
  let skippedLarge = 0;
  const savedAt = Date.now();
  for (const it of items) {
    if (!it.file) continue;
    if (it.status !== 'queued' && it.status !== 'uploading' && it.status !== 'error') continue;
    if (it.file.size > PERSIST_FILE_MAX_BYTES) {
      skippedLarge++;
      continue;
    }
    store.put({
      key: `${owner}:${it.key}`,
      owner,
      name: it.file.name,
      size: it.file.size,
      type: it.file.type,
      lastModified: it.file.lastModified,
      visitId: it.visitId,
      status: it.status === 'uploading' ? 'queued' : it.status,
      progress: 0,
      placeId: it.placeId,
      placeName: it.placeName,
      visitDate: it.visitDate,
      error: it.error,
      file: it.file,
      savedAt,
    } satisfies StoredUploadItem);
    saved++;
  }
  await txDone(tx);
  return { saved, skippedLarge };
}

/** 删掉某个账号持久化的队列（关闭队列 / 全部完成时用） */
export async function clearUploadQueue(owner: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const idx = store.index(OWNER_INDEX);
  const keys = await requestToPromise(idx.getAllKeys(owner) as IDBRequest<IDBValidKey[]>);
  for (const key of keys) store.delete(key);
  await txDone(tx);
}
