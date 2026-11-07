import { useEffect, useRef, useState } from 'react';
import type { DraftState } from '../App';
import { useT, useTp } from '../i18n';
import type { Poi } from '../lib/types';
import Segmented from './Segmented';
import CloseIcon from './CloseIcon';
import DatePicker from './DatePicker';

interface Props {
  draft: DraftState | null;
  saving: boolean;
  onSearch: (q: string) => Promise<Poi[]>;
  onPick: (p: Poi) => void;
  onChange: (patch: Partial<DraftState>) => void;
  onSave: () => void;
  onCancel: () => void;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function AddPanel({
  draft,
  saving,
  onSearch,
  onPick,
  onChange,
  onSave,
  onCancel,
}: Props) {
  const t = useT();
  const tp = useTp();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Poi[]>([]);
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hi, setHi] = useState(0);
  const timer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (draft) return;
    if (timer.current) window.clearTimeout(timer.current);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      setSearching(true);
      setErr(null);
      try {
        const r = await onSearch(q.trim());
        setResults(r);
        setHi(0);
      } catch (e: any) {
        setResults([]);
        setErr(e?.message || String(e));
      } finally {
        setSearching(false);
      }
    }, 600);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [q, draft]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
      return;
    }
    if (!results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((h) => (h + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => (h - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onPick(results[hi]);
    }
  };

  const region = draft?.addr
    ? [tp(draft.addr.province), draft.addr.city, draft.addr.county].filter(Boolean).join(' · ')
    : '';

  return (
    <aside className="panel" onKeyDown={onKey}>
      <div className="panel-head">
        <span className="title">{draft ? t('确认足迹') : t('+ 添加足迹')}</span>
        <button className="icon" onClick={onCancel} aria-label={t('关闭')}>
          <CloseIcon />
        </button>
      </div>

      {!draft && (
        <>
          <div className="search">
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('搜地名：西湖 / 青海湖 / 杭州')}
              spellCheck={false}
            />
          </div>

          {searching && <div className="muted pad">{t('搜索中…')}</div>}

          {!searching && q && results.length === 0 && (
            <div className="muted pad">
              {err ? (
                <>
                  {t('搜索失败：{err}', { err })}
                  <br />
                  {t('多半是天地图接口限流，等 2 秒再试一次。')}
                </>
              ) : (
                <>
                  {t('没有找到「{q}」。换个说法试试（比如加城市名）， 或者搜最近的镇，再把标记拖过去。', {
                    q,
                  })}
                </>
              )}
            </div>
          )}

          <ul className="results">
            {results.map((p, i) => (
              <li
                key={`${p.name}-${p.lnglat}-${i}`}
                className={i === hi ? 'active' : ''}
                onMouseEnter={() => setHi(i)}
                onClick={() => onPick(p)}
              >
                <div className="r-name">
                  {p.name}
                  {p.source === 'geocode' && <span className="r-tag">{t('行政区')}</span>}
                </div>
                <div className="r-addr">{p.address || '—'}</div>
              </li>
            ))}
          </ul>

          {!q && (
            <div className="muted pad">
              {t('输入任意层级的地名：省、市、区县、景点都行。')}
              <br />
              {t('选中后地图会飞过去，再拖动标记微调位置。')}
              <br />
              {t('也可以直接在地图上点选位置（缩放 ≥ 6）——此刻光标已经是飞镖，点哪落哪。')}
            </div>
          )}
        </>
      )}

      {draft && (
        <>
          <div className="form">
            <label className="field">
              <span>{t('名称')}</span>
              <input
                value={draft.name}
                autoFocus
                onChange={(e) => onChange({ name: e.target.value, nameTouched: true })}
              />
            </label>

            <div className="field-static">
              <span>{t('位置')}</span>
              <div className="value">{region || t('定位中…')}</div>
            </div>

            <div className="field-static">
              <span>{t('坐标')}</span>
              <div className="value mono">
                {draft.lng.toFixed(5)}, {draft.lat.toFixed(5)}
              </div>
            </div>

            {draft.kind === 'visited' && (
              <div className="field">
                <span>{t('日期')}</span>
                <div className="row">
                  <button
                    className={draft.date === today() ? 'chip on' : 'chip'}
                    onClick={() => onChange({ date: today() })}
                  >
                    {t('今天')}
                  </button>
                  <DatePicker value={draft.date} onChange={(date) => onChange({ date })} />
                </div>
              </div>
            )}

            <div className="field">
              <span>{t('类型')}</span>
              <Segmented<'visited' | 'wishlist'>
                variant="radio"
                ariaLabel={t('类型')}
                options={[
                  { id: 'visited', label: t('去过') },
                  { id: 'wishlist', label: t('想去') },
                ]}
                value={draft.kind}
                onChange={(kind) => onChange({ kind })}
              />
            </div>

            {draft.kind === 'wishlist' && (
              <p className="hint">
                {t('想去的地点不用填日期；之后真去了，在侧栏点「转为去过」再记日期。')}
              </p>
            )}

            <p className="hint">
              {t('地图上的大号标记可以拖动，拖到准确位置后会自动更新行政区。')}
            </p>
          </div>

          <div className="panel-foot">
            <button className="ghost" onClick={onCancel}>
              {t('取消')}
            </button>
            <button className="primary" onClick={onSave} disabled={saving}>
              {saving ? t('保存中…') : t('保存并添加照片')}
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
