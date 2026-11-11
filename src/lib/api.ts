import { tr } from '../i18n';
import type {
  AccountSummary,
  Addr,
  AdminUserInfo,
  AuthMe,
  AuthSessionResult,
  AuthUser,
  BackgroundTasks,
  BackupDirInfo,
  BackupDirResult,
  BackupExportJobStatus,
  BackupExportStart,
  BackupInspectResult,
  BackupRestoreJobStatus,
  BackupRestoreResult,
  BackupRestoreStart,
  BackupStatus,
  Companion,
  DuplicateScanResult,
  HomePoint,
  InviteInfo,
  MergeResult,
  PhotoWallData,
  PhotoWallQuery,
  Place,
  PlaceDetail,
  Poi,
  ProvinceLightData,
  PurgeTrashResult,
  QuotaOverview,
  QuotaRequestInfo,
  RestoreTrashResult,
  RevealResult,
  SecretStatus,
  StatsData,
  StatsQuery,
  TrashCount,
  TrashData,
  TrashDuplicatesResult,
  TrashSelection,
  UpdateCheckResult,
  UploadResult,
} from './types';

/** 同行人参数：多选时拼成逗号分隔（后端按 OR 匹配任意一人） */
const companionQs = (companion?: string | string[] | null) =>
  Array.isArray(companion) ? companion.join(',') : companion ?? '';

/** 把查询对象拼成 query string：跳过空值，数字转字符串 */
function qs(obj: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function json<T = any>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const b = await r.json();
      if (b?.error) msg = b.error;
    } catch {}
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export const api = {
  health: () =>
    fetch('/api/health').then((r) =>
      json<{
        ok: boolean;
        /** 账号模式（M6 P2-1，D-200）：local = 单机无账号 / multi = 云端多用户 */
        authMode: string;
        /** 以下字段在 multi 模式按角色分层（P2-4，D-205）：普通用户没有服务器路径 / ffmpeg / 全局数据 */
        hasTk?: boolean;
        mediaRoot?: string;
        dataDir?: string;
        version?: string;
        mode?: string;
        ffmpeg?: boolean;
        stats?: Record<string, number>;
        /** 仅管理员：所有账号合计的数据量 */
        globalStats?: Record<string, number>;
      }>(r)
    ),
  config: () =>
    fetch('/api/config').then((r) =>
      json<{
        tdtTk: string;
        home: HomePoint | null;
        maxUploadBytes: number;
        /** 2026-11-09 D-329：秘密基地初始密码（设置 → 安全 提示用；用户可自行修改） */
        starterSecretPassword?: string;
        /** 2026-11-10：设置 → 素材库 展示支持上传的格式（与后端上传白名单同源） */
        mediaFormats?: { photos: string[]; videos: string[] };
      }>(r)
    ),

  /**
   * 保存家的位置（M5.1）：一个独立坐标点，写 data/config.json.home。
   * 只有一个家；再次保存 = 覆盖。返回归一化后的点。
   */
  setHome: (lng: number, lat: number) =>
    fetch('/api/config/home', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lng, lat }),
    }).then((r) => json<{ ok: boolean; home: HomePoint }>(r)),

  /** 清除旧版「家坐标」（2026-11-04：家迁移为 place.home 地点后调用一次） */
  clearHome: () =>
    fetch('/api/config/home', { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean; home: null }>(r)
    ),

  /**
   * 保存天地图 Key（M5）：只写本机 data/config.json，后端不回显 key。
   * 原生下载/地图加载仍走 GET /api/config（既有设计）。
   */
  setTdtKey: (key: string) =>
    fetch('/api/config/tdt-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    }).then((r) => json<{ ok: boolean; hasTk: boolean }>(r)),

  /** 素材库状态 */
  library: () =>
    fetch('/api/library').then((r) =>
      json<{
        root: string;
        /** 是否自定义过素材库路径（普通用户；未自定义时 root 为空串，不暴露服务器路径） */
        customized?: boolean;
        total: number;
        deleted: number;
        missing: number;
        thumbMissing: number;
        sample: string[];
      }>(r)
    ),

  /** 切换素材库根目录（multi = 只改自己账号的路径；local = 服务器默认路径；切换后服务端自动同步素材） */
  setLibraryRoot: (root: string) =>
    fetch('/api/library/root', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root }),
    }).then((r) =>
      json<{
        ok?: boolean;
        root?: string;
        customized?: boolean;
        synced?: { files: number; moved: number; skipped: number; bytes: number; mode: string };
        error?: string;
      }>(r)
    ),

  /** 恢复默认素材库位置（multi：清掉自己的自定义路径，并把素材同步回默认位置） */
  resetLibraryRoot: () =>
    fetch('/api/library/root', { method: 'DELETE' }).then((r) =>
      json<{
        ok?: boolean;
        root?: string;
        customized?: boolean;
        synced?: { files: number; moved: number; skipped: number; bytes: number; mode: string };
        error?: string;
      }>(r)
    ),

  /** 在服务器所在机器上打开当前账号的素材库文件夹（资源管理器） */
  openLibraryFolder: () =>
    fetch('/api/library/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => json<{ ok?: boolean; error?: string }>(r)),

  /** 按文件名/大小/哈希把记录和磁盘文件重新对上 */
  relink: () =>
    fetch('/api/library/relink', { method: 'POST' }).then((r) =>
      json<{
        root: string;
        scanned: number;
        matched: number;
        byName: number;
        byHash: number;
        stillMissing: number;
        ms: number;
        error?: string;
      }>(r)
    ),

  /** 地名搜索（服务端代理，带限流与缓存） */
  search: (q: string) =>
    fetch(`/api/search?q=${encodeURIComponent(q)}`).then((r) =>
      json<{ results: Poi[]; error?: string }>(r)
    ),

  /** 坐标 → 省市区 */
  reverse: (lng: number, lat: number) =>
    fetch(`/api/reverse?lng=${lng}&lat=${lat}`).then((r) =>
      json<{ address: Addr | null; error?: string }>(r)
    ),

  /** 地点列表；companion 非空时只留有该同行人的到访的地点（F-BRW-06，多选=并集） */
  places: (companion?: string | string[] | null) =>
    fetch(`/api/places${qs({ companion: companionQs(companion) })}`).then((r) => json<Place[]>(r)),
  /** 本地搜索：地点名 或 到访笔记（F-BRW-02） */
  searchPlaces: (q: string) =>
    fetch(`/api/places?q=${encodeURIComponent(q)}`).then((r) => json<Place[]>(r)),
  place: (id: string) => fetch(`/api/places/${id}`).then((r) => json<PlaceDetail>(r)),

  /** 时间轴过滤（F-BRW-03）；companion 与时间区间取交集（F-BRW-06，多选=并集） */
  mapVisits: (from: string, to: string, companion?: string | string[] | null) =>
    fetch(`/api/map/visits${qs({ from, to, companion: companionQs(companion) })}`).then((r) =>
      json<Place[]>(r)
    ),
  timeline: () =>
    fetch('/api/timeline').then((r) =>
      json<{
        first: string | null;
        last: string | null;
        buckets: { q: string; n: number }[];
        dates?: string[];
      }>(r)
    ),

  createPlace: (body: Record<string, unknown>) =>
    fetch('/api/places', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<PlaceDetail>(r)),

  updatePlace: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/places/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<PlaceDetail>(r)),

  deletePlace: (id: string) =>
    fetch(`/api/places/${id}`, { method: 'DELETE' }).then((r) => json(r)),

  addVisit: (placeId: string, body: Record<string, unknown>) =>
    fetch(`/api/places/${placeId}/visits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<PlaceDetail>(r)),

  /** 编辑到访（F-VST-03） */
  updateVisit: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/visits/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<PlaceDetail>(r)),

  /** 删除到访（F-VST-04）：lastVisit 表示这是不剩最后一次 */
  deleteVisit: (id: string) =>
    fetch(`/api/visits/${id}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean; placeId: string; lastVisit: boolean }>(r)
    ),

  /**
   * 单文件上传（F-MED-10）：返回逐文件结果，支持进度回调和中止。
   * 一次只传一个文件，前端队列负责串行、进度、取消与失败重试。
   */
  uploadOne: (
    visitId: string,
    file: File,
    onProgress?: (ratio: number) => void,
    registerAbort?: (abort: () => void) => void
  ) =>
    new Promise<UploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/media/upload?visitId=${encodeURIComponent(visitId)}`);
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable && e.total > 0) {
          onProgress(Math.min(1, e.loaded / e.total));
        }
      };
      xhr.onload = () => {
        let body: any = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* 非 JSON 响应 */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body) {
          resolve(body as UploadResult);
          return;
        }
        const err: any = new Error(
          body?.error || tr('上传失败（HTTP {status}）', { status: xhr.status })
        );
        err.status = xhr.status;
        reject(err);
      };
      xhr.onerror = () => reject(new Error(tr('网络错误，上传失败')));
      xhr.onabort = () => {
        const err: any = new Error(tr('已取消'));
        err.aborted = true;
        reject(err);
      };
      const fd = new FormData();
      fd.append('files', file, file.name);
      registerAbort?.(() => xhr.abort());
      xhr.send(fd);
    }),

  deleteMedia: (id: string) =>
    fetch(`/api/media/${id}`, { method: 'DELETE' }).then((r) => json(r)),

  /** 2026-11-10 D-355（用户要求）：扫描同账号全库里的重复素材（同内容 hash，只读，不删除） */
  duplicateMedia: () =>
    fetch('/api/media/duplicates').then((r) => json<DuplicateScanResult>(r)),

  /** 把所选的重复副本软删进回收站（服务端保证每组至少保留 1 份） */
  trashDuplicateMedia: (ids: string[]) =>
    fetch('/api/media/duplicates/trash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    }).then((r) => json<TrashDuplicatesResult>(r)),

  /** 打开本地文件夹（F-MED-09）：服务端调资源管理器，绝对路径不下发前端 */
  revealMedia: (id: string) =>
    fetch(`/api/media/${id}/reveal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((r) => json<RevealResult>(r)),

  /** 合并重复地点（F-PLC-08）：省市不一致时返回 needConfirm，需 force 重试 */
  mergePlaces: async (fromId: string, intoId: string, force = false): Promise<MergeResult> => {
    const r = await fetch('/api/places/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromId, intoId, force }),
    });
    let body: any = null;
    try {
      body = await r.json();
    } catch {
      /* ignore */
    }
    if (r.status === 409 && body?.needConfirm) {
      return { needConfirm: true, ...body };
    }
    if (!r.ok) throw new Error(body?.error || r.statusText);
    return { ok: true, place: body?.place as PlaceDetail };
  },

  /** 移动媒体到别的到访（F-MED-05） */
  updateMedia: (id: string, body: Record<string, unknown>) =>
    fetch(`/api/media/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json(r)),

  /** 回收站（F-SYS-07）：只含地点/到访；媒体物理删除不入回收站（D-34） */
  trash: () => fetch('/api/trash').then((r) => json<TrashData>(r)),

  /** 顶栏角标：数量口径与 /api/trash 一致 */
  trashCount: () => fetch('/api/trash/count').then((r) => json<TrashCount>(r)),

  /** 恢复单个/批量（地点会连同同一次删除的到访一起恢复） */
  restoreTrash: (items: TrashSelection[]) =>
    fetch('/api/trash/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    }).then((r) => json<RestoreTrashResult>(r)),

  /**
   * 彻底删除（不可恢复）：删数据库记录 + B 库原片 + 缩略图/预览/封面帧缓存，立即释放空间。
   * A 原件永远不动；前端负责确认框。
   */
  purgeTrash: (items: TrashSelection[]) =>
    fetch('/api/trash/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items, confirm: true }),
    }).then((r) => json<PurgeTrashResult>(r)),

  thumbUrl: (id: string) => `/api/media/${id}/thumb`,
  previewUrl: (id: string) => `/api/media/${id}/preview`,
  origUrl: (id: string) => `/api/media/${id}/orig`,

  // ── M3：统计（F-STA / D-60） ──

  /** 统计（按筛选/粒度/分组）；默认全量，不跟随时间轴/随行筛选 */
  stats: (q: StatsQuery = {}) => fetch(`/api/stats${qs(q as Record<string, unknown>)}`).then((r) => json<StatsData>(r)),

  /** 省份点亮：全量口径（地图着色用，独立于统计面板筛选） */
  statsProvinces: () =>
    fetch('/api/stats/provinces').then((r) => json<ProvinceLightData>(r)),

  // ── M3：照片墙（F-BRW-04） ──

  photos: (q: PhotoWallQuery = {}) =>
    fetch(`/api/photos${qs(q as Record<string, unknown>)}`).then((r) => json<PhotoWallData>(r)),

  // ── M3：随行人员筛选（F-BRW-06） ──

  companions: () =>
    fetch('/api/companions').then((r) => json<{ items: Companion[] }>(r)),

  // ── M3：秘密基地（F-PLC-11） ──

  /** 是否已设置密码 + 秘密基地数量（只返回布尔，不下发哈希） */
  secretStatus: () => fetch('/api/secret/status').then((r) => json<SecretStatus>(r)),

  /** 设置 / 修改 / 清除秘密基地密码（修改需旧密码；reset:true = 设置页「重置密码」，不需要旧密码） */
  setSecretPassword: (body: { oldPassword?: string; newPassword: string; reset?: boolean }) =>
    fetch('/api/secret/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ ok: boolean; configured: boolean }>(r)),

  /** 验证秘密基地密码（成功一次后当前会话解锁） */
  verifySecret: (password: string) =>
    fetch('/api/secret/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }).then((r) => json<{ ok: boolean; configured?: boolean }>(r)),

  /**
   * 云端版秘密基地解锁（2026-11-09 D-332，多用户模式）：
   * 验证当前账号的登录密码（云端版不再使用单独的「秘密基地密码」）。
   */
  unlockSecretWithAccountPassword: (password: string) =>
    fetch('/api/secret/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }).then((r) => json<{ ok: boolean }>(r)),

  // ── M6 P2-1：账号 / 会话 / 邀请码（2026-11-06，D-200） ──

  /** 当前模式 + 登录用户；启动时先调它，multi 且 user=null → 显示登录页 */
  authMe: () =>
    fetch('/api/auth/me', { cache: 'no-store' }).then((r) => json<AuthMe>(r)),

  /** 登录（成功后服务端下发 HttpOnly 会话 Cookie） */
  login: (username: string, password: string) =>
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }).then((r) => json<AuthSessionResult>(r)),

  /**
   * 浏览样板展示（2026-11-09 D-335）：无需密码，服务端创建「只读会话」。
   * 成功后整页 reload 重新走启动流程；该会话只能看、不能改任何数据。
   */
  demoLogin: () =>
    fetch('/api/auth/demo', { method: 'POST' }).then((r) => json<AuthSessionResult>(r)),

  /** 邀请码注册（成功后直接登录） */
  register: (body: {
    inviteCode: string;
    username: string;
    password: string;
    displayName?: string;
  }) =>
    fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<AuthSessionResult>(r)),

  /** 登出（清 Cookie） */
  logout: () =>
    fetch('/api/auth/logout', { method: 'POST' }).then((r) => json<{ ok: boolean }>(r)),

  // ── 账号头像（2026-11-07 D-224，顶栏头像 + 名称）──

  /** 当前账号头像 URL（v = avatarUpdatedAt，用于破缓存）；没有头像时服务端 404 */
  avatarUrl: (v?: number) => `/api/account/avatar${v ? `?v=${v}` : ''}`,

  /** 上传 / 替换自己的头像（服务端统一转 128×128 webp，10MB 上限） */
  uploadAvatar: async (file: File) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const r = await fetch('/api/account/avatar', { method: 'POST', body: fd });
    return json<{ ok: boolean; avatarUpdatedAt: number }>(r);
  },

  /** 修改自己的显示名（2026-11-07 D-224：顶栏头像旁的名称；1~40 字） */
  updateProfile: (displayName: string) =>
    fetch('/api/account/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName }),
    }).then((r) => json<{ ok: boolean; user: AuthUser }>(r)),

  /** 修改自己的密码（需要旧密码） */
  changePassword: (oldPassword: string, newPassword: string) =>
    fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oldPassword, newPassword }),
    }).then((r) => json<{ ok: boolean }>(r)),

  /** 管理员：邀请码列表 */
  adminInvites: () =>
    fetch('/api/admin/invites').then((r) => json<{ items: InviteInfo[] }>(r)),

  /** 管理员：生成一次性邀请码（明文 code 只返回这一次） */
  adminCreateInvite: (body: { days?: number; note?: string } = {}) =>
    fetch('/api/admin/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ invite: InviteInfo; code: string }>(r)),

  /** 管理员：作废未使用的邀请码 */
  adminRevokeInvite: (id: string) =>
    fetch(`/api/admin/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  // ── M6 P2-3：账号用量 / 用户管理 / 用户数据导出（2026-11-06，D-204）──

  /** 当前账号 + 配额 + 用量（D-310 起云端 multi 按配额拦截上传，可申请扩容） */
  accountSummary: () => fetch('/api/account/summary').then((r) => json<AccountSummary>(r)),

  /** 我的配额 + 扩容申请记录（D-310；设置 → 账号的「申请扩容」板块） */
  quotaOverview: () => fetch('/api/account/quota-requests').then((r) => json<QuotaOverview>(r)),

  /** 提交扩容申请：requestedBytes = 希望调整到的配额（字节） */
  submitQuotaRequest: (requestedBytes: number, reason = '') =>
    fetch('/api/account/quota-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestedBytes, reason }),
    }).then((r) => json<{ ok: boolean; request: QuotaRequestInfo }>(r)),

  /** 取消自己的待审批扩容申请 */
  cancelQuotaRequest: (id: string) =>
    fetch(`/api/account/quota-requests/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  /** 管理员：扩容申请列表（默认只看 pending） */
  adminQuotaRequests: (status: 'pending' | 'all' = 'pending') =>
    fetch(`/api/admin/quota-requests?status=${encodeURIComponent(status)}`).then((r) =>
      json<{ items: QuotaRequestInfo[] }>(r)
    ),

  /** 管理员：批准（可选 quotaBytes，不传按申请值）/ 拒绝扩容申请 */
  adminDecideQuotaRequest: (
    id: string,
    body: { action: 'approve' | 'reject'; quotaBytes?: number; note?: string }
  ) =>
    fetch(`/api/admin/quota-requests/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<{ ok: boolean; request: QuotaRequestInfo; quotaBytes?: number }>(r)),

  /** 管理员：账号列表（含状态 / 配额 / 用量 / 最近登录） */
  adminUsers: () => fetch('/api/admin/users').then((r) => json<{ items: AdminUserInfo[] }>(r)),

  /** 管理员：改显示名 / 禁用启用 / 调整配额（quotaBytes=0 表示用服务端默认，D-310 起默认 1 GiB） */
  adminUpdateUser: (
    id: string,
    patch: { displayName?: string; status?: 'active' | 'disabled'; quotaBytes?: number }
  ) =>
    fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => json<{ ok: boolean; user: AdminUserInfo }>(r)),

  /** 管理员：重置某个账号的登录密码（不需要旧密码） */
  adminResetPassword: (id: string, newPassword: string) =>
    fetch(`/api/admin/users/${encodeURIComponent(id)}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newPassword }),
    }).then((r) => json<{ ok: boolean }>(r)),

  /**
   * 下载我的数据到本地（2026-11-11 D-369：云端普通用户取消备份 / 恢复，只保留导出 / 下载）：
   * zip 下载地址（GET 带 Cookie，直接给 <a href> 用）；thumbs 默认包含，media 需显式勾选。
   */
  userExportUrl: (opts: { thumbs?: boolean; media?: boolean } = {}) => {
    const p = new URLSearchParams();
    p.set('thumbs', opts.thumbs === false ? '0' : '1');
    p.set('media', opts.media ? '1' : '0');
    return `/api/account/export?${p.toString()}`;
  },

  // ── M4：备份 / 恢复 / 提醒（F-SYS-03/04/05） ──

  /** 备份状态与提醒（F-SYS-05 + v2）：上次备份 / 阈值 / 稍后 / 数据量 / 素材体积预估 */
  backupStatus: () => fetch('/api/backup/status').then((r) => json<BackupStatus>(r)),

  /**
   * 两阶段导出（F-SYS-03 v2）：先 start 拿 jobId/预估，再按 500ms 轮询 exportStatus。
   * 2026-11-11 用户拍板：本地模式打包完成后 zip 直接保存到「备份目录」，
   * 前端不再触发浏览器下载（只显示 savedPath / savedName 并提供「打开备份目录」）。
   */
  startBackupExport: (body: { includeThumbs: boolean; includeMedia: boolean }) =>
    fetch('/api/backup/export/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => json<BackupExportStart>(r)),

  /**
   * 导出任务进度（两阶段导出）：state=building/done/error/canceled。
   * 2026-11-11 用户拍板：本地模式 done 时 savedPath / savedName **一定有值**（zip 已在备份目录），
   * 失败则 state=error（savedPath 为空，saveError 带原因）；multi 模式保持旧浏览器下载行为。
   */
  exportStatus: (jobId: string) =>
    fetch(`/api/backup/export/status/${encodeURIComponent(jobId)}`).then((r) =>
      json<BackupExportJobStatus>(r)
    ),

  /** 取消 building 中的导出 / 清理 done 的临时 zip */
  cancelBackupExport: (jobId: string) =>
    fetch(`/api/backup/export/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).then((r) =>
      json<{ ok: boolean }>(r)
    ),

  /**
   * 原生下载 URL（保留但 2026-11-11 起**前端不再调用**）：本地导出只落「备份目录」，
   * 云端（multi）也不再提供应用内备份入口；服务端 download 接口仍可用（兼容 smoke / 运维脚本）。
   */
  backupDownloadUrl: (jobId: string) =>
    `/api/backup/export/download/${encodeURIComponent(jobId)}`,

  /** 校验备份包（F-SYS-04）：multipart 字段名 file，返回 token + 摘要（token 10 分钟内有效） */
  inspectBackup: (file: File) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return fetch('/api/backup/inspect', { method: 'POST', body: fd }).then((r) =>
      json<BackupInspectResult>(r)
    );
  },

  /**
   * 从备份恢复（F-SYS-04）：后端行级事务替换。
   * 失败 500 时数据已回滚，err.rolledBack = true 表示「当前数据未被修改」。
   */
  restoreBackup: async (token: string): Promise<BackupRestoreResult> => {
    const r = await fetch('/api/backup/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, confirm: true }),
    });
    let body: any = null;
    try {
      body = await r.json();
    } catch {
      /* 非 JSON 响应 */
    }
    if (!r.ok) {
      const err: any = new Error(
        body?.error || tr('恢复失败（HTTP {status}）', { status: r.status })
      );
      err.status = r.status;
      err.rolledBack = body?.rolledBack === true;
      throw err;
    }
    return body as BackupRestoreResult;
  },

  /** 稍后提醒（F-SYS-05）：默认 1 天（24 小时），返回最新 status */
  snoozeBackup: (days = 1) =>
    fetch('/api/backup/snooze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ days }),
    }).then((r) => json<BackupStatus>(r)),

  // ── 2026-11-11 D-364：备份目录（仅本地安装版）──

  /** 当前备份目录 + 默认目录 + 平台 */
  backupDir: () => fetch('/api/backup/dir').then((r) => json<BackupDirInfo>(r)),

  /** 手动设置备份目录（原生选择框不可用时的兜底） */
  setBackupDirPath: (path: string) =>
    fetch('/api/backup/dir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }).then((r) => json<BackupDirResult>(r)),

  /** 弹出系统「选择文件夹」对话框并切换（用户取消时 canceled=true） */
  pickBackupDir: () => fetch('/api/backup/dir/pick', { method: 'POST' }).then((r) => json<BackupDirResult>(r)),

  /** 在系统文件管理器里打开备份目录 */
  openBackupDir: () => fetch('/api/backup/dir/open', { method: 'POST' }).then((r) => json<{ ok: boolean; dir: string }>(r)),

  // ── 2026-11-11 D-365：后台任务（关掉设置 / 刷新页面不中断，重开可继续看）──

  /** 当前 + 最近的后台任务（导出 / 恢复） */
  backgroundTasks: () => fetch('/api/background-tasks').then((r) => json<BackgroundTasks>(r)),

  /** 启动后台恢复任务（服务端继续跑；客户端只轮询 status） */
  startBackupRestore: (token: string) =>
    fetch('/api/backup/restore/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then((r) => json<BackupRestoreStart>(r)),

  /** 后台恢复任务状态 */
  restoreJobStatus: (jobId: string) =>
    fetch(`/api/backup/restore/status/${encodeURIComponent(jobId)}`).then((r) =>
      json<BackupRestoreJobStatus>(r)
    ),

  /** 修改提醒阈值（F-SYS-05）：只允许 {7,14,30,60,90}，返回最新 status */
  updateBackupSettings: (reminderDays: number) =>
    fetch('/api/backup/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reminderDays }),
    }).then((r) => json<BackupStatus>(r)),

  /** 本地模式：检查 GitHub 上是否有新版本（2026-11-08 D-319；云端不需要，服务器更新后刷新即新版） */
  checkUpdate: () => fetch('/api/update/check').then((r) => json<UpdateCheckResult>(r)),
};
