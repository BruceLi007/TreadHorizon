import { useCallback, useEffect, useState } from 'react';
import type { BackupStatus } from '../../lib/types';
import BackupSection from '../BackupSection';
import { api } from '../../lib/api';
import { useT } from '../../i18n';
import './BackupSettings.css';

interface Props {
  onRestored: () => void;
  onBackupStatus?: (s: BackupStatus) => void;
}

/**
 * 设置 → 备份与恢复（F-SYS-03/04/05）
 *
 * 2026-11-11 用户拍板（v1.1.0 修订）：云端（multi，含管理员）不再显示本分类
 * （SettingsModal 里 `backupTabVisible = !multi` 过滤）—— 云端数据备份由管理员在服务器侧完成，
 * 普通用户改为 设置 → 账号 →「下载我的数据」。
 * 因此本组件只服务**本地模式**：备份目录 + BackupSection（导出到备份目录 / 恢复 / 提醒）。
 */
export default function BackupSettings({ onRestored, onBackupStatus }: Props) {
  const t = useT();

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
    void loadBackupDir();
  }, [loadBackupDir]);

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

  return (
    <div className="set-pane">
      {/* ── 备份目录（2026-11-11 D-364；本地模式）── */}
      {backupDir && (
        <section className="set-section">
          <div className="set-section-head">
            <h3 className="set-section-title">{t('备份目录')}</h3>
          </div>
          <div className="bk-dir-row">
            <span className="bk-dir-path mono" title={backupDir}>
              {backupDir}
            </span>
            <button type="button" className="ghost" onClick={() => void doPickDir()} disabled={dirBusy !== null}>
              {dirBusy === 'pick' ? t('正在选择…') : t('选择备份目录')}
            </button>
            <button
              type="button"
              className="ghost bk-open-dir"
              onClick={() => void doOpenDir()}
              disabled={dirBusy !== null}
            >
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
            {t('提示：备份目录可以放在 U 盘 / 移动硬盘等其它盘，但请确保该目录可写。')}
          </p>
        </section>
      )}

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('备份与恢复')}</h3>
        </div>
      </section>
      <BackupSection
        onRestored={onRestored}
        onStatus={onBackupStatus}
        backupDir={backupDir}
      />
    </div>
  );
}
