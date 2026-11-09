/**
 * F-PLC-11 秘密基地（本地 UI 门禁，不加密数据库 / 素材库）
 *
 * - local 模式（ownerId 为空，AUTH_MODE=local）：密码只存在 data/config.json 的 secret 字段
 *   { salt, hash, algo:'scrypt', updatedAt }（与改造前完全一致）；
 * - multi 模式（ownerId 非空）：密码存在 user_setting.secret（JSON 文本，格式同上），
 *   按账号各存各的（M6 P2-2，D-202），通过 auth.mjs 的 getUserSetting / saveUserSetting 读写。
 *   哈希 = scryptSync(password, salt, 64) 的十六进制；绝不把 salt / hash 下发给前端。
 * - 设置页「重置密码」：`{ reset: true, newPassword }` 不需要旧密码（用户拍板：只做本地门禁，
 *   忘了密码也能重设/清除；清除后 verify 恢复为「无门禁」）。
 * - 普通修改 / 清除仍必须校验旧密码。
 * - 验证限速：60 秒窗口内最多 8 次错误，超过返回 429；验证成功清空失败计数。
 *   多用户模式按账号分别计数（local 只有一个 key，行为与以前一致）。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readLocalConfig, saveLocalConfig } from './config.mjs';
import { db } from './db.mjs';
import { getUserSetting, saveUserSetting } from './auth.mjs';

const WINDOW_MS = 60_000;
const MAX_FAILS = 8;
const MAX_PASSWORD_LEN = 128;

/** 最近失败时间戳（毫秒），按 owner 分开（Map<ownerKey, number[]>）；只在进程内存里，重启即清空 */
const failures = new Map();

const ownerKey = (ownerId) => (ownerId ? String(ownerId) : '');

function failLog(ownerId) {
  const key = ownerKey(ownerId);
  let list = failures.get(key);
  if (!list) {
    list = [];
    failures.set(key, list);
  }
  return list;
}

function pruneFailures(list) {
  const cut = Date.now() - WINDOW_MS;
  if (list.length && list[0] <= cut) {
    const kept = list.filter((t) => t > cut);
    list.length = 0;
    list.push(...kept);
  }
}

function clearFailures(ownerId) {
  failures.delete(ownerKey(ownerId));
}

/** 校验 secret 对象形状（config.json / user_setting 共用同一格式） */
function normalizeSecret(s) {
  if (!s || typeof s !== 'object') return null;
  if (typeof s.salt !== 'string' || !s.salt) return null;
  if (typeof s.hash !== 'string' || !s.hash) return null;
  return s;
}

/** 读当前账号的 secret：local 走 data/config.json（旧逻辑），multi 走 user_setting.secret */
function storedSecret(ownerId = null) {
  if (!ownerId) return normalizeSecret(readLocalConfig()?.secret);
  let raw = '';
  try {
    raw = getUserSetting(ownerId)?.secret || '';
  } catch (e) {
    console.warn('[secret] 读取 user_setting 失败：', e.message);
    return null;
  }
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return normalizeSecret(JSON.parse(raw));
  } catch {
    return null;
  }
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function matches(stored, password) {
  if (!stored || typeof password !== 'string') return false;
  try {
    const a = Buffer.from(hashPassword(password, stored.salt), 'hex');
    const b = Buffer.from(stored.hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function writePassword(password, ownerId = null) {
  const salt = randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const secret = { salt, hash, algo: 'scrypt', updatedAt: Date.now() };
  if (ownerId) saveUserSetting(ownerId, { secret: JSON.stringify(secret) });
  else saveLocalConfig({ secret });
  clearFailures(ownerId);
}

function clearPassword(ownerId = null) {
  // saveLocalConfig 是浅合并；secret: null 表示「未设置」，等价于删掉该字段（multi 写 user_setting 为 NULL）
  if (ownerId) saveUserSetting(ownerId, { secret: null });
  else saveLocalConfig({ secret: null });
  clearFailures(ownerId);
}

/**
 * 首次初始化时直接设置秘密基地密码（2026-11-09 D-328，供 server/starter.mjs 种子使用）。
 * 不需要旧密码；正常「修改 / 清除」仍走 setSecretPassword（校验旧密码），
 * 设置页「重置密码」走 setSecretPassword({ reset: true })。密码只存 scrypt 哈希。
 */
export function setInitialSecretPassword(password, ownerId = null) {
  const p = String(password ?? '');
  if (!p || p.length > MAX_PASSWORD_LEN) {
    throw new Error('初始秘密基地密码无效（需 1~128 位）');
  }
  writePassword(p, ownerId);
}

export function isSecretConfigured(ownerId = null) {
  return Boolean(storedSecret(ownerId));
}

/** GET /api/secret/status → { configured, places }（multi 只数自己标记为秘密基地的地点） */
export function secretStatus(ownerId = null) {
  const n = ownerId
    ? db
        .prepare(
          'SELECT COUNT(*) AS n FROM place p WHERE p.deleted_at IS NULL AND p.secret = 1 AND p.user_id = ?'
        )
        .get(ownerId).n
    : db
        .prepare('SELECT COUNT(*) AS n FROM place WHERE deleted_at IS NULL AND secret = 1')
        .get().n;
  return { configured: isSecretConfigured(ownerId), places: Number(n) || 0 };
}

/**
 * POST /api/secret/password
 * body: { oldPassword?, newPassword: string, reset?: boolean }
 * 返回 { status, body }，由路由层决定 HTTP 状态。
 */
export function setSecretPassword(body = {}, ownerId = null) {
  const configured = isSecretConfigured(ownerId);
  const reset = body.reset === true;
  const raw = body.newPassword;
  if (typeof raw !== 'string') {
    return { status: 400, body: { error: '新密码必须是字符串' } };
  }
  const newPassword = raw;

  // 已设置密码：普通修改/清除必须校验旧密码；reset:true（设置页「重置密码」）不需要
  if (configured && !reset) {
    const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
    if (!matches(storedSecret(ownerId), oldPassword)) {
      return { status: 403, body: { error: '旧密码不正确' } };
    }
  }

  // 空串 = 清除（只有已设置时才有意义）
  if (newPassword === '') {
    if (!configured) {
      return { status: 400, body: { error: '请设置新密码（1~128 位）' } };
    }
    clearPassword(ownerId);
    return { status: 200, body: { ok: true, configured: false } };
  }

  if (newPassword.length > MAX_PASSWORD_LEN) {
    return { status: 400, body: { error: '新密码长度不能超过 128 位' } };
  }

  writePassword(newPassword, ownerId);
  return { status: 200, body: { ok: true, configured: true } };
}

/**
 * POST /api/secret/verify
 * body: { password: string }
 * 未设置密码 → { ok:true, configured:false }（无门禁）；
 * 正确 → { ok:true, configured:true }；错误 403；限速超限 429。
 */
export function verifySecret(body = {}, ownerId = null) {
  if (!isSecretConfigured(ownerId)) {
    return { status: 200, body: { ok: true, configured: false } };
  }

  const password = body.password;
  if (typeof password !== 'string') {
    return { status: 400, body: { error: '密码不能为空' } };
  }

  const log = failLog(ownerId);
  pruneFailures(log);
  if (log.length >= MAX_FAILS) {
    return { status: 429, body: { error: '尝试次数过多，请稍后再试' } };
  }

  if (!matches(storedSecret(ownerId), password)) {
    log.push(Date.now());
    return { status: 403, body: { error: '密码不正确' } };
  }

  clearFailures(ownerId);
  return { status: 200, body: { ok: true, configured: true } };
}
