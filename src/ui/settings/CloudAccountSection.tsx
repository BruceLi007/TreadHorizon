/**
 * 设置 → 云端账号（2026-11-18 D-523 / D-525，只在本地版显示）
 *
 * - 登录：地址 + 用户名 + 密码 → 本地服务换云端会话 Cookie（密码不落盘）；
 * - 同步：把全部足迹的缩略图 + 元数据打到云端「主页快照」（只保留一份，覆盖式）；
 * - 未同步改动提示：本地指纹（地点/到访/照片数 + 最大更新时间）与上次同步比对。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type CloudStatus, type CloudSyncJob } from '../../lib/api';
import { useT } from '../../i18n';
import { formatBytes } from '../../lib/bytes';
import ConfirmDialog from '../ConfirmDialog';

interface Props {
  status: CloudStatus | null;
  onChanged: () => void;
  /**
   * 2026-11-19 D-537（用户：「同步成功后，还是没有提示同步成功」）：
   * 把 jobId 交给 App —— 由 App 层盯着任务结束并弹 toast，
   * 这样**关掉设置**（甚至刷新页面）同步完成后也照样有提示。
   */
  onSyncStarted?: (jobId: string) => void;
}

const pad = (n: number) => String(n).padStart(2, '0');
const fmtTime = (ms?: number | null) => {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function CloudAccountSection({ status, onChanged, onSyncStarted }: Props) {
  const t = useT();
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState<CloudSyncJob | null>(null);
  /** 2026-11-18 D-529（用户要求）：点「立即同步」先确认一次再真正上传 */
  const [confirmSync, setConfirmSync] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (status?.baseUrl) setBaseUrl((v) => v || status.baseUrl || '');
  }, [status?.baseUrl]);

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    []
  );

  const configured = Boolean(status?.configured);
  const user = status?.user;
  const lastSync = status?.lastSync;
  const fp = status?.fingerprint;
  /** 本地有改动：数量对不上，或最大更新时间晚于上次同步 */
  const dirty = useMemo(() => {
    if (!lastSync || !fp) return false;
    return (
      fp.places !== lastSync.places ||
      fp.visits !== lastSync.visits ||
      fp.photos !== lastSync.photos
    );
  }, [fp, lastSync]);

  const login = async () => {
    setBusy(true);
    setError('');
    try {
      await api.cloudLogin(baseUrl.trim(), username.trim(), password);
      setPassword('');
      onChanged();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      await api.cloudLogout();
      onChanged();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const poll = useCallback(
    async (jobId: string) => {
      try {
        const s = await api.cloudSyncStatus(jobId);
        setJob(s);
        if (s.state === 'running') {
          timer.current = window.setTimeout(() => void poll(jobId), 900);
          return;
        }
        onChanged();
      } catch (e: any) {
        setError(e?.message || String(e));
        setJob(null);
      }
    },
    [onChanged]
  );

  /**
   * 2026-11-19 D-536：重开设置时接回正在跑的同步。
   *
   * 同步是服务端后台任务（关设置 / 刷新都不中断），但 jobId 以前只活在组件 state 里：
   * 关掉设置再打开就看不到进度、也拿不回结果。这里从 `/api/background-tasks.cloudSyncJobs`
   * 里找 running 的那条，重新挂上轮询；后台任务面板显示的是同一份数据。
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const t = await api.backgroundTasks();
        const running = (t?.cloudSyncJobs || []).find((j) => j.state === 'running');
        if (!alive || !running) return;
        setJob({
          jobId: running.jobId,
          state: 'running',
          phase: running.phase,
          total: running.total,
          done: running.done,
          bytes: running.bytes,
          photos: running.photos,
          places: running.places,
          visits: running.visits,
          error: running.error,
        });
        void poll(running.jobId);
        onSyncStarted?.(running.jobId);
      } catch {
        /* 云端 / 只读会话没有这个接口，忽略 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [poll, onSyncStarted]);

  const startSync = async () => {
    setError('');
    try {
      const j = await api.cloudSyncStart(user?.displayName || '');
      setJob({
        jobId: j.jobId,
        state: 'running',
        phase: 'pack',
        total: 0,
        done: 0,
        bytes: 0,
        photos: 0,
        places: 0,
        visits: 0,
        error: null,
      });
      void poll(j.jobId);
      onSyncStarted?.(j.jobId);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  const cancelSync = async () => {
    if (!job) return;
    try {
      await api.cloudSyncCancel(job.jobId);
    } catch {
      /* ignore */
    }
  };

  const syncing = job?.state === 'running';
  /**
   * 进度：打包阶段按「已生成 / 总数」，上传阶段按「已上传字节 / 包大小」（2026-11-19 D-541）。
   * 以前上传阶段一直停在 3342/3342（100%），看起来像卡死。
   */
  const progress =
    job?.phase === 'upload'
      ? job.bytes > 0
        ? Math.min(100, Math.round(((job.uploaded || 0) / job.bytes) * 100))
        : 0
      : job && job.total > 0
        ? Math.round((job.done / job.total) * 100)
        : 0;

  return (
    <>
      <div className="set-section-head" style={{ marginBottom: 2 }}>
        <h3 className="set-section-title">{t('云端账号')}</h3>
        <span className="set-section-tag">
          {configured ? t('已登录 · {name}', { name: user?.displayName || '' }) : t('未登录')}
        </span>
      </div>
      <p className="set-pane-desc">
        {t('用你在云端官网注册的账号登录。登录后，本地分享可以直接上传到云端（只传缩略图，不上传原图）。')}
      </p>

      {error && <p className="share-error-text">{error}</p>}

      {!configured ? (
        <section className="set-section">
          <label className="set-field">
            <span>{t('云端地址')}</span>
            <input
              value={baseUrl}
              placeholder="https://share.example.com"
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label className="set-field">
            <span>{t('用户名')}</span>
            <input value={username} spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="set-field">
            <span>{t('密码')}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void login();
              }}
            />
          </label>
          <div className="set-actions-row">
            <button type="button" className="primary" disabled={busy} onClick={() => void login()}>
              {busy ? t('登录中…') : t('登录云端')}
            </button>
            <span className="set-hint">{t('只在本机保存会话凭证，不保存密码')}</span>
          </div>
          <p className="set-hint">
            {t('建议用 https 地址；公网 http 下密码是明文传输。')}
          </p>
        </section>
      ) : (
        <>
          <section className="set-section">
            <div className="cloud-account-row">
              {/* 2026-11-18 D-528：云端账号的头像（没设头像时用显示名首字母） */}
              {status?.user?.avatarUpdatedAt ? (
                <img
                  className="cloud-account-avatar"
                  src={api.cloudAvatarUrl(status.user.avatarUpdatedAt)}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.visibility = 'hidden';
                  }}
                />
              ) : (
                <span className="cloud-account-avatar" aria-hidden="true">
                  {(user?.displayName || user?.username || '?').slice(0, 1)}
                </span>
              )}
              <div>
                <b>{user?.displayName || user?.username || ''}</b>
                <span className="set-hint">{status?.baseUrl}</span>
              </div>
              <span className={status?.reachable ? 'cloud-ok' : 'cloud-bad'}>
                {status?.reachable ? t('已连接') : t('连不上云端')}
              </span>
              <button type="button" className="ghost" disabled={busy} onClick={() => void logout()}>
                {t('退出登录')}
              </button>
            </div>
            {status?.usage && (
              <p className="set-hint">
                {t('云端已用 {used} / {quota} · 剩余 {free} · {n} 份分享', {
                  used: formatBytes((status.usage.sharesBytes || 0) + (status.usage.mediaBytes || 0)),
                  quota: formatBytes(status.usage.quotaBytes || 0),
                  free: formatBytes(
                    Math.max(
                      0,
                      (status.usage.quotaBytes || 0) -
                        (status.usage.sharesBytes || 0) -
                        (status.usage.mediaBytes || 0)
                    )
                  ),
                  n: status.usage.shareCount,
                })}
              </p>
            )}
          </section>

          <section className="set-section">
            <div className="set-section-head">
              <h3 className="set-section-title">{t('同步到云端')}</h3>
              <span className="set-section-tag">{t('主页快照 · 只保留一份')}</span>
            </div>
            <p className="set-pane-desc">
              {t('把全部地点 / 到访 / 照片的缩略图同步到云端，登录云端看到的就是这一份；视频与秘密基地不参与。')}
            </p>

            {syncing ? (
              <>
                <p className="set-hint">
                  {job?.phase === 'upload'
                    ? t('正在上传… {pct}%（{done} / {total}）', {
                        pct: progress,
                        done: formatBytes(job?.uploaded || 0),
                        total: formatBytes(job?.bytes || 0),
                      })
                    : t('正在生成缩略图… {done} / {total}', {
                        done: job?.done || 0,
                        total: job?.total || 0,
                      })}
                </p>
                {job?.reused && <p className="set-hint">{t('复用上次打包好的结果，不用重新生成缩略图')}</p>}
                <div className="cloud-progress">
                  <span style={{ width: `${Math.max(4, progress)}%` }} />
                </div>
                <div className="set-actions-row">
                  <button type="button" className="ghost" onClick={() => void cancelSync()}>
                    {t('取消同步')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="cloud-sync-line">
                  {lastSync
                    ? t('上次同步 {time} · {places} 地点 · {visits} 到访 · {photos} 张照片 · {size}', {
                        time: fmtTime(lastSync.at),
                        places: lastSync.places,
                        visits: lastSync.visits,
                        photos: lastSync.photos,
                        size: formatBytes(lastSync.bytes),
                      })
                    : t('还没有同步过')}
                </p>
                {dirty && (
                  <p className="cloud-dirty">
                    {t('本地有未同步的改动（当前 {places} 地点 / {visits} 到访 / {photos} 张照片）', {
                      places: fp?.places ?? 0,
                      visits: fp?.visits ?? 0,
                      photos: fp?.photos ?? 0,
                    })}
                  </p>
                )}
                <div className="set-actions-row">
                  <button type="button" className="primary" onClick={() => setConfirmSync(true)}>
                    {lastSync ? t('立即同步（覆盖云端）') : t('立即同步')}
                  </button>
                  <span className="set-hint">
                    {t('会覆盖云端现有的主页快照；上限 = 账号容量。')}
                  </span>
                </div>
              </>
            )}
            {job?.state === 'error' && <p className="share-error-text">{job.error}</p>}
          </section>
        </>
      )}
      {confirmSync && (
        <ConfirmDialog
          title={t('同步到云端？')}
          confirmText={t('开始同步')}
          cancelText={t('取消')}
          onCancel={() => setConfirmSync(false)}
          onConfirm={() => {
            setConfirmSync(false);
            void startSync();
          }}
        >
          <p>
            {t('会用本地全部足迹覆盖云端现有的主页快照（只保留一份）。')}
          </p>
          <p className="set-hint">
            {t('视频与秘密基地不参与；当前 {places} 地点 / {visits} 到访 / {photos} 张照片。', {
              places: fp?.places ?? 0,
              visits: fp?.visits ?? 0,
              photos: fp?.photos ?? 0,
            })}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
