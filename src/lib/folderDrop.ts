/**
 * 2026-11-07 D-246：拖文件夹到侧栏 → 按文件夹名新建一次到访，并批量上传文件夹里的图片 / 视频。
 *
 * 浏览器侧：`DataTransferItem.webkitGetAsEntry()` 能拿到拖入的文件夹（Chromium / Firefox），
 * 这里递归读出所有媒体文件；不支持该 API 的浏览器回退成「零散文件」处理。
 * 媒体扩展名与 `server/importer.mjs` 的 PHOTO_EXT / VIDEO_EXT 保持一致。
 */
export interface DroppedFolder {
  name: string;
  files: File[];
}

export interface FolderDropResult {
  folders: DroppedFolder[];
  /** 直接拖入的单个文件（不是文件夹） */
  looseFiles: File[];
  /** 被忽略的非图片 / 视频文件数量 */
  skipped: number;
}

const PHOTO_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif', '.avif',
]);
const VIDEO_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv',
]);
const extOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
};
export const isMediaFile = (file: File): boolean => {
  const ext = extOf(file.name);
  if (PHOTO_EXT.has(ext) || VIDEO_EXT.has(ext)) return true;
  return file.type.startsWith('image/') || file.type.startsWith('video/');
};

const fileOf = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => entry.file(resolve, reject));

const readAllEntries = (dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => {
    const reader = dir.createReader();
    const all: FileSystemEntry[] = [];
    const readNext = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) {
            resolve(all);
            return;
          }
          all.push(...batch);
          readNext();
        },
        reject
      );
    };
    readNext();
  });

async function walkDirectory(
  dir: FileSystemDirectoryEntry,
  skipped: { n: number }
): Promise<File[]> {
  const out: File[] = [];
  let entries: FileSystemEntry[] = [];
  try {
    entries = await readAllEntries(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory) {
      out.push(...(await walkDirectory(entry as FileSystemDirectoryEntry, skipped)));
    } else if (entry.isFile) {
      try {
        const file = await fileOf(entry as FileSystemFileEntry);
        if (isMediaFile(file)) out.push(file);
        else skipped.n += 1;
      } catch {
        skipped.n += 1;
      }
    }
  }
  return out;
}

/**
 * 解析一次拖放：文件夹 → { 名字, 媒体文件[] }；散文件 → looseFiles。
 * 注意：`webkitGetAsEntry()` 必须在 drop 事件同步阶段调用，所以这里先把 items 快照成 entries，
 * 之后再做异步递归（否则 Safari / 部分 Chromium 会在事件结束后失效）。
 */
export async function collectFolderDrop(items: DataTransferItem[]): Promise<FolderDropResult> {
  const folders: DroppedFolder[] = [];
  const looseFiles: File[] = [];
  const skipped = { n: 0 };

  const snapshots: { entry: FileSystemEntry | null; file: File | null }[] = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    const file = entry ? null : item.getAsFile();
    snapshots.push({ entry, file });
  }

  for (const snap of snapshots) {
    const { entry, file } = snap;
    if (!entry) {
      if (file && isMediaFile(file)) looseFiles.push(file);
      else if (file) skipped.n += 1;
      continue;
    }
    if (entry.isDirectory) {
      const files = await walkDirectory(entry as FileSystemDirectoryEntry, skipped);
      files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      folders.push({ name: entry.name, files });
    } else if (entry.isFile) {
      try {
        const f = await fileOf(entry as FileSystemFileEntry);
        if (isMediaFile(f)) looseFiles.push(f);
        else skipped.n += 1;
      } catch {
        skipped.n += 1;
      }
    }
  }

  return { folders, looseFiles, skipped: skipped.n };
}
