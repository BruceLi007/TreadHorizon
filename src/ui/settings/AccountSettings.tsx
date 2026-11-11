import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { AccountSummary, AuthUser, QuotaOverview } from '../../lib/types';
import { markerSrc, type MarkerColorPrefs } from '../../lib/markerColors';
import { useLang, useT } from '../../i18n';
import { formatBytes, formatQuota } from '../../lib/bytes';
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

  // ── 下载我的数据（2026-11-11 D-369 用户要求：云端普通用户取消备份 / 恢复，只保留「从云端下载到本地」）──
  const [dlThumbs, setDlThumbs] = useState(true);
  const [dlMedia, setDlMedia] = useState(false);

  // ── 存储配额 + 扩容申请（2026-11-08 D-310：云端默认 1 GB，可申请扩容）──
  const [quota, setQuota] = useState<QuotaOverview | null>(null);
  const [quotaErr, setQuotaErr] = useState<string | null>(null);
  const [reqOpen, setReqOpen] = useState(false);
  const [reqGb, setReqGb] = useState('2');
  const [reqReason, setReqReason] = useState('');
  const [reqBusy, setReqBusy] = useState(false);
  const [reqMsg, setReqMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadQuota = useCallback(async () => {
    try {
      setQuota(await api.quotaOverview());
      setQuotaErr(null);
    } catch (e: any) {
      setQuota(null);
      setQuotaErr(e?.message || String(e));
    }
  }, []);
  useEffect(() => {
    void loadQuota();
  }, [loadQuota]);

  const refreshQuota = async () => {
    await Promise.all([loadQuota(), loadSummary()]);
  };

  const statusLabel = (s: string) =>
    s === 'pending'
      ? t('待审批')
      : s === 'approved'
        ? t('已批准')
        : s === 'rejected'
          ? t('已拒绝')
          : t('已取消');

  const openRequestForm = () => {
    const curGb = (quota?.quotaBytes ?? 0) / 1024 ** 3;
    setReqGb(String(Math.max(1, Math.ceil(curGb) + 1 || 2)));
    setReqReason('');
    setReqMsg(null);
    setReqOpen(true);
  };

  const submitRequest = async () => {
    if (reqBusy) return;
    const gb = Number(reqGb);
    if (!Number.isFinite(gb) || gb <= 0) {
      setReqMsg({ ok: false, text: t('请输入大于 0 的数字') });
      return;
    }
    const bytes = Math.round(gb * 1024 ** 3);
    const current = quota?.quotaBytes ?? 0;
    if (bytes <= current) {
      setReqMsg({
        ok: false,
        text: t('申请的空间必须大于当前配额（{size}）', { size: formatQuota(current) }),
      });
      return;
    }
    setReqBusy(true);
    setReqMsg(null);
    try {
      await api.submitQuotaRequest(bytes, reqReason.trim());
      setReqOpen(false);
      setReqMsg({ ok: true, text: t('已提交扩容申请，等待管理员审批') });
      await refreshQuota();
    } catch (e: any) {
      setReqMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setReqBusy(false);
    }
  };

  const cancelRequest = async (id: string) => {
    setReqBusy(true);
    setReqMsg(null);
    try {
      await api.cancelQuotaRequest(id);
      setReqMsg({ ok: true, text: t('扩容申请已取消') });
      await refreshQuota();
    } catch (e: any) {
      setReqMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setReqBusy(false);
    }
  };

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

  // 存储用量 / 配额百分比（D-310）
  const usedBytes = quota?.usedBytes ?? summary?.usage.mediaBytes ?? 0;
  const quotaBytes = quota?.quotaBytes ?? summary?.quotaBytes ?? 0;
  const percent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 0;
  const overQuota = quotaBytes > 0 && usedBytes >= quotaBytes;

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
            accept="image/*,.heic,.heif"
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
          <span className="acc-badge">{t('云端配额')}</span>
        </div>
        <p className="set-section-desc">
          {t('云端版每个账号有独立存储配额（默认 1 GB）；回收站里还没彻底删除的素材也占用配额。空间用满后新的上传会被拒绝，可以删除不需要的素材或申请扩容。')}
        </p>
        {summaryErr ? (
          <p className="hint err">{summaryErr}</p>
        ) : !summary || !quota ? (
          <p className="hint">{t('读取中…')}</p>
        ) : (
          <>
            <div className="acc-quota-head">
              <b>
                {t('已用 {used} / 上限 {quota}', {
                  used: formatBytes(usedBytes),
                  quota: formatQuota(quotaBytes),
                })}
              </b>
              <span className={overQuota ? 'acc-quota-percent is-over' : 'acc-quota-percent'}>
                {percent}%
              </span>
            </div>
            <div
              className="acc-quota-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <i
                className={overQuota ? 'is-over' : percent >= 85 ? 'is-warn' : ''}
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="hint">
              {t('{places} 个地点 · {visits} 次到访 · {photos} 张照片 · {videos} 段视频', {
                places: summary.usage.places,
                visits: summary.usage.visits,
                photos: summary.usage.photos,
                videos: summary.usage.videos,
              })}
            </p>
            {overQuota && (
              <p className="hint err">
                {t(
                  '空间已满：新的上传会被拒绝。请删除不需要的素材（回收站里的要彻底删除），或在下面申请扩容。'
                )}
              </p>
            )}

            {/* 扩容申请（2026-11-08 D-310） */}
            {quota.pending ? (
              <div className="acc-quota-pending">
                <p className="acc-quota-pending-title">{t('扩容申请：待管理员审批')}</p>
                <p className="hint">
                  {t('申请将配额提高到 {size}', {
                    size: formatQuota(quota.pending.requestedBytes),
                  })}
                  {quota.pending.reason ? ` · ${quota.pending.reason}` : ''}
                </p>
                <button
                  className="text-btn"
                  onClick={() => void cancelRequest(quota.pending!.id)}
                  disabled={reqBusy}
                >
                  {t('取消申请')}
                </button>
              </div>
            ) : !reqOpen ? (
              <button className="primary" onClick={openRequestForm} disabled={reqBusy}>
                {t('申请扩容')}
              </button>
            ) : (
              <div className="acc-quota-form">
                <label className="field">
                  <span>{t('希望的新配额（GB）')}</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={reqGb}
                    disabled={reqBusy}
                    onChange={(e) => {
                      setReqGb(e.target.value);
                      setReqMsg(null);
                    }}
                  />
                </label>
                <label className="field">
                  <span>{t('理由（可选）')}</span>
                  <input
                    value={reqReason}
                    maxLength={200}
                    disabled={reqBusy}
                    placeholder={t('例如：旅行照片和视频比较多')}
                    onChange={(e) => {
                      setReqReason(e.target.value);
                      setReqMsg(null);
                    }}
                  />
                </label>
                <div className="acc-quota-form-actions">
                  <button className="primary" onClick={() => void submitRequest()} disabled={reqBusy}>
                    {reqBusy ? t('提交中…') : t('提交申请')}
                  </button>
                  <button
                    className="text-btn"
                    onClick={() => {
                      setReqOpen(false);
                      setReqMsg(null);
                    }}
                    disabled={reqBusy}
                  >
                    {t('取消')}
                  </button>
                </div>
              </div>
            )}
            {reqMsg && <p className={reqMsg.ok ? 'hint acc-ok' : 'hint err'}>{reqMsg.text}</p>}

            {quota.history.some((h) => h.status !== 'pending') && (
              <div className="acc-quota-history">
                <p className="acc-quota-history-title">{t('申请记录')}</p>
                {quota.history
                  .filter((h) => h.status !== 'pending')
                  .slice(0, 5)
                  .map((h) => (
                    <div className="acc-quota-history-row" key={h.id}>
                      <span>
                        {t('申请将配额提高到 {size}', { size: formatQuota(h.requestedBytes) })}
                      </span>
                      <span className={`acc-quota-status is-${h.status}`}>
                        {statusLabel(h.status)}
                      </span>
                      {h.adminNote && <span className="hint">{h.adminNote}</span>}
                      <span className="hint">{fmtDate(h.createdAt, lang)}</span>
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* 下载我的数据（2026-11-11 D-369 用户要求：云端普通用户不再有备份 / 恢复，
          只保留「从云端下载到本地」；管理员有完整备份页，这里不重复显示） */}
      {!isAdmin && (
        <section className="set-section">
          <div className="set-section-head">
            <h3 className="set-section-title">{t('下载我的数据')}</h3>
            <span className="acc-badge">{t('云端 → 本地')}</span>
          </div>
          <p className="set-section-desc">
            {t('你的旅迹数据保存在云端服务器上，日常使用不需要自己备份（服务器数据由管理员负责备份）。这里可以把你的数据打包下载到本地，用于换电脑 / 留档；云端不提供自助恢复，如果需要恢复数据请联系管理员。')}
          </p>
          <label className="acc-dl-check">
            <input type="checkbox" checked readOnly disabled />
            <span>
              {t('应用数据（必选）')}
              <small>{t('地点 / 到访 / 笔记 / 评分 / 回收站')}</small>
            </span>
          </label>
          <label className="acc-dl-check">
            <input
              type="checkbox"
              checked={dlThumbs}
              onChange={(e) => setDlThumbs(e.currentTarget.checked)}
            />
            <span>
              {t('包含缩略图 / 预览（推荐，体积小）')}
              <small>{t('下载后不联网也能浏览缩略图')}</small>
            </span>
          </label>
          <label className="acc-dl-check">
            <input
              type="checkbox"
              checked={dlMedia}
              onChange={(e) => setDlMedia(e.currentTarget.checked)}
            />
            <span>
              {t('包含照片 / 视频文件（体积可能很大）')}
              <small>{t('勾选后打包会久一点；受账号存储配额限制')}</small>
            </span>
          </label>
          <a
            className="primary full acc-dl-btn"
            href={api.userExportUrl({ thumbs: dlThumbs, media: dlMedia })}
          >
            {t('下载到本地')}
          </a>
          <p className="hint">
            {t('下载包是一个 zip：包含你的应用数据、说明文件，以及可选的缩略图与照片视频文件；只包含你自己的账号数据，不会包含其他账号。')}
          </p>
        </section>
      )}

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('修改登录密码')}</h3>
        </div>
        <p className="set-section-desc">
          {t('修改后请用新密码登录；密码会加密保存，任何人都看不到原文。')}
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
