/**
 * 云端：主页快照导入（2026-11-18 D-524）
 *
 * 本地「同步」把全部足迹打成与分享包同格式的 zip（manifest + media/*.webp，1280 长边），
 * 这里做三件事：
 *   1. 校验 + 解压到临时目录（复用 share-package 的严格校验：字段、路径、体积、webp）；
 *   2. 把照片落到 `mediaRoot/snapshot/<userId>/<batch>/`，**按账号整批替换**账号主库
 *      （place / visit / media 打 snapshot=1 标记，重新同步时整批删）；
 *   3. 写 snapshot 元信息行（时间 / 地点 / 到访 / 照片 / 字节数）。
 *
 * 只读展示模式下这是**唯一**能往云端库里写内容的通道（白名单在 index.mjs 的 preHandler）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CONFIG } from './config.mjs';
import { db, now } from './db.mjs';
import { stageSharePackage, ShareError } from './share-package.mjs';
import { mediaBaseFor } from './media-root.mjs';
import { safeResolve } from './paths.mjs';

export function snapshotInfo(ownerId) {
  if (!ownerId) return { exists: false };
  const row = db.prepare('SELECT * FROM snapshot WHERE user_id = ?').get(ownerId);
  if (!row) return { exists: false };
  return {
    exists: true,
    syncedAt: Number(row.synced_at) || null,
    bytes: Number(row.bytes) || 0,
    places: Number(row.places) || 0,
    visits: Number(row.visits) || 0,
    photos: Number(row.photos) || 0,
    appVersion: row.app_version || '',
  };
}

const idFor = (owner, prefix, raw) =>
  `sn_${prefix}${createHash('sha256').update(`${owner}:${raw}`).digest('hex').slice(0, 18)}`;

/**
 * 导入一份快照包（调用方已把 zip 落到临时路径；这里负责解压、落盘、换库）。
 * @returns {{ places:number, visits:number, photos:number, bytes:number }}
 */
export async function importSnapshot(ownerId, zipPath, stageDir) {
  if (!ownerId) throw new ShareError('本地版没有账号，快照请导入云端账号', 400);
  const pkg = await stageSharePackage(zipPath, stageDir);
  if (pkg.hasSecret) throw new ShareError('快照不能包含秘密基地', 400);
  const manifest = pkg.manifest;
  if (!manifest.media.length) throw new ShareError('快照里没有照片', 400);

  const mediaRoot = mediaBaseFor(ownerId);
  const batch = randomUUID();
  const relBase = `snapshot/${ownerId}/${batch}`;
  const absBase = safeResolve(mediaRoot, relBase);
  if (!absBase) throw new ShareError('快照落盘路径非法', 400);
  mkdirSync(absBase, { recursive: true });

  // 1) 先把照片复制到新批次目录（失败就能整体丢掉，旧快照不动）
  const mediaById = new Map();
  let bytes = 0;
  for (const m of manifest.media) {
    const src = join(stageDir, 'media', m.file);
    const dst = join(absBase, m.file);
    copyFileSync(src, dst);
    const size = statSync(dst).size;
    bytes += size;
    mediaById.set(m.id, { ...m, relPath: `${relBase}/${m.file}`, bytes: size });
  }

  // 2) 事务内整批替换该账号的主库（旧行级联删除；媒体文件随后按批次目录清）
  const insertPlace = db.prepare(`
    INSERT INTO place (id, user_id, name, lng, lat, province, city, county, province_code,
                       kind, cover_media_id, created_at, updated_at, deleted_at, secret, home, snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, 1)`);
  const insertVisit = db.prepare(`
    INSERT INTO visit (id, user_id, place_id, date, title, note, rating, companions,
                       created_at, updated_at, deleted_at, snapshot)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 1)`);
  const insertMedia = db.prepare(`
    INSERT INTO media (id, user_id, visit_id, kind, rel_path, hash, bytes, width, height,
                       duration, taken_at, thumb, preview, poster, created_at, snapshot)
    VALUES (?, ?, ?, 'photo', ?, NULL, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, 1)`);

  let visitCount = 0;
  let photoCount = 0;
  const t = now();

  db.exec('BEGIN');
  try {
    // 旧快照（以及旧库里同账号的内容）整批删除：display-only 模式下云端主库 = 最新快照
    db.prepare('DELETE FROM place WHERE user_id = ?').run(ownerId);
    db.prepare('DELETE FROM visit WHERE user_id = ?').run(ownerId);
    db.prepare('DELETE FROM media WHERE user_id = ?').run(ownerId);

    for (const p of manifest.places) {
      const placeId = idFor(ownerId, 'p', p.id);
      const coverId =
        p.coverId && mediaById.has(p.coverId) ? idFor(ownerId, 'm', p.coverId) : null;
      insertPlace.run(
        placeId,
        ownerId,
        p.name,
        p.lng,
        p.lat,
        p.provinceName || null,
        p.city || null,
        p.district || null,
        p.provinceCode || null,
        p.kind === 'wishlist' ? 'wishlist' : 'visited',
        coverId,
        t,
        t,
        p.home ? 1 : 0
      );
      for (const v of p.visits || []) {
        const visitId = idFor(ownerId, 'v', v.id);
        insertVisit.run(
          visitId,
          ownerId,
          placeId,
          v.date,
          v.title || null,
          v.note || null,
          Array.isArray(v.companions) && v.companions.length ? JSON.stringify(v.companions) : null,
          t,
          t
        );
        visitCount += 1;
        for (const mid of v.media || []) {
          const mm = mediaById.get(mid);
          if (!mm) continue;
          insertMedia.run(
            idFor(ownerId, 'm', mid),
            ownerId,
            visitId,
            mm.relPath,
            mm.bytes,
            Number(mm.w) || 0,
            Number(mm.h) || 0,
            Number(mm.takenAt) || t,
            t
          );
          photoCount += 1;
        }
      }
    }
    db.prepare(
      `INSERT INTO snapshot (user_id, synced_at, bytes, places, visits, photos, app_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET synced_at = excluded.synced_at, bytes = excluded.bytes,
         places = excluded.places, visits = excluded.visits, photos = excluded.photos,
         app_version = excluded.app_version`
    ).run(ownerId, t, bytes, manifest.places.length, visitCount, photoCount, manifest.appVersion || '');
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    rmSync(absBase, { recursive: true, force: true });
    throw e;
  }

  // 3) 清掉旧批次目录（只动 snapshot/<owner> 下、且不是新批次的目录）
  const ownerDir = safeResolve(mediaRoot, `snapshot/${ownerId}`);
  if (ownerDir && existsSync(ownerDir)) {
    for (const name of readdirSync(ownerDir)) {
      if (name === batch) continue;
      try {
        rmSync(join(ownerDir, name), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  return { places: manifest.places.length, visits: visitCount, photos: photoCount, bytes };
}

/* ───────────── 路由 ───────────── */

export async function registerSnapshotRoutes(app) {
  // 账号：快照元信息（云端主页用不到，但在「我的分享」里显示一行）
  app.get('/api/snapshot', async (req) => snapshotInfo(req.authUser?.id));

  // 本地客户端：导入快照（multipart: file）
  app.post('/api/snapshot/import', async (req, reply) => {
    const owner = req.authUser?.id;
    if (!owner) return reply.code(401).send({ error: '请先登录' });
    if (req.method !== 'POST') return reply.code(405).send({ error: 'method' });

    const declared = Number(req.headers['content-length']);
    const MAX_ZIP = 2 * 1024 ** 3; // 2 GB
    if (Number.isFinite(declared) && declared > MAX_ZIP) {
      return reply.code(413).send({ error: '快照包超过 2 GB 上限' });
    }

    const tmpRoot = join(CONFIG.dataDir, 'tmp');
    mkdirSync(tmpRoot, { recursive: true });
    const zipPath = join(tmpRoot, `snapshot-upload-${randomUUID()}.zip`);
    const stageDir = join(tmpRoot, `snapshot-stage-${randomUUID()}`);
    let fileBytes = 0;

    try {
      for await (const part of req.parts({ limits: { fileSize: MAX_ZIP, files: 1, fields: 2 } })) {
        if (part.type !== 'file' || part.fieldname !== 'file') {
          if (part.type === 'file') part.file.resume();
          continue;
        }
        const { createWriteStream } = await import('node:fs');
        const { pipeline } = await import('node:stream/promises');
        await pipeline(part.file, createWriteStream(zipPath));
        fileBytes = Number(part.file.bytesRead) || 0;
      }
    } catch (e) {
      rmSync(zipPath, { force: true });
      return reply.code(400).send({ error: e?.message || '读取快照包失败' });
    }

    try {
      if (!fileBytes) throw new ShareError('缺少快照包（multipart 字段名 file）', 400);
      const out = await importSnapshot(owner, zipPath, stageDir);
      return { ok: true, ...out };
    } catch (e) {
      const status = e instanceof ShareError ? e.status : 400;
      return reply.code(status).send({ error: e?.message || '快照导入失败' });
    } finally {
      try {
        rmSync(zipPath, { force: true });
      } catch {
        /* ignore */
      }
      try {
        rmSync(stageDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
}
