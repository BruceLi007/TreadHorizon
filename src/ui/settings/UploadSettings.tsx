/**
 * 2026-11-10 D-350（用户要求）：上传队列从「到访点侧栏」拆到「设置 → 上传」。
 *
 * 用户原话：「上传队列，给单独拆出来可以吗？不要放在到访点那里展示，或者在到访点那里只显示一个总数，
 * 比如共几张图片在传，已完成多少，但是不能展开，可以加一个链接转到设置里面，设置里面单独有一个上传板块，
 * 里面显示哪个地点、到访正常传，这里可以收起可以展开。」
 *
 * 实现约定：
 * - 本组件放完整队列：按「地点 · 到访日期」分组，组内逐文件显示状态 / 进度 / 取消 / 重试；
 *   头部可整体收起 / 展开，顶部有 全部取消 / 清除已完成 / 关闭队列（有失败时先二次确认）。
 * - 队列状态仍由 App 统一持有（关掉设置、切换地点、关掉侧栏都不中断上传）；这里只是展示与操作。
 * - 沿用 D-341 / 2026-11-10 的关闭策略：全部成功 5 秒后 App 自动清空队列；有失败不自动关闭。
 */
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { UploadItem } from '../../lib/types';
import ConfirmDialog from '../ConfirmDialog';

interface Props {
  uploads: UploadItem[];
  onCancelUpload: (key: string) => void;
  onCancelAllUploads: () => void;
  onRetryUpload: (key: string) => void;
  onClearFinishedUploads: () => void;
  onCloseUploadQueue: () => void;
  readOnly?: boolean;
}

interface UploadGroup {
  key: string;
  placeName: string;
  visitDate: string;
  items: UploadItem[];
}

export default function UploadSettings({
  uploads,
  onCancelUpload,
  onCancelAllUploads,
  onRetryUpload,
  onClearFinishedUploads,
  onCloseUploadQueue,
  readOnly = false,
}: Props) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const [askClose, setAskClose] = useState(false);

  const total = uploads.length;
  const done = uploads.filter((x) => x.status === 'done').length;
  const failed = uploads.filter((x) => x.status === 'error').length;
  const active = uploads.some((x) => x.status === 'queued' || x.status === 'uploading');
  const hasFinished = uploads.some((x) =>
    ['done', 'skipped', 'canceled'].includes(x.status)
  );
  // 整体进度：完成 / 跳过算 1，上传中按实际 progress 折算
  const pct = total
    ? Math.round(
        (uploads.reduce((sum, x) => {
          if (x.status === 'done' || x.status === 'skipped') return sum + 1;
          if (x.status === 'uploading') return sum + Math.max(0, Math.min(1, x.progress || 0));
          return sum;
        }, 0) /
          total) *
          100
      )
    : 0;

  // 有新任务 / 失败第一次出现时自动展开（用户手动收起后不强行反复展开）
  const prevTotal = useRef(0);
  const prevFailed = useRef(0);
  useEffect(() => {
    if (total > prevTotal.current) setExpanded(true);
    prevTotal.current = total;
  }, [total]);
  useEffect(() => {
    if (failed > 0 && prevFailed.current === 0) setExpanded(true);
    prevFailed.current = failed;
  }, [failed]);

  /** 上传状态文案（组件内翻译，切语言即时生效） */
  const statusLabel = (s: UploadItem['status']): string => {
    switch (s) {
      case 'queued':
        return t('等待中');
      case 'uploading':
        return t('上传中');
      case 'done':
        return t('完成');
      case 'skipped':
        return t('跳过（重复）');
      case 'error':
        return t('失败');
      default:
        return t('已取消');
    }
  };

  // 按「地点 + 到访」分组（保持入队顺序，第一组 = 最早开始上传的）
  const groups: UploadGroup[] = [];
  const byKey = new Map<string, UploadGroup>();
  for (const item of uploads) {
    const key = `${item.placeId ?? '?'}|${item.visitId}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        placeName: item.placeName || t('未知地点'),
        visitDate: item.visitDate || t('未标注日期'),
        items: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  if (readOnly) return null; // 只读样板会话没有上传（设置导航里也不显示这个分类）

  return (
    <div className="set-upload">
      <p className="hint set-upload-hint">
        {t('上传在后台继续，切换地点或关掉设置都不会中断。')}
      </p>

      <div className="upload-queue set-upload-card">
        <div className="uq-head">
          <button
            type="button"
            className={`uq-toggle${expanded ? ' expanded' : ''}`}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={expanded ? t('收起上传列表') : t('展开上传列表')}
          >
            <span className="uq-chevron" aria-hidden="true">
              <svg width="9" height="9" viewBox="0 0 10 10" focusable="false">
                <path
                  d="M3 1.5 7 5 3 8.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span>
              {t('上传队列')} <span className="uq-count">{done}/{total}</span>
            </span>
            {active && <span className="uq-pct">{pct}%</span>}
            {failed > 0 && <span className="uq-failed">{t('失败 {n}', { n: failed })}</span>}
          </button>
          <div className="uq-actions">
            {active && (
              <button type="button" className="text-btn" onClick={onCancelAllUploads}>
                {t('全部取消')}
              </button>
            )}
            {hasFinished && (
              <button type="button" className="text-btn" onClick={onClearFinishedUploads}>
                {t('清除已完成')}
              </button>
            )}
            <button
              type="button"
              className="text-btn danger"
              onClick={() => (failed > 0 ? setAskClose(true) : onCloseUploadQueue())}
            >
              {t('关闭队列')}
            </button>
          </div>
        </div>

        {active && (
          <div className="uq-mini" aria-hidden="true">
            <div className="uq-mini-fill" style={{ width: `${Math.max(3, pct)}%` }} />
          </div>
        )}

        <div className={`uq-list-wrap${expanded ? '' : ' collapsed'}`}>
          <div className="uq-list-inner">
            {groups.length === 0 ? (
              <div className="set-upload-empty">
                <div className="set-upload-empty-title">{t('现在没有上传任务')}</div>
                <p className="hint">
                  {t(
                    '在到访里添加素材（或把照片 / 文件夹拖进地点侧栏）后，上传进度和失败重试会显示在这里。'
                  )}
                </p>
              </div>
            ) : (
              groups.map((group) => {
                const groupDone = group.items.filter(
                  (x) => x.status === 'done' || x.status === 'skipped'
                ).length;
                const groupFailed = group.items.filter((x) => x.status === 'error').length;
                return (
                  <div className="set-upload-group" key={group.key}>
                    <div className="set-upload-group-head">
                      <span className="set-upload-group-place" title={group.placeName}>
                        {group.placeName}
                      </span>
                      <span className="set-upload-group-sep" aria-hidden="true">
                        ·
                      </span>
                      <span className="set-upload-group-date">{group.visitDate}</span>
                      <span className="set-upload-group-count">
                        {t('共 {n} 个 · 已完成 {done} 个', {
                          n: group.items.length,
                          done: groupDone,
                        })}
                      </span>
                      {groupFailed > 0 && (
                        <span className="uq-failed">{t('失败 {n}', { n: groupFailed })}</span>
                      )}
                    </div>
                    <div className="uq-list">
                      {group.items.map((it) => {
                        const itemPct = Math.round(it.progress * 100);
                        const statusText =
                          it.status === 'uploading' && it.progress >= 1
                            ? t('处理中（缩略图）…')
                            : statusLabel(it.status);
                        // 进度到 100% 后服务端还在生成缩略图 / 封面帧，此时中止停不下服务端，隐藏取消
                        const cancelable =
                          it.status === 'queued' ||
                          (it.status === 'uploading' && it.progress < 1);
                        return (
                          <div key={it.key} className={`uq-item ${it.status}`}>
                            <div className="uq-line">
                              <span className="uq-name" title={it.file.name}>
                                {it.file.name}
                              </span>
                              <span className="uq-status">
                                {statusText}
                                {it.status === 'uploading' && it.progress < 1
                                  ? ` ${itemPct}%`
                                  : ''}
                              </span>
                              {cancelable && (
                                <button
                                  type="button"
                                  className="text-btn"
                                  onClick={() => onCancelUpload(it.key)}
                                >
                                  {t('取消')}
                                </button>
                              )}
                              {it.status === 'error' && (
                                <button
                                  type="button"
                                  className="text-btn"
                                  onClick={() => onRetryUpload(it.key)}
                                >
                                  {t('重试')}
                                </button>
                              )}
                            </div>
                            <div className="uq-bar">
                              <div
                                className="uq-fill"
                                style={{
                                  width: `${
                                    it.status === 'done' || it.status === 'skipped'
                                      ? 100
                                      : it.status === 'uploading'
                                        ? Math.max(4, itemPct)
                                        : 0
                                  }%`,
                                }}
                              />
                            </div>
                            {it.status === 'error' && it.error && (
                              <div className="uq-err">{it.error}</div>
                            )}
                            {/* 2026-11-10 D-354：跳过（重复）也显示原因（已存在于哪个地点 · 到访） */}
                            {it.status === 'skipped' && it.error && (
                              <div className="uq-err">{it.error}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* D-261 / D-350：有失败项时关闭队列先二次确认（失败记录清掉后要重新选文件） */}
      {askClose && (
        <ConfirmDialog
          title={t('还有 {n} 个文件上传失败，仍要关闭上传队列？', { n: failed })}
          confirmText={t('仍然关闭')}
          onCancel={() => setAskClose(false)}
          onConfirm={() => {
            setAskClose(false);
            onCloseUploadQueue();
          }}
        >
          <p>{t('关闭后，失败的文件需要重新选择上传（不会自动重试）。')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
