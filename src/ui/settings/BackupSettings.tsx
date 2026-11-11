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

  // 说明文案用显式 t() 调用（i18n-check 静态扫描需要字面量字符串）
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
          {t('从电脑本地选择照片 / 视频上传时，应用会把原件复制一份到素材库 B，并按「省 / 市 / 区县 / 日期_地点名」的文件夹结构存放（例如 浙江省/杭州市/西湖区/2024-03-10_西湖/），方便在文件管理器里按地区和日期翻看。')}
        </p>
        <p className="set-section-desc">
          {t('上传时你电脑上的原始文件不会被移动或修改，素材库会另存一份副本，上传前请确认磁盘空间足够。备份 / 恢复只涉及应用数据和素材库里的副本。')}
        </p>
      </section>

      {/* ── 备份目录（2026-11-11 D-364；本地模式）── */}
      {backupDir && (
        <section className="set-section">
          <div className="set-section-head">
            <h3 className="set-section-title">{t('备份目录')}</h3>
          </div>
          <p className="set-section-desc">
            {t('恢复前自动备份（pre-restore 包）与手动导出的备份包都会存到这个目录；想换到空间更大的磁盘（比如移动硬盘）就在这里选择。只影响以后生成的备份，不移动已有文件。')}
          </p>
          {/* 2026-11-11 用户拍板：本地手动导出只落备份目录（不再走浏览器下载） */}
          <p className="set-section-desc">
            {t('手动导出的备份包直接保存在这里（不经过浏览器下载）。')}
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
            {t('提示：备份目录可以放在 U 盘 / 移动硬盘等其它盘，但请确保该目录可写。')}
          </p>
        </section>
      )}

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('备份与恢复')}</h3>
        </div>
        <p className="set-section-desc">{localDesc}</p>
      </section>
      <BackupSection
        onRestored={onRestored}
        onStatus={onBackupStatus}
        backupDir={backupDir}
      />
    </div>
  );
}
