/**
 * 设置 →「后台任务」（2026-11-15 D-431，用户要求）。
 *
 * 用户原话：「这也算是有持续时间的任务，需要能在后台运行；这样吧，你在设置里加一个"后台任务"栏，
 * 这里面就放现有的一些有持续时间的后台任务状态，像之前的上传等等，把后台任务都分类放在这里面」。
 *
 * 实现约定：
 * - 一栏集中展示**所有有持续时间**的任务，按来源分类：
 *   ① 上传（本机队列，状态由 App 持有，直接复用 `UploadSettings`）；
 *   ② 备份（备份导出 / 备份恢复 / 备份包检查）；
 *   ③ 分享（本地分享包导出 / 云端分享上传）；
 *   ④ 回收站（批量恢复 / 彻底删除）；
 *   ⑤ 云端同步（本地 → 云端 主页快照同步，2026-11-19 D-536 —— 服务端后台任务，关设置不中断）。
 * - 服务端任务（②③④）每 2 秒轮询 `GET /api/background-tasks`，只在本页显示时轮询；
 *   上传（①）是纯前端状态，跟着 props 变。
 * - 只读样板会话 / 云端非管理员：接口会 403，这里静默显示「没有可查看的后台任务」。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import { api } from '../../lib/api';
import type {
  BackgroundTasks,
  BackupExportJobStatus,
  BackupInspectJobStatus,
  BackupRestoreJobStatus,
  CloudSyncTaskRow,
  ShareExportJob,
  ShareUploadTask,
  TrashJob,
  UploadItem,
} from '../../lib/types';
import UploadSettings from './UploadSettings';

interface Props {
  uploads: UploadItem[];
  onCancelUpload: (key: string) => void;
  onCancelAllUploads: () => void;
  onRetryUpload: (key: string) => void;
  onClearFinishedUploads: () => void;
  onCloseUploadQueue: () => void;
  /** 云端分享包上传（2026-11-15 D-438）：App 层持有，进度 / 结果 / 取消 / 重试 */
  shareUploads?: ShareUploadTask[];
  onCancelShareUpload?: (id: string) => void;
  onRetryShareUpload?: (id: string) => void;
  readOnly?: boolean;
}

type Tone = 'running' | 'done' | 'error' | 'idle';

interface Row {
  id: string;
  kind: string;
  tone: Tone;
  done?: number;
  total?: number;
  /** 覆盖「done / total」进度文案（云端上传用百分比） */
  percentLabel?: string;
  detail?: string;
  error?: string | null;
  createdAt?: number;
  /** 完成后的可复制链接（2026-11-15 D-438：云端分享上传） */
  link?: string;
  /** 行内操作（取消上传 / 失败重试） */
  action?: { label: string; onClick: () => void };
}

const EMPTY: BackgroundTasks = {
  exportJobs: [],
  restoreJobs: [],
  inspectJobs: [],
  shareExportJobs: [],
  trashJobs: [],
  cloudSyncJobs: [],
};

/** 每个分类最多先显示几条（多了折在「展开全部」里） */
const SECTION_PREVIEW = 5;
const TASKS_COLLAPSED_KEY = 'tm-tasks-collapsed';

function pct(done?: number, total?: number): number | null {
  if (typeof done !== 'number' || typeof total !== 'number' || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function fmtTime(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

export default function TasksSettings({
  uploads,
  onCancelUpload,
  onCancelAllUploads,
  onRetryUpload,
  onClearFinishedUploads,
  onCloseUploadQueue,
  shareUploads = [],
  onCancelShareUpload,
  onRetryShareUpload,
  readOnly = false,
}: Props) {
  const t = useT();
  const [tasks, setTasks] = useState<BackgroundTasks>(EMPTY);
  const [denied, setDenied] = useState(false);

  // D-432：分类折叠 + 列表「展开全部」，状态存本机（localStorage），刷新后保持
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(TASKS_COLLAPSED_KEY);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const [listExpanded, setListExpanded] = useState<Record<string, boolean>>({});

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsedSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(TASKS_COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        /* 隐私模式写不进去：忽略 */
      }
      return next;
    });
  }, []);

  const toggleListExpanded = useCallback((key: string) => {
    setListExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await api.backgroundTasks();
      setTasks({
        exportJobs: next?.exportJobs || [],
        restoreJobs: next?.restoreJobs || [],
        inspectJobs: next?.inspectJobs || [],
        trashJobs: next?.trashJobs || [],
        shareExportJobs: next?.shareExportJobs || [],
        cloudSyncJobs: next?.cloudSyncJobs || [],
      });
      setDenied(false);
    } catch {
      // 只读会话 / 云端非管理员：接口 403，这里不报错，当作没有任务
      setDenied(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [load]);

  /** 上传（本机队列）：按状态统计，行在下面的 UploadSettings 里 */
  const uploadStats = useMemo(() => {
    const total = uploads.length;
    const done = uploads.filter((x) => x.status === 'done' || x.status === 'skipped').length;
    const failed = uploads.filter((x) => x.status === 'error').length;
    const active = uploads.filter((x) => x.status === 'queued' || x.status === 'uploading').length;
    return { total, done, failed, active };
  }, [uploads]);

  const backupRows: Row[] = useMemo(() => {
    const rows: Row[] = [];
    for (const j of tasks.exportJobs as BackupExportJobStatus[]) {
      rows.push({
        id: `export-${j.jobId}`,
        kind: t('备份导出'),
        tone: j.state === 'building' ? 'running' : j.state === 'error' ? 'error' : 'done',
        done: j.filesDone,
        total: j.filesTotal,
        detail: j.state === 'done' ? j.savedName || fmtBytes(j.zipBytes) : fmtBytes(j.bytesDone),
        error: j.error,
        createdAt: j.createdAt,
      });
    }
    for (const j of tasks.restoreJobs as BackupRestoreJobStatus[]) {
      rows.push({
        id: `restore-${j.jobId}`,
        kind: t('备份恢复'),
        tone: j.state === 'running' ? 'running' : j.state === 'error' ? 'error' : 'done',
        detail: j.result ? t('已恢复') : undefined,
        error: j.error,
        createdAt: j.createdAt,
      });
    }
    for (const j of tasks.inspectJobs as BackupInspectJobStatus[]) {
      const tone: Tone =
        j.state === 'error' ? 'error' : j.state === 'done' ? 'done' : 'running';
      rows.push({
        id: `inspect-${j.jobId}`,
        kind: t('备份包检查'),
        tone,
        detail:
          j.state === 'uploading'
            ? t('上传中')
            : j.state === 'validating'
              ? t('校验中')
              : j.state === 'done'
                ? t('已完成')
                : undefined,
        error: j.error,
        createdAt: j.createdAt,
      });
    }
    return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [tasks, t]);

  const shareRows: Row[] = useMemo(() => {
    // 2026-11-15 D-438：云端「分享包上传」也放进这一分类 ——
    // 它以前只是分享弹窗里的前台请求，关掉弹窗就看不到结果、后台任务里也没有。
    const cloud: Row[] = (shareUploads as ShareUploadTask[]).map((u) => ({
      id: `shareup-${u.id}`,
      kind: t('云端分享上传'),
      tone: (u.state === 'uploading'
        ? 'running'
        : u.state === 'error'
          ? 'error'
          : u.state === 'canceled'
            ? 'idle'
            : 'done') as Tone,
      done: u.state === 'uploading' ? u.progress : undefined,
      total: u.state === 'uploading' ? 100 : undefined,
      percentLabel: u.state === 'uploading' ? `${u.progress}%` : undefined,
      detail: `${u.fileName} · ${fmtBytes(u.bytes)}${u.state === 'done' ? ' · ' + t('已上传') : ''}`,
      error: u.error,
      createdAt: u.startedAt,
      link: u.state === 'done' ? u.url : undefined,
      action:
        u.state === 'uploading'
          ? { label: t('取消上传'), onClick: () => onCancelShareUpload?.(u.id) }
          : u.state === 'error'
            ? { label: t('重试'), onClick: () => onRetryShareUpload?.(u.id) }
            : undefined,
    }));
    const local: Row[] = (tasks.shareExportJobs as ShareExportJob[]).map((j) => ({
      id: `share-${j.jobId}`,
      kind: t('分享包导出'),
      tone: (j.state === 'running' ? 'running' : j.canceled ? 'idle' : j.state === 'error' ? 'error' : 'done') as Tone,
      done: j.done,
      total: j.total,
      detail:
        j.state === 'done'
          ? `${j.savedName || ''} · ${fmtBytes(j.bytes)}`
          : t('{n} 张照片', { n: j.total }),
      error: j.error,
      createdAt: j.createdAt,
    }));
    return [...cloud, ...local].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [tasks, t, shareUploads, onCancelShareUpload, onRetryShareUpload]);

  const trashRows: Row[] = useMemo(
    () =>
      (tasks.trashJobs as TrashJob[])
        .map((j) => {
          let detail: string | undefined;
          const r: any = j.result;
          if (r && j.kind === 'restore') {
            detail = t('恢复 {p} 地点 · {v} 到访 · {m} 媒体', {
              p: r.restoredPlaces ?? 0,
              v: (r.restoredVisits ?? 0) + (r.restoredEarlierVisits ?? 0),
              m: (r.restoredMedia ?? 0) + (r.restoredEarlierMedia ?? 0),
            });
          } else if (r && j.kind === 'purge') {
            detail = t('彻底删除 {p} 地点 · {v} 到访 · {m} 媒体', {
              p: r.purgedPlaces ?? 0,
              v: r.purgedVisits ?? 0,
              m: r.purgedMedia ?? 0,
            });
          }
          return {
            id: `trash-${j.jobId}`,
            kind: j.kind === 'restore' ? t('回收站恢复') : t('回收站彻底删除'),
            tone: (j.state === 'running' ? 'running' : j.state === 'error' ? 'error' : 'done') as Tone,
            detail,
            error: j.error,
            createdAt: j.createdAt,
          };
        })
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [tasks, t]
  );

  /**
   * 2026-11-19 D-536：本地 → 云端 主页快照同步。
   * 它本来就是服务端后台任务（关设置 / 刷新不中断），只是以前没在后台任务里露脸；
   * 这里把 `/api/background-tasks.cloudSyncJobs` 的最近几条列出来，进度口径与「云端账号」卡片一致。
   */
  const cloudRows: Row[] = useMemo(
    () =>
      (tasks.cloudSyncJobs as CloudSyncTaskRow[])
        .map((j) => {
          const running = j.state === 'running';
          const uploading = running && j.phase === 'upload';
          /** 2026-11-20 D-544：写 zip 单独一个阶段（以前 3342/3342 之后条子不动，像卡死） */
          const zipping = running && j.phase === 'zip';
          const uploadPct =
            uploading && j.bytes > 0 ? Math.min(100, Math.round(((j.uploaded || 0) / j.bytes) * 100)) : 0;
          const zipPct =
            zipping && Number(j.zipTotal) > 0
              ? Math.min(100, Math.round(((j.zipDone || 0) / Number(j.zipTotal)) * 100))
              : 0;
          const phaseLabel = running
            ? j.phase === 'upload'
              ? t('上传中')
              : zipping
                ? t('打包成 zip')
                : t('打包中')
            : j.state === 'done'
              ? t('已同步')
              : j.state === 'canceled'
                ? t('已取消')
                : undefined;
          return {
            id: `cloud-${j.jobId}`,
            kind: t('同步到云端'),
            tone: (running ? 'running' : j.state === 'error' ? 'error' : j.state === 'canceled' ? 'idle' : 'done') as Tone,
            /**
             * 2026-11-19 D-541：打包阶段用「已生成 / 总数」；上传阶段改用**字节**进度
             * （以前上传时 done/total 已经是 3342/3342，条子一直 100% 不动，看着像卡死）。
             * 2026-11-20 D-544：写 zip 也用字节进度。
             */
            done: uploading ? j.uploaded || 0 : zipping ? j.zipDone || 0 : running && j.total > 0 ? j.done : undefined,
            total: uploading ? j.bytes || 0 : zipping ? j.zipTotal || 0 : running && j.total > 0 ? j.total : undefined,
            percentLabel: uploading
              ? t('上传中 {pct}%', { pct: uploadPct })
              : zipping
                ? t('打包中 {pct}%', { pct: zipPct })
                : running && j.total === 0
                  ? t('打包中')
                  : undefined,
            detail: [
              phaseLabel,
              uploading
                ? `${fmtBytes(j.uploaded || 0)} / ${fmtBytes(j.bytes || 0)}`
                : zipping
                  ? `${fmtBytes(j.zipDone || 0)} / ${fmtBytes(j.zipTotal || 0)}`
                  : '',
              j.reused ? t('复用上次打包') : '',
              j.places > 0 || j.visits > 0
                ? t('{p} 地点 · {v} 到访 · {m} 照片', { p: j.places, v: j.visits, m: j.photos || j.total })
                : '',
              !uploading && !zipping && j.bytes > 0 ? fmtBytes(j.bytes) : '',
              running ? t('已用 {n} 分钟', { n: Math.max(1, Math.round((Date.now() - j.createdAt) / 60000)) }) : '',
            ]
              .filter(Boolean)
              .join(' · '),
            error: j.error,
            createdAt: j.createdAt,
          } as Row;
        })
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [tasks, t]
  );

  const runningCount =
    uploadStats.active +
    backupRows.filter((r) => r.tone === 'running').length +
    shareRows.filter((r) => r.tone === 'running').length +
    trashRows.filter((r) => r.tone === 'running').length +
    cloudRows.filter((r) => r.tone === 'running').length;

  const emptyHint = denied ? t('当前账号没有可查看的后台任务。') : t('暂无任务。');

  /**
   * 2026-11-15 D-432（用户：「都做成收起和展开了吧？任务多了的话放不下」）：
   * 每个分类可折叠（状态存本机 localStorage），列表默认只显示 5 条，多出来的折在「展开全部 N 个」里。
   */
  const section = (key: string, title: string, subtitle: string, rows: Row[], children?: ReactNode) => {
    const runningRows = rows.filter((r) => r.tone === 'running');
    const collapsed = collapsedSections[key] ?? false;
    const allShown = listExpanded[key] ?? false;
    const shown = allShown ? rows : rows.slice(0, SECTION_PREVIEW);
    const hidden = rows.length - shown.length;
    return (
      <section className={`tasks-section${collapsed ? ' collapsed' : ''}`} key={key}>
        <button
          type="button"
          className="tasks-section-head"
          onClick={() => toggleCollapsed(key)}
          aria-expanded={!collapsed}
        >
          <span className={`tasks-caret${collapsed ? '' : ' open'}`} aria-hidden="true" />
          <span className="tasks-section-title">
            <b>{title}</b>
            <span className="tasks-section-desc">{subtitle}</span>
          </span>
          <span className="tasks-section-count">
            {runningRows.length > 0
              ? t('进行中 {n} 个', { n: runningRows.length })
              : rows.length > 0
                ? t('最近 {n} 个', { n: rows.length })
                : t('空闲')}
          </span>
        </button>
        {!collapsed && (
          <>
            {children}
            {rows.length > 0 && (
              <ul className="tasks-list">
                {shown.map((r) => {
                  const p = pct(r.done, r.total);
                  return (
                    <li className={`tasks-row ${r.tone}`} key={r.id}>
                      <div className="tasks-row-main">
                        <span className="tasks-kind">{r.kind}</span>
                        {typeof p === 'number' && (
                          <span className="tasks-progress-text">
                            {r.percentLabel ?? `${r.done} / ${r.total}`}
                          </span>
                        )}
                        <span className="tasks-time">{fmtTime(r.createdAt)}</span>
                      </div>
                      {typeof p === 'number' && r.tone === 'running' && (
                        <div className="tasks-bar">
                          <span style={{ width: `${Math.max(2, p)}%` }} />
                        </div>
                      )}
                      {r.detail && <p className="tasks-detail">{r.detail}</p>}
                      {r.error && <p className="tasks-detail err">{r.error}</p>}
                      {(r.link || r.action) && (
                        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                          {r.link && (
                            <button
                              type="button"
                              className="ghost"
                              style={{ height: 26, padding: '0 10px', borderRadius: 999, fontSize: 'calc(11.5px * var(--fs-scale))' }}
                              onClick={() => {
                                void navigator.clipboard?.writeText(r.link || '').catch(() => {});
                              }}
                            >
                              {t('复制链接')}
                            </button>
                          )}
                          {r.action && (
                            <button
                              type="button"
                              className="ghost"
                              style={{ height: 26, padding: '0 10px', borderRadius: 999, fontSize: 'calc(11.5px * var(--fs-scale))' }}
                              onClick={r.action.onClick}
                            >
                              {r.action.label}
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {hidden > 0 && (
              <button type="button" className="tasks-more" onClick={() => toggleListExpanded(key)}>
                {t('展开全部 {n} 个', { n: rows.length })}
              </button>
            )}
            {allShown && rows.length > SECTION_PREVIEW && (
              <button type="button" className="tasks-more" onClick={() => toggleListExpanded(key)}>
                {t('收起')}
              </button>
            )}
            {rows.length === 0 && !children && <p className="tasks-empty">{emptyHint}</p>}
          </>
        )}
      </section>
    );
  };

  return (
    <div className="tasks-wrap">
      <div className="tasks-summary">
        <p className="hint">
          {runningCount > 0
            ? t('正在后台运行 {n} 个任务；关掉设置、切换页面或刷新都不会中断。', { n: runningCount })
            : t('这些任务在后台运行，关掉设置、切换页面或刷新都不会中断。')}
        </p>
        <button type="button" className="ghost sm" onClick={() => void load()}>
          {t('刷新')}
        </button>
      </div>

      {section(
        'upload',
        t('上传'),
        t('本机队列：按地点 · 到访分组，可取消 / 重试'),
        uploadStats.total > 0
          ? [
              {
                id: 'upload-summary',
                kind: t('上传队列'),
                tone: uploadStats.active > 0 ? 'running' : uploadStats.failed > 0 ? 'error' : 'done',
                done: uploadStats.done,
                total: uploadStats.total,
                detail: t('失败 {n} 个', { n: uploadStats.failed }),
              } as Row,
            ]
          : [],
        uploadStats.total > 0 ? (
          <UploadSettings
            uploads={uploads}
            onCancelUpload={onCancelUpload}
            onCancelAllUploads={onCancelAllUploads}
            onRetryUpload={onRetryUpload}
            onClearFinishedUploads={onClearFinishedUploads}
            onCloseUploadQueue={onCloseUploadQueue}
            readOnly={readOnly}
          />
        ) : undefined
      )}

      {section(
        'backup',
        t('备份'),
        t('备份导出 / 备份恢复 / 备份包检查'),
        backupRows
      )}

      {section('share', t('分享'), t('本地分享包导出 / 云端上传'), shareRows)}

      {section('cloud', t('云端同步'), t('主页快照同步到云端（关设置不中断）'), cloudRows)}

      {section('trash', t('回收站'), t('批量恢复 / 彻底删除'), trashRows)}
    </div>
  );
}
