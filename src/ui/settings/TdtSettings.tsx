import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { tr, useT } from '../../i18n';
import TdtGuideLink from '../TdtGuideLink';

/** 天地图 Key：32 位字母或数字（与后端校验一致） */
const TDT_KEY_RE = /^[A-Za-z0-9]{32}$/;

/**
 * 天地图 Key（2026-11-04，D-92 从「通用」独立出来，放在「安全」上面）：
 * 只显示是否配置，绝不把已存 key 渲染进 DOM；保存写 data/config.json，刷新后生效。
 * 2026-11-06 用户要求：删除「地图底图（固定）」冗余板块（底图不可切换，无需单独说明）。
 * 2026-11-06 M6 P2-4（D-205）：多用户模式下 Key 按账号保存到服务端（user_setting），
 * 每个账号一份、互不可见；文案随之切换（不再说「只保存在本机 data/config.json」）。
 */
export default function TdtSettings({ multi = false }: { multi?: boolean }) {
  const t = useT();
  const [hasTk, setHasTk] = useState<boolean | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      const h = await api.health();
      setHasTk(h.hasTk ?? null);
      setHealthErr(null);
    } catch (e: unknown) {
      setHasTk(null);
      setHealthErr(tr('读取 Key 状态失败：') + (e instanceof Error ? e.message : String(e)));
    }
  }, []);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  /** 前端先校验 32 位字母数字，再调后端；成功后提示刷新 */
  const saveKey = async () => {
    const key = keyInput.trim();
    if (!TDT_KEY_RE.test(key)) {
      setMsg({ ok: false, text: t('天地图 Key 必须是 32 位字母或数字') });
      return;
    }
    setSaving(true);
    setMsg(null);
    setSaved(false);
    try {
      const r = await api.setTdtKey(key);
      setHasTk(r.hasTk);
      setKeyInput('');
      setSaved(true);
      setMsg({ ok: true, text: t('已保存 · 刷新页面后地图使用新 Key') });
    } catch (e: unknown) {
      setMsg({
        ok: false,
        text: t('保存失败：') + (e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="set-pane">
      {/* 2026-11-07 用户要求：说明天地图 Key 对个人免费、但有每日调用限额，
          尽量用免费额度（后面还要写一篇「申请 Key 教程」文档，见 DECISIONS D-220） */}
      <div className="set-key-free-note">
        <p className="set-key-free-title">{t('免费额度说明')}</p>
        <p>
          {t(
            '为了尽量用上天地图的免费额度（让这个应用保持免费可用），建议你自己申请一个天地图 Key；个人使用目前是免费的。'
          )}
        </p>
        <p>
          {t(
            '免费 Key 每天有调用次数限制：只要不是频繁、长时间地使用地图（大量搜索、反复拖动、批量逆地理），日常记录完全够用；万一当天额度用完，地图可能暂时加载不出来，第二天额度重置后就恢复，已记录的数据不受影响。'
          )}
        </p>
      </div>
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('Key 配置')}</h3>
          <span className={hasTk === true ? 'set-key-badge ok' : 'set-key-badge'}>
            {hasTk === null
              ? healthErr
                ? t('状态未知')
                : t('读取中')
              : hasTk
                ? t('已配置')
                : t('未配置')}
          </span>
        </div>
        <p className="set-section-desc">
          {hasTk === true
            ? t('已配置（输入新 Key 可替换）。修改后需要刷新页面，地图才会使用新 Key。')
            : hasTk === false
              ? t('当前未配置，地图无法加载。请粘贴在天地图控制台申请的 32 位 Key。')
              : healthErr
                ? t('无法读取 Key 状态；仍可以直接粘贴新 Key 保存。')
                : t('正在读取 Key 状态…')}
        </p>
        {healthErr && (
          <p className="set-key-msg err">
            {healthErr}
            <button type="button" className="set-key-retry" onClick={() => void loadHealth()}>
              {t('重试')}
            </button>
          </p>
        )}

        <div className="set-key-form">
          <input
            className="set-key-input"
            type="password"
            value={keyInput}
            autoComplete="off"
            spellCheck={false}
            maxLength={32}
            disabled={saving}
            placeholder={t('粘贴 32 位天地图 Key')}
            aria-label={t('天地图 Key')}
            onChange={(e) => {
              setKeyInput(e.target.value);
              setMsg(null);
              setSaved(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveKey();
            }}
          />
          <button
            type="button"
            className="set-key-btn"
            onClick={() => void saveKey()}
            disabled={saving || !keyInput.trim()}
          >
            {saving ? t('保存中…') : t('保存 Key')}
          </button>
        </div>

        {msg && <p className={msg.ok ? 'set-key-msg ok' : 'set-key-msg err'}>{msg.text}</p>}

        {saved && (
          <div className="set-key-actions">
            <button
              type="button"
              className="set-key-reload"
              onClick={() => window.location.reload()}
            >
              {t('立即刷新')}
            </button>
            <span className="muted">{t('刷新后地图使用新 Key。')}</span>
          </div>
        )}

        <p className="set-key-note">
          {t('申请地址：')}
          <a
            className="set-key-link"
            href="https://www.tianditu.gov.cn/"
            target="_blank"
            rel="noreferrer"
          >
            www.tianditu.gov.cn
          </a>
          {multi
            ? t('。Key 只保存在你自己的账号设置里，其他账号看不到；请不要把 Key 发到聊天或截图里。')
            : t('。Key 只保存在这台电脑上；请不要把 Key 发到聊天或截图里。')}
        </p>

        {/* 2026-11-07 用户要求（D-222）：设置页也放一个申请教程 PDF 入口 */}
        <p className="set-key-note">
          {t('不知道怎么申请？')}
          <TdtGuideLink />
        </p>
      </section>
    </div>
  );
}
