/**
 * 账号 / 会话 / 邀请码（2026-11-06 M6 P2-1，D-200）
 *
 * 只在 `AUTH_MODE=multi`（云端多用户）时启用；`AUTH_MODE=local`（默认）下
 * 这些函数不会被路由调用，表是空的、旧行为完全不变。
 *
 * 安全要点：
 * - 密码用 scrypt + 随机盐，绝不明文 / 不可逆；比较用 timingSafeEqual。
 * - 会话 token 只把 sha256 哈希落库，Cookie 里是原始随机串（HttpOnly + SameSite=Lax）。
 * - 邀请码明文只在生成时返回一次，库里只存 sha256；一次性、可过期。
 * - 登录失败按「IP + 用户名」计数，超限锁定一段时间（内存即可，重启清零）。
 * - 不写日志、不下载密钥类信息。
 */
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { CONFIG } from './config.mjs';
import { db, now } from './db.mjs';

export const AUTH_COOKIE = 'th_session';

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const DISPLAY_NAME_MAX = 40;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const INVITE_DAYS_MIN = 1;
const INVITE_DAYS_MAX = 90;
const INVITE_DEFAULT_DAYS = 7;
/** 邀请码字符表：去掉容易看错的 I / O / 0 / 1 */
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_GROUP = 4;
const INVITE_GROUPS = 4;

/** 业务错误：带 HTTP 状态码，路由层直接 reply.code(e.status) */
export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

const isMulti = () => CONFIG.authMode === 'multi';

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const randomHex = (bytes) => randomBytes(bytes).toString('hex');

// ── 密码 ───────────────────────────────────────────────────

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, 'hex');
  return scryptSync(password.normalize('NFKC'), salt, 64).toString('hex');
}

/** 校验密码（错误 / 用户不存在都返回 false；不区分原因，避免泄露） */
export function verifyPassword(userRow, password) {
  if (!userRow?.password_hash || !userRow?.salt) return false;
  try {
    const a = Buffer.from(hashPassword(String(password ?? ''), userRow.salt), 'hex');
    const b = Buffer.from(String(userRow.password_hash), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── 用户 ───────────────────────────────────────────────────

const normalizeUsername = (v) => String(v ?? '').trim();

function assertUsername(username) {
  if (!USERNAME_RE.test(username)) {
    throw new AuthError('用户名需为 3~24 位字母、数字、下划线、点或横线');
  }
}

function assertPassword(password) {
  const pwd = String(password ?? '');
  if (pwd.length < PASSWORD_MIN || pwd.length > PASSWORD_MAX) {
    throw new AuthError(`密码长度需为 ${PASSWORD_MIN}~${PASSWORD_MAX} 位`);
  }
}

/** 出口用（下发给前端）：绝不带 password_hash / salt */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status === 'disabled' ? 'disabled' : 'active',
    quotaBytes: Number(row.quota_bytes) > 0 ? Number(row.quota_bytes) : CONFIG.defaultQuotaBytes,
    createdAt: Number(row.created_at) || 0,
    lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at),
    /** 头像更新时间（2026-11-07 D-224；0 = 没上传过头像，前端显示首字母占位） */
    avatarUpdatedAt: Number(row.avatar_updated_at) || 0,
  };
}

export function findUserByUsername(username) {
  return db.prepare('SELECT * FROM user WHERE username = ?').get(normalizeUsername(username)) ?? null;
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM user WHERE id = ?').get(id) ?? null;
}

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM user').get().n;
}

/**
 * 创建用户（管理员初始化 / 邀请码注册用）。
 * 用户名唯一、密码强度校验都在这里；重复用户名抛 409。
 */
export function createUser({
  username,
  password,
  displayName,
  role = 'user',
  quotaBytes = 0,
} = {}) {
  const name = normalizeUsername(username);
  assertUsername(name);
  assertPassword(password);
  if (findUserByUsername(name)) throw new AuthError('用户名已被占用', 409);
  const salt = randomHex(16);
  const row = {
    id: randomUUID(),
    username: name,
    display_name: String(displayName ?? '').trim().slice(0, DISPLAY_NAME_MAX) || name,
    password_hash: hashPassword(String(password), salt),
    salt,
    role: role === 'admin' ? 'admin' : 'user',
    quota_bytes: Math.max(0, Number(quotaBytes) || 0),
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO user (id, username, display_name, password_hash, salt, role, status, quota_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).run(
    row.id,
    row.username,
    row.display_name,
    row.password_hash,
    row.salt,
    row.role,
    row.quota_bytes,
    row.created_at
  );
  return getUserById(row.id);
}

/** 改密码：需要旧密码；成功后返回 true（不清除当前会话） */
export function changePassword(userId, oldPassword, newPassword) {
  const row = getUserById(userId);
  if (!row) throw new AuthError('账号不存在', 404);
  if (!verifyPassword(row, oldPassword)) throw new AuthError('旧密码不正确');
  assertPassword(newPassword);
  setPasswordHash(userId, newPassword);
  return true;
}

/** 直接写新密码（管理员重置 / 初始化脚本用，不需要旧密码；P2-3 管理后台复用） */
export function resetPassword(userId, newPassword) {
  if (!getUserById(userId)) throw new AuthError('账号不存在', 404);
  assertPassword(newPassword);
  setPasswordHash(userId, newPassword);
  return true;
}

function setPasswordHash(userId, newPassword) {
  const salt = randomHex(16);
  db.prepare('UPDATE user SET password_hash = ?, salt = ? WHERE id = ?').run(
    hashPassword(String(newPassword), salt),
    salt,
    userId
  );
}

/**
 * 首个管理员初始化（幂等）：
 * 只有在 multi 模式、库中没有用户、且提供了 ADMIN_USERNAME + ADMIN_PASSWORD 时才创建。
 */
export function bootstrapAdmin() {
  if (!isMulti()) return null;
  if (countUsers() > 0) return null;
  if (!CONFIG.adminUsername || !CONFIG.adminPassword) {
    console.warn(
      '[auth] ⚠️  多用户模式还没有管理员账号：设置 ADMIN_USERNAME / ADMIN_PASSWORD 后重启，' +
        '或运行 `npm run init:admin -- <用户名> <密码>` 创建。'
    );
    return null;
  }
  const user = createUser({
    username: CONFIG.adminUsername,
    password: CONFIG.adminPassword,
    displayName: CONFIG.adminUsername,
    role: 'admin',
  });
  console.log(`[auth] 已创建首个管理员账号：${user.username}（密码不打印）`);
  return user;
}

// ── 会话 ───────────────────────────────────────────────────

const sessionTtlMs = () => Math.max(1, CONFIG.sessionDays) * 24 * 60 * 60 * 1000;

export function createSession(userId, { ip = '', ua = '' } = {}) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now() + sessionTtlMs();
  db.prepare(
    `INSERT INTO session (token_hash, user_id, expires_at, ip, ua, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(sha256(token), userId, expiresAt, String(ip || '').slice(0, 64), String(ua || '').slice(0, 300), now(), now());
  return { token, expiresAt };
}

export function destroySession(token) {
  if (!token) return false;
  return db.prepare('DELETE FROM session WHERE token_hash = ?').run(sha256(token)).changes > 0;
}

/** 清理过期会话（启动时跑一次即可） */
export function pruneSessions() {
  try {
    return db.prepare('DELETE FROM session WHERE expires_at <= ?').run(now()).changes;
  } catch {
    return 0;
  }
}

export function readCookie(req, name = AUTH_COOKIE) {
  const raw = String(req?.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/** session Cookie 序列化（HttpOnly + SameSite=Lax；HTTPS 部署置 COOKIE_SECURE=1 加 Secure） */
export function sessionCookie(token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt - now()) / 1000));
  const parts = [
    `${AUTH_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (CONFIG.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  const parts = [`${AUTH_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (CONFIG.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

/** 从请求 Cookie 解析当前登录用户；无效 / 过期 / 被禁用返回 null（会顺手删过期会话） */
export function userFromRequest(req) {
  if (!isMulti()) return null;
  const token = readCookie(req);
  if (!token) return null;
  const hash = sha256(token);
  const session = db.prepare('SELECT * FROM session WHERE token_hash = ?').get(hash);
  if (!session) return null;
  if (Number(session.expires_at) <= now()) {
    db.prepare('DELETE FROM session WHERE token_hash = ?').run(hash);
    return null;
  }
  const user = getUserById(session.user_id);
  if (!user || user.status === 'disabled') {
    db.prepare('DELETE FROM session WHERE token_hash = ?').run(hash);
    return null;
  }
  // 滚动续期：剩余不足「有效期 - 1 天」时延长；顺手更新 last_seen_at
  const ttl = sessionTtlMs();
  if (Number(session.expires_at) - now() < ttl - 24 * 60 * 60 * 1000) {
    db.prepare('UPDATE session SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?').run(
      now() + ttl,
      now(),
      hash
    );
  } else {
    db.prepare('UPDATE session SET last_seen_at = ? WHERE token_hash = ?').run(now(), hash);
  }
  return publicUser(user);
}

// ── 登录限速（内存即可：单进程、几百个账号） ────────────────

const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const failures = new Map(); // key -> { count, first, lockUntil }

export function loginKey(req, username) {
  const ip = String(req?.ip || req?.headers?.['x-forwarded-for'] || 'unknown');
  return `${ip}|${normalizeUsername(username).toLowerCase()}`;
}

/** 返回还需锁定的毫秒数（0 = 未锁定） */
export function loginLockRemaining(key) {
  const rec = failures.get(key);
  if (!rec) return 0;
  const left = rec.lockUntil - now();
  if (left > 0) return left;
  if (now() - rec.first > LOGIN_WINDOW_MS) failures.delete(key);
  return 0;
}

export function recordLoginFailure(key) {
  const rec = failures.get(key);
  if (!rec || now() - rec.first > LOGIN_WINDOW_MS) {
    failures.set(key, { count: 1, first: now(), lockUntil: 0 });
    return;
  }
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILS) rec.lockUntil = now() + LOGIN_LOCK_MS;
}

export function clearLoginFailures(key) {
  failures.delete(key);
}

// ── 邀请码 ─────────────────────────────────────────────────

const normalizeInviteCode = (code) => String(code ?? '').replace(/[\s-]/g, '').toUpperCase();

function randomInviteCode() {
  const pick = () => INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  const groups = [];
  for (let g = 0; g < INVITE_GROUPS; g++) {
    let s = '';
    for (let i = 0; i < INVITE_GROUP; i++) s += pick();
    groups.push(s);
  }
  return groups.join('-');
}

const inviteRow = (id) => db.prepare('SELECT * FROM invite WHERE id = ?').get(id) ?? null;

function inviteOut(row) {
  if (!row) return null;
  const creator = getUserById(row.created_by);
  const usedBy = row.used_by ? getUserById(row.used_by) : null;
  return {
    id: row.id,
    note: row.note || '',
    createdAt: Number(row.created_at) || 0,
    expiresAt: Number(row.expires_at) || 0,
    usedAt: row.used_at == null ? null : Number(row.used_at),
    createdBy: creator ? creator.username : '',
    usedBy: usedBy ? usedBy.username : '',
    expired: Number(row.expires_at) <= now(),
    used: row.used_by != null,
  };
}

/** 管理员生成一次性邀请码；明文 code 只在这里返回一次 */
export function createInvite(createdBy, { days = INVITE_DEFAULT_DAYS, note = '' } = {}) {
  const n = Number(days);
  const d = Number.isFinite(n) ? Math.min(INVITE_DAYS_MAX, Math.max(INVITE_DAYS_MIN, Math.round(n))) : INVITE_DEFAULT_DAYS;
  let code = randomInviteCode();
  // 理论上撞不到；保险起见重试几次
  for (let i = 0; i < 5 && db.prepare('SELECT 1 FROM invite WHERE code_hash = ?').get(sha256(normalizeInviteCode(code))); i++) {
    code = randomInviteCode();
  }
  const row = {
    id: randomUUID(),
    code_hash: sha256(normalizeInviteCode(code)),
    created_by: createdBy,
    note: String(note ?? '').trim().slice(0, 80),
    expires_at: now() + d * 24 * 60 * 60 * 1000,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO invite (id, code_hash, created_by, note, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.code_hash, row.created_by, row.note, row.expires_at, row.created_at);
  return { invite: inviteOut(inviteRow(row.id)), code };
}

/** 邀请码列表（不含哈希 / 明文） */
export function listInvites() {
  return db
    .prepare('SELECT * FROM invite ORDER BY created_at DESC')
    .all()
    .map(inviteOut);
}

/** 作废（删除）一个未使用的邀请码；已使用的不允许删（留作记录） */
export function revokeInvite(id) {
  const row = inviteRow(id);
  if (!row) throw new AuthError('邀请码不存在', 404);
  if (row.used_by) throw new AuthError('该邀请码已被使用，不能作废', 409);
  db.prepare('DELETE FROM invite WHERE id = ?').run(id);
  return true;
}

/** 校验邀请码可用（不消费）；返回 db 行 */
export function findUsableInvite(code) {
  const norm = normalizeInviteCode(code);
  if (!norm) throw new AuthError('请输入邀请码');
  const row = db.prepare('SELECT * FROM invite WHERE code_hash = ?').get(sha256(norm));
  if (!row) throw new AuthError('邀请码无效');
  if (row.used_by) throw new AuthError('邀请码已被使用', 409);
  if (Number(row.expires_at) <= now()) throw new AuthError('邀请码已过期', 410);
  return row;
}

/** 消费邀请码（注册成功后调用）：原子占用，防并发重复注册 */
export function consumeInvite(id, userId) {
  const r = db
    .prepare('UPDATE invite SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL')
    .run(userId, now(), id);
  if (r.changes !== 1) throw new AuthError('邀请码已被使用', 409);
  return true;
}

// ── 每用户设置（M6 P2-2，D-202）────────────────────────────────
// 秘密基地密码 / 自己的天地图 Key / 备份提醒按账号存；local 模式不写这张表。

const USER_SETTING_COLUMNS = [
  'secret',
  'tdt_tk',
  'media_root',
  'last_backup_at',
  'backup_threshold_days',
  'backup_snooze_until',
];

/** 读取某用户的设置行；没有返回 null */
export function getUserSetting(userId) {
  if (!userId) return null;
  return db.prepare('SELECT * FROM user_setting WHERE user_id = ?').get(userId) ?? null;
}

/**
 * 写入 / 更新某用户的设置（只接受白名单字段，undefined 跳过、null 写入 NULL）。
 * @returns 更新后的设置行
 */
export function saveUserSetting(userId, patch = {}) {
  if (!userId) throw new AuthError('缺少用户', 400);
  const current = getUserSetting(userId);
  const values = {};
  for (const key of USER_SETTING_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) values[key] = patch[key];
  }
  if (Object.keys(values).length === 0) return current;
  if (!current) {
    const cols = ['user_id', ...Object.keys(values), 'updated_at'];
    const placeholders = cols.map(() => '?').join(', ');
    db.prepare(`INSERT INTO user_setting (${cols.join(', ')}) VALUES (${placeholders})`).run(
      userId,
      ...Object.values(values),
      now()
    );
  } else {
    const sets = Object.keys(values).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE user_setting SET ${sets}, updated_at = ? WHERE user_id = ?`).run(
      ...Object.values(values),
      now(),
      userId
    );
  }
  return getUserSetting(userId);
}

// ── 用量 / 配额 / 管理后台（M6 P2-3）──────────────────────────
// 只在 multi 模式由路由调用；local 模式（数据行 user_id 全为 NULL）不调用这些函数。

/** 管理员可设的配额上限 / 用户可申请的上限：1 TiB（防手滑写出天文数字） */
export const QUOTA_MAX_BYTES = 1024 ** 4;

/** 空用量兜底（无账号 / local 模式不会被调用，防御性返回零） */
function emptyUsage() {
  return { mediaBytes: 0, mediaCount: 0, places: 0, visits: 0, photos: 0, videos: 0 };
}

/**
 * 某账号的用量（P2-3）：
 * - mediaBytes / mediaCount：**全部** media 行（含回收站里还没彻底删的）——反映磁盘真实占用；
 * - places / visits / photos / videos：alive 口径（deleted_at IS NULL，照片 / 视频还要求父级到访 / 地点未删）。
 */
export function userUsage(userId) {
  if (!userId) return emptyUsage();
  const count = (sql, ...params) => Number(db.prepare(sql).get(...params)?.n) || 0;
  const media = db
    .prepare(
      'SELECT COALESCE(SUM(COALESCE(bytes, 0)), 0) AS bytes, COUNT(*) AS n FROM media WHERE user_id = ?'
    )
    .get(userId);
  return {
    mediaBytes: Number(media?.bytes) || 0,
    mediaCount: Number(media?.n) || 0,
    places: count('SELECT COUNT(*) AS n FROM place WHERE user_id = ? AND deleted_at IS NULL', userId),
    visits: count('SELECT COUNT(*) AS n FROM visit WHERE user_id = ? AND deleted_at IS NULL', userId),
    photos: count(
      `SELECT COUNT(*) AS n FROM media m
         JOIN visit v ON v.id = m.visit_id AND v.deleted_at IS NULL
         JOIN place p ON p.id = v.place_id AND p.deleted_at IS NULL
        WHERE m.user_id = ? AND m.kind = 'photo' AND m.deleted_at IS NULL`,
      userId
    ),
    videos: count(
      `SELECT COUNT(*) AS n FROM media m
         JOIN visit v ON v.id = m.visit_id AND v.deleted_at IS NULL
         JOIN place p ON p.id = v.place_id AND p.deleted_at IS NULL
        WHERE m.user_id = ? AND m.kind = 'video' AND m.deleted_at IS NULL`,
      userId
    ),
  };
}

/**
 * 账号的生效配额：quota_bytes > 0 用自己的，否则用服务端默认（2026-11-08 D-310 起 = 1 GiB）。
 * 兼容蛇形 db 行（quota_bytes）与驼峰 publicUser（quotaBytes，已解析成生效值）。
 */
export function quotaBytesOf(userRow) {
  const raw = Number(userRow?.quota_bytes ?? userRow?.quotaBytes);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : CONFIG.defaultQuotaBytes;
}

/** 管理员：全部账号 + 用量（回收站里还没彻底删的媒体也计入磁盘占用；created_at 升序，首个管理员在最前） */
export function listUsersWithUsage() {
  return db
    .prepare('SELECT * FROM user ORDER BY created_at ASC, username ASC')
    .all()
    .map((row) => {
      const usage = userUsage(row.id);
      return { ...publicUser(row), usedBytes: usage.mediaBytes, usage };
    });
}

/**
 * 管理员改账号（P2-3）：displayName / status / quotaBytes。
 * 安全约束：不能禁用自己；不能禁用最后一个 active 管理员（本函数不提供角色降级）。
 * @returns 更新后的 db 行（调用方用 publicUser 出网）
 */
export function updateUserByAdmin(actorId, targetId, patch = {}) {
  const target = getUserById(targetId);
  if (!target) throw new AuthError('账号不存在', 404);
  const body = patch && typeof patch === 'object' ? patch : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const values = {};

  if (has('displayName')) {
    const name = String(body.displayName ?? '').trim();
    if (!name) throw new AuthError('显示名称不能为空');
    if ([...name].length > DISPLAY_NAME_MAX) {
      throw new AuthError(`显示名称最多 ${DISPLAY_NAME_MAX} 个字`);
    }
    values.display_name = name;
  }

  if (has('status')) {
    const status = String(body.status ?? '').trim().toLowerCase();
    if (status !== 'active' && status !== 'disabled') {
      throw new AuthError('状态只能是 active 或 disabled');
    }
    if (status === 'disabled') {
      if (target.id === actorId) throw new AuthError('不能禁用自己的账号');
      if (target.status === 'active' && target.role === 'admin') {
        const activeAdmins =
          Number(
            db.prepare("SELECT COUNT(*) AS n FROM user WHERE role = 'admin' AND status = 'active'").get().n
          ) || 0;
        if (activeAdmins <= 1) throw new AuthError('不能禁用最后一个启用的管理员', 409);
      }
    }
    values.status = status;
  }

  if (has('quotaBytes')) {
    const n = Number(body.quotaBytes);
    if (!Number.isInteger(n) || n < 0) throw new AuthError('配额必须是不小于 0 的整数（字节）');
    if (n > QUOTA_MAX_BYTES) throw new AuthError('配额不能超过 1 TiB');
    values.quota_bytes = n;
  }

  if (Object.keys(values).length === 0) return target;

  const sets = Object.keys(values).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE user SET ${sets} WHERE id = ?`).run(...Object.values(values), target.id);
  // 被禁用后立刻踢掉该账号的所有会话（userFromRequest 也会拦截，这里做即时失效）
  if (values.status === 'disabled') {
    db.prepare('DELETE FROM session WHERE user_id = ?').run(target.id);
  }
  return getUserById(target.id);
}

/**
 * 账号自己改显示名（2026-11-07 D-224 追加：顶栏头像旁的名称可改）。
 * 长度 / 空值规则与管理员改显示名一致；返回更新后的 user 行。
 */
export function updateOwnDisplayName(userId, displayName) {
  const target = getUserById(userId);
  if (!target) throw new AuthError('账号不存在', 404);
  const name = String(displayName ?? '').trim();
  if (!name) throw new AuthError('显示名称不能为空');
  if ([...name].length > DISPLAY_NAME_MAX) {
    throw new AuthError(`显示名称最多 ${DISPLAY_NAME_MAX} 个字`);
  }
  db.prepare('UPDATE user SET display_name = ? WHERE id = ?').run(name, target.id);
  return getUserById(target.id);
}

// ── CSRF / 来源校验 ────────────────────────────────────────

/**
 * 状态变更请求的简单 CSRF 防护：带 Origin 时必须与实际 Host 同源。
 * 没带 Origin 的（curl / 本地脚本 / 服务端测试）放行——浏览器跨站表单一定会带 Origin。
 */
export function sameOrigin(req) {
  const origin = req?.headers?.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const host = String(req?.headers?.host || '');
    return !host || u.host === host;
  } catch {
    return false;
  }
}

export { isMulti };
