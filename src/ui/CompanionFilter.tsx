import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Companion } from '../lib/types';
import { useT } from '../i18n';
import './CompanionFilter.css';

interface Props {
  /** 当前选中的同行人（可多选，并集语义）；空数组 = 不筛选 */
  value: string[];
  /** 选中/取消某位同行人后回传的完整数组；空数组 = 全部（清除筛选） */
  onChange: (names: string[]) => void;
}

/** 兜底排序：共同地点数降序 → 到访次数降序 → 名字（后端已排，这里再稳一次） */
function sortCompanions(list: Companion[]): Companion[] {
  return [...list].sort(
    (a, b) =>
      (b.places ?? 0) - (a.places ?? 0) ||
      (b.visits ?? 0) - (a.visits ?? 0) ||
      a.name.localeCompare(b.name, 'zh')
  );
}

/**
 * 随行人员筛选（F-BRW-06 / D-59）
 * 入口是时间轴右侧的「筛选」键：点开 popover 可多选同行人（并集），点外面或 Esc 关闭。
 * 只负责「选择与展示」，真正的过滤（地图 / 清单 / 统计）由 App 统一处理；
 * 同行人是自由文本，这里按字面匹配、不做任何归并。列表行点击是切换选中，popover 不关闭，
 * 方便连续勾选；「全部（清除筛选）」清空整个选择。
 */
export default function CompanionFilter({ value, onChange }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Companion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /** 关闭 popover；按 Esc 时把焦点还给「筛选」键 */
  const close = (focusBack = true) => {
    setOpen(false);
    setQ('');
    if (focusBack) window.setTimeout(() => btnRef.current?.focus(), 0);
  };

  // 每次打开都重新拉一次：编辑到访填了新的同行人后，再打开就能看到
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError('');
    api
      .companions()
      .then((res) => {
        if (!alive) return;
        setItems(Array.isArray(res?.items) ? sortCompanions(res.items) : []);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setItems([]);
        setError(e instanceof Error && e.message ? e.message : t('加载失败'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, reloadKey]);

  // 打开后聚焦搜索框，方便直接打字
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 点外面 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const term = q.trim().toLowerCase();
  const shown = useMemo(
    () => (term ? items.filter((it) => it.name.toLowerCase().includes(term)) : items),
    [items, term]
  );

  /** 多选切换：选中 <-> 取消（按字面匹配，不做归并） */
  const toggle = (name: string) => {
    onChange(
      value.includes(name) ? value.filter((n) => n !== name) : [...value, name]
    );
  };

  const clearAll = () => {
    if (value.length > 0) onChange([]);
  };

  return (
    <div className="cf-root" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={value.length > 0 ? 'cf-btn cf-on' : 'cf-btn'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={
          value.length > 0
            ? t('按随行人员筛选（已选 {n} 人）', { n: value.length })
            : t('按随行人员筛选')
        }
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {t('筛选')}
      </button>

      {open && (
        <div className="cf-pop" role="dialog" aria-label={t('随行人员筛选')}>
          <div className="cf-pop-head">
            <span className="cf-pop-title">{t('随行人员')}</span>
            {!loading && !error && items.length > 0 && (
              <span className="cf-pop-count">
                {t('已选 {selected} 人 · 共 {total} 人', {
                  selected: value.length,
                  total: items.length,
                })}
              </span>
            )}
          </div>

          <input
            ref={searchRef}
            className="cf-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('搜索同行人')}
            aria-label={t('搜索同行人')}
            spellCheck={false}
          />

          <div className="cf-list">
            <button
              type="button"
              className={value.length === 0 ? 'cf-item cf-all cf-on' : 'cf-item cf-all'}
              aria-pressed={value.length === 0}
              onClick={clearAll}
            >
              <span className="cf-item-main">
                <span className="cf-item-name">{t('全部（清除筛选）')}</span>
              </span>
              {value.length === 0 && (
                <span className="cf-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>

            {!loading && !error && items.length > 0 && <div className="cf-sep" />}

            {loading && <div className="cf-hint">{t('加载中…')}</div>}

            {!loading && error && (
              <div className="cf-hint cf-err" title={error}>
                {t('同行人列表加载失败')}
                <button
                  type="button"
                  className="cf-retry"
                  onClick={() => setReloadKey((n) => n + 1)}
                >
                  {t('重试')}
                </button>
              </div>
            )}

            {!loading && !error && items.length === 0 && (
              <div className="cf-hint">
                {t('还没有记录过同行人；编辑到访时填「同行人」即可。')}
              </div>
            )}

            {!loading && !error && items.length > 0 && shown.length === 0 && (
              <div className="cf-hint">{t('没有匹配「{q}」的同行人', { q: q.trim() })}</div>
            )}

            {!loading &&
              shown.map((it) => {
                const on = value.includes(it.name);
                return (
                  <button
                    key={it.name}
                    type="button"
                    className={on ? 'cf-item cf-on' : 'cf-item'}
                    aria-pressed={on}
                    title={it.name}
                    onClick={() => toggle(it.name)}
                  >
                    <span className="cf-item-main">
                      <span className="cf-item-name">{it.name}</span>
                      <span className="cf-item-meta">
                        {t('{places} 个共同地点 · {visits} 次到访', {
                          places: it.places ?? 0,
                          visits: it.visits ?? 0,
                        })}
                      </span>
                    </span>
                    {on && (
                      <span className="cf-check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
