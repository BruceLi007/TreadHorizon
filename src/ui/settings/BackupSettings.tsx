import { useCallback, useEffect, useState } from 'react';
import type { BackupStatus } from '../../lib/types';
import BackupSection from '../BackupSection';
import { api } from '../../lib/api';
import { useT } from '../../i18n';
import './BackupSettings.css';

interface Props {
  onRestored: () => void;
  onBackupStatus?: (s: BackupStatus) => void;
  /** 多用户模式（M6 P2-3，D-204）：multi 下本分类只对管理员显示 */
  multi?: boolean;
  /** 当前账号是否管理员（multi 下才有意义；仅用于说明文案分流） */
  isAdmin?: boolean;
}

/**
 * 设置 → 备份与恢复（F-SYS-03/04/05）
 *
 * - 本地模式：原样复用 BackupSection（导出三勾选 / 两阶段进度 / 恢复 / 提醒）。
 * - 多用户 + 管理员：全量备份 / 恢复（整库），多一段提示。
 * - 多用户 + 普通用户：**不再显示本分类**（2026-11-11 D-369 用户要求「云端用户侧的备份功能整体取消，
 *   改为从云端下载到本地」）——普通用户改为 设置 → 账号 →「下载我的数据」，只有导出 / 下载、没有恢复；
 *   该入口在 SettingsModal 里过滤掉本分类，本组件因此只服务 本地 / 云端管理员。
 */
export default function BackupSettings({
  onRestored,
  onBackupStatus,
  multi = false,
}: Props) {
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

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('备份与恢复')}</h3>
        </div>
        <p className="set-section-desc">{multi ? adminDesc : localDesc}</p>
      </section>
      <BackupSection onRestored={onRestored} onStatus={onBackupStatus} />
    </div>
  );
}
