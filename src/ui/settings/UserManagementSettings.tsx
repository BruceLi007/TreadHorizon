import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { AdminUserInfo, AuthUser, InviteInfo, QuotaRequestInfo } from '../../lib/types';
import { useLang, useT } from '../../i18n';
import { formatBytes, formatQuota } from '../../lib/bytes';
import './UserManagementSettings.css';

interface Props {
  /** 当前管理员自己的账号（用于禁止禁用自己） */
  currentUser: AuthUser;
}

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
 * 设置 → 用户管理（2026-11-06 M6 P2-3，D-204；2026-11-07 D-209 去掉配额、D-221 并入邀请码管理）
 *
 * 仅多用户模式的管理员可见（由 SettingsModal 过滤）。功能：
 * 账号列表（角色 / 状态 / 已用空间 / 最近登录）、禁用 / 启用、重置登录密码；
 * 「邀请码管理」（生成一次性邀请码 / 列表 / 作废）——2026-11-07 按用户要求从「账号」页移到这里。
 * 配额（上限拦截）按用户要求延后到 P1 素材上云后再做，这里只显示已用空间统计。
 */
export default function UserManagementSettings({ currentUser }: Props) {
  const t = useT();
  const lang = useLang();
  const [users, setUsers] = useState<AdminUserInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pwdFor, setPwdFor] = useState<string | null>(null);
  const [newPwd, setNewPwd] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // ── 邀请码管理（2026-11-07 从「账号」页移入，D-221）──
  const [invites, setInvites] = useState<InviteInfo[] | null>(null);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [inviteDays, setInviteDays] = useState(7);
  const [inviteNote, setInviteNote] = useState('');
  const [creating, setCreating] = useState(false);
  const [newCode, setNewCode] = useState<{ code: string; invite: InviteInfo } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // ── 扩容申请（2026-11-08 D-310）──
  const [quotaReqs, setQuotaReqs] = useState<QuotaRequestInfo[] | null>(null);
  const [quotaReqErr, setQuotaReqErr] = useState<string | null>(null);
  const [quotaReqBusy, setQuotaReqBusy] = useState<string | null>(null);
  const [adjustFor, setAdjustFor] = useState<string | null>(null);
  const [adjustGb, setAdjustGb] = useState('');
  const [adjustBusy, setAdjustBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.adminUsers();
      setUsers(r.items);
      setError(null);
    } catch (e: any) {
      setUsers(null);
      setError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadQuotaReqs = useCallback(async () => {
    try {
      const r = await api.adminQuotaRequests('pending');
      setQuotaReqs(r.items);
      setQuotaReqErr(null);
    } catch (e: any) {
      setQuotaReqs(null);
      setQuotaReqErr(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    void loadQuotaReqs();
  }, [loadQuotaReqs]);

  const toggleStatus = async (u: AdminUserInfo) => {
    if (busyId || u.id === currentUser.id) return;
    setBusyId(u.id);
    setMsg(null);
    try {
      const next = u.status === 'active' ? 'disabled' : 'active';
      await api.adminUpdateUser(u.id, { status: next });
      await load();
      setMsg({
        ok: true,
        text: next === 'disabled' ? t('已禁用账号 {name}', { name: u.username }) : t('已启用账号 {name}', { name: u.username }),
      });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setBusyId(null);
    }
  };

  const resetPwd = async (u: AdminUserInfo) => {
    if (busyId) return;
    if (newPwd.length < 8) {
      setMsg({ ok: false, text: t('新密码至少 8 位') });
      return;
    }
    setBusyId(u.id);
    setMsg(null);
    try {
      await api.adminResetPassword(u.id, newPwd);
      setPwdFor(null);
      setNewPwd('');
      setMsg({ ok: true, text: t('已重置 {name} 的登录密码', { name: u.username }) });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setBusyId(null);
    }
  };

  // ── 邀请码管理（2026-11-07 从「账号」页移入，D-221）──
  const loadInvites = useCallback(async () => {
    try {
      const r = await api.adminInvites();
      setInvites(r.items);
      setInviteErr(null);
    } catch (e: any) {
      setInvites(null);
      setInviteErr(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    void loadInvites();
  }, [loadInvites]);

  const createInvite = async () => {
    if (creating) return;
    setCreating(true);
    setInviteErr(null);
    try {
      const r = await api.adminCreateInvite({ days: inviteDays, note: inviteNote.trim() });
      setNewCode({ code: r.code, invite: r.invite });
      setCopied(false);
      setInviteNote('');
      await loadInvites();
    } catch (e: any) {
      setInviteErr(e?.message || String(e));
    } finally {
      setCreating(false);
    }
  };

  const copyCode = async () => {
    if (!newCode) return;
    try {
      await navigator.clipboard.writeText(newCode.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用（http / 权限）：用户手动选中复制 */
    }
  };

  const revoke = async (id: string) => {
    if (revokingId) return;
    setRevokingId(id);
    setInviteErr(null);
    try {
      await api.adminRevokeInvite(id);
      await loadInvites();
    } catch (e: any) {
      setInviteErr(e?.message || String(e));
    } finally {
      setRevokingId(null);
    }
  };

  // ── 配额调整 / 扩容审批（2026-11-08 D-310）──
  const openAdjust = (u: AdminUserInfo) => {
    setAdjustFor(adjustFor === u.id ? null : u.id);
    setAdjustGb(((Number(u.quotaBytes) || 0) / 1024 ** 3).toFixed(0));
    setMsg(null);
  };

  const saveQuota = async (u: AdminUserInfo) => {
    if (adjustBusy) return;
    const gb = Number(adjustGb);
    if (!Number.isFinite(gb) || gb < 1) {
      setMsg({ ok: false, text: t('配额至少 1 GB') });
      return;
    }
    const bytes = Math.round(gb * 1024 ** 3);
    setAdjustBusy(true);
    setMsg(null);
    try {
      await api.adminUpdateUser(u.id, { quotaBytes: bytes });
      setAdjustFor(null);
      setAdjustGb('');
      await Promise.all([load(), loadQuotaReqs()]);
      setMsg({
        ok: true,
        text: t('已把 {name} 的配额调整为 {size}', {
          name: u.username,
          size: formatQuota(bytes),
        }),
      });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || String(e) });
    } finally {
      setAdjustBusy(false);
    }
  };

  const decideReq = async (req: QuotaRequestInfo, action: 'approve' | 'reject') => {
    if (quotaReqBusy) return;
    setQuotaReqBusy(req.id);
    setQuotaReqErr(null);
    try {
      await api.adminDecideQuotaRequest(req.id, { action });
      await Promise.all([loadQuotaReqs(), load()]);
      setMsg({
        ok: true,
        text:
          action === 'approve'
            ? t('已批准扩容到 {size}', { size: formatQuota(req.requestedBytes) })
            : t('已拒绝该扩容申请'),
      });
    } catch (e: any) {
      setQuotaReqErr(e?.message || String(e));
    } finally {
      setQuotaReqBusy(null);
    }
  };

  return (
    <div className="set-pane">
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('用户管理')}</h3>
          <button className="text-btn" onClick={load} disabled={!!busyId}>
            {t('刷新')}
          </button>
        </div>
        <p className="set-section-desc">
          {t('每个账号的数据完全隔离；新用户通过下方「邀请码管理」生成的邀请码注册。这里可以禁用账号、重置登录密码、查看 / 调整各账号的存储配额，并审批扩容申请。')}
        </p>

        {error && <p className="hint err">{error}</p>}
        {users === null && !error && <p className="hint">{t('读取中…')}</p>}

        {users !== null && (
          <div className="um-list">
            <div className="um-head" aria-hidden="true">
              <span>{t('账号')}</span>
              <span>{t('状态')}</span>
              <span>{t('已用空间')}</span>
              <span>{t('操作')}</span>
            </div>
            {users.map((u) => {
              const isSelf = u.id === currentUser.id;
              const used = Number(u.usedBytes) || 0;
              const quota = Number(u.quotaBytes) || 0;
              const over = quota > 0 && used >= quota;
              return (
                <div className={pwdFor === u.id ? 'um-row is-open' : 'um-row'} key={u.id}>
                  <div className="um-id">
                    <div className="um-name">
                      {u.displayName || u.username}
                      <span className="um-handle">@{u.username}</span>
                      {u.role === 'admin' && <span className="um-role">{t('管理员')}</span>}
                      {isSelf && <span className="um-self">{t('我')}</span>}
                    </div>
                    <div className="um-sub">
                      {t('加入')} {fmtDate(u.createdAt, lang)} · {t('最近登录')}{' '}
                      {fmtDate(u.lastLoginAt, lang)}
                    </div>
                  </div>

                  <div className="um-status">
                    <span className={u.status === 'active' ? 'um-badge is-on' : 'um-badge is-off'}>
                      {u.status === 'active' ? t('正常') : t('已禁用')}
                    </span>
                  </div>

                  <div className="um-usage">
                    <span className={over ? 'um-usage-text is-over' : 'um-usage-text'}>
                      {formatBytes(used)} / {formatQuota(quota)}
                    </span>
                    {over && <span className="um-badge is-over">{t('已超额')}</span>}
                    <span className="um-usage-sub">
                      {t('{places} 个地点 · {visits} 次到访 · {photos} 张照片 · {videos} 段视频', {
                        places: u.usage?.places ?? 0,
                        visits: u.usage?.visits ?? 0,
                        photos: u.usage?.photos ?? 0,
                        videos: u.usage?.videos ?? 0,
                      })}
                    </span>
                  </div>

                  <div className="um-actions">
                    <button
                      className="text-btn"
                      onClick={() => {
                        setPwdFor(pwdFor === u.id ? null : u.id);
                        setNewPwd('');
                        setMsg(null);
                      }}
                      disabled={!!busyId}
                    >
                      {t('重置密码')}
                    </button>
                    <button className="text-btn" onClick={() => openAdjust(u)} disabled={!!busyId || adjustBusy}>
                      {t('调整配额')}
                    </button>
                    <button
                      className={u.status === 'active' ? 'text-btn danger' : 'text-btn'}
                      onClick={() => toggleStatus(u)}
                      disabled={!!busyId || isSelf}
                      title={isSelf ? t('不能禁用自己') : undefined}
                    >
                      {u.status === 'active' ? t('禁用') : t('启用')}
                    </button>
                  </div>

                  {adjustFor === u.id && (
                    <div className="um-pwd-row">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={adjustGb}
                        placeholder={t('配额（GB）')}
                        aria-label={t('配额（GB）')}
                        autoFocus
                        disabled={adjustBusy}
                        onChange={(e) => {
                          setAdjustGb(e.target.value);
                          setMsg(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveQuota(u);
                          if (e.key === 'Escape') {
                            setAdjustFor(null);
                            setMsg(null);
                          }
                        }}
                      />
                      <button className="text-btn" onClick={() => void saveQuota(u)} disabled={adjustBusy}>
                        {adjustBusy ? t('保存中…') : t('保存配额')}
                      </button>
                      <button
                        className="text-btn"
                        onClick={() => {
                          setAdjustFor(null);
                          setMsg(null);
                        }}
                        disabled={adjustBusy}
                      >
                        {t('取消')}
                      </button>
                      <span className="hint">
                        {t('配额以 GB 为单位（整数）；回收站里还没彻底删除的素材也计入占用。')}
                      </span>
                    </div>
                  )}

                  {pwdFor === u.id && (
                    <div className="um-pwd-row">
                      <input
                        type="password"
                        value={newPwd}
                        placeholder={t('新密码（至少 8 位）')}
                        autoFocus
                        maxLength={128}
                        disabled={!!busyId}
                        onChange={(e) => {
                          setNewPwd(e.target.value);
                          setMsg(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void resetPwd(u);
                        }}
                      />
                      <button className="text-btn" onClick={() => resetPwd(u)} disabled={!!busyId}>
                        {t('确认重置')}
                      </button>
                      <button
                        className="text-btn"
                        onClick={() => {
                          setPwdFor(null);
                          setNewPwd('');
                        }}
                        disabled={!!busyId}
                      >
                        {t('取消')}
                      </button>
                      <span className="hint">{t('重置后请把新密码告诉对方；不会退出对方已登录的会话。')}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {msg && <p className={msg.ok ? 'hint acc-ok' : 'hint err'}>{msg.text}</p>}
      </section>

      {/* 扩容申请（2026-11-08 D-310）：用户在「设置 → 账号」提交，管理员在这里审批 */}
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('扩容申请')}</h3>
          <span className="acc-badge">
            {quotaReqs && quotaReqs.length > 0
              ? t('{n} 条待审批', { n: quotaReqs.length })
              : t('暂无待审批')}
          </span>
        </div>
        <p className="set-section-desc">
          {t('用户空间用满后可以在「设置 → 账号」提交扩容申请；批准后按申请值提高配额。如需其它额度，可在上方账号列表里直接调整。')}
        </p>
        {quotaReqErr && <p className="hint err">{quotaReqErr}</p>}
        {quotaReqs === null && !quotaReqErr && <p className="hint">{t('读取中…')}</p>}
        {quotaReqs !== null && quotaReqs.length === 0 && (
          <p className="hint">{t('暂无待审批的扩容申请。')}</p>
        )}
        {quotaReqs !== null && quotaReqs.length > 0 && (
          <div className="um-req-list">
            {quotaReqs.map((r) => (
              <div className="um-req-row" key={r.id}>
                <div className="um-req-main">
                  <div className="um-req-title">
                    <b>{r.displayName || r.username}</b>
                    <span className="um-handle">@{r.username}</span>
                    <span className="um-req-move">
                      {t('申请将配额从 {current} 提高到 {requested}', {
                        current: formatQuota(r.currentBytes),
                        requested: formatQuota(r.requestedBytes),
                      })}
                    </span>
                  </div>
                  {r.reason && (
                    <div className="um-req-reason">
                      {t('理由：')}
                      {r.reason}
                    </div>
                  )}
                  <div className="um-req-meta">
                    {t('申请时间：')}
                    {fmtDate(r.createdAt, lang)}
                  </div>
                </div>
                <div className="um-req-actions">
                  <button
                    className="primary"
                    onClick={() => void decideReq(r, 'approve')}
                    disabled={quotaReqBusy === r.id}
                  >
                    {quotaReqBusy === r.id
                      ? t('处理中…')
                      : t('批准提高到 {size}', { size: formatQuota(r.requestedBytes) })}
                  </button>
                  <button
                    className="text-btn danger"
                    onClick={() => void decideReq(r, 'reject')}
                    disabled={quotaReqBusy === r.id}
                  >
                    {t('拒绝')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 邀请码管理（2026-11-07 按用户要求从「账号」页移到「用户管理」里，D-221） */}
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('邀请码管理')}</h3>
          <span className="acc-badge">{t('仅管理员')}</span>
        </div>
        <p className="set-section-desc">
          {t('邀请码一次性使用、可设有效期；生成后只显示一次明文，请复制发给朋友。')}
        </p>

        <div className="acc-invite-form">
          <label className="field acc-invite-days">
            <span>{t('有效期（天）')}</span>
            <input
              type="number"
              min={1}
              max={90}
              value={inviteDays}
              disabled={creating}
              onChange={(e) => {
                const n = Number(e.target.value);
                setInviteDays(Number.isFinite(n) ? Math.min(90, Math.max(1, Math.round(n))) : 7);
              }}
            />
          </label>
          <label className="field acc-invite-note">
            <span>{t('备注（可选）')}</span>
            <input
              value={inviteNote}
              maxLength={80}
              disabled={creating}
              placeholder={t('例如：给小王')}
              onChange={(e) => setInviteNote(e.target.value)}
            />
          </label>
          <button className="primary acc-invite-create" onClick={createInvite} disabled={creating}>
            {creating ? t('生成中…') : t('生成邀请码')}
          </button>
        </div>

        {newCode && (
          <div className="acc-newcode">
            <div className="acc-newcode-text">
              <b>{t('新邀请码（只显示这一次）')}</b>
              <code>{newCode.code}</code>
            </div>
            <div className="acc-newcode-actions">
              <button className="ghost" onClick={copyCode}>
                {copied ? t('已复制') : t('复制')}
              </button>
              <button className="text-btn" onClick={() => setNewCode(null)}>
                {t('完成')}
              </button>
            </div>
          </div>
        )}

        {inviteErr && <p className="hint err">{inviteErr}</p>}

        {invites === null && !inviteErr && <p className="hint">{t('读取中…')}</p>}

        {invites !== null && invites.length === 0 && (
          <p className="hint">{t('还没有生成过邀请码。')}</p>
        )}

        {invites !== null && invites.length > 0 && (
          <div className="acc-invites">
            {invites.map((it) => {
              const status = it.used ? 'used' : it.expired ? 'expired' : 'active';
              return (
                <div className="acc-invite-row" key={it.id}>
                  <div className="acc-invite-main">
                    <div className="acc-invite-line">
                      <span className={`acc-invite-status is-${status}`}>
                        {status === 'used'
                          ? t('已使用')
                          : status === 'expired'
                            ? t('已过期')
                            : t('未使用')}
                      </span>
                      {it.note && <span className="acc-invite-note-text">{it.note}</span>}
                    </div>
                    <div className="acc-invite-meta">
                      {t('创建 {created} · 到期 {expires}', {
                        created: fmtDate(it.createdAt, lang),
                        expires: fmtDate(it.expiresAt, lang),
                      })}
                      {it.used ? ` · ${t('使用人：{name}', { name: it.usedBy })}` : ''}
                    </div>
                  </div>
                  {status === 'active' && (
                    <button
                      className="text-btn danger"
                      onClick={() => revoke(it.id)}
                      disabled={revokingId === it.id}
                    >
                      {revokingId === it.id ? t('作废中…') : t('作废')}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
