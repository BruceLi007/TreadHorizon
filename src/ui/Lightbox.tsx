import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useT } from '../i18n';
import type { MediaItem } from '../lib/types';
import CloseIcon from './CloseIcon';

/** 视频缩略图上的播放角标（2026-11-06 D-198：胶片带里的视频用） */
function PlayBadge() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden="true" focusable="false">
      <path d="M8 5.4v13.2L19.2 12z" fill="currentColor" />
    </svg>
  );
}

/** 灯箱左右翻页箭头（2026-11-05 D-166 第 2 步：用 SVG 替代 `‹ ›` 字形，避免字体差异） */
function NavArrow({ dir }: { dir: 'prev' | 'next' }) {
  return (
    <svg viewBox="0 0 16 16" width={30} height={30} aria-hidden="true" focusable="false">
      <path
        d={dir === 'prev' ? 'M10.2 3.2 5.4 8l4.8 4.8' : 'M5.8 3.2 10.6 8l-4.8 4.8'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface Props {
  items: MediaItem[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
  /** F-BRW-05：从灯箱跳到照片墙并定位到这张（App 负责关灯箱 / 开照片墙） */
  onGotoWall?: (mediaId: string) => void;
  /**
   * D-358（用户要求）：灯箱里直接删除当前照片 / 视频（父组件负责调接口 + 刷新列表）。
   * 不传 = 只读样板会话 / 不需要删除入口，此时不显示删除按钮。
   */
  onDelete?: (item: MediaItem) => Promise<void> | void;
}

const MIN = 1;
const MAX = 6;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function Lightbox({ items, index, onClose, onIndex, onGotoWall, onDelete }: Props) {
  const t = useT();
  const cur = items[index];
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 底部胶片带（D-198）：横向滚动的缩略图条，当前项自动滚到中间 */
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripFirstScroll = useRef(true);

  // 缩放 + 平移（只对图片有效）
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  /** D-358：正在删除当前项（按钮显示「删除中…」并禁止重复点） */
  const [deleting, setDeleting] = useState(false);
  /** D-358：删除结果提示（不跟翻页重置，几秒后自动消失） */
  const [flash, setFlash] = useState<{ text: string; bad: boolean } | null>(null);
  const flashTimer = useRef<number | null>(null);
  const showFlash = useCallback((text: string, bad = false) => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    setFlash({ text, bad });
    flashTimer.current = window.setTimeout(() => setFlash(null), 4200);
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current) window.clearTimeout(flashTimer.current);
    },
    []
  );

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ dist: number; s: number } | null>(null);
  const panStart = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // 翻页 / 关闭时复位
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setView({ s: 1, x: 0, y: 0 });
    setMsg(null);
    pointers.current.clear();
    pinchStart.current = null;
    panStart.current = null;
  }, [index]);

  /** 相对舞台中心的坐标（transform-origin 是 center） */
  const centerOf = (clientX: number, clientY: number) => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return { cx: 0, cy: 0 };
    return { cx: clientX - (r.left + r.width / 2), cy: clientY - (r.top + r.height / 2) };
  };

  const zoomAt = useCallback((factor: number, clientX: number, clientY: number) => {
    const { cx, cy } = centerOf(clientX, clientY);
    setView((v) => {
      const s1 = clamp(v.s * factor, MIN, MAX);
      if (s1 === v.s) return v;
      if (s1 === MIN) return { s: MIN, x: 0, y: 0 };
      const k = s1 / v.s;
      return { s: s1, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }, []);

  // 滚轮缩放
  useEffect(() => {
    const el = stageRef.current;
    if (!el || cur?.kind !== 'photo') return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [cur?.id, cur?.kind, zoomAt]);

  // 键盘
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowRight') {
        onIndex((index + 1) % items.length);
        return;
      }
      if (e.key === 'ArrowLeft') {
        onIndex((index - 1 + items.length) % items.length);
        return;
      }
      if (cur?.kind !== 'photo') return;
      if (e.key === '+' || e.key === '=') {
        const r = stageRef.current?.getBoundingClientRect();
        zoomAt(1.25, r ? r.left + r.width / 2 : 0, r ? r.top + r.height / 2 : 0);
      } else if (e.key === '-') {
        const r = stageRef.current?.getBoundingClientRect();
        zoomAt(1 / 1.25, r ? r.left + r.width / 2 : 0, r ? r.top + r.height / 2 : 0);
      } else if (e.key === '0') {
        setView({ s: 1, x: 0, y: 0 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onClose, onIndex, zoomAt, cur?.kind]);

  // ── 底部胶片带（2026-11-06 D-198）──
  // 翻页 / 打开灯箱时，把当前缩略图滚到可视区中间；首次打开直接跳到位（不做动画）。
  useEffect(() => {
    const strip = stripRef.current;
    const el = strip?.querySelector<HTMLElement>('.lb-thumb.on');
    if (!strip || !el) return;
    const sr = strip.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const delta = er.left + er.width / 2 - (sr.left + sr.width / 2);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const smooth = !stripFirstScroll.current && !reduce;
    stripFirstScroll.current = false;
    strip.scrollTo({ left: strip.scrollLeft + delta, behavior: smooth ? 'smooth' : 'auto' });
  }, [index]);

  // 胶片带：鼠标滚轮 / 触摸板纵向滚动转成横向滚动（悬停在缩略图上时不再缩放主图）。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, [items.length]);

  // ── 指针：拖拽平移 + 双指缩放 ──
  const onPointerDown = (e: React.PointerEvent) => {
    if (cur?.kind !== 'photo') return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), s: view.s };
      panStart.current = null;
      setDragging(true);
    } else if (pointers.current.size === 1 && view.s > 1) {
      panStart.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
      setDragging(true);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStart.current.dist > 0) {
        const next = clamp((d / pinchStart.current.dist) * pinchStart.current.s, MIN, MAX);
        setView((v) => {
          if (next === MIN) return { s: MIN, x: 0, y: 0 };
          return { ...v, s: next };
        });
      }
      return;
    }

    if (panStart.current) {
      const dx = e.clientX - panStart.current.px;
      const dy = e.clientY - panStart.current.py;
      setView((v) => ({ ...v, x: panStart.current!.x + dx, y: panStart.current!.y + dy }));
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (pointers.current.size === 0) {
      panStart.current = null;
      setDragging(false);
    }
  };

  // D-358（用户要求）：浏览照片 / 视频时随时可删——点删除键直接移到回收站（可恢复），
  // 与侧栏单张素材删除（D-56）一致不弹确认；删掉最后一张时父组件会关灯箱。
  const handleDelete = async () => {
    if (!onDelete || !cur || deleting) return;
    setDeleting(true);
    try {
      await onDelete(cur);
      showFlash(t('已移到回收站（可在回收站恢复）'));
    } catch (e: any) {
      showFlash(t('删除失败：{msg}', { msg: e?.message || e }), true);
    } finally {
      setDeleting(false);
    }
  };

  if (!cur) return null;

  const zoomed = view.s > 1.001;
  const hasStrip = items.length > 1;

  return (
    <div className={hasStrip ? 'lightbox has-strip' : 'lightbox'} onClick={onClose}>
      <button className="icon lb-close" onClick={onClose} aria-label={t('关闭')} title={t('关闭')}>
        <CloseIcon />
      </button>

      {items.length > 1 && (
        <>
          <button
            type="button"
            className="lb-nav prev"
            aria-label={t('上一张')}
            title={t('上一张')}
            onClick={(e) => {
              e.stopPropagation();
              onIndex((index - 1 + items.length) % items.length);
            }}
          >
            <NavArrow dir="prev" />
          </button>
          <button
            type="button"
            className="lb-nav next"
            aria-label={t('下一张')}
            title={t('下一张')}
            onClick={(e) => {
              e.stopPropagation();
              onIndex((index + 1) % items.length);
            }}
          >
            <NavArrow dir="next" />
          </button>
        </>
      )}

      <div className="lb-stage" ref={stageRef} onClick={(e) => e.stopPropagation()}>
        {cur.kind === 'photo' ? (
          <img
            src={api.previewUrl(cur.id)}
            alt=""
            draggable={false}
            className={zoomed ? 'zoomed' : ''}
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
              cursor: zoomed ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (view.s > 1.001) setView({ s: 1, x: 0, y: 0 });
              else zoomAt(2.5, e.clientX, e.clientY);
            }}
          />
        ) : (
          <video src={api.origUrl(cur.id)} controls autoPlay playsInline />
        )}
      </div>

      {/* 底部胶片带（2026-11-06 D-198）：当前序列的缩略图，横向滚动 / 点击切换 */}
      {hasStrip && (
        <div
          className="lb-strip"
          ref={stripRef}
          onClick={(e) => e.stopPropagation()}
          role="group"
          aria-label={t('灯箱缩略图')}
        >
          <div className="lb-strip-inner">
            {items.map((it, i) => (
              <button
                key={it.id}
                type="button"
                className={i === index ? 'lb-thumb on' : 'lb-thumb'}
                onClick={() => onIndex(i)}
                aria-label={t('第 {n} 项', { n: i + 1 })}
                aria-current={i === index ? 'true' : undefined}
                title={t('第 {n} 项', { n: i + 1 })}
              >
                <img src={api.thumbUrl(it.id)} alt="" loading="lazy" draggable={false} />
                {it.kind === 'video' && (
                  <span className="lb-thumb-play" aria-hidden="true">
                    <PlayBadge />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span>
          {index + 1} / {items.length}
        </span>
        {cur.kind === 'photo' && (
          <span className="lb-zoom">
            {Math.round(view.s * 100)}%
            {zoomed && (
              <button className="lb-reset" onClick={() => setView({ s: 1, x: 0, y: 0 })}>
                {t('复位')}
              </button>
            )}
          </span>
        )}
        <a href={api.origUrl(cur.id)} target="_blank" rel="noreferrer">
          {t('查看原图')}
        </a>
        {onGotoWall && (
          <button className="lb-reset" onClick={() => onGotoWall(cur.id)}>
            {t('在照片墙中查看')}
          </button>
        )}
        {/* D-358（用户要求）：灯箱内删当前照片 / 视频（移到回收站，可恢复） */}
        {onDelete && (
          <button
            type="button"
            className="lb-reset lb-del"
            onClick={() => void handleDelete()}
            disabled={deleting}
            title={t('删除（移到回收站，可恢复）')}
            aria-label={t('删除（移到回收站，可恢复）')}
          >
            {deleting ? t('删除中…') : t('删除')}
          </button>
        )}
        <button
          className="lb-reset"
          onClick={async () => {
            setMsg(null);
            try {
              const r = await api.revealMedia(cur.id);
              setMsg(r.missing ? t('文件不在了，已打开所在文件夹') : t('已在资源管理器中定位'));
            } catch (e: any) {
              setMsg(t('打开失败：{msg}', { msg: e?.message || e }));
            }
          }}
        >
          {t('打开本地文件夹')}
        </button>
        {msg && <span className="lb-msg">{msg}</span>}
        {flash && <span className={flash.bad ? 'lb-msg err' : 'lb-msg'}>{flash.text}</span>}
      </div>

      {cur.kind === 'photo' && !zoomed && (
        <div className="lb-hint">{t('滚轮 / 双指缩放 · 双击放大 · 拖动平移')}</div>
      )}
    </div>
  );
}
