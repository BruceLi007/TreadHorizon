import { useCallback, useEffect, useState } from 'react';
import type { BackupStatus, UserRestoreSummary } from '../../lib/types';
import BackupSection from '../BackupSection';
import { api } from '../../lib/api';
import { useLang, useT } from '../../i18n';
import './BackupSettings.css';

interface Props {
  onRestored: () => void;
  onBackupStatus?: (s: BackupStatus) => void;
  /** 多用户模式（M6 P2-3，D-204）：普通用户只能导出 / 恢复自己的数据 */
  multi?: boolean;
  /** 当前账号是否管理员（multi 下才有意义） */
  isAdmin?: boolean;
}

/**
 * 设置 → 备份与恢复（F-SYS-03/04/05）
 *
 * - 本地模式：原样复用 BackupSection（导出三勾选 / 两阶段进度 / 恢复 / 提醒）。
 * - 多用户 + 管理员：全量备份 / 恢复（整库），多一段提示。
 * - 多用户 + 普通用户（P2-3，D-204；2026-11-07 D-210 增加恢复）：导出我的数据 + 从我的备份恢复
 *   （只含 / 只替换自己账号的数据；恢复前自动导出当前数据作为备份；秘密基地密码 / Key 不随导出恢复）。
 */
export default function BackupSettings({
  onRestored,
  onBackupStatus,
  multi = false,
  isAdmin = false,
}: Props) {
  const t = useT();
  const lang = useLang();
  const [includeThumbs, setIncludeThumbs] = useState(true);
  const [includeMedia, setIncludeMedia] = useState(false);
  const userOnly = multi && !isAdmin;

  // ── 备份目录（2026-11-11 D-364 用户要求，仅本地安装版）──
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const [backupDir, setBackupDir] = useState('');
  const [backupDirDefault, setBackupDirDefault] = useState('');
  const [dirBusy, setDirBusy] = useState<'pick' | 'save' | 'open' | null>(null);
  const [dirMsg, setDirMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPath, setManualPath] = useState('');

  const loadBackupDir = useCallback(async () => {
    try {
      const r = await api.backupDir();
      setBackupDir(r.dir);
      setBackupDirDefault(r.defaultDir);
      setManualPath(r.dir);
    } catch {
      /* 旧服务端 / 云端模式没有该接口：不显示此卡片 */
      setBackupDir('');
    }
  }, []);

  useEffect(() => {
    if (!multi) void loadBackupDir();
  }, [multi, loadBackupDir]);

  const doPickDir = async () => {
    if (dirBusy) return;
    setDirBusy('pick');
    setDirMsg(null);
    try {
      const r = await api.pickBackupDir();
      if (r.canceled) {
        setDirMsg({ ok: false, text: t('已取消选择') });
      } else if (r.dir) {
        setBackupDir(r.dir);
        setManualPath(r.dir);
        setDirMsg({ ok: true, text: t('已切换备份目录：{path}', { path: r.dir }) });
      }
    } catch (e: unknown) {
      setDirMsg({ ok: false, text: t('选择备份目录失败：') + errText(e) });
    } finally {
      setDirBusy(null);
    }
  };

  const doOpenDir = async () => {
    if (dirBusy) return;
    setDirBusy('open');
    setDirMsg(null);
    try {
      await api.openBackupDir();
    } catch (e: unknown) {
      setDirMsg({ ok: false, text: t('打开备份目录失败：') + errText(e) });
    } finally {
      setDirBusy(null);
    }
  };

  const saveDirPath = async (path: string) => {
    if (dirBusy) return;
    setDirBusy('save');
    setDirMsg(null);
    try {
      const r = await api.setBackupDirPath(path);
      if (r.dir) {
        setBackupDir(r.dir);
        setManualPath(r.dir);
        setManualOpen(false);
        setDirMsg({ ok: true, text: t('备份目录已保存：{path}', { path: r.dir }) });
      }
    } catch (e: unknown) {
      setDirMsg({ ok: false, text: t('保存备份目录失败：') + errText(e) });
    } finally {
      setDirBusy(null);
    }
  };

  // ── 从我的备份恢复（D-210）──
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreSummary, setRestoreSummary] = useState<UserRestoreSummary | null>(null);
  const [restoreToken, setRestoreToken] = useState<string | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const resetRestore = () => {
    setRestoreSummary(null);
    setRestoreToken(null);
    setRestoreMsg(null);
  };

  const doInspectRestore = async () => {
    if (!restoreFile || inspecting || restoring) return;
    setInspecting(true);
    resetRestore();
    try {
      const r = await api.inspectUserRestore(restoreFile);
      setRestoreSummary(r.summary);
      setRestoreToken(r.token);
    } catch (e: any) {
      setRestoreMsg({ ok: false, text: t('检查失败：') + (e?.message || String(e)) });
    } finally {
      setInspecting(false);
    }
  };

  const doApplyRestore = async () => {
    if (!restoreToken || inspecting || restoring) return;
    if (!window.confirm(t('恢复会替换当前账号的全部数据，确定继续？'))) return;
    setRestoring(true);
    setRestoreMsg(null);
    try {
      const r = await api.restoreUserBackup(restoreToken);
      setRestoreMsg({
        ok: true,
        text: t('已恢复 {places} 个地点 / {visits} 次到访 / {media} 个媒体；恢复前自动备份：{name}', {
          places: r.restored.places,
          visits: r.restored.visits,
          media: r.restored.media,
          name: r.autoBackup?.name ?? '—',
        }),
      });
      setRestoreFile(null);
      setRestoreSummary(null);
      setRestoreToken(null);
      onRestored();
    } catch (e: any) {
      setRestoreMsg({ ok: false, text: t('恢复失败：') + (e?.message || String(e)) });
    } finally {
      setRestoring(false);
    }
  };

  const restoreTimeText = restoreSummary?.exportedAtISO
    ? new Date(restoreSummary.exportedAtISO).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN')
    : '—';

  // 两条说明用显式 t() 调用（i18n-check 静态扫描需要字面量字符串）
  const adminDesc = t(
    '管理员备份包含服务器上所有账号的数据（可选缩略图 / 素材）。恢复会覆盖整个服务器的数据，请先确认。'
  );
  const localDesc = t(
    '备份只含应用数据（可选缩略图 / 照片视频素材）。恢复前会自动备份当前数据，中途失败会回滚；含素材的恢复只写入 / 覆盖备份里的文件，不删除素材库里的其它文件。'
  );

  return (
    <div className="set-pane">
      {/* 2026-11-06 用户要求：在「设置 → 备份」里说明数据流转 / 素材会变成两份 */}
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('素材与数据流转')}</h3>
        </div>
        <p className="set-section-desc">
          {t('从电脑本地选择照片 / 视频上传时，应用会把原件复制一份到素材库 B，并按「省 / 市 / 区县 / 日期_地点名」的文件夹结构存放（例如 浙江省/杭州市/西湖区/2024-03-10_西湖/），方便在资源管理器里按地区和日期翻看。')}
        </p>
        <p className="set-section-desc">
          {t('上传时你电脑上的原始文件不会被移动或修改，素材库会另存一份副本，上传前请确认磁盘空间足够。备份 / 恢复只涉及应用数据和素材库里的副本。')}
        </p>
      </section>

      {/* ── 备份目录（2026-11-11 D-364；仅本地安装版）── */}
      {!multi && backupDir && (
        <section className="set-section">
          <div className="set-section-head">
            <h3 className="set-section-title">{t('备份目录')}</h3>
          </div>
          <p className="set-section-desc">
            {t('恢复前自动备份（pre-restore 包）会存到这个目录；想换到空间更大的磁盘（比如移动硬盘）就在这里选择。只影响以后生成的备份，不移动已有文件。')}
          </p>
          <div className="bk-dir-row">
            <span className="bk-dir-path mono" title={backupDir}>
              {backupDir}
            </span>
            <button type="button" className="ghost" onClick={() => void doPickDir()} disabled={dirBusy !== null}>
              {dirBusy === 'pick' ? t('正在选择…') : t('选择备份目录')}
            </button>
            <button type="button" className="ghost" onClick={() => void doOpenDir()} disabled={dirBusy !== null}>
              {dirBusy === 'open' ? t('正在打开…') : t('打开备份目录')}
            </button>
          </div>
          {manualOpen && (
            <div className="bk-dir-row">
              <input
                className="bk-file"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                placeholder={t('输入备份目录绝对路径')}
                spellCheck={false}
              />
              <button
                type="button"
                className="primary"
                onClick={() => void saveDirPath(manualPath)}
                disabled={dirBusy !== null || !manualPath.trim()}
              >
                {dirBusy === 'save' ? t('保存中…') : t('保存路径')}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setManualOpen(false);
                  setManualPath(backupDir);
                  setDirMsg(null);
                }}
                disabled={dirBusy !== null}
              >
                {t('取消')}
              </button>
            </div>
          )}
          <div className="row bk-dir-actions">
            <button
              type="button"
              className="ghost tiny"
              onClick={() => {
                setManualOpen((v) => !v);
                setManualPath(backupDir);
              }}
            >
              {manualOpen ? t('收起手动输入') : t('手动输入路径')}
            </button>
            {backupDir !== backupDirDefault && (
              <button
                type="button"
                className="ghost tiny"
                onClick={() => void saveDirPath(backupDirDefault)}
                disabled={dirBusy !== null}
              >
                {t('恢复默认目录')}
              </button>
            )}
          </div>
          {dirMsg && (
            <p className={dirMsg.ok ? 'hint acc-ok' : 'hint err'} style={{ marginTop: 8 }}>
              {dirMsg.text}
            </p>
          )}
          <p className="hint">
            {t('提示：备份目录可以放在 U 盘 / 移动硬盘等其它盘，但请确保该目录可写。仅本地安装版可修改，云端版不显示此项。')}
          </p>
        </section>
      )}

      {userOnly ? (
        // 2026-11-07（D-217）：普通用户的导出 / 恢复也改成和「本地 / 管理员备份」一致的卡片样式
        // （.bk-card / .bk-check / .bk-file / .bk-summary，复用 BackupSection.css 的备份卡片体系）。
        <div className="backup-section">
          {/* ── 导出我的数据 ── */}
          <div className="bk-card">
            <div className="bk-card-head">
              <span className="bk-card-title">{t('导出我的数据')}</span>
              <span className="bk-muted">{t('备份包：应用数据 + 缩略图 + 可选素材')}</span>
            </div>
            <p className="set-section-desc" style={{ marginTop: 0 }}>
              {t('导出只包含你自己的账号数据（地点 / 到访 / 笔记 / 媒体记录，可选缩略图，可选照片视频文件），不会包含其他账号的数据。这个备份可以在下面「从我的备份恢复」里恢复回你自己的账号。')}
            </p>
            {/* 用户反馈：元数据固定包含、不可取消；补一行「元数据（必选）」和本地 / 管理员界面一致 */}
            <label className="bk-check bk-check-fixed">
              <input type="checkbox" checked readOnly disabled onChange={() => undefined} />
              <span>
                {t('应用数据（必选）')}
                <small>{t('地点 / 到访 / 笔记 / 评分 / 回收站，备份的核心数据')}</small>
              </span>
            </label>
            <label className="bk-check">
              <input
                type="checkbox"
                checked={includeThumbs}
                onChange={(e) => setIncludeThumbs(e.target.checked)}
              />
              <span>{t('包含缩略图 / 预览（推荐，体积小）')}</span>
            </label>
            <label className="bk-check">
              <input
                type="checkbox"
                checked={includeMedia}
                onChange={(e) => setIncludeMedia(e.target.checked)}
              />
              <span>{t('包含照片 / 视频文件（体积可能很大）')}</span>
            </label>
            <a
              className="primary full user-export-btn"
              href={api.userExportUrl({ thumbs: includeThumbs, media: includeMedia })}
            >
              {t('下载导出包')}
            </a>
            <p className="hint">
              {t('文件包含应用数据、说明文件，以及可选的缩略图与素材；素材多时打包会久一点。')}
            </p>
          </div>

          {/* ── 从我的备份恢复 ── */}
          <div className="bk-card">
            <div className="bk-card-head">
              <span className="bk-card-title">{t('从我的备份恢复')}</span>
              <span className="bk-muted">{t('选择备份文件')}</span>
            </div>
            <p className="set-section-desc" style={{ marginTop: 0 }}>
              {t('选择你之前用「导出我的数据」下载的备份文件，检查通过后可以把地点 / 到访 / 照片视频记录恢复回当前账号。恢复会替换当前账号的全部数据（其他账号不受影响）；恢复前会自动导出当前数据作为备份。秘密基地密码和天地图 Key 不随导出恢复，需要的话恢复后请重新设置。')}
            </p>

            <input
              className="bk-file"
              type="file"
              accept=".zip,application/zip"
              disabled={inspecting || restoring}
              onChange={(e) => {
                setRestoreFile(e.target.files?.[0] ?? null);
                resetRestore();
              }}
            />

            <div className="row bk-inspect-row">
              <button
                type="button"
                className="primary"
                onClick={() => void doInspectRestore()}
                disabled={!restoreFile || inspecting || restoring}
              >
                {inspecting ? t('正在检查…') : t('开始检查备份包')}
              </button>
              {restoreFile && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setRestoreFile(null);
                    resetRestore();
                  }}
                  disabled={inspecting || restoring}
                >
                  {t('取消选择')}
                </button>
              )}
            </div>

            {restoreFile && (
              <p className="hint">{t('已选择：{name}', { name: restoreFile.name })}</p>
            )}

            {restoreSummary && (
              <div className="bk-summary">
                <div className="bk-summary-title">{t('备份包内容')}</div>
                <div className="bk-line">
                  <span className="bk-label">{t('账号')}</span>
                  <span className="bk-value">{`${restoreSummary.displayName}（@${restoreSummary.username}）`}</span>
                </div>
                <div className="bk-line">
                  <span className="bk-label">{t('导出时间')}</span>
                  <span className="bk-value">{restoreTimeText}</span>
                </div>
                <div className="bk-line">
                  <span className="bk-label">{t('数据量')}</span>
                  <span className="bk-value">
                    {t('{places} 个地点 · {visits} 次到访 · {media} 张照片/视频', {
                      places: restoreSummary.counts.places,
                      visits: restoreSummary.counts.visits,
                      media: restoreSummary.counts.media,
                    })}
                  </span>
                </div>
                <div className="bk-line">
                  <span className="bk-label">{t('缩略图')}</span>
                  <span className="bk-value">
                    {restoreSummary.includes.thumbs
                      ? t('包含 {n} 张', { n: restoreSummary.filesInZip.thumbs })
                      : t('不含（恢复后按素材库重建）')}
                  </span>
                </div>
                <div className="bk-line">
                  <span className="bk-label">{t('素材')}</span>
                  <span className={restoreSummary.missingMedia > 0 ? 'bk-value bk-warn' : 'bk-value'}>
                    {restoreSummary.includes.media
                      ? t('包含 {n} 个文件', { n: restoreSummary.filesInZip.media })
                      : t('不含（只恢复记录）')}
                    {restoreSummary.missingMedia > 0
                      ? ' · ' + t('缺 {n} 个素材文件', { n: restoreSummary.missingMedia })
                      : ''}
                  </span>
                </div>
                {restoreSummary.homeSet && (
                  <div className="bk-line">
                    <span className="bk-label">{t('家')}</span>
                    <span className="bk-value">{t('包含「家」设置（恢复后会跟着回来）')}</span>
                  </div>
                )}
                {(restoreSummary.secretConfigured || restoreSummary.tdtKeyConfigured) && (
                  <p className="hint">{t('秘密基地密码 / 天地图 Key 不随导出恢复，需要的话请在设置里重新填写。')}</p>
                )}
                {restoreSummary.warnings.map((w, i) => (
                  <p className="hint" key={i}>
                    {w}
                  </p>
                ))}
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void doApplyRestore()}
                    disabled={restoring}
                  >
                    {restoring ? t('恢复中…') : t('确认恢复（覆盖当前账号数据）')}
                  </button>
                </div>
              </div>
            )}

            {restoreMsg && (
              <p className={restoreMsg.ok ? 'hint acc-ok' : 'hint err'} style={{ marginTop: 10 }}>
                {restoreMsg.text}
              </p>
            )}

            <p className="hint" style={{ marginTop: 8 }}>
              {t('恢复只替换你自己的账号数据；其他账号不受影响。恢复前会自动备份当前数据，恢复后如需回退可以用它再恢复一次。')}
            </p>
          </div>
        </div>
      ) : (
        <>
          <section className="set-section">
            <div className="set-section-head">
              <h3 className="set-section-title">{t('备份与恢复')}</h3>
            </div>
            <p className="set-section-desc">{multi ? adminDesc : localDesc}</p>
          </section>
          <BackupSection onRestored={onRestored} onStatus={onBackupStatus} />
        </>
      )}
    </div>
  );
}
