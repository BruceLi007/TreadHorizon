import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { AccountSummary, AuthUser } from '../../lib/types';
import { formatBytes } from '../../lib/bytes';
import { tr, useT } from '../../i18n';

interface Health {
  ok: boolean;
  authMode?: string;
  hasTk?: boolean;
  mediaRoot?: string;
  dataDir?: string;
  version?: string;
  mode?: string;
  ffmpeg?: boolean;
  stats?: Record<string, number>;
  globalStats?: Record<string, number>;
}

interface Props {
  /** 多用户模式（M6 P2-4，D-205）：关于页按角色分层，普通用户不下发服务器路径 */
  multi?: boolean;
  isAdmin?: boolean;
  currentUser?: AuthUser | null;
}

/**
 * 关于分类（F-SYS-02）
 *
 * - 本地模式（默认）：与以前完全一致——版本 / 运行模式 / 数据目录 / 素材库 / Key / ffmpeg /
 *   数据文件说明 +「本地运行 · 无账号 · 无云」标签和「换电脑拷 data/」提示。
 * - 多用户模式（P2-4，D-205）：普通用户只看账号 / 角色 / 存储用量 / 自己的 Key 状态 / 自己的数据量
 *   与导出入口提示，**不下发服务器绝对路径、ffmpeg、全局数据量**；
 *   管理员额外看到服务器目录 / 素材库 / ffmpeg / 全局数据量 / 运行模式。
 */
export default function AboutSettings({ multi = false, isAdmin = false, currentUser = null }: Props) {
  const t = useT();
  const [h, setH] = useState<Health | null>(null);
  const [sum, setSum] = useState<AccountSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const health = (await api.health()) as Health;
        if (!alive) return;
        setH(health);
        if (multi) {
          try {
            const s = await api.accountSummary();
            if (alive) setSum(s);
          } catch {
            /* 用量读不到只影响这一块 */
          }
        }
      } catch (e: any) {
        if (alive) setErr(tr('读取运行状态失败：') + (e?.message || e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [multi]);

  const s = (multi && isAdmin ? h?.globalStats : h?.stats) ?? (multi ? h?.stats : h?.stats) ?? {};
  const own = h?.stats ?? {};
  const modeText = !h
    ? '—'
    : h.mode === 'dev'
      ? t('开发模式（npm run dev）')
      : t('正式模式（npm start / node server/index.mjs）');

  return (
    <div className="set-pane">
      {!multi ? (
        // ── 本地模式：与以前完全一致 ──
        <>
          <section className="set-section">
            <div className="set-section-head">
              <h3 className="set-section-title">{t('Tread Horizon 本地旅行足迹')}</h3>
              <span className="set-section-tag">{t('本地运行 · 无账号 · 无云')}</span>
            </div>
            <p className="set-section-desc">
              {t('一个纯本地的个人旅行足迹地图：数据在 SQLite，照片/视频在本地素材库，地图用天地图。 A 原件永远不被 app 读取或修改；B 素材库是上传时生成的副本。')}
            </p>

            {err && <p className="hint err">{err}</p>}
            {!h && !err && <p className="hint">{t('读取中…')}</p>}

            {h && (
              <>
                <div className="set-about-grid">
                  <div className="set-about-stat">
                    <b>{s.places ?? 0}</b>
                    <span>{t('地点')}</span>
                  </div>
                  <div className="set-about-stat">
                    <b>{s.visits ?? 0}</b>
                    <span>{t('到访')}</span>
                  </div>
                  <div className="set-about-stat">
                    <b>{s.photos ?? 0}</b>
                    <span>{t('照片')}</span>
                  </div>
                  <div className="set-about-stat">
                    <b>{s.videos ?? 0}</b>
                    <span>{t('视频')}</span>
                  </div>
                </div>

                <div className="field-static">
                  <span>{t('应用版本')}</span>
                  <div className="value mono">{h.version || '—'}</div>
                </div>
                <div className="field-static">
                  <span>{t('运行模式')}</span>
                  <div className="value">{modeText}</div>
                </div>
                <div className="field-static">
                  <span>{t('数据目录')}</span>
                  <div className="value mono" style={{ wordBreak: 'break-all' }}>
                    {h.dataDir}
                  </div>
                </div>
                <div className="field-static">
                  <span>{t('素材库 B')}</span>
                  <div className="value mono" style={{ wordBreak: 'break-all' }}>
                    {h.mediaRoot}
                  </div>
                </div>
                <div className="field-static">
                  <span>{t('天地图 key')}</span>
                  <div className="value">
                    {h.hasTk ? t('已配置') : t('未配置（地图可能加载不出来）')}
                  </div>
                </div>
                <div className="field-static">
                  <span>{t('视频封面（ffmpeg）')}</span>
                  <div className="value">
                    {h.ffmpeg ? t('可用') : t('不可用（视频仍可播放）')}
                  </div>
                </div>
              </>
            )}
          </section>

          <section className="set-section">
            <div className="set-section-head">
              <h3 className="set-section-title">{t('数据文件说明')}</h3>
            </div>
            <div className="field-static">
              <span>{t('数据库 / 配置')}</span>
              <div className="value">
                <span className="mono">data/travel.db</span>
                {t('、')}
                <span className="mono">data/config.json</span>
                {t('（唯一元数据；请定期手动备份）')}
              </div>
            </div>
            <div className="field-static">
              <span>{t('缩略图缓存')}</span>
              <div className="value">
                <span className="mono">data/thumbs/</span>
                {t('（可重建，不算数据）')}
              </div>
            </div>
            <div className="field-static">
              <span>{t('恢复前自动备份')}</span>
              <div className="value">
                <span className="mono">data/backups/</span>
                {t('（保留最近 5 份 pre-restore zip）')}
              </div>
            </div>
            <div className="field-static">
              <span>{t('导出 / 检查临时文件')}</span>
              <div className="value">
                <span className="mono">data/tmp/</span>
                {t('（自动清理）')}
              </div>
            </div>
            <p className="hint">
              {t('换电脑：拷贝 ')}
              <span className="mono">data/</span>
              {t(' + 素材库 B + ')}
              <span className="mono">.env.local</span>
              {t('； 或使用「备份与恢复」里的完整备份（含素材）一次性带走。')}
            </p>
          </section>
        </>
      ) : (
        // ── 多用户模式：按角色分层（P2-4，D-205）──
        <>
          <section className="set-section">
            <div className="set-section-head">
              <h3 className="set-section-title">{t('Tread Horizon')}</h3>
              <span className="set-section-tag">{t('云端多用户 · 数据按账号隔离')}</span>
            </div>
            <p className="set-section-desc">
              {t('数据保存在服务器上，每个账号的数据完全隔离、互不可见；照片 / 视频在服务器素材库，地图用天地图（每个账号用自己的 Key）。')}
            </p>

            {err && <p className="hint err">{err}</p>}
            {!h && !err && <p className="hint">{t('读取中…')}</p>}

            {h && (
              <>
                <div className="set-about-grid">
                  <div className="set-about-stat">
                    <b>{own.places ?? 0}</b>
                    <span>{t('我的地点')}</span>
                  </div>
                  <div className="set-about-stat">
                    <b>{own.visits ?? 0}</b>
                    <span>{t('我的到访')}</span>
                  </div>
                  <div className="set-about-stat">
                    <b>{own.photos ?? 0}</b>
                    <span>{t('我的照片')}</span>
                  </div>
                  <div className="set-about-stat">
                    <b>{own.videos ?? 0}</b>
                    <span>{t('我的视频')}</span>
                  </div>
                </div>

                <div className="field-static">
                  <span>{t('应用版本')}</span>
                  <div className="value mono">{h.version || '—'}</div>
                </div>
                <div className="field-static">
                  <span>{t('账号')}</span>
                  <div className="value">
                    {currentUser ? `${currentUser.displayName}（@${currentUser.username}）` : '—'}
                    {/* 2026-11-07（D-216）：角色是中文文案，不能套 .mono（等宽字体会回退成宋体，字体不对）；
                        复用账号页的角色小标签样式，保持界面字体一致。 */}
                    <span className="acc-role-tag">
                      {isAdmin ? t('管理员') : t('普通用户')}
                    </span>
                  </div>
                </div>
                {sum && (
                  <div className="field-static">
                    <span>{t('存储用量')}</span>
                    <div className="value">
                      {formatBytes(sum.usage.mediaBytes)}
                      <span className="muted" style={{ marginLeft: 8 }}>
                        {t('只做统计，不限制上传')}
                      </span>
                    </div>
                  </div>
                )}
                <div className="field-static">
                  <span>{t('天地图 Key')}</span>
                  <div className="value">
                    {h.hasTk
                      ? t('已配置（你账号自己的 Key）')
                      : t('未配置：请到 设置 → 天地图 Key 填写（每个账号一份）')}
                  </div>
                </div>
                <div className="field-static">
                  <span>{t('数据备份')}</span>
                  <div className="value">
                    {isAdmin
                      ? t('管理员可在「备份与恢复」里导出全量备份 / 恢复；普通用户可在那里导出自己的数据。')
                      : t('可在 设置 → 备份与恢复 里导出「我的数据」zip；需要恢复数据请联系管理员。')}
                  </div>
                </div>
              </>
            )}
          </section>

          {isAdmin && h && (
            <section className="set-section">
              <div className="set-section-head">
                <h3 className="set-section-title">{t('服务器信息（仅管理员可见）')}</h3>
              </div>
              <div className="field-static">
                <span>{t('运行模式')}</span>
                <div className="value">{modeText}</div>
              </div>
              <div className="field-static">
                <span>{t('数据目录')}</span>
                <div className="value mono" style={{ wordBreak: 'break-all' }}>
                  {h.dataDir || '—'}
                </div>
              </div>
              <div className="field-static">
                <span>{t('素材库 B')}</span>
                <div className="value mono" style={{ wordBreak: 'break-all' }}>
                  {h.mediaRoot || '—'}
                </div>
              </div>
              <div className="field-static">
                <span>{t('视频封面（ffmpeg）')}</span>
                <div className="value">
                  {h.ffmpeg ? t('可用') : t('不可用（视频仍可播放）')}
                </div>
              </div>
              <div className="field-static">
                <span>{t('全局数据量（所有账号）')}</span>
                <div className="value">
                  {t('{places} 个地点 · {visits} 次到访 · {photos} 张照片 · {videos} 段视频', {
                    places: s.places ?? 0,
                    visits: s.visits ?? 0,
                    photos: s.photos ?? 0,
                    videos: s.videos ?? 0,
                  })}
                </div>
              </div>
            </section>
          )}

          <section className="set-section">
            <div className="set-section-head">
              <h3 className="set-section-title">{t('数据与备份说明（云端）')}</h3>
            </div>
            <p className="set-section-desc">
              {t('云端模式的数据在服务器的数据目录与素材库中，按账号隔离存放；不要在服务器上手改。备份与恢复由管理员在服务器侧完成（每日快照 + 手动备份），普通用户请使用「导出我的数据」。')}
            </p>
            <p className="hint">
              {t('换电脑 / 换浏览器不需要迁移数据：用同一个账号登录即可；界面偏好（主题 / 字体等）只存本机浏览器。')}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
