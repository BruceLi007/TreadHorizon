import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { AccountSummary, AuthUser } from '../../lib/types';
import { markerSrc, type MarkerColorPrefs } from '../../lib/markerColors';
import { useLang, useT } from '../../i18n';
import { formatBytes } from '../../lib/bytes';
import './AccountSettings.css';

interface Props {
  /** 当前登录用户（multi 模式才有） */
  user: AuthUser;
  /** 「去过」标记的当前配色（默认头像用它，2026-11-07 D-224） */
  markerColors: MarkerColorPrefs;
  /** 头像 / 显示名更新后通知 App 刷新顶栏（D-224） */
  onProfileChanged?: () => void;
  /** 退出登录后由 App 处理（整页 reload 回登录页） */
  onLoggedOut: () => void;
}

/** 时间戳 → 本地日期（en / zh 跟随界面语言） */
function fmtDate(ts: number | null | undefined, lang: string): string {
  if (ts == null || !Number.isFinite(Number(ts))) return '—';
  try {
    return new Date(Number(ts)).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * 设置 → 账号（2026-11-06 M6 P2-1，D-200）
 *
 * 账号信息（用户名 / 显示名 / 角色 / 加入时间 / 最近登录）、
 * 存储用量（只统计、不限额，D-209）、修改登录密码、退出登录。
 * 2026-11-07 用户要求（D-221）：「邀请码管理」从账号页移到「用户管理」页；
 * 账号页对所有角色只保留自己的账号操作。
 */
export default function AccountSettings({
  user,
  markerColors,
  onProfileChanged,
  onLoggedOut,
}: Props) {
  const t = useT();
  const lang = useLang();
  const isAdmin = user.role === 'admin';

  // ── 显示名（2026-11-07 D-224：顶栏头像旁的名称可改）──
  const [displayName, setDisplayName] = useState(user.displayName);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameInput, setNameInput] = useState(user.displayName);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMsg, setNameMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setDisplayName(user.displayName);
    if (!nameEditing) setNameInput(user.displayName);
  }, [user.displayName, nameEditing]);

  const saveDisplayName = async () => {
    const name = nameInput.trim();
    if (!name) {
      setNameMsg({ ok: false, text: t('显示名称不能为空') });
      return;
    }
    if ([...name].length > 40) {
      setNameMsg({ ok: false, text: t('显示名称最多 40 个字') });
      return;
    }
    setNameBusy(true);
    setNameMsg(null);
    try {
      const r = await api.updateProfile(name);
      setDisplayName(r.user.displayName);
      setNameEditing(false);
      setNameMsg({ ok: true, text: t('已保存') });
      onProfileChanged?.();
    } catch (e: any) {
      setNameMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setNameBusy(false);
    }
  };

  // ── 存储用量（M6 P2-3，D-204；D-209 起只统计、不限额）──
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [summaryErr, setSummaryErr] = useState<string | null>(null);
  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api.accountSummary());
      setSummaryErr(null);
    } catch (e: any) {
      setSummaryErr(e?.message || String(e));
    }
  }, []);
  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  // ── 改密码 ──
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdMsg, setPwdMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [logoutBusy, setLogoutBusy] = useState(false);

  const doChangePwd = async () => {
    if (pwdBusy) return;
    if (!oldPwd) {
      setPwdMsg({ ok: false, text: t('请输入旧密码') });
      return;
    }
    if (newPwd.length < 8) {
      setPwdMsg({ ok: false, text: t('新密码至少 8 位') });
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdMsg({ ok: false, text: t('两次输入的新密码不一致') });
      return;
    }
    setPwdBusy(true);
    setPwdMsg(null);
    try {
      await api.changePassword(oldPwd, newPwd);
      setOldPwd('');
      setNewPwd('');
      setConfirmPwd('');
      setPwdMsg({ ok: true, text: t('密码已修改') });
    } catch (e: any) {
      setPwdMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setPwdBusy(false);
    }
  };

  const doLogout = async () => {
    if (logoutBusy) return;
    setLogoutBusy(true);
    try {
      await api.logout();
    } catch {
      /* 网络失败也回登录页：Cookie 由服务端会话表决定，刷新后自然回到未登录 */
    }
    onLoggedOut();
  };

  // ── 头像（2026-11-07 D-224，用户要求：设置 → 账号里单独的换头像板块）──
  const [avatarVersion, setAvatarVersion] = useState(user.avatarUpdatedAt ?? 0);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMsg, setAvatarMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setAvatarVersion(user.avatarUpdatedAt ?? 0);
  }, [user.avatarUpdatedAt]);

  const pickAvatar = () => {
    if (!avatarBusy) avatarInputRef.current?.click();
  };

  const uploadAvatar = async (file: File) => {
    if (avatarBusy) return;
    if (!file.type.startsWith('image/')) {
      setAvatarMsg({ ok: false, text: t('请选择图片文件') });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setAvatarMsg({ ok: false, text: t('图片太大，请选择 10MB 以内的图片') });
      return;
    }
    setAvatarBusy(true);
    setAvatarMsg(null);
    try {
      const r = await api.uploadAvatar(file);
      setAvatarVersion(r.avatarUpdatedAt);
      setAvatarMsg({ ok: true, text: t('头像已更新') });
      onProfileChanged?.();
    } catch (e: any) {
      setAvatarMsg({
        ok: false,
        text: t('头像上传失败：{msg}', { msg: e?.message || String(e) }),
      });
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <div className="set-pane">
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('账号信息')}</h3>
        </div>
        <p className="set-section-desc">
          {t('多用户模式下每个账号的数据完全独立；账号由管理员通过邀请码创建。')}
        </p>

        {/* 账号信息横排（2026-11-07 P2 验收反馈）：不再一列一行，改为 3 列网格（窄屏自动降为 2 / 1 列） */}
        <div className="acc-info-grid">
          <div className="field-static">
            <span>{t('用户名')}</span>
            <div className="value">{user.username}</div>
          </div>
          <div className="field-static">
            <span>{t('显示名')}</span>
            <div className="value acc-name-value">
              <span className="acc-name-text">{displayName}</span>
              {!nameEditing && (
                <button
                  type="button"
                  className="acc-name-edit-btn"
                  onClick={() => {
                    setNameInput(displayName);
                    setNameMsg(null);
                    setNameEditing(true);
                  }}
                >
                  {t('修改')}
                </button>
              )}
            </div>
            {/* 2026-11-07 D-224（用户要求）：修改显示名直接放在「显示名」旁边（内联编辑） */}
            {nameEditing && (
              <div className="acc-name-edit">
                <input
                  className="acc-name-input"
                  value={nameInput}
                  maxLength={40}
                  autoFocus
                  disabled={nameBusy}
                  aria-label={t('显示名')}
                  onChange={(e) => {
                    setNameInput(e.target.value);
                    setNameMsg(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveDisplayName();
                    if (e.key === 'Escape') {
                      setNameEditing(false);
                      setNameInput(displayName);
                      setNameMsg(null);
                    }
                  }}
                />
                <div className="acc-name-edit-actions">
                  <button
                    className="primary acc-name-save"
                    onClick={() => void saveDisplayName()}
                    disabled={nameBusy}
                  >
                    {nameBusy ? t('保存中…') : t('保存')}
                  </button>
                  <button
                    className="text-btn"
                    onClick={() => {
                      setNameEditing(false);
                      setNameInput(displayName);
                      setNameMsg(null);
                    }}
                    disabled={nameBusy}
                  >
                    {t('取消')}
                  </button>
                </div>
              </div>
            )}
            {nameMsg && (
              <p className={nameMsg.ok ? 'hint acc-ok' : 'hint err'}>{nameMsg.text}</p>
            )}
          </div>
          <div className="field-static">
            <span>{t('角色')}</span>
            <div className="value">
              {isAdmin ? t('管理员') : t('普通用户')}
              <span className="acc-role-tag">{user.role}</span>
            </div>
          </div>
          <div className="field-static">
            <span>{t('加入时间')}</span>
            <div className="value">{fmtDate(user.createdAt, lang)}</div>
          </div>
          <div className="field-static">
            <span>{t('最近登录')}</span>
            <div className="value">{fmtDate(user.lastLoginAt, lang)}</div>
          </div>
        </div>
      </section>

      {/* 头像（2026-11-07 D-224，用户要求：设置 → 账号里单独的换头像板块） */}
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('头像')}</h3>
        </div>
        <p className="set-section-desc">
          {t('头像会显示在顶栏「+ 添加足迹」上方；点击下方头像或按钮上传 / 更换，上传后顶栏立即更新。')}
        </p>
        <div className="acc-avatar-row">
          <button
            type="button"
            className={avatarVersion ? 'acc-avatar-preview' : 'acc-avatar-preview is-default'}
            onClick={pickAvatar}
            disabled={avatarBusy}
            title={t('更换头像')}
            aria-label={t('更换头像')}
          >
            {avatarVersion ? (
              <img src={api.avatarUrl(avatarVersion)} alt={t('用户头像')} />
            ) : (
              <img src={markerSrc('visited', markerColors)} alt="" aria-hidden="true" />
            )}
          </button>
          <div className="acc-avatar-actions">
            <button className="primary" onClick={pickAvatar} disabled={avatarBusy}>
              {avatarBusy ? t('上传中…') : t('上传 / 更换头像')}
            </button>
            <p className="acc-avatar-hint">
              {t('支持 JPG / PNG / WebP / GIF / AVIF，≤10MB；会自动裁成 128×128 的方形头像。没上传时用「去过」标记做默认头像（透明底）。')}
            </p>
          </div>
          <input
            ref={avatarInputRef}
            className="acc-avatar-input"
            type="file"
            accept="image/*"
            disabled={avatarBusy}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (f) void uploadAvatar(f);
            }}
          />
        </div>
        {avatarMsg && (
          <p className={avatarMsg.ok ? 'hint acc-ok' : 'hint err'} style={{ marginTop: 10 }}>
            {avatarMsg.text}
          </p>
        )}
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('存储用量')}</h3>
        </div>
        <p className="set-section-desc">
          {t('已用空间只做统计、不限制上传（素材库里的照片 / 视频在磁盘上，每份素材都会占用容量，回收站里还没彻底删除的也算）。服务器空间有限，上云后才会按账号设上限。')}
        </p>
        {summaryErr ? (
          <p className="hint err">{summaryErr}</p>
        ) : !summary ? (
          <p className="hint">{t('读取中…')}</p>
        ) : (
          <>
            <div className="acc-usage-total">
              <b>{formatBytes(summary.usage.mediaBytes)}</b>
              <span>{t('已用空间')}</span>
            </div>
            <p className="hint">
              {t('{places} 个地点 · {visits} 次到访 · {photos} 张照片 · {videos} 段视频', {
                places: summary.usage.places,
                visits: summary.usage.visits,
                photos: summary.usage.photos,
                videos: summary.usage.videos,
              })}
            </p>
          </>
        )}
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('修改登录密码')}</h3>
        </div>
        <p className="set-section-desc">
          {t('修改后请用新密码登录；登录密码只以 scrypt 加盐哈希保存在服务端，任何人都看不到原文。')}
        </p>

        <label className="field">
          <span>{t('旧密码')}</span>
          <input
            type="password"
            value={oldPwd}
            autoComplete="current-password"
            spellCheck={false}
            maxLength={128}
            disabled={pwdBusy}
            onChange={(e) => {
              setOldPwd(e.target.value);
              setPwdMsg(null);
            }}
          />
        </label>
        <label className="field">
          <span>{t('新密码（至少 8 位）')}</span>
          <input
            type="password"
            value={newPwd}
            autoComplete="new-password"
            spellCheck={false}
            maxLength={128}
            disabled={pwdBusy}
            onChange={(e) => {
              setNewPwd(e.target.value);
              setPwdMsg(null);
            }}
          />
        </label>
        <label className="field">
          <span>{t('确认新密码')}</span>
          <input
            type="password"
            value={confirmPwd}
            autoComplete="new-password"
            spellCheck={false}
            maxLength={128}
            disabled={pwdBusy}
            onChange={(e) => {
              setConfirmPwd(e.target.value);
              setPwdMsg(null);
            }}
          />
        </label>
        <button className="primary full" onClick={doChangePwd} disabled={pwdBusy}>
          {pwdBusy ? t('修改中…') : t('修改密码')}
        </button>
        {pwdMsg && (
          <p className={pwdMsg.ok ? 'hint acc-ok' : 'hint err'} style={{ marginTop: 10 }}>
            {pwdMsg.text}
          </p>
        )}
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('退出登录')}</h3>
        </div>
        <p className="set-section-desc">
          {t('退出后需要重新输入用户名和密码；不会删除任何数据。')}
        </p>
        <button className="danger-btn" onClick={doLogout} disabled={logoutBusy}>
          {logoutBusy ? t('退出中…') : t('退出登录')}
        </button>
      </section>
    </div>
  );
}
