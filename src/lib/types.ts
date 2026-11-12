export interface Place {
  id: string;
  name: string;
  lng: number;
  lat: number;
  province?: string | null;
  city?: string | null;
  county?: string | null;
  province_code?: string | null;
  city_code?: string | null;
  county_code?: string | null;
  kind: 'visited' | 'wishlist';
  /** 秘密基地标记（F-PLC-11）：1 = 是；仅影响飞镖颜色/侧栏标识与打开前的密码校验 */
  secret?: number | null;
  /**
   * 家（M5 遗留字段）：1 = 是。
   * M5.1 起「家」改为独立地图点位（见 HomePoint），侧栏不再提供设置入口；
   * 该字段只为旧备份 / 旧接口兼容保留，前端不再渲染。
   */
  home?: number | null;
  cover_id?: string | null;
  /** alive 照片 / 视频数量（2026-11-04，D-117）：My旅迹地点行显示「照片 N · 视频 M」 */
  photos?: number;
  videos?: number;
  visit_count?: number;
  first_date?: string | null;
  last_date?: string | null;
  /** 时间轴区间接口额外带的「总共」统计（不退化为区间内计数） */
  total_visit_count?: number;
  total_first_date?: string | null;
  total_last_date?: string | null;
  /** 加入时间（ms），想去清单里显示 */
  created_at?: number;
}

export interface MediaItem {
  id: string;
  kind: 'photo' | 'video';
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  created_at: number;
}

export interface Visit {
  id: string;
  place_id: string;
  date: string;
  title?: string | null;
  note?: string | null;
  rating?: number | null;
  companions?: string[] | null;
  media: MediaItem[];
}

export interface PlaceDetail extends Place {
  visits: Visit[];
}

/**
 * 家的位置（M5.1）：一个独立的地图坐标点，存 data/config.json.home。
 * 不是地点记录：不参与聚合、统计、清单、时间轴；只有一个家，重新打点即覆盖。
 */
export interface HomePoint {
  lng: number;
  lat: number;
}

export interface Poi {
  name: string;
  address: string;
  lnglat: string;
  source?: 'poi' | 'geocode';
}

export interface Addr {
  province?: string;
  city?: string;
  county?: string;
  province_code?: string;
  city_code?: string;
  county_code?: string;
  formatted?: string;
  poi?: string;
}

// ── M2：上传队列 / 合并 / 打开文件夹 ──

export interface UploadSkipped {
  name: string;
  reason: string;
  mediaId?: string;
  /**
   * 2026-11-10 D-354（用户要求：上传按「同账号全库」查重）：
   * 命中重复时返回已存在的地点名 / 到访日期 / 是否就是本次这个到访，供前端提示「已存在于哪」。
   */
  sameVisit?: boolean;
  placeName?: string | null;
  visitDate?: string | null;
}

export interface UploadResult {
  added: { id: string; name: string }[];
  skipped: UploadSkipped[];
  errors: string[];
}

// ── 重复素材检测（2026-11-10 D-355，用户要求）──

/** 一组重复素材（内容 hash 相同）里的一份 */
export interface DuplicateMediaItem {
  id: string;
  kind: 'photo' | 'video';
  name: string;
  bytes: number;
  createdAt: number;
  visitId: string;
  visitDate: string;
  placeId: string;
  placeName: string;
}

/** 一组重复素材（2 份以上） */
export interface DuplicateMediaGroup {
  hash: string;
  count: number;
  bytes: number;
  items: DuplicateMediaItem[];
}

export interface DuplicateScanResult {
  groups: DuplicateMediaGroup[];
  /** 重复组数 */
  totalGroups: number;
  /** 多出来的副本数（每组保留 1 份后剩下的） */
  extraCopies: number;
  /** 多出来的副本总字节（彻底删除后释放） */
  extraBytes: number;
}

export interface TrashDuplicatesResult {
  trashed: number;
  /** 因为「每组至少保留 1 份」而被保留的组数 */
  keptLast: number;
  bytes: number;
  ids?: string[];
}

export interface PlaceBrief {
  name?: string | null;
  province?: string | null;
  city?: string | null;
  county?: string | null;
}

export interface MergeResult {
  ok?: boolean;
  needConfirm?: boolean;
  error?: string;
  place?: PlaceDetail;
  from?: PlaceBrief;
  into?: PlaceBrief;
}

export interface RevealResult {
  ok: boolean;
  missing: boolean;
  opened: 'select' | 'folder';
  error?: string;
}

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'skipped' | 'error' | 'canceled';

/** F-MED-10 上传队列里的一项（一个文件） */
export interface UploadItem {
  key: string;
  file: File;
  visitId: string;
  status: UploadStatus;
  /** 0..1 上传进度；服务端处理缩略图时停在 1 */
  progress: number;
  error?: string;
  mediaId?: string;
  /**
   * 2026-11-10 D-350（用户要求）：上传队列拆到「设置 → 上传」后，需要显示「哪个地点、哪次到访」，
   * 在入队时由 Sidebar 带上；老数据 / 兜底可缺省（显示「未知地点 / 未标注日期」）。
   */
  placeId?: string;
  placeName?: string;
  visitDate?: string;
}

// ── M3：回收站（F-SYS-07 / D-57：按删除动作分层） ──

/** 回收站里的一行媒体占用统计 */
export interface TrashSizeInfo {
  /** 原片字节数 */
  bytes: number;
  /** 缩略图 / 1600 预览 / 视频封面帧缓存字节数 */
  cache_bytes: number;
  /** bytes + cache_bytes */
  size: number;
}

/** 父级行里「此前单独删除、默认不随父级恢复」子项的统计 */
export interface TrashEarlierInfo {
  earlier_bytes: number;
  earlier_cache_bytes: number;
  earlier_size: number;
}

/** 回收站里的一个已删地点：媒体/到访只统计「随本次删除」的子项 */
export interface TrashPlaceItem extends TrashSizeInfo, TrashEarlierInfo {
  type: 'place';
  id: string;
  name: string;
  kind: 'visited' | 'wishlist';
  province?: string | null;
  city?: string | null;
  county?: string | null;
  deleted_at: number;
  /** 随这次删除一起恢复的到访数 */
  visit_count: number;
  /** 随这次删除一起恢复的媒体数 */
  media_count: number;
  /** 此前单独删除的到访数（它们仍在到访标签里单独显示） */
  earlier_visit_count: number;
  /** 此前单独删除的媒体数（仍在照片标签里单独显示，或在其到访行里） */
  earlier_media_count: number;
}

/** 回收站里的一个已删到访（所属地点可能也已删除） */
export interface TrashVisitItem extends TrashSizeInfo, TrashEarlierInfo {
  type: 'visit';
  id: string;
  place_id: string;
  place_name: string;
  province?: string | null;
  city?: string | null;
  county?: string | null;
  date: string;
  title?: string | null;
  deleted_at: number;
  /** 地点是否也在回收站（是的话恢复需先恢复地点） */
  place_deleted_at?: number | null;
  media_count: number;
  earlier_media_count: number;
}

/** 单独删掉的一条照片/视频：永远留在媒体标签 */
export interface TrashMediaItem extends TrashSizeInfo {
  type: 'media';
  id: string;
  visit_id: string;
  place_id: string;
  place_name: string;
  date: string;
  kind: 'photo' | 'video';
  name: string;
  deleted_at: number;
  /** 所属到访/地点是否也在回收站（是的话需先恢复父级） */
  parent_visit_deleted: boolean;
  parent_place_deleted: boolean;
}

export type TrashItem = TrashPlaceItem | TrashVisitItem | TrashMediaItem;

export interface TrashData extends TrashSizeInfo {
  items: TrashItem[];
  /** 行数 = placeCount + visitCount + mediaCount */
  total: number;
  placeCount: number;
  visitCount: number;
  /** 单独列出的媒体行数 */
  mediaCount: number;
  /** 回收站里的全部媒体数（含随父级删除的） */
  mediaTotal: number;
}

export interface TrashCount {
  total: number;
  places: number;
  visits: number;
  media: number;
}

export interface TrashSelection {
  type: 'place' | 'visit' | 'media';
  id: string;
  /** 恢复父级时：同时恢复此前单独删除的子项 */
  restoreEarlier?: boolean;
}

export interface TrashFileStats {
  deleted: number;
  missing: number;
  errors: string[];
}

export interface RestoreTrashResult {
  ok: boolean;
  restoredPlaces: number;
  restoredVisits: number;
  restoredMedia: number;
  /** restoreEarlier 额外恢复的子项（不含默认随父级恢复的） */
  restoredEarlierVisits: number;
  restoredEarlierMedia: number;
  remaining: TrashCount;
}

export interface PurgeTrashResult {
  ok: boolean;
  purgedPlaces: number;
  purgedVisits: number;
  purgedMedia: number;
  files?: TrashFileStats | null;
  remaining: TrashCount;
}

/**
 * 回收站后台任务（2026-11-12 D-400）：批量恢复 / 彻底删除在服务端执行，
 * 关掉设置 / 切页 / 刷新页面不会中断，重新打开回收站可以接回进度与结果。
 */
export type TrashJobKind = 'restore' | 'purge';
export type TrashJobState = 'running' | 'done' | 'error';

export interface TrashJob {
  jobId: string;
  kind: TrashJobKind;
  state: TrashJobState;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  result: RestoreTrashResult | PurgeTrashResult | null;
}

export interface TrashJobStart {
  jobId: string;
  kind: TrashJobKind;
  createdAt: number;
}

// ── M3：统计（F-STA / D-60） ──

export interface StatsTotals {
  provinces: number;
  cities: number;
  places: number;
  visits: number;
  photos: number;
  videos: number;
}

/** 首访 / 最近一条到访（F-STA-04） */
export interface StatsFirstLast {
  date: string;
  place_id: string;
  place_name: string;
  province?: string | null;
  city?: string | null;
  lng: number;
  lat: number;
}

/** 时间趋势的一个桶（年 / 季 / 月）；所有指标都在，前端只挑最多 2 个画图 */
export interface StatsTimePoint {
  /** 2024 / 2024-Q1 / 2024-03 */
  bucket: string;
  /** 展示文案：2024 / 2024 Q1 / 2024.03 */
  label: string;
  visits: number;
  places: number;
  first_visits: number;
  photos: number;
  videos: number;
}

/** seriesBy 分组后的一条序列（Top N + 其他） */
export interface StatsSeries {
  name: string;
  points: { bucket: string; visits: number; places: number }[];
}

export interface StatsProvinceRow {
  name: string;
  code?: string | null;
  places: number;
  visits: number;
  photos: number;
  videos: number;
  first_date?: string | null;
  last_date?: string | null;
}

export interface StatsCityRow {
  name: string;
  province?: string | null;
  places: number;
  visits: number;
  photos: number;
  videos: number;
  first_date?: string | null;
  last_date?: string | null;
}

export interface StatsPlaceRow {
  id: string;
  name: string;
  province?: string | null;
  city?: string | null;
  secret?: number | null;
  visits: number;
  photos: number;
  videos: number;
  first_date?: string | null;
  last_date?: string | null;
}

/** 离家最远（2026-11-06 用户需求）：当前筛选范围内，到「家」的直线距离（km） */
export interface StatsFarthest {
  distance_km: number;
  place_id: string;
  name: string;
  province?: string | null;
  city?: string | null;
  lng: number;
  lat: number;
}

/** 统计里「家」的简要信息（2026-11-06 D-199：离家距离排行显示以家为原点）；未设置家时 null */
export interface StatsHome {
  id: string;
  name: string;
}

/** 离家距离排行的一行（2026-11-06 D-199）：当前筛选内、到「家」直线距离从远到近 */
export interface StatsDistanceRow {
  id: string;
  name: string;
  province?: string | null;
  city?: string | null;
  secret?: number | null;
  visits: number;
  photos: number;
  videos: number;
  first_date?: string | null;
  last_date?: string | null;
  distance_km: number;
}

export interface StatsData {
  range: { from: string | null; to: string | null; province: string | null; city: string | null };
  totals: StatsTotals;
  first: StatsFirstLast | null;
  last: StatsFirstLast | null;
  /** 未设置家 / 无访问地点时为 null */
  farthest: StatsFarthest | null;
  /** 家（用于「离家距离」视图）；未设置家时 null */
  home: StatsHome | null;
  /** 离家距离排行：当前筛选内按到「家」直线距离从远到近（limit 截断，排除家本身） */
  distance_places: StatsDistanceRow[];
  /** 当前筛选内参与离家距离排行的地点总数（不受 limit 截断） */
  distance_total: number;
  time: StatsTimePoint[];
  series: StatsSeries[];
  provinces: StatsProvinceRow[];
  cities: StatsCityRow[];
  places: StatsPlaceRow[];
}

export interface StatsQuery {
  from?: string | null;
  to?: string | null;
  province?: string | null;
  city?: string | null;
  bucket?: 'year' | 'quarter' | 'month';
  seriesBy?: 'province' | 'city' | null;
  limit?: number;
}

/** 省份点亮（F-STA-01）：全量口径，供地图着色 */
export interface ProvinceLight {
  name: string;
  code?: string | null;
  places: number;
  visits: number;
  first_date?: string | null;
  last_date?: string | null;
}

export interface ProvinceLightData {
  provinces: ProvinceLight[];
  maxPlaces: number;
  maxVisits: number;
}

/** /province-boundaries.json 里的一条省界（自绘 SVG 用；归属仍看 place.province_code） */
export interface ProvinceBoundaryFeature {
  name: string;
  adcode: string;
  center?: [number, number] | null;
  /** 每个环是一串 [lng, lat]；外环 + 内环（洞）不做区分，统一填充 */
  rings: [number, number][][];
}

export interface ProvinceBoundaryData {
  source?: string;
  generated_at?: string;
  features: ProvinceBoundaryFeature[];
}

// ── M3：照片墙（F-BRW-04） ──

export interface PhotoWallItem {
  id: string;
  kind: 'photo' | 'video';
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  bytes?: number | null;
  created_at: number;
  /** 所属到访日期 YYYY-MM-DD */
  date: string;
  visit_id: string;
  visit_title?: string | null;
  place: {
    id: string;
    name: string;
    province?: string | null;
    city?: string | null;
    county?: string | null;
  };
  secret?: number | null;
}

export interface PhotoWallData {
  total: number;
  items: PhotoWallItem[];
  /** 当前筛选下的年份分布，用于顶部年份 chip */
  years: { year: string; count: number }[];
  /**
   * 当前筛选下「有素材的省份」分布（2026-11-10 D-359）。
   * 服务端按年 / 地点 / 种类等其它筛选聚合，但**不受省份筛选本身影响**，
   * 所以选了某个省后下拉仍能切到别的省；用于照片墙「省份」下拉。
   */
  provinces: { name: string; count: number }[];
}

export interface PhotoWallQuery {
  from?: string | null;
  to?: string | null;
  province?: string | null;
  city?: string | null;
  place_id?: string | null;
  kind?: 'photo' | 'video';
  limit?: number;
  offset?: number;
}

// ── M3：随行人员筛选（F-BRW-06） ──

export interface Companion {
  name: string;
  visits: number;
  places: number;
  first_date?: string | null;
  last_date?: string | null;
}

// ── M3：秘密基地（F-PLC-11） ──

export interface SecretStatus {
  configured: boolean;
  places: number;
}

// ── M6 P2-1：账号 / 会话 / 邀请码（2026-11-06，D-200） ──

/** 账号模式：local = 单机本地（默认，不需要登录）；multi = 云端多用户 */
export type AuthMode = 'local' | 'multi';

/** 当前登录用户（服务端出口字段，不含密码 / 盐） */
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  quotaBytes: number;
  createdAt: number;
  lastLoginAt?: number | null;
  /** 头像更新时间（2026-11-07 D-224；0 / 缺省 = 没上传过头像，顶栏显示首字母占位） */
  avatarUpdatedAt?: number;
  /**
   * 2026-11-09 D-335：只读样板会话（云端版「浏览样板展示（只读）」入口）。
   * true = 服务端强制只读：不能打点 / 上传 / 删除 / 改密码；前端据此隐藏所有写入口。
   */
  readOnly?: boolean;
}

/** GET /api/auth/me：模式 + 当前用户（未登录 / local 模式为 null） */
export interface AuthMe {
  mode: AuthMode;
  user: AuthUser | null;
  /**
   * 只读样板展示入口（2026-11-09 D-335）：云端配置了 DEMO_USERNAME 时出现，登录页显示
   * 「浏览样板展示（只读）」按钮；未开放为 undefined。
   */
  demo?: { enabled: boolean; displayName?: string };
}

/** 登录 / 邀请码注册成功后的返回 */
export interface AuthSessionResult {
  ok: boolean;
  user: AuthUser;
}

/** 管理员邀请码列表的一行（不含哈希 / 明文） */
export interface InviteInfo {
  id: string;
  note: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  createdBy: string;
  usedBy: string;
  expired: boolean;
  used: boolean;
}

// ── M6 P2-3：管理后台 / 配额 / 用户数据导出（2026-11-06，D-204） ──

/** 一个账号的用量（mediaBytes 含回收站里还没彻底删除的媒体，反映磁盘真实占用） */
export interface UserUsage {
  mediaBytes: number;
  mediaCount: number;
  places: number;
  visits: number;
  photos: number;
  videos: number;
}

/** 管理员「用户管理」列表的一行 */
export interface AdminUserInfo extends AuthUser {
  usedBytes: number;
  usage: UserUsage;
}

/** GET /api/account/summary：当前账号 + 配额 + 用量 */
export interface AccountSummary {
  user: AuthUser;
  quotaBytes: number;
  usage: UserUsage;
  /** 待审批的扩容申请（D-310；没有则为 null / 缺省） */
  pendingQuotaRequest?: QuotaRequestInfo | null;
}

/** 扩容申请状态（D-310） */
export type QuotaRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** 扩容申请（D-310；云端 multi 默认 1 GiB，用满后可申请扩容） */
export interface QuotaRequestInfo {
  id: string;
  userId: string;
  requestedBytes: number;
  currentBytes: number;
  reason: string;
  status: QuotaRequestStatus;
  createdAt: number;
  decidedAt: number | null;
  approvedBytes: number | null;
  adminNote: string | null;
  /** 管理员列表才带：申请人的账号名 / 显示名 */
  username?: string;
  displayName?: string;
}

/** GET /api/account/quota-requests：我的配额 + 申请记录 */
export interface QuotaOverview {
  quotaBytes: number;
  usedBytes: number;
  pending: QuotaRequestInfo | null;
  history: QuotaRequestInfo[];
}

// ── M4：备份 / 恢复 / 提醒（F-SYS-03/04/05） ──

/** 备份计数：地点 / 到访 / 媒体。alive = 不含回收站，counts = 含软删总行数 */
export interface BackupCounts {
  places: number;
  visits: number;
  media: number;
}

/**
 * 备份 zip manifest 里的计数（单数键 place / visit / media）。
 * 注意与 status.dataCounts / restore.restored 的复数键不同，后端契约如此。
 */
export interface BackupZipCounts {
  place: number;
  visit: number;
  media: number;
}

/** data/backups/ 下的自动备份（恢复前生成） */
export interface AutoBackupInfo {
  name: string;
  bytes: number;
  createdAt: number;
}

/** GET /api/backup/status：备份提醒状态（F-SYS-05） */
export interface BackupStatus {
  lastBackupAt: number | null;
  lastBackupAtISO: string | null;
  daysSinceBackup: number | null;
  thresholdDays: number;
  snoozeUntil: number | null;
  due: boolean;
  reason: 'never' | 'overdue' | null;
  dataCounts: BackupCounts;
  /** 全部 media 行 bytes 合计（含软删），用于预估「照片视频素材」体积 */
  mediaBytes: number;
  /** 全部 media 行数（含软删） */
  mediaFiles: number;
  autoBackupDir: string;
  recentAutoBackups: AutoBackupInfo[];
}

/** 备份包摘要（POST /api/backup/inspect 校验通过后返回） */
export interface BackupSummary {
  createdAt: number | null;
  createdAtISO: string | null;
  appVersion: string | null;
  formatVersion: number;
  zipBytes: number;
  includeThumbs: boolean;
  thumbsCount: number;
  /** v2：备份包是否包含照片/视频素材文件 */
  includeMedia: boolean;
  /** v2：备份包内的素材文件数（manifest.includes.mediaCount） */
  mediaCount: number;
  /** v2：备份包内素材文件字节合计 */
  mediaBytes: number;
  /** v2：导出时素材库里已经缺失、没被计入包内的素材数 */
  mediaMissingAtExport: number;
  /** 含回收站的原始行数（单数键，与 zip manifest 一致） */
  counts: BackupZipCounts;
  /** 正常显示的数据量（不含回收站；单数键） */
  aliveCounts: BackupZipCounts;
  secretConfigured: boolean;
  /** 备份包里的媒体在当前素材库下找不到原片的数量 */
  mediaMissing: number;
  /** 含缩略图时，当前缺失的缩略图数量 */
  thumbsMissing: number;
  warnings: string[];
}

/** POST /api/backup/inspect：token 10 分钟内有效，用于随后的 restore */
export interface BackupInspectResult {
  token: string;
  expiresAt: number;
  summary: BackupSummary;
}

/** POST /api/backup/restore：行级事务替换的结果 */
export interface BackupRestoreResult {
  ok: boolean;
  restored: BackupCounts;
  autoBackup: { name: string; bytes: number } | null;
  /** v2：含素材备份的落盘统计（不含素材的备份为 null / 缺省） */
  media?: { packaged: number; written: number; skipped: number; failed: number } | null;
  /** v2：恢复后素材库里不被当前 DB 引用的文件数（只是提示，绝不自动删除） */
  orphans?: number;
  missingMedia: number;
  missingThumbs: number;
  warnings: string[];
}

/** POST /api/backup/export/start：两阶段导出的任务信息（F-SYS-03 v2） */
export interface BackupExportStart {
  jobId: string;
  /** 预计文件条目数（元数据 + 缩略图 + 素材） */
  filesTotal: number;
  /** 预计未压缩总字节（进度分母；zip 实际大小通常更小） */
  bytesTotal: number;
  createdAt: number;
}

export type BackupExportState = 'building' | 'done' | 'error' | 'canceled';

/** GET /api/backup/export/status/:jobId：两阶段导出进度 */
export interface BackupExportJobStatus {
  jobId: string;
  state: BackupExportState;
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** state=done 时的最终 zip 大小 */
  zipBytes: number;
  error: string | null;
  createdAt: number;
  /**
   * 2026-11-11 用户拍板（v1.1.0 修订）：本地模式导出**只保存到「备份目录」**，
   * done 时本字段一定有值（zip 的绝对路径，如 `D:\图片\My旅迹素材备份-2026-11-11-（备份勿删）.zip`）；
   * 导出失败时 state=error（本字段为空）；multi（云端）不提供应用内备份，恒为 null。
   * 类型保留可选 / null 仅用于旧服务端 / 防御性渲染。
   */
  savedPath?: string | null;
  /** 本地模式 done 时保存到备份目录的文件名（savedPath 的 basename）；失败 / 云端为 null */
  savedName?: string | null;
  /** 本地模式导出失败的原因（state=error 时与 error 同源；成功 / 云端为 null） */
  saveError?: string | null;
  /** 本地模式下的备份目录绝对路径（云端版为 null）；「打开备份目录」/ 目录展示的兜底 */
  backupDir?: string | null;
}

/**
 * GET /api/update/check：应用更新检查结果（2026-11-08 D-319，本地模式「设置 → 关于」用）。
 * 只做提示；ok=false 时不影响使用（断网 / GitHub 不可达 / 主动关闭）。
 */
export interface UpdateCheckResult {
  ok: boolean;
  disabled?: boolean;
  currentVersion: string;
  latestVersion?: string;
  hasUpdate?: boolean;
  releaseUrl?: string;
  publishedAt?: string | null;
  checkedAt?: string;
  error?: string;
}

// ── 2026-11-11 D-364 / D-365：备份目录选择 + 后台任务（关掉设置不中断、重开可续看） ──

/** GET /api/backup/dir：当前备份目录（仅本地模式） */
export interface BackupDirInfo {
  dir: string;
  defaultDir: string;
  platform: string;
  localOnly: boolean;
}

/** POST /api/backup/dir、/api/backup/dir/pick：切换结果；canceled=true 表示用户取消选择 */
export interface BackupDirResult {
  ok: boolean;
  dir?: string;
  canceled?: boolean;
}

/** POST /api/backup/restore/start：后台恢复任务信息 */
export interface BackupRestoreStart {
  jobId: string;
  createdAt: number;
}

/** GET /api/backup/restore/status/:jobId：后台恢复任务状态 */
export interface BackupRestoreJobStatus {
  jobId: string;
  state: 'running' | 'done' | 'error';
  error: string | null;
  rolledBack: boolean;
  result: BackupRestoreResult | null;
  createdAt: number;
  finishedAt: number | null;
}

/** POST /api/backup/inspect/start：后台检查任务的创建结果（2026-11-12 D-401） */
export interface BackupInspectStart {
  jobId: string;
  createdAt: number;
}

export type BackupInspectJobState = 'created' | 'uploading' | 'validating' | 'done' | 'error';

/** GET /api/backup/inspect/status/:jobId：备份包检查（上传 + 校验）任务状态 */
export interface BackupInspectJobStatus {
  jobId: string;
  state: BackupInspectJobState;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  bytes: number;
  /** 上传的备份文件名（用于重开设置后显示「已选择」） */
  filename: string;
  summary: BackupSummary | null;
  token: string | null;
  expiresAt: number | null;
}

/** GET /api/background-tasks：当前 + 最近的后台任务（设置重开 / 刷新页面后恢复进度用） */
export interface BackgroundTasks {
  exportJobs: BackupExportJobStatus[];
  restoreJobs: BackupRestoreJobStatus[];
  /** 2026-11-12 D-401：备份包检查（上传 + 校验）后台任务 */
  inspectJobs: BackupInspectJobStatus[];
}

