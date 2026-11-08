import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { api } from '../lib/api';
import { tr, useT } from '../i18n';
import type {
  BackupExportJobStatus,
  BackupInspectResult,
  BackupRestoreResult,
  BackupStatus,
} from '../lib/types';
import './BackupSection.css';

interface Props {
  /** 恢复成功后由设置页转交给 App 做全量刷新（F-SYS-04） */
  onRestored: () => void;
  /** 状态变化（导出 / 稍后提醒 / 改阈值后）同步给 App，顶栏红点即时更新 */
  onStatus?: (s: BackupStatus) => void;
}

/** 允许的提醒阈值（天），与后端 /api/backup/settings 白名单一致 */
const THRESHOLD_CHOICES = [7, 14, 30, 60, 90];

const pad2 = (n: number) => String(n).padStart(2, '0');

const fmtBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

/** 2026/11/03 20:25（本地时区；毫秒时间戳来自后端） */
const fmtDateTime = (ms: number | null | undefined): string => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
};

const daysText = (days: number | null | undefined): string => {
  if (days == null || !Number.isFinite(days)) return tr('未知');
  if (days <= 0) return tr('今天');
  return tr('{n} 天前', { n: days });
};

/** 后端字段缺失时也保证数组/计数可用，避免设置页整块崩掉（正常后端都会返回完整字段） */
const normalizeStatus = (s: BackupStatus | null): BackupStatus => ({
  lastBackupAt: s?.lastBackupAt ?? null,
  lastBackupAtISO: s?.lastBackupAtISO ?? null,
  daysSinceBackup: s?.daysSinceBackup ?? null,
  thresholdDays: s?.thresholdDays ?? 30,
  snoozeUntil: s?.snoozeUntil ?? null,
  due: s?.due === true,
  reason: s?.reason ?? null,
  dataCounts: s?.dataCounts ?? { places: 0, visits: 0, media: 0 },
  mediaBytes: s?.mediaBytes ?? 0,
  mediaFiles: s?.mediaFiles ?? 0,
  autoBackupDir: s?.autoBackupDir ?? 'data/backups',
  recentAutoBackups: s?.recentAutoBackups ?? [],
});

/** 把后端/网络错误翻成人话，尤其照顾「后端还没起来」和「接口 404」两种情况 */
const errText = (e: unknown): string => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) {
    return tr('无法连接后端服务（确认 npm run dev 正在运行）');
  }
  if (/^not found$/i.test(msg)) {
    return tr('后端还没有备份接口（HTTP 404），请重启服务或更新到 M4 版本后再试');
  }
  return msg || tr('未知错误');
};

/**
 * 触发浏览器原生下载：只给 URL，绝不把 zip 读进 Blob/内存
 * （含素材的备份可能 1.6GB，XHR/fetch 会直接爆内存）。
 * 文件名由服务端 content-disposition 决定，这里交给隐藏 <a download> 处理。
 */
function triggerDownload(jobId: string) {
  const a = document.createElement('a');
  a.href = api.backupDownloadUrl(jobId);
  a.setAttribute('download', '');
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 设置页「备份」区块（F-SYS-03/04/05，v2 含素材）。
 * - 常驻：上次备份 / 提醒阈值 / 当前数据量 / due 提醒 + 稍后 24h
 * - 导出：三块可选（元数据必选 / 缩略图默认勾 / 素材默认不勾）；
 *   两阶段任务：start → 500ms 轮询进度（可取消）→ done 后浏览器原生下载，不读进内存
 * - 恢复：选 zip → inspect 摘要（含素材信息）→ 红色二次确认 → restore；
 *   含素材时写入当前素材库但绝不删除其它文件；成功后 onRestored() 全量刷新
 * 后端没起来 / 接口 404 时各区块就地报错，不崩页面。
 */
export default function BackupSection({ onRestored, onStatus }: Props) {
  const t = useT();
  // ── 备份状态（F-SYS-05 + v2 素材体积）──
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [reminderMsg, setReminderMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // ── 两阶段导出（F-SYS-03 v2）──
  const [includeThumbs, setIncludeThumbs] = useState(true);
  const [includeMedia, setIncludeMedia] = useState(false);
  const [exportStarting, setExportStarting] = useState(false);
  const [exportCanceling, setExportCanceling] = useState(false);
  const [exportJob, setExportJob] = useState<BackupExportJobStatus | null>(null);
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** 已触发过下载的 jobId：轮询 done 后只触发一次原生下载 */
  const downloadedJob = useRef<string | null>(null);

  /** 导出进行中（打包中）：与恢复互斥；done/error/canceled 后解除 */
  const exporting = exportStarting || exportJob?.state === 'building';

  // ── 恢复（F-SYS-04）──
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectErr, setInspectErr] = useState<string | null>(null);
  const [inspected, setInspected] = useState<BackupInspectResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [restoreResult, setRestoreResult] = useState<BackupRestoreResult | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const s = normalizeStatus(await api.backupStatus());
      setStatus(s);
      setStatusErr(null);
      onStatus?.(s);
    } catch (e: unknown) {
      setStatus(null);
      setStatusErr(errText(e));
    } finally {
      setStatusLoading(false);
    }
  }, [onStatus]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // ── 两阶段导出轮询（500ms）：building → done 时触发浏览器原生下载 ──
  useEffect(() => {
    const jobId = exportJob?.jobId;
    if (!jobId || exportJob?.state !== 'building') return;
    let alive = true;
    let timer: number | null = null;

    const tick = async () => {
      try {
        const s = await api.exportStatus(jobId);
        if (!alive) return;
        setExportJob(s);
        if (s.state === 'done') {
          // 只触发一次下载；文件名由服务端 content-disposition 决定
          if (downloadedJob.current !== jobId) {
            downloadedJob.current = jobId;
            triggerDownload(jobId);
          }
          setExportMsg({
            ok: true,
            text: tr('导出完成：备份包大小 {size}；文件名为「My旅迹素材备份-YYYY-MM-DD-（备份勿删）.zip」', {
              size: fmtBytes(s.zipBytes),
            }),
          });
          void loadStatus();
          return;
        }
        if (s.state === 'error') {
          setExportMsg({
            ok: false,
            text: tr('导出失败：') + (s.error || tr('没有返回原因')),
          });
          void loadStatus();
          return;
        }
        if (s.state === 'canceled') {
          setExportMsg({ ok: false, text: tr('导出已取消') });
          void loadStatus();
          return;
        }
        timer = window.setTimeout(tick, 500);
      } catch (e: unknown) {
        if (!alive) return;
        setExportMsg({ ok: false, text: tr('读取导出进度失败：') + errText(e) });
        // 停止轮询；服务端任务会按 TTL 自行清理，重新点导出即可
        setExportJob(null);
      }
    };

    timer = window.setTimeout(tick, 500);
    return () => {
      alive = false;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [exportJob?.jobId, exportJob?.state, loadStatus]);

  // ── 提醒阈值 / 稍后提醒 ──
  const doSnooze = async () => {
    if (snoozing) return;
    setSnoozing(true);
    setReminderMsg(null);
    try {
      const s = normalizeStatus(await api.snoozeBackup(1));
      setStatus(s);
      onStatus?.(s);
      setReminderMsg({ ok: true, text: t('已稍后提醒：24 小时内不再提示') });
    } catch (e: unknown) {
      setReminderMsg({ ok: false, text: t('稍后提醒失败：') + errText(e) });
    } finally {
      setSnoozing(false);
    }
  };

  const saveThreshold = async (days: number) => {
    if (settingsBusy || days === status?.thresholdDays) return;
    setSettingsBusy(true);
    setReminderMsg(null);
    try {
      const s = normalizeStatus(await api.updateBackupSettings(days));
      setStatus(s);
      onStatus?.(s);
      setReminderMsg({ ok: true, text: t('提醒阈值已改为 {n} 天', { n: s.thresholdDays }) });
    } catch (e: unknown) {
      setReminderMsg({ ok: false, text: t('修改提醒阈值失败：') + errText(e) });
    } finally {
      setSettingsBusy(false);
    }
  };

  // ── 两阶段导出：start → 轮询 → 原生下载 ──
  const doExport = async () => {
    if (exporting || restoring) return;
    setExportStarting(true);
    setExportMsg(null);
    setExportJob(null);
    try {
      const start = await api.startBackupExport({ includeThumbs, includeMedia });
      setExportJob({
        jobId: start.jobId,
        state: 'building',
        filesDone: 0,
        filesTotal: start.filesTotal,
        bytesDone: 0,
        bytesTotal: start.bytesTotal,
        zipBytes: 0,
        error: null,
        createdAt: start.createdAt,
      });
    } catch (e: unknown) {
      setExportMsg({ ok: false, text: t('开始导出失败：') + errText(e) });
    } finally {
      setExportStarting(false);
    }
  };

  /** 取消 building 中的两阶段导出（DELETE 会清理服务端临时 zip） */
  const cancelExport = async () => {
    const jobId = exportJob?.jobId;
    if (!jobId || exportJob?.state !== 'building' || exportCanceling) return;
    setExportCanceling(true);
    try {
      await api.cancelBackupExport(jobId);
      setExportJob(null);
      setExportMsg({ ok: false, text: t('导出已取消（临时文件已清理）') });
    } catch (e: unknown) {
      setExportMsg({ ok: false, text: t('取消导出失败：') + errText(e) });
    } finally {
      setExportCanceling(false);
    }
  };

  const resetFile = () => {
    setFileName('');
    setInspected(null);
    setInspecting(false);
    setInspectErr(null);
    setConfirming(false);
    setRestoreMsg(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  // ── 从备份恢复：先选文件；点「开始检查备份包」才真正上传/校验（用户要求，避免一选文件就后台跑）──
  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setInspected(null);
    setInspectErr(null);
    setConfirming(false);
    setRestoreMsg(null);
    setRestoreResult(null);
  };

  /** 点击按钮后才开始校验（inspect） */
  const doInspect = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || inspecting || restoring || exporting) return;
    setInspected(null);
    setInspectErr(null);
    setConfirming(false);
    setRestoreMsg(null);
    setRestoreResult(null);
    setInspecting(true);
    try {
      const r = await api.inspectBackup(file);
      setInspected(r);
    } catch (err: unknown) {
      setInspectErr(t('校验失败：') + errText(err));
    } finally {
      setInspecting(false);
    }
  };

  // ── 确认恢复（已再点一次确认）──
  const doRestore = async () => {
    const token = inspected?.token;
    if (!token || restoring || exporting) return;
    setRestoring(true);
    setRestoreMsg(null);
    setRestoreResult(null);
    try {
      const r = await api.restoreBackup(token);
      setRestoreResult(r);
      setRestoreMsg(null);
      resetFile();
      void loadStatus();
      onRestored();
    } catch (e: any) {
      const rolled = e?.rolledBack === true;
      const raw = errText(e);
      setRestoreMsg({
        ok: false,
        text: rolled && !raw.includes('回滚') ? raw + t('（已回滚，当前数据未被修改）') : raw,
      });
    } finally {
      setRestoring(false);
    }
  };

  /** 导出进度百分比：优先按字节（bytesTotal 是未压缩预估），没有体积时按文件数 */
  const exportPct = exportJob
    ? exportJob.bytesTotal > 0
      ? Math.min(100, Math.round((exportJob.bytesDone / exportJob.bytesTotal) * 100))
      : exportJob.filesTotal > 0
        ? Math.min(100, Math.round((exportJob.filesDone / exportJob.filesTotal) * 100))
        : 0
    : 0;

  const summary = inspected?.summary ?? null;

  return (
    <div className="backup-section">
      {/* ── 状态 + 提醒（F-SYS-05） ── */}
      <div className="bk-card">
        {statusLoading && !status ? (
          <p className="hint">{t('读取备份状态…')}</p>
        ) : statusErr ? (
          <>
            <p className="hint err">
              {t('读取备份状态失败：')}
              {statusErr}
            </p>
            <button className="ghost full" onClick={() => void loadStatus()}>
              {t('重试')}
            </button>
          </>
        ) : status ? (
          <>
            <div className="bk-line">
              <span className="bk-label">{t('上次备份')}</span>
              <span className={status.due ? 'bk-value bk-due' : 'bk-value'}>
                {status.lastBackupAt == null
                  ? t('从未备份')
                  : `${fmtDateTime(status.lastBackupAt)} · ${daysText(status.daysSinceBackup)}`}
              </span>
            </div>

            <div className="bk-line">
              <span className="bk-label">{t('提醒阈值')}</span>
              <span className="bk-value bk-inline">
                <select
                  className="bk-select"
                  aria-label={t('备份提醒阈值（天）')}
                  value={status.thresholdDays}
                  disabled={settingsBusy}
                  onChange={(e) => void saveThreshold(Number(e.target.value))}
                >
                  {THRESHOLD_CHOICES.map((d) => (
                    <option key={d} value={d}>
                      {t('{n} 天', { n: d })}
                    </option>
                  ))}
                </select>
                <span className="bk-muted">{t('超过这么久没备份就提醒')}</span>
              </span>
            </div>

            <div className="bk-line">
              <span className="bk-label">{t('当前数据')}</span>
              <span className="bk-value">
                {t('{places} 个地点 · {visits} 次到访 · {media} 张照片/视频', {
                  places: status.dataCounts.places,
                  visits: status.dataCounts.visits,
                  media: status.dataCounts.media,
                })}
                {status.dataCounts.places > 0 ? '' : t('（空库不会提醒备份）')}
              </span>
            </div>

            {status.due && (
              <div className="bk-due-row">
                <span>
                  {status.reason === 'never'
                    ? t('还没有备份过：照片视频只有一份，数据丢了就找不回来，建议现在导出一份。')
                    : t('已经 {days}没备份（阈值 {days2} 天），建议现在导出一份。', {
                        days: daysText(status.daysSinceBackup),
                        days2: status.thresholdDays,
                      })}
                </span>
                <button
                  className="ghost bk-snooze"
                  onClick={() => void doSnooze()}
                  disabled={snoozing}
                >
                  {snoozing ? t('稍后…') : t('稍后提醒（24 小时）')}
                </button>
              </div>
            )}

            {status.recentAutoBackups.length > 0 && (
              <p className="hint bk-hint">
                {t('最近自动备份：{name}（{size}）', {
                  name: status.recentAutoBackups[0].name,
                  size: fmtBytes(status.recentAutoBackups[0].bytes),
                  dir: status.autoBackupDir,
                })}
              </p>
            )}
          </>
        ) : (
          <p className="hint">{t('读取备份状态失败。')}</p>
        )}

        {reminderMsg && (
          <p className={reminderMsg.ok ? 'hint bk-ok' : 'hint err'}>{reminderMsg.text}</p>
        )}
      </div>

      {/* ── 两阶段导出（F-SYS-03 v2） ── */}
      <div className="bk-card">
        <div className="bk-card-head">
          <span className="bk-card-title">{t('导出备份')}</span>
          <span className="bk-muted">{t('备份包：应用数据 + 缩略图 + 可选素材')}</span>
        </div>

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
            disabled={exporting}
            onChange={(e) => setIncludeThumbs(e.target.checked)}
          />
          <span>
            {t('缩略图 / 预览缓存')}
            <small>{t('默认包含；体积小，也可由素材库重建')}</small>
          </span>
        </label>

        <label className="bk-check">
          <input
            type="checkbox"
            checked={includeMedia}
            disabled={exporting}
            onChange={(e) => setIncludeMedia(e.target.checked)}
          />
          <span>
            {t('照片 / 视频素材')}
            <small>
              {status
                ? t('当前引用 {n} 个文件，约 {size}', {
                    n: status.mediaFiles,
                    size: fmtBytes(status.mediaBytes),
                  })
                : t('读取素材体积…')}
              {includeMedia
                ? t('；会显著增大备份体积与打包时间，恢复时会写入当前素材库')
                : t('；默认不打包，恢复后需自己拷素材库')}
            </small>
          </span>
        </label>

        {includeMedia && (
          <p className="bk-media-warn">
            {t('含素材的备份会大很多：1.6GB 素材大约需要几分钟；恢复时会把素材写回当前素材库，同名同内容跳过、同名不同内容覆盖，不会删除其它文件。')}
          </p>
        )}

        <button
          className="primary full"
          onClick={() => void doExport()}
          disabled={exporting || restoring}
        >
          {exportStarting
            ? t('正在准备…')
            : exportJob?.state === 'building'
              ? t('正在打包…')
              : restoring
                ? t('恢复中，暂不能导出')
                : t('导出备份')}
        </button>

        {exporting && exportJob?.state === 'building' && (
          <div className="bk-progress-row">
            <div
              className="bk-progress"
              role="progressbar"
              aria-label={t('备份打包进度')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={exportPct}
            >
              <div className="bk-progress-bar">
                <div
                  className="bk-progress-fill"
                  style={{ width: `${Math.max(2, exportPct)}%` }}
                />
              </div>
              <div className="bk-progress-text">
                {t('正在打包… {pct}%（{done} / {total} · 文件 {filesDone}/{filesTotal}）', {
                  pct: exportPct,
                  done: fmtBytes(exportJob.bytesDone),
                  total: fmtBytes(exportJob.bytesTotal),
                  filesDone: exportJob.filesDone,
                  filesTotal: exportJob.filesTotal,
                })}
              </div>
            </div>
            <button
              className="ghost bk-cancel"
              onClick={() => void cancelExport()}
              disabled={exportCanceling}
            >
              {exportCanceling ? t('取消中…') : t('取消')}
            </button>
          </div>
        )}

        {exportStarting && <p className="hint">{t('正在准备导出…')}</p>}

        {exportMsg && <p className={exportMsg.ok ? 'hint bk-ok' : 'hint err'}>{exportMsg.text}</p>}

        {exportJob?.state === 'done' && (
          <p className="hint">
            {t('如果浏览器没有自动开始下载，可')}
            <a
              className="bk-download"
              href={api.backupDownloadUrl(exportJob.jobId)}
              download
            >
              {t('点这里重新下载')}
            </a>
            {t('（10 分钟内可以重新下载）。')}
          </p>
        )}

        <p className="hint">
          {t('备份不会动你电脑上的原始文件。含素材时会逐个打包素材文件；恢复只写入 / 覆盖备份里的文件，不会删除素材库里的其它文件。')}
        </p>
      </div>

      {/* ── 从备份恢复（F-SYS-04） ── */}
      <div className="bk-card">
        <div className="bk-card-head">
          <span className="bk-card-title">{t('从备份恢复')}</span>
          <span className="bk-muted">{t('选择备份文件')}</span>
        </div>

        <input
          ref={fileRef}
          className="bk-file"
          type="file"
          accept=".zip,application/zip"
          aria-label={t('选择备份文件')}
          disabled={inspecting || restoring || exporting}
          onChange={onPickFile}
        />

        <div className="row bk-inspect-row">
          <button
            type="button"
            className="primary"
            onClick={() => void doInspect()}
            disabled={!fileName || inspecting || restoring || exporting}
          >
            {inspecting ? t('正在检查…') : t('开始检查备份包')}
          </button>
          {fileName && (
            <button
              type="button"
              className="ghost"
              onClick={resetFile}
              disabled={inspecting || restoring || exporting}
            >
              {t('取消选择')}
            </button>
          )}
        </div>

        {exporting && (
          <p className="hint">{t('导出进行中：完成后再从备份恢复（避免导出和恢复抢资源）。')}</p>
        )}
        {fileName && (
          <p className="hint">
            {t('已选择：{name}', { name: fileName })}
            {!inspected && !inspecting
              ? t('（点「开始检查备份包」才会读取/校验，不会立刻改数据）')
              : ''}
          </p>
        )}
        {inspecting && <p className="hint">{t('正在校验备份包…（大文件可能要等一会儿）')}</p>}
        {inspectErr && <p className="hint err">{inspectErr}</p>}

        {summary && (
          <div className="bk-summary">
            <div className="bk-summary-title">{t('备份包内容')}</div>
            <div className="bk-line">
              <span className="bk-label">{t('备份时间')}</span>
              <span className="bk-value">
                {fmtDateTime(summary.createdAt)}
                {summary.appVersion ? t(' · 版本 {v}', { v: summary.appVersion }) : ''}
              </span>
            </div>
            <div className="bk-line">
              <span className="bk-label">{t('数据量')}</span>
              <span className="bk-value">
                {t('{places} 个地点 · {visits} 次到访 · {media} 张照片/视频', {
                  places: summary.aliveCounts.place,
                  visits: summary.aliveCounts.visit,
                  media: summary.aliveCounts.media,
                })}
                {summary.counts.place !== summary.aliveCounts.place ||
                summary.counts.visit !== summary.aliveCounts.visit ||
                summary.counts.media !== summary.aliveCounts.media
                  ? t('（含回收站共 {places}/{visits}/{media}）', {
                      places: summary.counts.place,
                      visits: summary.counts.visit,
                      media: summary.counts.media,
                    })
                  : ''}
              </span>
            </div>
            <div className="bk-line">
              <span className="bk-label">{t('缩略图')}</span>
              <span className="bk-value">
                {summary.includeThumbs
                  ? t('包含 {n} 张', { n: summary.thumbsCount })
                  : t('不含（恢复后按素材库重建）')}
              </span>
            </div>
            <div className="bk-line">
              <span className="bk-label">{t('素材')}</span>
              <span
                className={
                  summary.includeMedia && summary.mediaMissingAtExport > 0
                    ? 'bk-value bk-warn'
                    : 'bk-value'
                }
              >
                {summary.includeMedia
                  ? t('{n} 个文件 / {size}', {
                      n: summary.mediaCount,
                      size: fmtBytes(summary.mediaBytes),
                    })
                  : t('不含素材（只恢复记录）')}
                {summary.includeMedia && summary.mediaMissingAtExport > 0
                  ? t(' · 导出时缺失 {n} 个', { n: summary.mediaMissingAtExport })
                  : ''}
              </span>
            </div>
            <div className="bk-line">
              <span className="bk-label">{t('秘密基地')}</span>
              <span className="bk-value">
                {summary.secretConfigured
                  ? t('包含密码（恢复后沿用备份里的密码）')
                  : t('未设置密码（恢复后会清除当前密码）')}
              </span>
            </div>
            <div className="bk-line">
              <span className="bk-label">{t('素材库')}</span>
              <span className={summary.mediaMissing > 0 ? 'bk-value bk-warn' : 'bk-value'}>
                {summary.mediaMissing > 0
                  ? t('当前素材库缺 {n} 个素材文件：恢复后记录都在，但照片/视频要拷过来才能显示', {
                      n: summary.mediaMissing,
                    })
                  : t('素材齐全（0 个缺失）')}
              </span>
            </div>
            {summary.includeThumbs && summary.thumbsMissing > 0 && (
              <div className="bk-line">
                <span className="bk-label">{t('缩略图缺失')}</span>
                <span className="bk-value">
                  {t('{n} 张（打开时会按素材库重建）', { n: summary.thumbsMissing })}
                </span>
              </div>
            )}
            {(summary.warnings ?? []).map((w, i) => (
              <p className="hint err" key={`${i}-${w}`}>
                · {w}
              </p>
            ))}

            {!confirming ? (
              <div className="row">
                <button
                  className="ghost"
                  onClick={resetFile}
                  disabled={restoring || exporting}
                >
                  {t('取消')}
                </button>
                <button
                  className="danger-btn"
                  onClick={() => setConfirming(true)}
                  disabled={restoring || exporting}
                >
                  {t('从备份恢复…')}
                </button>
              </div>
            ) : (
              <div className="confirm-del bk-confirm">
                <div className="confirm-text">
                  {t('恢复会覆盖当前全部数据：')}
                  <small>
                    {t('地点、到访、笔记、媒体记录、秘密基地密码都会替换成备份里的内容。恢复前会自动备份当前数据；中途失败会回滚，当前数据保持原样。你电脑上的原始文件不会被删除。')}
                  </small>
                </div>
                {summary.includeMedia && (
                  <p className="bk-media-note">
                    {t('这是含素材的备份：恢复时会把 {n} 个素材文件写入当前素材库—— 同名同内容跳过、同名不同内容覆盖，', {
                      n: summary.mediaCount,
                    })}
                    <b>{t('不会删除素材库里的其它文件')}</b>
                    {t('。')}
                  </p>
                )}
                <div className="row">
                  <button
                    className="ghost"
                    onClick={() => setConfirming(false)}
                    disabled={restoring}
                  >
                    {t('取消')}
                  </button>
                  <button
                    className="danger-btn"
                    onClick={() => void doRestore()}
                    disabled={restoring || exporting}
                  >
                    {restoring ? t('恢复中…') : t('确认恢复')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {restoring && (
          <div className="bk-progress" role="progressbar" aria-label={t('正在恢复')}>
            <div className="bk-progress-bar">
              <div className="bk-progress-fill indeterminate" />
            </div>
            <div className="bk-progress-text">
              {t('正在恢复…请不要关闭页面')}
            </div>
          </div>
        )}

        {restoreMsg && <p className="hint err">{restoreMsg.text}</p>}

        {restoreResult && (
          <div className="bk-result">
            <p className="bk-result-title">{t('恢复完成')}</p>
            <p className="hint bk-ok">
              {t('已恢复 {places} 个地点 · {visits} 次到访 · {media} 张照片/视频；地图和清单已刷新。', {
                places: restoreResult.restored.places,
                visits: restoreResult.restored.visits,
                media: restoreResult.restored.media,
              })}
            </p>
            {restoreResult.autoBackup && (
              <p className="hint">
                {t('恢复前已自动备份当前数据：')}
                <span className="mono">{restoreResult.autoBackup.name}</span>
                {t('（{size}）', { size: fmtBytes(restoreResult.autoBackup.bytes) })}
              </p>
            )}
            {restoreResult.media && restoreResult.media.packaged > 0 && (
              <p className="hint">
                {t('素材：写入 {written} 个 · 跳过 {skipped} 个（同名同内容）', {
                  written: restoreResult.media.written,
                  skipped: restoreResult.media.skipped,
                })}
                {restoreResult.media.failed > 0
                  ? t(' · 失败 {n} 个', { n: restoreResult.media.failed })
                  : ''}
              </p>
            )}
            {typeof restoreResult.orphans === 'number' && restoreResult.orphans > 0 && (
              <p className="hint">
                {t('素材库里有 {n} 个文件不被当前数据引用（可能来自旧数据或手工放置），已保留未删除；确认没用后可自行清理。', {
                  n: restoreResult.orphans,
                })}
              </p>
            )}
            {restoreResult.missingMedia > 0 && (
              <p className="hint err">
                {t('当前素材库还缺 {n} 个素材文件：记录已恢复，但对应照片/视频要等把素材库拷过来才能显示。', {
                  n: restoreResult.missingMedia,
                })}
              </p>
            )}
            {restoreResult.missingThumbs > 0 && (
              <p className="hint">
                {t('有 {n} 张缩略图缺失，打开照片墙时会按素材库重建。', {
                  n: restoreResult.missingThumbs,
                })}
              </p>
            )}
            {(restoreResult.warnings ?? []).map((w, i) => (
              <p className="hint" key={`${i}-${w}`}>
                · {w}
              </p>
            ))}
          </div>
        )}

        <p className="hint">
          {t('恢复只替换应用数据与缩略图缓存。不含素材的备份不写素材库；含素材的备份只写入 / 覆盖包内文件，不会删除素材库里的其它文件，也不会动你电脑上的原始文件。')}
        </p>
      </div>
    </div>
  );
}
