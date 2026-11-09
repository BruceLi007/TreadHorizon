import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { SecretStatus } from '../../lib/types';
import { tr, useT } from '../../i18n';
import '../SecretPrompt.css';

interface Props {
  /** 密码设置 / 修改 / 重置后通知 App 刷新秘密基地状态 */
  onChanged: () => void;
  /**
   * 2026-11-09 D-331（用户反馈）：密码被设置 / 修改 / 重置后，通知 App 清掉当前会话的
   * 「秘密基地已解锁」状态——改了密码后再打开秘密基地需要重新输入新密码。
   */
  onPasswordChanged?: () => void;
  /**
   * 2026-11-09 D-332（用户选择方案 B）：multi（云端版）不再有单独的「秘密基地密码」，
   * 改为打开秘密基地时验证登录账号密码；本页只做说明，不提供设置 / 修改 / 重置密码的 UI。
   */
  multi?: boolean;
}

/** 安全分类：秘密基地密码（设置 / 修改 / 重置） */
export default function SecuritySettings({ onChanged, onPasswordChanged, multi = false }: Props) {
  const t = useT();
  const [secret, setSecret] = useState<SecretStatus | null>(null);
  const [secretErr, setSecretErr] = useState<string | null>(null);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdBusy, setPwdBusy] = useState<'set' | 'change' | 'reset' | null>(null);
  const [pwdMsg, setPwdMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  // 2026-11-09 D-329：显示秘密基地「初始密码」提示（首次初始化时自动设置；用户可修改 / 重置）
  const [initialPwd, setInitialPwd] = useState('');
  useEffect(() => {
    let alive = true;
    api
      .config()
      .then((c) => {
        if (alive && typeof c.starterSecretPassword === 'string') {
          setInitialPwd(c.starterSecretPassword);
        }
      })
      .catch(() => {
        /* 读不到就显示原始说明，不影响页面 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const loadSecret = useCallback(async () => {
    try {
      const s = await api.secretStatus();
      setSecret(s);
      setSecretErr(null);
    } catch (e: any) {
      setSecret(null);
      setSecretErr(tr('读取秘密基地状态失败：') + (e?.message || e));
    }
  }, []);

  useEffect(() => {
    loadSecret();
  }, [loadSecret]);

  /** 新密码规则：1..128 位，且两次输入一致；只做本地提示，真正的校验仍在服务端 */
  const validateNewPwd = (): string | null => {
    if (newPwd.length < 1) return t('新密码不能为空');
    if (newPwd.length > 128) return t('新密码最多 128 位');
    if (newPwd !== confirmPwd) return t('两次输入的新密码不一致');
    return null;
  };

  const clearPwdInputs = () => {
    setOldPwd('');
    setNewPwd('');
    setConfirmPwd('');
  };

  const doSetPwd = async () => {
    if (pwdBusy) return;
    const bad = validateNewPwd();
    if (bad) {
      setPwdMsg({ ok: false, text: bad });
      return;
    }
    setPwdBusy('set');
    setPwdMsg(null);
    try {
      await api.setSecretPassword({ newPassword: newPwd });
      clearPwdInputs();
      setPwdMsg({ ok: true, text: t('已设置密码：秘密基地已上锁') });
      await loadSecret();
      onChanged();
      onPasswordChanged?.();
    } catch (e: any) {
      setPwdMsg({ ok: false, text: t('设置失败：') + (e?.message || e) });
    } finally {
      setPwdBusy(null);
    }
  };

  const doChangePwd = async () => {
    if (pwdBusy) return;
    if (!oldPwd) {
      setPwdMsg({ ok: false, text: t('请输入旧密码') });
      return;
    }
    const bad = validateNewPwd();
    if (bad) {
      setPwdMsg({ ok: false, text: bad });
      return;
    }
    setPwdBusy('change');
    setPwdMsg(null);
    try {
      await api.setSecretPassword({ oldPassword: oldPwd, newPassword: newPwd });
      clearPwdInputs();
      setPwdMsg({ ok: true, text: t('密码已修改') });
      await loadSecret();
      onChanged();
      onPasswordChanged?.();
    } catch (e: any) {
      setPwdMsg({ ok: false, text: t('修改失败：') + (e?.message || e) });
    } finally {
      setPwdBusy(null);
    }
  };

  const doResetPwd = async () => {
    if (pwdBusy) return;
    setPwdBusy('reset');
    setPwdMsg(null);
    try {
      await api.setSecretPassword({ newPassword: '', reset: true });
      setConfirmingReset(false);
      clearPwdInputs();
      setPwdMsg({ ok: true, text: t('已重置密码：秘密基地不再上锁（地点标记和内容都保留）') });
      await loadSecret();
      onChanged();
      onPasswordChanged?.();
    } catch (e: any) {
      setPwdMsg({ ok: false, text: t('重置失败：') + (e?.message || e) });
    } finally {
      setPwdBusy(null);
    }
  };

  // 2026-11-09 D-332（用户选择方案 B）：云端版（multi）秘密基地用「登录账号密码」解锁，
  // 没有单独的秘基密码可设置 / 修改 / 重置，本分类只做说明 + 数量展示。
  if (multi) {
    return (
      <div className="set-pane">
        <section className="set-section">
          <div className="set-section-head">
            <h3 className="set-section-title">{t('秘密基地密码')}</h3>
          </div>
          <p className="set-section-desc">
            {t('云端版用登录账号密码解锁：打开秘密基地详情前需要重新输入你的登录账号密码；忘记登录密码时请联系管理员重置。')}
          </p>
          {secret && (
            <div className="field-static">
              <span>{t('状态')}</span>
              <div className="value">
                {secret.places > 0
                  ? t('已用登录密码保护 · {n} 个秘密基地', { n: secret.places })
                  : t('还没有秘密基地')}
              </div>
            </div>
          )}
          <p className="hint">
            {t('秘密基地内容不加密，仅防止他人临时使用你已登录的浏览器时直接查看。')}
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="set-pane">
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('秘密基地密码')}</h3>
        </div>
        <p className="set-section-desc">
          {t('秘密基地在地图上照常可见（只用紫罗兰色飞镖区分），点开详情需要密码。密码只保存在这台电脑上，不会上传。')}
        </p>

        {initialPwd && secret?.configured && (
          <p className="hint" style={{ marginTop: -6 }}>
            {t('（初始密码为{v}）', { v: initialPwd })}
          </p>
        )}

        {secretErr ? (
          <>
            <p className="hint err">{secretErr}</p>
            <button className="ghost full" onClick={loadSecret}>
              {t('重试')}
            </button>
          </>
        ) : secret === null ? (
          <p className="hint">{t('读取中…')}</p>
        ) : (
          <>
            <div className="field-static">
              <span>{t('状态')}</span>
              <div className="value">
                {secret.configured
                  ? t('已设置密码 · {n} 个秘密基地', { n: secret.places })
                  : t('未设置密码（秘密基地不会上锁）') +
                    (secret.places > 0
                      ? t(' · 已有 {n} 个地点标为秘密基地', { n: secret.places })
                      : '')}
              </div>
            </div>

            {secret.configured ? (
              <>
                <p className="hint" style={{ marginTop: -6 }}>
                  {t('修改密码需要旧密码。')}
                </p>

                <label className="field">
                  <span>{t('旧密码')}</span>
                  <input
                    type="password"
                    value={oldPwd}
                    autoComplete="current-password"
                    spellCheck={false}
                    maxLength={128}
                    placeholder={t('当前密码')}
                    disabled={!!pwdBusy}
                    onChange={(e) => {
                      setOldPwd(e.target.value);
                      setPwdMsg(null);
                    }}
                  />
                </label>

                <label className="field">
                  <span>{t('新密码（1–128 位）')}</span>
                  <input
                    type="password"
                    value={newPwd}
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={128}
                    placeholder={t('新密码')}
                    disabled={!!pwdBusy}
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
                    placeholder={t('再输一次新密码')}
                    disabled={!!pwdBusy}
                    onChange={(e) => {
                      setConfirmPwd(e.target.value);
                      setPwdMsg(null);
                    }}
                  />
                </label>

                <button className="primary full" onClick={doChangePwd} disabled={!!pwdBusy}>
                  {pwdBusy === 'change' ? t('修改中…') : t('修改密码')}
                </button>

                <div className="sec-reset">
                  {confirmingReset ? (
                    <div className="confirm-del">
                      <div className="confirm-text">
                        {t('重置秘密基地密码？')}
                        <small>
                          {t('不需要旧密码；清掉之后秘密基地不再上锁，地点标记和照片都保留。')}
                        </small>
                      </div>
                      <div className="row">
                        <button
                          className="ghost"
                          onClick={() => setConfirmingReset(false)}
                          disabled={!!pwdBusy}
                        >
                          {t('取消')}
                        </button>
                        <button className="danger-btn" onClick={doResetPwd} disabled={!!pwdBusy}>
                          {pwdBusy === 'reset' ? t('重置中…') : t('确认重置')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="text-btn danger"
                      style={{ alignSelf: 'flex-end' }}
                      onClick={() => {
                        setPwdMsg(null);
                        setConfirmingReset(true);
                      }}
                      disabled={!!pwdBusy}
                    >
                      {t('重置密码（忘记旧密码时用）')}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="hint" style={{ marginTop: -6 }}>
                  {t('设置后，点开秘密基地的详情需要输入密码；地图上它们和普通地点只有飞镖颜色不同。')}
                </p>

                <label className="field">
                  <span>{t('新密码（1–128 位）')}</span>
                  <input
                    type="password"
                    value={newPwd}
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={128}
                    placeholder={t('设置密码')}
                    disabled={!!pwdBusy}
                    onChange={(e) => {
                      setNewPwd(e.target.value);
                      setPwdMsg(null);
                    }}
                  />
                </label>

                <label className="field">
                  <span>{t('确认密码')}</span>
                  <input
                    type="password"
                    value={confirmPwd}
                    autoComplete="new-password"
                    spellCheck={false}
                    maxLength={128}
                    placeholder={t('再输一次')}
                    disabled={!!pwdBusy}
                    onChange={(e) => {
                      setConfirmPwd(e.target.value);
                      setPwdMsg(null);
                    }}
                  />
                </label>

                <button className="primary full" onClick={doSetPwd} disabled={!!pwdBusy}>
                  {pwdBusy === 'set' ? t('设置中…') : t('设置密码')}
                </button>
              </>
            )}

            {pwdMsg && (
              <p className={pwdMsg.ok ? 'hint sec-ok' : 'hint err'} style={{ marginTop: 12 }}>
                {pwdMsg.text}
              </p>
            )}

            <p className="hint">
              {t('密码只保存在这台电脑上，不会上传，也不会显示在任何地方。【本地版应用的秘密基地密码其实是个摆设，忘记了就直接重置就行~~】')}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
