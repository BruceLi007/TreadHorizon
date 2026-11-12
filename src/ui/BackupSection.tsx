import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { api } from '../lib/api';
import { tr, useT } from '../i18n';
import type {
  BackupExportJobStatus,
  BackupInspectJobStatus,
  BackupInspectResult,
  BackupRestoreJobStatus,
  BackupRestoreResult,
  BackupStatus,
} from '../lib/types';
import './BackupSection.css';

interface Props {
  /** 恢复成功后由设置页转交给 App 做全量刷新（F-SYS-04） */
  onRestored: () => void;
  /** 状态变化（导出 / 稍后提醒 / 改阈值后）同步给 App，顶栏红点即时更新 */
  onStatus?: (s: BackupStatus) => void;
  /** 当前「备份目录」绝对路径（设置页 /api/backup/dir 加载；导出说明与「打开备份目录」共用） */
  backupDir?: string;
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
 * 设置页「备份」区块（F-SYS-03/04/05，v2 含素材；2026-11-11 用户拍板改为「只落备份目录」）。
 * - 常驻：上次备份 / 提醒阈值 / 当前数据量 / due 提醒 + 稍后 24h
 * - 导出：三块可选（元数据必选 / 缩略图默认勾 / 素材默认不勾）；
 *   两阶段任务：start → 500ms 轮询进度（可取消）→ done 后 zip 已保存到本机「备份目录」
 *   （**不走浏览器下载 / 不弹另存为**，前端只显示文件名 + 完整路径 + 「打开备份目录」）
 * - 恢复：选 zip（默认在「备份目录」里）→ inspect 摘要 → 红色二次确认 → restore；
 *   含素材时写入当前素材库但绝不删除其它文件；成功后 onRestored() 全量刷新
 * 后端没起来 / 接口 404 时各区块就地报错，不崩页面。
 */
export default function BackupSection({ onRestored, onStatus, backupDir = '' }: Props) {
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
  /** 2026-11-11「打开备份目录」按钮：导出区 / 恢复区各一个，错误原地显示（where 区分） */
  const [openDirBusy, setOpenDirBusy] = useState(false);
  const [openDirErr, setOpenDirErr] = useState<{ where: 'export' | 'restore'; text: string } | null>(
    null
  );

  /** 导出进行中（打包中）：与恢复互斥；done/error/canceled 后解除 */
  const exporting = exportStarting || exportJob?.state === 'building';

  // ── 恢复（F-SYS-04）──
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [fileName, setFileName] = useState('');
  /** 2026-11-12 D-401：备份包检查改成后台任务（start → 上传 → 校验），这里表示「正在启动 / 上传」 */
  const [inspectStarting, setInspectStarting] = useState(false);
  const [inspectJobId, setInspectJobId] = useState<string | null>(null);
  const [inspectJob, setInspectJob] = useState<BackupInspectJobStatus | null>(null);
  const [inspectUploadPct, setInspectUploadPct] = useState<number | null>(null);
  const inspectAbortRef = useRef<(() => void) | null>(null);
  const [inspectErr, setInspectErr] = useState<string | null>(null);
  const [inspected, setInspected] = useState<BackupInspectResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  /** 2026-11-11 D-365：恢复改后台任务（关掉设置不中断，重开可续看） */
  const [restoreJobId, setRestoreJobId] = useState<string | null>(null);
  const [restoreJob, setRestoreJob] = useState<BackupRestoreJobStatus | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [restoreResult, setRestoreResult] = useState<BackupRestoreResult | null>(null);

  /** 上传 / 校验阶段都算「正在检查」（按钮禁用、显示进度） */
  const inspecting =
    inspectStarting || inspectJob?.state === 'uploading' || inspectJob?.state === 'validating';

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
          // 2026-11-11 用户拍板：zip 由服务端直接落「备份目录」（savedPath/savedName 一定有值），
          // 前端不再触发浏览器下载；done 的「文件名 + 完整路径 + 打开备份目录」由下方渲染块负责。
          setExportMsg(null);
          void loadStatus();
          return;
        }
        if (s.state === 'error') {
          // 服务端本地导出失败的文案自带「导出失败：…」前缀，避免重复拼一次
          const raw = s.error || tr('没有返回原因');
          setExportMsg({
            ok: false,
            text: /导出失败/.test(raw) ? raw : tr('导出失败：') + raw,
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

  // ── 两阶段导出：start → 轮询 → zip 已落到本机「备份目录」 ──
  const doExport = async () => {
    if (exporting || restoring) return;
    setExportStarting(true);
    setExportMsg(null);
    setExportJob(null);
    setOpenDirErr(null);
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
      setExportMsg({ ok: false, text: t('导出已取消') });
    } catch (e: unknown) {
      setExportMsg({ ok: false, text: t('取消导出失败：') + errText(e) });
    } finally {
      setExportCanceling(false);
    }
  };

  /** 在系统文件管理器里打开「备份目录」（复用 POST /api/backup/dir/open；本地导出/恢复区共用） */
  const openBackupDir = async (where: 'export' | 'restore') => {
    if (openDirBusy) return;
    setOpenDirBusy(true);
    setOpenDirErr(null);
    try {
      await api.openBackupDir();
    } catch (e: unknown) {
      setOpenDirErr({ where, text: t('打开备份目录失败：') + errText(e) });
    } finally {
      setOpenDirBusy(false);
    }
  };

  const resetFile = () => {
    setFileName('');
    setInspected(null);
    setInspectStarting(false);
    setInspectJobId(null);
    setInspectJob(null);
    setInspectUploadPct(null);
    inspectAbortRef.current = null;
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

  /** 点击按钮后才开始校验（D-401 起：start → 上传 → 后台校验 → 轮询） */
  const doInspect = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file || inspecting || restoring || exporting) return;
    setInspected(null);
    setInspectErr(null);
    setConfirming(false);
    setRestoreMsg(null);
    setRestoreResult(null);
    setInspectStarting(true);
    setInspectUploadPct(0);
    try {
      const start = await api.startBackupInspect();
      setInspectJobId(start.jobId);
      await api.uploadBackupInspect(
        start.jobId,
        file,
        (p) => setInspectUploadPct(p),
        (abort) => {
          inspectAbortRef.current = abort;
        }
      );
      // 上传完成；校验已交给服务端后台任务，下面的轮询 effect 会接着显示进度 / 结果
      setInspectStarting(false);
      setInspectUploadPct(null);
    } catch (err: unknown) {
      setInspectStarting(false);
      setInspectUploadPct(null);
      setInspectJobId(null);
      setInspectJob(null);
      inspectAbortRef.current = null;
      setInspectErr(t('校验失败：') + errText(err));
    }
  };

  // ── 确认恢复：2026-11-11 D-365 起走「后台任务」（服务端跑完，客户端只轮询）──
  const doRestore = async () => {
    const token = inspected?.token;
    if (!token || restoring || exporting || restoreJobId) return;
    setRestoring(true);
    setRestoreMsg(null);
    setRestoreResult(null);
    setConfirming(false);
    try {
      const start = await api.startBackupRestore(token);
      setRestoreJobId(start.jobId);
    } catch (e: any) {
      setRestoring(false);
      const rolled = e?.rolledBack === true;
      const raw = errText(e);
      setRestoreMsg({
        ok: false,
        text: rolled && !raw.includes('回滚') ? raw + t('（已回滚，当前数据未被修改）') : raw,
      });
    }
  };

  // ── 恢复任务轮询：running 时继续；done → 展示结果并刷新；error → 提示（含是否已回滚）──
  useEffect(() => {
    if (!restoreJobId) {
      setRestoreJob(null);
      return;
    }
    let alive = true;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const s = await api.restoreJobStatus(restoreJobId);
        if (!alive) return;
        setRestoreJob(s);
        if (s.state === 'running') {
          timer = window.setTimeout(tick, 800);
          return;
        }
        setRestoreJobId(null);
        setRestoring(false);
        if (s.state === 'done' && s.result) {
          setRestoreResult(s.result);
          setRestoreMsg(null);
          resetFile();
          void loadStatus();
          onRestored();
        } else {
          const raw = s.error || tr('没有返回原因');
          setRestoreMsg({
            ok: false,
            text: s.rolledBack ? raw + t('（已回滚，当前数据未被修改）') : raw,
          });
          void loadStatus();
        }
      } catch (e: unknown) {
        if (!alive) return;
        setRestoreJobId(null);
        setRestoring(false);
        setRestoreMsg({ ok: false, text: tr('读取恢复进度失败：') + errText(e) });
      }
    };
    timer = window.setTimeout(tick, 600);
    return () => {
      alive = false;
      if (timer != null) window.clearTimeout(timer);
    };
    // resetFile / loadStatus / onRestored 为稳定闭包或父级回调；只按 jobId 触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreJobId]);

  // ── 备份包检查任务轮询：uploading / validating 继续；done → 摘要 + token；error → 提示（D-401）──
  useEffect(() => {
    if (!inspectJobId) return;
    let alive = true;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const s = await api.inspectJobStatus(inspectJobId);
        if (!alive) return;
        setInspectJob(s);
        if (s.state === 'uploading' || s.state === 'validating') {
          timer = window.setTimeout(tick, 800);
          return;
        }
        setInspectJobId(null);
        if (s.state === 'done' && s.token && s.summary && s.expiresAt) {
          setInspected({ token: s.token, expiresAt: s.expiresAt, summary: s.summary });
          if (s.filename) setFileName(s.filename);
          setInspectErr(null);
        } else {
          setInspectErr(t('校验失败：') + (s.error || tr('没有返回原因')));
        }
      } catch (e: unknown) {
        if (!alive) return;
        setInspectJobId(null);
        setInspectErr(t('读取检查进度失败：') + errText(e));
      }
    };
    timer = window.setTimeout(tick, 300);
    return () => {
      alive = false;
      if (timer != null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectJobId]);

  // ── 设置关掉再打开 / 页面刷新后：接回正在跑的后台恢复任务 + 导出任务进度（D-365 / D-364）──
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const tasks = await api.backgroundTasks();
        if (!alive) return;
        const runningRestore = (tasks.restoreJobs ?? []).find((j) => j.state === 'running');
        if (runningRestore) {
          setRestoring(true);
          setRestoreJobId(runningRestore.jobId);
          setRestoreMsg(null);
        }
        const exp = (tasks.exportJobs ?? [])[0];
        if (exp) {
          setExportJob((prev) => prev ?? exp);
          if (exp.state === 'building') {
            setExportMsg({
              ok: true,
              text: tr('导出任务正在后台打包，关掉设置不会中断；完成后会保存到「备份目录」。'),
            });
          }
          // done：不再提示「下载」——看下方渲染块的「文件名 / 完整路径 / 打开备份目录」
        }

        // 2026-11-12 D-401：接回备份包检查任务（校验阶段关设置 / 刷新不中断）
        const insp = (tasks.inspectJobs ?? []).find(
          (j) => j.state === 'uploading' || j.state === 'validating'
        );
        if (insp) {
          if (insp.filename) setFileName(insp.filename);
          setInspectStarting(false);
          setInspectJob(insp);
          setInspectJobId(insp.jobId);
        } else {
          const doneInsp = (tasks.inspectJobs ?? []).find(
            (j) =>
              j.state === 'done' &&
              !!j.token &&
              !!j.summary &&
              !!j.expiresAt &&
              j.expiresAt > Date.now()
          );
          if (doneInsp && doneInsp.token && doneInsp.summary && doneInsp.expiresAt) {
            if (doneInsp.filename) setFileName(doneInsp.filename);
            setInspected({
              token: doneInsp.token,
              expiresAt: doneInsp.expiresAt,
              summary: doneInsp.summary,
            });
          } else {
            const errInsp = (tasks.inspectJobs ?? []).find(
              (j) =>
                j.state === 'error' &&
                j.finishedAt != null &&
                Date.now() - j.finishedAt < 10 * 60 * 1000
            );
            if (errInsp) setInspectErr(t('校验失败：') + (errInsp.error || tr('没有返回原因')));
          }
        }
      } catch {
        /* 旧服务端 / multi 权限不足：忽略，不影响手动操作 */
      }
    })();
    return () => {
      alive = false;
    };
    // 仅在挂载时执行一次
  }, []);

  /** 导出进度百分比：优先按字节（bytesTotal 是未压缩预估），没有体积时按文件数 */
  const exportPct = exportJob
    ? exportJob.bytesTotal > 0
      ? Math.min(100, Math.round((exportJob.bytesDone / exportJob.bytesTotal) * 100))
      : exportJob.filesTotal > 0
        ? Math.min(100, Math.round((exportJob.filesDone / exportJob.filesTotal) * 100))
        : 0
    : 0;

  const summary = inspected?.summary ?? null;

  /**
   * 导出完成后的保存信息（2026-11-11 用户拍板：本地导出只落「备份目录」）：
   * - 目录优先用设置页加载的 backupDir，其次导出状态返回的 backupDir / savedPath 的父目录兜底；
   * - 文件名优先 savedName，旧字段缺失时从 savedPath 取 basename。
   */
  const shownBackupDir =
    backupDir ||
    exportJob?.backupDir ||
    (exportJob?.savedPath ? exportJob.savedPath.replace(/[\\/][^\\/]+$/, '') : '');
  const savedFileName =
    exportJob?.savedName ||
    (exportJob?.savedPath ? exportJob.savedPath.split(/[\\/]/).pop() || '' : '');

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

      {/* ── 两阶段导出（F-SYS-03 v2；2026-11-11 用户拍板：只保存到「备份目录」） ── */}
      <div className="bk-card">
        <div className="bk-card-head">
          <span className="bk-card-title">{t('导出到备份目录')}</span>
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
                : t('导出到备份目录')}
        </button>

        {/* 2026-11-11 用户拍板：本地导出直接写本机「备份目录」，不走浏览器下载 / 不弹另存为 */}
        <p className="hint bk-export-note">
          {t('备份在本机「备份目录」中完成，不经过浏览器下载；大文件可能要等一会儿。')}
        </p>
        {shownBackupDir && (
          <div className="bk-dir-line">
            <span className="bk-muted">{t('备份文件保存目录：')}</span>
            <span className="mono bk-saved-path" title={shownBackupDir}>
              {shownBackupDir}
            </span>
            <button
              type="button"
              className="ghost bk-dir-open"
              onClick={() => void openBackupDir('export')}
              disabled={openDirBusy}
            >
              {openDirBusy ? t('正在打开…') : t('打开备份目录')}
            </button>
          </div>
        )}
        {openDirErr?.where === 'export' && <p className="hint err">{openDirErr.text}</p>}

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

        {/* 2026-11-11 用户拍板：本地导出 done 时 zip 已在「备份目录」（savedPath/savedName 一定有值），
         * 不再有浏览器下载 / 重新下载；这里显示「文件名 + 完整路径 + 打开备份目录」。
         * saveError / 两个字段都没有属于异常，红字提示（正常服务端不会出现）。 */}
        {exportJob?.state === 'done' && exportJob.savedPath && (
          <div className="bk-saved">
            <p className="hint bk-ok">
              {t('导出完成：备份包大小 {size}，已保存到备份目录。', {
                size: fmtBytes(exportJob.zipBytes),
              })}
            </p>
            <div className="bk-line">
              <span className="bk-label">{t('文件名')}</span>
              <span className="bk-value mono">{savedFileName}</span>
            </div>
            <div className="bk-line">
              <span className="bk-label">{t('完整路径')}</span>
              <span className="bk-value mono bk-saved-path" title={exportJob.savedPath}>
                {exportJob.savedPath}
              </span>
            </div>
            <div className="row bk-saved-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => void openBackupDir('export')}
                disabled={openDirBusy}
              >
                {openDirBusy ? t('正在打开…') : t('打开备份目录')}
              </button>
            </div>
          </div>
        )}
        {exportJob?.state === 'done' && !exportJob.savedPath && (
          <p className="hint err">
            {exportJob.saveError
              ? t('未能保存到备份目录：{err}', { err: exportJob.saveError })
              : t('导出失败：服务端没有返回备份文件保存路径，请重试或查看服务端日志。')}
          </p>
        )}

        <p className="hint">
          {t('备份不会动你电脑上的原始文件。含素材时会逐个打包素材文件；恢复只写入 / 覆盖备份里的文件，不会删除素材库里的其它文件。')}
        </p>
      </div>

      {/* ── 从备份恢复（F-SYS-04；保持「选文件 → 检查 → 确认恢复」，不做列表 / 原生对话框） ── */}
      <div className="bk-card">
        <div className="bk-card-head">
          <span className="bk-card-title">{t('从备份恢复')}</span>
          <span className="bk-muted">{t('选择备份文件')}</span>
        </div>

        {/* 2026-11-11：导出只落「备份目录」，恢复区提示去哪里找 zip；选文件逻辑口径不变 */}
        <p className="hint">
          {t('恢复步骤：选择备份文件（默认保存在「备份目录」里，可先点「打开备份目录」查找）→ 开始检查备份包 → 确认恢复。')}
        </p>
        <div className="row bk-restore-dir">
          <button
            type="button"
            className="ghost"
            onClick={() => void openBackupDir('restore')}
            disabled={openDirBusy}
          >
            {openDirBusy ? t('正在打开…') : t('打开备份目录')}
          </button>
          <span className="bk-muted">{t('导出的备份包默认保存在这里。')}</span>
        </div>
        {openDirErr?.where === 'restore' && <p className="hint err">{openDirErr.text}</p>}

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
        {inspecting && (
          <p className="hint">
            {inspectJob?.state === 'validating'
              ? t('正在校验备份包…（在服务端后台进行，关掉设置不会中断；重新打开设置可继续查看）')
              : inspectUploadPct != null
                ? t('正在上传备份包… {pct}%（上传阶段请勿刷新页面）', {
                    pct: Math.round(inspectUploadPct * 100),
                  })
                : t('正在上传备份包…（上传阶段请勿刷新页面）')}
          </p>
        )}
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
              {t('正在恢复…（任务在服务端后台继续，关掉设置不会中断；重新打开设置可继续查看）')}
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
