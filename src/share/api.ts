/** 分享只读页的接口封装（2026-11-14 D-416 / P2） */

export interface ShareMedia {
  id: string;
  kind: 'photo';
  w: number;
  h: number;
  takenAt: number;
  file: string;
  bytes: number;
}

export interface ShareVisit {
  id: string;
  date: string;
  title?: string;
  note?: string;
  companions?: string[];
  media: string[];
}

export interface SharePlace {
  id: string;
  name: string;
  kind: 'visited' | 'wishlist';
  lng: number;
  lat: number;
  provinceCode?: string;
  provinceName?: string;
  city?: string;
  district?: string;
  coverId?: string;
  lastDate?: string;
  home?: boolean;
  homeDistanceKm?: number;
  visits: ShareVisit[];
}

export interface ShareManifest {
  format: 'tread-horizon-share';
  formatVersion: 1;
  appVersion?: string;
  createdAt: number;
  range?: { from: string; to: string };
  title: string;
  sharer: { displayName: string; avatar?: string };
  counts: { places: number; visits: number; photos: number };
  places: SharePlace[];
  media: ShareMedia[];
}

export interface PublicShare {
  manifest: ShareManifest;
  /** 上传时填的标题（可能为空；老分享可能回退成了「起止日期」） */
  title?: string;
  expiresAt: number | null;
  hasPassword: boolean;
}

export type LoadResult =
  | { kind: 'ok'; data: PublicShare }
  | { kind: 'password'; title: string }
  | { kind: 'expired' }
  | { kind: 'revoked' }
  | { kind: 'notfound' }
  | { kind: 'error'; message: string };

export const mediaUrl = (token: string, file: string) =>
  `/api/share/${encodeURIComponent(token)}/media/${encodeURIComponent(file)}`;

export async function loadShare(token: string): Promise<LoadResult> {
  let res: Response;
  try {
    res = await fetch(`/api/share/${encodeURIComponent(token)}`, {
      headers: { accept: 'application/json' },
    });
  } catch {
    return { kind: 'error', message: 'network' };
  }
  if (res.ok) {
    try {
      return { kind: 'ok', data: (await res.json()) as PublicShare };
    } catch {
      return { kind: 'error', message: 'invalid_json' };
    }
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 401 && body?.error === 'password_required') {
    return { kind: 'password', title: String(body?.title || '') };
  }
  if (res.status === 410) {
    return body?.error === 'revoked' ? { kind: 'revoked' } : { kind: 'expired' };
  }
  if (res.status === 404) return { kind: 'notfound' };
  return { kind: 'error', message: `http_${res.status}` };
}

export async function unlockShare(
  token: string,
  password: string
): Promise<{ ok: boolean; status: number; error?: string }> {
  let res: Response;
  try {
    res = await fetch(`/api/share/${encodeURIComponent(token)}/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch {
    return { ok: false, status: 0, error: 'network' };
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, error: body?.error ? String(body.error) : undefined };
}
