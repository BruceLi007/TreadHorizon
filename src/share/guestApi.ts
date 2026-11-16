import { api } from '../lib/api';
import type { AuthMe } from '../lib/types';
import { mediaUrl } from './api';
import { GUEST_TIP } from './guestFlag';
import type { ShareSource } from './shareSource';

export const SHARE_KEY_STORAGE = 'tm-share-tdt-key';

const readonlyError = () => Promise.reject(new Error(GUEST_TIP));

/**
 * 把正式版前端用到的 api 替换成「manifest 只读数据源」。
 * 读接口返回分享数据；写接口一律拒绝（提示只读），图片走 /api/share/<token>/media/<file>。
 */
export function patchGuestApi(source: ShareSource): void {
  const me: AuthMe = {
    mode: 'multi',
    user: {
      id: 'share-guest',
      username: 'guest',
      displayName: source.displayName || 'Traveler',
      role: 'user',
      status: 'active',
      readOnly: true,
      quotaBytes: 0,
      createdAt: source.manifest.createdAt,
      // 2026-11-15 D-424：分享包里带了分享者头像 → 顶栏显示真实头像
      avatarUpdatedAt: source.manifest.sharer?.avatar ? 1 : 0,
    } as any,
  } as any;

  const readKey = () => {
    try {
      return localStorage.getItem(SHARE_KEY_STORAGE) || '';
    } catch {
      return '';
    }
  };

  Object.assign(api as any, {
    authMe: async () => me,
    health: async () => ({ ok: true, version: source.manifest.appVersion || '', mediaRoot: '', dataDir: '', authMode: 'multi' }),
    config: async () => ({
      tdtTk: readKey(),
      home: null,
      maxUploadBytes: 0,
      starterSecretPassword: '',
      mediaFormats: { photos: [], videos: [] },
    }),
    places: async () => source.places,
    searchPlaces: async () => [],
    place: async (id: string) => {
      const d = source.details.get(id);
      if (!d) throw new Error('not found');
      return d;
    },
    mapVisits: async (from: string, to: string, companions?: string | string[] | null) => {
      const list = Array.isArray(companions) ? companions : companions ? [companions] : [];
      return source.places.filter((p) =>
        (source.details.get(p.id)?.visits ?? []).some((v) => {
          if (from && v.date < from) return false;
          if (to && v.date > to) return false;
          if (list.length) {
            const cs = v.companions ?? [];
            if (!list.every((c) => cs.includes(c))) return false;
          }
          return true;
        })
      );
    },
    timeline: async () => source.timeline,
    stats: async (q: any) => source.stats(q || {}),
    statsProvinces: async () => source.provinceLight(),
    statsCities: async () => source.cityLight(),
    photos: async (q: any) => source.photos(q || {}),
    companions: async () => source.companions,
    secretStatus: async () => ({ configured: false, places: 0 }),
    trashCount: async () => ({ places: 0, visits: 0, media: 0 }),
    thumbUrl: (id: string) => source.thumbUrl(id),
    previewUrl: (id: string) => source.thumbUrl(id),
    origUrl: (id: string) => source.thumbUrl(id),
    avatarUrl: (v?: number) =>
      source.manifest.sharer?.avatar && v
        ? `/api/share/${encodeURIComponent(source.token)}/avatar`
        : '',
    setTdtKey: async (key: string) => {
      try {
        localStorage.setItem(SHARE_KEY_STORAGE, key);
      } catch {
        /* ignore */
      }
      return { ok: true };
    },
    // 写操作全部拒绝（只读访客）
    setHome: readonlyError,
    clearHome: readonlyError,
    createPlace: readonlyError,
    updatePlace: readonlyError,
    deletePlace: readonlyError,
    addVisit: readonlyError,
    updateVisit: readonlyError,
    deleteVisit: readonlyError,
    uploadOne: readonlyError,
    deleteMedia: readonlyError,
    duplicateMedia: readonlyError,
    trashDuplicateMedia: readonlyError,
    revealMedia: readonlyError,
    mergePlaces: readonlyError,
    updateMedia: readonlyError,
    restoreTrash: readonlyError,
    purgeTrash: readonlyError,
    startTrashRestore: readonlyError,
    startTrashPurge: readonlyError,
    setSecretPassword: readonlyError,
    verifySecret: readonlyError,
    unlockSecretWithAccountPassword: readonlyError,
    login: readonlyError,
    register: readonlyError,
    logout: readonlyError,
    uploadAvatar: readonlyError,
    updateProfile: readonlyError,
    changePassword: readonlyError,
    adminInvites: readonlyError,
    adminCreateInvite: readonlyError,
    search: readonlyError,
    reverse: readonlyError,
    setLibraryRoot: readonlyError,
    resetLibraryRoot: readonlyError,
    openLibraryFolder: readonlyError,
    relink: readonlyError,
    library: async () => ({ root: '', ok: true }),
  });
}

export const shareMediaUrl = mediaUrl;
