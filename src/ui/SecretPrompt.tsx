import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { useT, type TFn } from '../i18n';
import './SecretPrompt.css';

interface Props {
  /** 副标题：通常是地点名（秘密基地在列表里本来就可见，显示名字不算泄密） */
  title?: string;
  /** 密码校验通过（App 负责把「当前会话已解锁」状态记在内存里） */
  onSuccess: () => void;
  onCancel: () => void;
}

/** 把接口错误翻译成用户看得懂的提示；不打印、不落地密码 */
function friendlyError(e: unknown, t: TFn): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  if (/429|too many|rate.?limit|稍后再试|次数过多|过于频繁/i.test(raw)) {
    return t('尝试次数过多，请稍后再试');
  }
  if (!raw || /^(Forbidden|Unauthorized)$/i.test(raw)) return t('密码错误，请重试');
  return raw;
}

/**
 * 秘密基地密码框（F-PLC-11）
 * 只在打开秘密基地详情前弹一次；密码只存在于本组件的输入框 state，
 * 不写 localStorage / sessionStorage，也不 console.log。
 * - Enter 提交、Esc / 点遮罩取消
 * - 请求中禁用按钮，避免重复提交
 */
export default function SecretPrompt({ title, onSuccess, onCancel }: Props) {
  const t = useT();
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const aliveRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const cancel = () => {
    if (busyRef.current) return; // 请求中不响应 Esc / 点遮罩
    setPwd(''); // 密码只活在 state 里，取消即丢弃
    onCancel();
  };
  // 用 ref 保证 Esc 监听只注册一次，又能拿到最新的 busy / onCancel
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 捕获阶段拦下：避免 App 全局的 Esc（关面板/退打点模式）跟着一起触发
      e.preventDefault();
      e.stopPropagation();
      cancelRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busyRef.current) return;
    if (!pwd) {
      setErr(t('请输入密码'));
      inputRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      await api.verifySecret(pwd); // 服务端只回 ok，不泄露任何地点信息
      if (!aliveRef.current) return;
      setPwd('');
      onSuccess();
    } catch (e2: unknown) {
      if (!aliveRef.current) return;
      setErr(friendlyError(e2, t));
      inputRef.current?.select();
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  return createPortal(
    <div
      className="sec-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <form
        className="sec-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sec-dialog-title"
        onSubmit={submit}
      >
        <div className="sec-headline" id="sec-dialog-title">
          <span className="sec-dot" aria-hidden="true" />
          {t('秘密基地')}
        </div>
        {title && <p className="sec-sub">{title}</p>}
        <p className="sec-tip">{t('这是秘密基地，输入密码后才能查看详情。')}</p>

        <label className="field">
          <span>{t('密码')}</span>
          <input
            ref={inputRef}
            type="password"
            value={pwd}
            autoFocus
            autoComplete="current-password"
            spellCheck={false}
            maxLength={128}
            placeholder={t('输入密码')}
            disabled={busy}
            onChange={(e) => setPwd(e.target.value)}
          />
        </label>

        {err && (
          <p className="hint err" role="alert">
            {err}
          </p>
        )}

        <p className="hint">{t('密码错误只会提示错误，不会泄露任何地点信息。')}</p>

        <div className="sec-actions">
          <button type="button" className="ghost" onClick={cancel} disabled={busy}>
            {t('取消')}
          </button>
          <button type="submit" className="primary" disabled={busy || !pwd}>
            {busy ? t('解锁中…') : t('解锁')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
