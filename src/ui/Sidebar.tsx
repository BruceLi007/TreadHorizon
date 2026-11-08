import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type SetStateAction,
} from 'react';
import { api } from '../lib/api';
import { collectFolderDrop } from '../lib/folderDrop';
import { fmtKm } from '../lib/geo';
import { normalizeRegion, regionFromText, PROVINCE_FULL_NAMES } from '../lib/region';
import { useT, useTp } from '../i18n';
import type { MediaItem, PlaceDetail, UploadItem, Visit } from '../lib/types';
import type { MediaCols } from './settings/types';
import { MEDIA_COLS } from './settings/types';
import { FolderIcon } from './TreeIcons';
import Segmented from './Segmented';
import CloseIcon from './CloseIcon';
import DatePicker from './DatePicker';
import ConfirmDialog from './ConfirmDialog';
// 秘密基地共用样式（styles.css 由 Lead 维护，本任务不改）
import './SecretPrompt.css';

interface Props {
  detail: PlaceDetail;
  onClose: () => void;
  /** 从哪一层打开（D-290）：标题栏左上「← 返回」的文案与返回目标由这个决定 */
  entry?: 'map' | 'trail' | 'cluster';
  /** 返回上一层：地图 = 关闭详情回地图；My旅迹 = 回列表；这一簇 = 回簇面板（D-290） */
  onBack?: () => void;
  /** 点地区面包屑：在 My旅迹里展开到该省 / 市 / 地点并高亮（D-290） */
  onLocateInMyTrail?: (level: 'province' | 'city' | 'place') => void;
  /** 从 My旅迹「+ 添加一次到访」进来：自动展开新增到访表单（D-109） */
  autoAddVisit?: boolean;
  /** 自动展开一次后通知 App 清掉标记，避免每次打开都自动弹 */
  onAutoAddVisitHandled?: () => void;
  /** F-MED-10 上传队列（状态由 App 管理，关掉侧栏也会继续传） */
  uploads: UploadItem[];
  onPickFiles: (visitId: string, files: File[]) => void;
  /** 拖文件夹等操作的轻提示（App 传 say；不传则静默） */
  onToast?: (msg: string) => void;
  onCancelUpload: (key: string) => void;
  onCancelAllUploads: () => void;
  onRetryUpload: (key: string) => void;
  onClearFinishedUploads: () => void;
  /** 关闭上传队列卡片（有未完成项时会先中止/清空） */
  onCloseUploadQueue: () => void;
  onOpenLightbox: (visitId: string, index: number) => void;
  onChanged: () => void;
  onDeleted: () => void;
  /** 媒体删除后给 App 一个 toast 提示（已移到回收站） */
  onTrashed?: () => void;
  /** F-PLC-08：打开「合并到…」面板 */
  onMerge: (detail: PlaceDetail) => void;
  /** F-PLC-11：是否已设置秘密基地密码（App 传入；未设置时开启秘密基地会先提示去设置） */
  secretConfigured?: boolean;
  /** 到访照片每行张数（2026-11-04，D-116）：2 / 3 / 4 / 5；由 App 持有并写 localStorage */
  mediaCols: MediaCols;
  onMediaColsChange: (n: MediaCols) => void;
  /** 离家距离（km，2026-11-06 用户需求）：由 App 按「家」地点坐标算好；未设家 / 地点本身是家时为 null */
  homeDistanceKm?: number | null;
}

const fmtDuration = (s?: number | null) => {
  if (!s || !Number.isFinite(s) || s <= 0) return '';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
};

const splitCompanions = (s: string) =>
  s
    .split(/[、,，;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** 「今天」YYYY-MM-DD（新建到访的默认日期，与 + 添加一次到访 一致） */
const todayISO = () => new Date().toISOString().slice(0, 10);

/** 相册里的一格：缩略图 / 视频封面帧 + 悬停操作（封面 / 移动 / 删除） */
function MediaTile({
  m,
  cover,
  onClick,
  onCover,
  onMove,
  onReveal,
  onDelete,
}: {
  m: MediaItem;
  cover: boolean;
  onClick: () => void;
  onCover: () => void;
  onMove: () => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [broken, setBroken] = useState(false);
  const dur = fmtDuration(m.duration);
  return (
    <div className="tile-wrap">
      <button className={cover ? 'tile cover' : 'tile'} onClick={onClick}>
        {!broken ? (
          <img src={api.thumbUrl(m.id)} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <span className="play">{m.kind === 'video' ? '▶' : '▨'}</span>
        )}
        {m.kind === 'video' && !broken && <span className="play-badge">▶</span>}
        {m.kind === 'video' && dur && <span className="dur">{dur}</span>}
        {cover && <span className="cover-flag">{t('封面')}</span>}
      </button>
      <div className="tile-actions">
        <button
          type="button"
          title={t('设为封面')}
          aria-label={t('设为封面')}
          onClick={(e) => {
            e.stopPropagation();
            onCover();
          }}
        >
          {/* D-166 第 3 步：4 个操作键统一 20×20 深底白 SVG（不再混用 ★ / ⇄ / × 文字字形） */}
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <path
              d="M8 1.9l1.86 3.77 4.16.6-3.01 2.94.71 4.14L8 11.4l-3.72 1.95.71-4.14L1.98 6.27l4.16-.6z"
              fill="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          title={t('移动到别的到访')}
          aria-label={t('移动到别的到访')}
          onClick={(e) => {
            e.stopPropagation();
            onMove();
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <g
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2.2 5.2h9.6" />
              <path d="M9.4 2.8 11.8 5.2 9.4 7.6" />
              <path d="M13.8 10.8H4.2" />
              <path d="M6.6 8.4 4.2 10.8l2.4 2.4" />
            </g>
          </svg>
        </button>
        <button
          type="button"
          title={t('打开本地文件夹')}
          aria-label={t('打开本地文件夹')}
          onClick={(e) => {
            e.stopPropagation();
            onReveal();
          }}
        >
          {/* 用 SVG 而不是 emoji：emoji 在不同字体下垂直居中不一致 */}
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <path
              d="M1.6 3.6h4.1l1.3 1.6h7.4v8.2H1.6z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          title={t('删除（移到回收站，可恢复）')}
          aria-label={t('删除（移到回收站，可恢复）')}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <CloseIcon size={12} />
        </button>
      </div>
    </div>
  );
}

/** 到访编辑表单的数据（新增到访与编辑已有到访共用，2026-11-04 D-102） */
interface VForm {
  date: string;
  title: string;
  note: string;
  rating: number;
  companions: string;
}

/** 到访编辑表单：日期 / 标题 / 评分 / 同行人 / 笔记 + 取消/保存 */
function VisitFormEditor({
  form,
  setForm,
  err,
  saving,
  onSave,
  onCancel,
}: {
  form: VForm;
  setForm: Dispatch<SetStateAction<VForm>>;
  err: string | null;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className="visit-form">
        <div className="vf-row">
          <div className="field vf-date">
            <span>{t('日期')}</span>
            <DatePicker
              value={form.date}
              onChange={(date) => setForm((f) => ({ ...f, date }))}
            />
          </div>
          <label className="field">
            <span>{t('标题')}</span>
            <input
              value={form.title}
              placeholder={t('可选')}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
          </label>
        </div>

        <div className="vf-row">
          <div className="field vf-rating">
            <span>{t('评分')}</span>
            <div className="stars">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={form.rating >= n ? 'on' : ''}
                  onClick={() => setForm((f) => ({ ...f, rating: f.rating === n ? 0 : n }))}
                  title={t('{n} 星', { n })}
                >
                  {form.rating >= n ? '★' : '☆'}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>{t('同行人（用、或逗号分隔）')}</span>
            <input
              value={form.companions}
              placeholder={t('小王、小李')}
              onChange={(e) => setForm((f) => ({ ...f, companions: e.target.value }))}
            />
          </label>
        </div>

        <label className="field">
          <span>{t('笔记')}</span>
          <textarea
            rows={2}
            value={form.note}
            placeholder={t('这次旅行…')}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
        </label>

        {err && <p className="hint err">{err}</p>}
      </div>
      <div className="vf-actions">
        <button className="ghost" onClick={onCancel} disabled={saving}>
          {t('取消')}
        </button>
        <button className="primary" onClick={onSave} disabled={saving}>
          {saving ? t('保存中…') : t('保存')}
        </button>
      </div>
    </>
  );
}

export default function Sidebar({
  detail,
  onClose,
  entry = 'map',
  onBack,
  onLocateInMyTrail,
  autoAddVisit = false,
  onAutoAddVisitHandled,
  uploads,
  onPickFiles,
  onToast,
  onCancelUpload,
  onCancelAllUploads,
  onRetryUpload,
  onClearFinishedUploads,
  onCloseUploadQueue,
  onOpenLightbox,
  onChanged,
  onDeleted,
  onTrashed,
  onMerge,
  secretConfigured = false,
  mediaCols,
  onMediaColsChange,
  homeDistanceKm = null,
}: Props) {
  const t = useT();
  const tp = useTp();
  const fileRef = useRef<HTMLInputElement>(null);
  /** 点某个到访照片格里的「+」时，记住这次上传要加到哪个到访（D-110） */
  const pendingPickVisit = useRef<string | null>(null);
  /** 到访列表滚动容器：点「+ 添加一次到访」时把新表单滚到视口顶部 */
  const visitsRef = useRef<HTMLDivElement | null>(null);
  const [target, setTarget] = useState<string | null>(detail.visits[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 编辑地点（F-PLC-04：只改名称/类型，坐标不可改，见 D-21）
  const [editingPlace, setEditingPlace] = useState(false);
  const [name, setName] = useState(detail.name);
  const [kind, setKind] = useState<'visited' | 'wishlist'>(detail.kind);
  /**
   * 2026-11-08 D-284（用户要求）：地区（省 / 市 / 区县）允许手动编辑——
   * 逆地理识别不到的（如澳门只返回省级、香港个别离岸点连省都不返回）由用户自己填。
   * 编辑时先放一份草稿，点「保存」才写回；坐标仍不可改。
   */
  const [province, setProvince] = useState(detail.province ?? '');
  const [city, setCity] = useState(detail.city ?? '');
  const [county, setCounty] = useState(detail.county ?? '');
  const [refilling, setRefilling] = useState(false);
  // 秘密基地开关（F-PLC-11）：本地先记一份，onChanged 后 App 重新拉详情会同步回来
  const [secretOn, setSecretOn] = useState(detail.secret === 1);
  // 家开关（2026-11-04）：唯一一个普通地点，onChanged 后靠 detail.home 同步
  const [homeOn, setHomeOn] = useState(detail.home === 1);
  const [confirmingPlace, setConfirmingPlace] = useState(false);

  // 编辑到访（F-VST-03）
  const [editingVisit, setEditingVisit] = useState<string | null>(null);
  /** 新增到访：点「+ 添加一次到访」先打开编辑表单，保存时才真正创建（D-102） */
  const [addingVisit, setAddingVisit] = useState(false);
  const [vform, setVform] = useState<VForm>({
    date: '',
    title: '',
    note: '',
    rating: 0,
    companions: '',
  });
  // 删除到访（F-VST-04）
  const [confirmingVisit, setConfirmingVisit] = useState<string | null>(null);
  const [askDeletePlace, setAskDeletePlace] = useState(false);
  // D-246：拖文件夹到侧栏 → 按文件夹名新建一次到访并批量上传
  const [folderDropActive, setFolderDropActive] = useState(false);
  const [folderDropBusy, setFolderDropBusy] = useState(false);
  const folderDragDepth = useRef(0);

  // 媒体操作（F-MED-05 / F-MED-06）
  const [moving, setMoving] = useState<string | null>(null);

  // 上传队列卡片的本地关闭兜底：即使父组件的状态没来得及清（或 HMR 旧闭包），点 × 也应立刻收起
  const [queueClosed, setQueueClosed] = useState(false);
  // 2026-11-07 D-261：有上传失败项时，点 × 先弹确认，避免把「失败 + 可重试」记录静默清掉
  const [closeQueueAsk, setCloseQueueAsk] = useState(false);
  const prevUploadLen = useRef(0);
  useEffect(() => {
    if (uploads.length === 0) {
      setQueueClosed(false);
      setCloseQueueAsk(false);
      prevUploadLen.current = 0;
      return;
    }
    // 新加了一批文件 → 重新显示队列
    if (uploads.length > prevUploadLen.current) {
      setQueueClosed(false);
      setCloseQueueAsk(false);
    }
    prevUploadLen.current = uploads.length;
  }, [uploads.length]);

  // 换到别的地点时复位所有状态
  useEffect(() => {
    setEditingPlace(false);
    setConfirmingPlace(false);
    setEditingVisit(null);
    setAddingVisit(false);
    setConfirmingVisit(null);
    setAskDeletePlace(false);
    setMoving(null);
    setSaving(false);
    setErr(null);
    setName(detail.name);
    setKind(detail.kind);
    setSecretOn(detail.secret === 1);
    setHomeOn(detail.home === 1);
    setTarget(detail.visits[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id]);

  // 详情刷新（onChanged 后 App 重新拉取）时同步秘密基地标签/开关
  useEffect(() => {
    setSecretOn(detail.secret === 1);
  }, [detail.secret]);

  // 详情刷新时同步「家」开关（家唯一，可能被别的地点抢走）
  useEffect(() => {
    setHomeOn(detail.home === 1);
  }, [detail.home]);

  const region = [tp(detail.province), detail.city, detail.county].filter(Boolean).join(' · ');
  const activeVisit = detail.visits.find((v) => v.id === (target ?? detail.visits[0]?.id));
  const total = detail.visits.reduce((n, v) => n + v.media.length, 0);

  /** 选完文件：优先用「+」格子记录的到访，否则用当前选中的到访 */
  const onFilesPicked = (files: FileList | null, visitId?: string) => {
    const id = visitId ?? pendingPickVisit.current ?? activeVisit?.id;
    pendingPickVisit.current = null;
    if (!files || !id) return;
    onPickFiles(id, Array.from(files));
  };

  /** 点某次到访照片格的「+」：把目标切到这次到访再打开文件选择（D-110） */
  const startPickForVisit = (visitId: string) => {
    pendingPickVisit.current = visitId;
    setTarget(visitId);
    fileRef.current?.click();
  };

  // ── D-246：拖文件夹到侧栏 → 按文件夹名新建一次到访并批量上传 ──
  const hasFileDrag = (e: DragEvent<HTMLElement>) => {
    const types = e.dataTransfer?.types;
    return Boolean(types && Array.from(types).includes('Files'));
  };

  const onPanelDragEnter = (e: DragEvent<HTMLElement>) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    folderDragDepth.current += 1;
    setFolderDropActive(true);
  };

  const onPanelDragOver = (e: DragEvent<HTMLElement>) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  const onPanelDragLeave = (e: DragEvent<HTMLElement>) => {
    if (!hasFileDrag(e)) return;
    folderDragDepth.current = Math.max(0, folderDragDepth.current - 1);
    if (folderDragDepth.current === 0) setFolderDropActive(false);
  };

  const onPanelDrop = async (e: DragEvent<HTMLElement>) => {
    if (!hasFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    folderDragDepth.current = 0;
    setFolderDropActive(false);
    if (folderDropBusy) return;
    if (detail.kind === 'wishlist') {
      onToast?.(t('这个地点还是「想去」，先转为「去过」再拖文件夹'));
      return;
    }
    setFolderDropBusy(true);
    try {
      const items = Array.from(e.dataTransfer?.items ?? []);
      const { folders, looseFiles, skipped } = await collectFolderDrop(items);
      let created = 0;
      let queued = 0;
      let lastCreatedId: string | null = null;
      for (const folder of folders) {
        if (!folder.files.length) {
          onToast?.(t('文件夹「{name}」里没有可上传的图片 / 视频', { name: folder.name }));
          continue;
        }
        try {
          const before = new Set(detail.visits.map((v) => v.id));
          const updated = await api.addVisit(detail.id, {
            date: todayISO(),
            title: folder.name.slice(0, 100),
          });
          const createdVisit = updated.visits.find((v) => !before.has(v.id));
          if (!createdVisit) throw new Error(t('新建到访后找不到它'));
          created += 1;
          queued += folder.files.length;
          lastCreatedId = createdVisit.id;
          onPickFiles(createdVisit.id, folder.files);
        } catch (err: any) {
          onToast?.(t('按文件夹新建到访失败：{msg}', { msg: err?.message || String(err) }));
        }
      }
      if (looseFiles.length) {
        const targetId = activeVisit?.id ?? detail.visits[0]?.id;
        if (targetId) {
          onPickFiles(targetId, looseFiles);
          queued += looseFiles.length;
        } else {
          onToast?.(t('先添加一次到访，再把零散文件拖进来'));
        }
      }
      if (created || queued) {
        if (lastCreatedId) setTarget(lastCreatedId);
        onChanged();
        const skippedText =
          skipped > 0 ? ' · ' + t('已忽略 {n} 个非图片 / 视频文件', { n: skipped }) : '';
        const msg =
          created > 0
            ? t('已按文件夹名新建 {n} 次到访，开始上传 {files} 个文件', {
                n: created,
                files: queued,
              })
            : t('已加入上传队列：{files} 个文件', { files: queued });
        onToast?.(msg + skippedText);
      } else if (skipped > 0) {
        onToast?.(t('已忽略 {n} 个非图片 / 视频文件', { n: skipped }));
      } else {
        onToast?.(t('没有识别到可上传的文件夹或图片 / 视频'));
      }
    } finally {
      setFolderDropBusy(false);
    }
  };

  /** F-MED-09：打开本地文件夹（服务端调资源管理器） */
  const revealMedia = async (m: MediaItem) => {
    setErr(null);
    try {
      const r = await api.revealMedia(m.id);
      if (r.missing) setErr(t('文件已经不在素材库里了；已打开它原来所在的文件夹。'));
    } catch (e: any) {
      setErr(t('打开本地文件夹失败：{msg}', { msg: e?.message || e }));
    }
  };

  /**
   * 「+ 添加一次到访」：不立刻建一条空到访，而是先打开**编辑表单**（日期默认今天），
   * 用户填好后点「保存」才真正创建；取消不会留下空记录（2026-11-04，D-102）。
   */
  const startAddVisit = () => {
    setVform({
      date: todayISO(),
      title: '',
      note: '',
      rating: 0,
      companions: '',
    });
    setAddingVisit(true);
    setEditingVisit(null);
    setErr(null);
    // 表单在列表顶部：下一帧滚到顶，确保「点了就直接看到编辑页」
    window.requestAnimationFrame(() => {
      visitsRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    });
  };

  const cancelAddVisit = () => {
    setAddingVisit(false);
    setErr(null);
  };

  // 从 My旅迹「+ 添加一次到访」入口进来：自动展开一次新增表单（D-109）
  useEffect(() => {
    if (!autoAddVisit) return;
    startAddVisit();
    onAutoAddVisitHandled?.();
    // 只消费一次；startAddVisit 每次渲染都是新函数，不放进依赖避免重复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAddVisit]);

  const saveNewVisit = async () => {
    if (!vform.date) {
      setErr(t('日期不能为空'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const before = new Set(detail.visits.map((v) => v.id));
      const d = await api.addVisit(detail.id, {
        date: vform.date,
        title: vform.title.trim() || null,
        note: vform.note || null,
        rating: vform.rating || null,
        companions: splitCompanions(vform.companions),
      });
      const created = d.visits.find((v) => !before.has(v.id));
      setAddingVisit(false);
      if (created) setTarget(created.id);
      onChanged();
    } catch (e: any) {
      setErr(t('添加到访失败：{msg}', { msg: e?.message || e }));
    } finally {
      setSaving(false);
    }
  };

  // ── 地点编辑 / 删除 ──
  const startPlaceEdit = () => {
    setName(detail.name);
    setKind(detail.kind);
    setProvince(detail.province ?? '');
    setCity(detail.city ?? '');
    setCounty(detail.county ?? '');
    setSecretOn(detail.secret === 1);
    setHomeOn(detail.home === 1);
    setErr(null);
    setConfirmingPlace(false);
    setEditingPlace(true);
  };

  /**
   * 2026-11-08 D-284：按坐标重新识别一次地区，填进编辑框（不直接保存）。
   * 逆地理缺省份时再用地址文本兜底（与 D-263 保存兜底同一套逻辑）。
   */
  const refillRegion = async () => {
    setRefilling(true);
    setErr(null);
    try {
      const { address } = await api.reverse(detail.lng, detail.lat);
      const region = normalizeRegion(address);
      const fallback = region.province
        ? null
        : regionFromText(address?.formatted) ?? regionFromText(address?.poi);
      setProvince(region.province ?? fallback?.province ?? '');
      setCity(region.city ?? fallback?.city ?? '');
      setCounty(region.county ?? fallback?.county ?? '');
    } catch (e: any) {
      setErr(t('识别失败：{msg}', { msg: e?.message || e }));
    } finally {
      setRefilling(false);
    }
  };

  const savePlace = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr(t('名称不能为空'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      // 2026-11-08 D-284：地区三个字段一起保存（留空 = 清空 / 未标注；代码字段一起清掉，
      // 避免手动改省后旧 code 与文字对不上——省份点亮按名称也能匹配）。
      await api.updatePlace(detail.id, {
        name: trimmed,
        kind,
        province: province.trim() || null,
        city: city.trim() || null,
        county: county.trim() || null,
        province_code: null,
        city_code: null,
        county_code: null,
      });
      setEditingPlace(false);
      onChanged();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const deletePlaceNow = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.deletePlace(detail.id);
      onDeleted();
    } catch (e: any) {
      setErr(e?.message || String(e));
      setSaving(false);
    }
  };

  /** 「想去」→「去过」（F-PLC-07）：转完之后再记实际到访日期 */
  const convertToVisited = async () => {
    setSaving(true);
    setErr(null);
    try {
      await api.updatePlace(detail.id, { kind: 'visited' });
      onChanged();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  /** 秘密基地开关（F-PLC-11）：没设置密码时先提示去设置，不发请求 */
  const toggleSecret = async () => {
    const on = !secretOn;
    if (on && !secretConfigured) {
      setErr(t('请先在「设置 → 秘密基地」里设置密码'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.updatePlace(detail.id, { secret: on ? 1 : 0 });
      setSecretOn(on);
      onChanged();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 家开关（2026-11-04 用户最终版）：普通地点里的一个按钮，PATCH place.home；
   * 服务端保证全库唯一（设新家会自动清掉旧家），成功后用返回的 detail.home 同步并刷新。
   */
  const toggleHome = async () => {
    const on = !homeOn;
    setSaving(true);
    setErr(null);
    try {
      const p = await api.updatePlace(detail.id, { home: on ? 1 : 0 });
      setHomeOn(p.home === 1);
      onChanged();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── 到访编辑 / 删除 ──
  const startVisitEdit = (v: Visit) => {
    setAddingVisit(false);
    setVform({
      date: v.date,
      title: v.title ?? '',
      note: v.note ?? '',
      rating: v.rating ?? 0,
      companions: (v.companions ?? []).join('、'),
    });
    setEditingVisit(v.id);
    setErr(null);
  };

  const saveVisit = async (v: Visit) => {
    if (!vform.date) {
      setErr(t('日期不能为空'));
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.updateVisit(v.id, {
        date: vform.date,
        title: vform.title.trim() || null,
        note: vform.note || null,
        rating: vform.rating || null,
        companions: splitCompanions(vform.companions),
      });
      setEditingVisit(null);
      onChanged();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const removeVisit = async (v: Visit) => {
    setSaving(true);
    setErr(null);
    try {
      const r = await api.deleteVisit(v.id);
      setConfirmingVisit(null);
      if (r.lastVisit) setAskDeletePlace(true);
      onChanged();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── 媒体：封面 / 移动 / 删除 ──
  const setCover = async (m: MediaItem) => {
    setErr(null);
    try {
      await api.updatePlace(detail.id, { cover_media_id: m.id });
      onChanged();
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  };

  const moveMedia = async (mediaId: string, visitId: string) => {
    setSaving(true);
    setErr(null);
    try {
      await api.updateMedia(mediaId, { visit_id: visitId });
      setMoving(null);
      onChanged();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  /** F-MED-05 / D-56：删除媒体 = 直接移到回收站（可恢复，不弹确认） */
  const trashMedia = async (mediaId: string) => {
    setSaving(true);
    setErr(null);
    try {
      await api.deleteMedia(mediaId);
      onChanged();
      onTrashed?.();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  // 上传队列汇总（F-MED-10）
  const uploadDone = uploads.filter((x) => x.status === 'done').length;
  // D-261：失败项数量 —— 关闭队列前若有失败项，先弹确认（失败项清掉后需要重新选文件）
  const uploadFailed = uploads.filter((x) => x.status === 'error').length;
  const uploadActive = uploads.some((x) => x.status === 'queued' || x.status === 'uploading');
  const uploadHasFinished = uploads.some((x) =>
    ['done', 'skipped', 'canceled'].includes(x.status)
  );

  /** 上传状态文案：在组件里翻译，切换语言即时生效（避免模块级常量缓存中文，D-138） */
  const uploadStatusLabel = (s: UploadItem['status']): string => {
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

  return (
    <aside
      className="panel"
      onDragEnter={onPanelDragEnter}
      onDragOver={onPanelDragOver}
      onDragLeave={onPanelDragLeave}
      onDrop={(e) => void onPanelDrop(e)}
    >
      {/* D-246：拖文件夹到侧栏的提示 / 处理中状态（覆盖层不接收鼠标事件，避免挡住 drop） */}
      {(folderDropActive || folderDropBusy) && (
        <div className="folder-drop-overlay" aria-hidden="true">
          <div className="folder-drop-card">
            <div className="folder-drop-icon">📁</div>
            <div className="folder-drop-title">
              {folderDropBusy
                ? t('正在按文件夹新建到访并加入上传队列…')
                : t('松开鼠标：按文件夹名新建一次到访并上传')}
            </div>
            {!folderDropBusy && (
              <div className="folder-drop-sub">
                {t('文件夹中的图片 / 视频会批量上传；日期默认今天，之后可编辑')}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="panel-head">
        <div className="head-left">
          {onBack && !editingPlace && (
            <button
              type="button"
              className="back-btn"
              onClick={onBack}
              title={
                entry === 'trail'
                  ? t('返回 My旅迹列表（保留列表的展开 / 滚动位置）')
                  : entry === 'cluster'
                    ? t('返回这一簇')
                    : t('返回地图')
              }
            >
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
                <path
                  d="M10.2 3.2 5.4 8l4.8 4.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {entry === 'trail' ? t('My旅迹') : entry === 'cluster' ? t('这一簇') : t('地图')}
            </button>
          )}
          {detail.cover_id && !editingPlace && (
            <img className="head-cover" src={api.thumbUrl(detail.cover_id)} alt="" />
          )}
          <span className="title">{editingPlace ? t('编辑地点') : detail.name}</span>
          {!editingPlace && detail.secret === 1 && (
            <span className="sec-tag">{t('秘密基地')}</span>
          )}
          {!editingPlace && detail.home === 1 && <span className="home-tag">{t('家')}</span>}
        </div>
        <div className="head-actions">
          {!editingPlace && (
            <>
              <button className="text-btn" onClick={startPlaceEdit}>
                {t('编辑')}
              </button>
              <button
                className="text-btn"
                onClick={() => onMerge(detail)}
                title={t('合并重复地点')}
              >
                {t('合并')}
              </button>
            </>
          )}
          <button className="icon" onClick={onClose} aria-label={t('关闭')}>
            <CloseIcon />
          </button>
        </div>
      </div>

      {editingPlace && (
        <div className="place-edit">
          <label className="pe-field">
            <span>{t('名称')}</span>
            <input
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') savePlace();
                if (e.key === 'Escape') setEditingPlace(false);
              }}
            />
          </label>

          <div className="pe-row">
            <div className="pe-field pe-kind">
              <span>{t('类型')}</span>
              <Segmented<'visited' | 'wishlist'>
                size="sm"
                variant="radio"
                ariaLabel={t('类型')}
                options={[
                  { id: 'visited', label: t('去过') },
                  { id: 'wishlist', label: t('想去') },
                ]}
                value={kind}
                onChange={setKind}
              />
            </div>
            <div className="pe-toggles">
              <button
                type="button"
                className={secretOn ? 'chip sec-on' : 'chip'}
                onClick={toggleSecret}
                disabled={saving}
                title={
                  secretConfigured
                    ? t('秘密基地：地图上紫色飞镖，点开详情需要密码')
                    : t('还没有设置密码，可先去设置 → 安全里设置')
                }
              >
                {secretOn ? t('取消秘密基地') : t('设为秘密基地')}
              </button>
              <button
                type="button"
                className={homeOn ? 'chip home-on' : 'chip'}
                onClick={toggleHome}
                disabled={saving}
                title={t('家：全库唯一，地图上用青绿房子图标，功能和普通地点一样')}
              >
                {homeOn ? t('取消家') : t('设为家')}
              </button>
            </div>
          </div>

          {/* 2026-11-08 D-284（用户要求）：地区（省 / 市 / 区县）可手动编辑——
              逆地理识别不到或识别不准（如澳门只返回省级、香港离岸点连省都不返回）时由用户自己填；
              留空 = 未标注。编辑框旁提供「重新识别」按坐标再试一次。 */}
          <div className="pe-region">
            <div className="pe-region-head">
              <span className="pe-region-title">{t('地区（省 / 市 / 区县）')}</span>
              <span className="pe-region-tip">{t('识别不到或不准可以直接改，留空 = 未标注')}</span>
              <button
                type="button"
                className="text-btn sm pe-region-refill"
                onClick={() => void refillRegion()}
                disabled={refilling || saving}
                title={t('按坐标重新识别一次省 / 市 / 区县并填入')}
              >
                {refilling ? t('识别中…') : t('重新识别')}
              </button>
            </div>
            <div className="pe-region-row">
              <label className="pe-field">
                <span>{t('省')}</span>
                <input
                  list="pe-province-options"
                  value={province}
                  maxLength={24}
                  spellCheck={false}
                  placeholder={t('如：浙江省')}
                  onChange={(e) => setProvince(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') savePlace();
                    if (e.key === 'Escape') setEditingPlace(false);
                  }}
                />
              </label>
              <label className="pe-field">
                <span>{t('市')}</span>
                <input
                  value={city}
                  maxLength={24}
                  spellCheck={false}
                  placeholder={t('如：杭州市')}
                  onChange={(e) => setCity(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') savePlace();
                    if (e.key === 'Escape') setEditingPlace(false);
                  }}
                />
              </label>
              <label className="pe-field">
                <span>{t('区 / 县')}</span>
                <input
                  value={county}
                  maxLength={24}
                  spellCheck={false}
                  placeholder={t('如：西湖区')}
                  onChange={(e) => setCounty(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') savePlace();
                    if (e.key === 'Escape') setEditingPlace(false);
                  }}
                />
              </label>
            </div>
            <datalist id="pe-province-options">
              {PROVINCE_FULL_NAMES.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>

          <div className="pe-meta">
            <span className="pe-coord mono">
              {detail.lng.toFixed(5)}, {detail.lat.toFixed(5)}
            </span>
            <span className="pe-hint">{t('坐标不可改，位置不对请删掉重加')}</span>
          </div>

          {err && <p className="hint err">{err}</p>}

          <div className="pe-actions">
            <button className="ghost" onClick={() => setEditingPlace(false)} disabled={saving}>
              {t('取消')}
            </button>
            <button className="primary" onClick={savePlace} disabled={saving}>
              {saving ? t('保存中…') : t('保存')}
            </button>
          </div>
        </div>
      )}

      <>
        <div className={detail.kind === 'wishlist' ? 'subhead' : 'subhead subhead-split'}>
          <div className="subhead-text">
            <div className="region region-crumbs">
              {detail.province && (
                <button
                  type="button"
                  className="crumb"
                  onClick={() => onLocateInMyTrail?.('province')}
                  title={t('在 My旅迹中查看 {name}', { name: tp(detail.province) })}
                >
                  {tp(detail.province)}
                </button>
              )}
              {detail.city && (
                <>
                  <span className="crumb-sep" aria-hidden="true">
                    ›
                  </span>
                  <button
                    type="button"
                    className="crumb"
                    onClick={() => onLocateInMyTrail?.('city')}
                    title={t('在 My旅迹中查看 {name}', { name: detail.city })}
                  >
                    {detail.city}
                  </button>
                </>
              )}
              {detail.county && (
                <>
                  <span className="crumb-sep" aria-hidden="true">
                    ›
                  </span>
                  <button
                    type="button"
                    className="crumb"
                    onClick={() => onLocateInMyTrail?.('place')}
                    title={t('在 My旅迹中查看并定位到这个地点')}
                  >
                    {detail.county}
                  </button>
                </>
              )}
              {!region && <span className="crumb-empty">{t('未知位置')}</span>}
              {region && onLocateInMyTrail && (
                <button
                  type="button"
                  className="crumb-jump"
                  onClick={() => onLocateInMyTrail('place')}
                  title={t('在 My旅迹中查看并定位到这个地点')}
                  aria-label={t('在 My旅迹中查看并定位到这个地点')}
                >
                  <FolderIcon className="crumb-jump-icon" />
                </button>
              )}
            </div>
            <div className="meta">
              {detail.kind === 'wishlist' ? (
                <>
                  <span className="kind-wish">{t('想去')}</span>
                  {detail.created_at
                    ? t(' 加入于 {date}', {
                        date: new Date(detail.created_at).toISOString().slice(0, 10),
                      })
                    : ''}
                </>
              ) : (
                <>{t('去过 {n} 次 · {m} 个文件', { n: detail.visits.length, m: total })}</>
              )}
              {homeDistanceKm != null && (
                <> · {t('离家 {km} km', { km: fmtKm(homeDistanceKm) })}</>
              )}
            </div>
          </div>
          {detail.kind !== 'wishlist' && (
            <div className="visit-cols">
              <span className="visit-cols-label">{t('照片每行')}</span>
              <Segmented
                size="sm"
                variant="radio"
                ariaLabel={t('到访照片每行张数')}
                options={MEDIA_COLS.map((n) => ({ id: String(n), label: t('{n} 张', { n }) }))}
                value={String(mediaCols)}
                onChange={(id) => onMediaColsChange(Number(id) as MediaCols)}
              />
            </div>
          )}
        </div>

          {detail.kind === 'wishlist' && (
            <>
              <div className="form">
                <p className="hint">
                  {t('这是「想去」的地方，还没有记过到访。')}
                  <br />
                  {t('转成「去过」之后，就能记录到访日期、笔记和照片了。')}
                </p>
                {err && <p className="hint err">{err}</p>}
              </div>
              <div className="panel-foot column">
                <button className="primary full" onClick={convertToVisited} disabled={saving}>
                  {saving ? t('处理中…') : t('转为去过')}
                </button>
                {confirmingPlace ? (
                  <div className="confirm-del">
                    <div className="confirm-text">
                      {t('删除「{name}」？', { name: detail.name })}
                      <small>{t('想去清单里的这条也会消失（软删，M3 回收站可恢复）')}</small>
                    </div>
                    <div className="row">
                      <button
                        className="ghost"
                        onClick={() => setConfirmingPlace(false)}
                        disabled={saving}
                      >
                        {t('取消')}
                      </button>
                      <button className="danger-btn" onClick={deletePlaceNow} disabled={saving}>
                        {saving ? t('删除中…') : t('确认删除')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="text-btn danger"
                    style={{ alignSelf: 'flex-end' }}
                    onClick={() => setConfirmingPlace(true)}
                  >
                    {t('从想去清单删除')}
                  </button>
                )}
              </div>
            </>
          )}

          {detail.kind !== 'wishlist' && (
          <div className="visits" ref={visitsRef}>
            {addingVisit && (
              <div className="visit active editing" onClick={(e) => e.stopPropagation()}>
                <VisitFormEditor
                  form={vform}
                  setForm={setVform}
                  err={err}
                  saving={saving}
                  onSave={() => void saveNewVisit()}
                  onCancel={cancelAddVisit}
                />
              </div>
            )}
            {detail.visits.map((v) => (
              <Fragment key={v.id}>
              <div
                className={
                  'visit' +
                  (v.id === activeVisit?.id ? ' active' : '') +
                  (editingVisit === v.id ? ' editing' : '')
                }
                onClick={() => setTarget(v.id)}
              >
                <div className="visit-head">
                      <span className="date">{v.date}</span>
                      {v.title && <span className="vtitle">{v.title}</span>}
                      {v.rating ? <span className="rate">{'★'.repeat(v.rating)}</span> : null}
                      <span className="n">{v.media.length}</span>
                      {editingVisit !== v.id && (
                      <div className="visit-actions">
                        <button
                          className="text-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            startVisitEdit(v);
                          }}
                        >
                          {t('编辑')}
                        </button>
                        <button
                          className="text-btn danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmingVisit(v.id);
                          }}
                        >
                          {t('删除')}
                        </button>
                      </div>
                      )}
                    </div>

                    {(v.companions?.length ?? 0) > 0 && (
                      <div className="companions">
                        {t('同行：{names}', { names: (v.companions ?? []).join('、') })}
                      </div>
                    )}

                    {confirmingVisit === v.id && (
                      <div className="confirm-del" onClick={(e) => e.stopPropagation()}>
                        <div className="confirm-text">
                          {t('删除这次到访？')}
                          <small>
                            {t('{n} 个照片/视频会一起移到回收站，可恢复', {
                              n: v.media.length,
                            })}
                          </small>
                        </div>
                        <div className="row">
                          <button
                            className="ghost"
                            onClick={() => setConfirmingVisit(null)}
                            disabled={saving}
                          >
                            {t('取消')}
                          </button>
                          <button
                            className="danger-btn"
                            onClick={() => removeVisit(v)}
                            disabled={saving}
                          >
                            {saving ? t('删除中…') : t('确认删除')}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 到访编辑表单：2026-11-07 D-244（用户要求）从照片下方移到照片上方，
                        点「编辑」后立刻在眼前，不用滚过整排照片。 */}
                    {editingVisit === v.id && (
                      <div className="visit-edit-drawer" onClick={(e) => e.stopPropagation()}>
                        <VisitFormEditor
                          form={vform}
                          setForm={setVform}
                          err={err}
                          saving={saving}
                          onSave={() => void saveVisit(v)}
                          onCancel={() => setEditingVisit(null)}
                        />
                      </div>
                    )}

                    <div className="grid">
                      {/* 「+ 添加素材」格始终放在第一格（2026-11-07 D-245，用户要求），照片依次排在后面 */}
                      <div className="tile-wrap">
                        <button
                          type="button"
                          className="tile tile-add"
                          onClick={(e) => {
                            e.stopPropagation();
                            startPickForVisit(v.id);
                          }}
                          title={t('给这次到访（{date}）添加素材（图片 / 视频）', { date: v.date })}
                        >
                          <span className="tile-add-plus" aria-hidden="true">
                            +
                          </span>
                          <span className="tile-add-label">{t('添加素材')}</span>
                        </button>
                      </div>
                      {v.media.map((m, i) => (
                        <MediaTile
                          key={m.id}
                          m={m}
                          cover={detail.cover_id === m.id}
                          onClick={() => onOpenLightbox(v.id, i)}
                          onCover={() => setCover(m)}
                          onMove={() => setMoving(m.id)}
                          onReveal={() => revealMedia(m)}
                          onDelete={() => trashMedia(m.id)}
                        />
                      ))}
                    </div>

                    {moving && v.media.some((m) => m.id === moving) && (
                      <div className="chooser" onClick={(e) => e.stopPropagation()}>
                        <span>{t('移动到：')}</span>
                        {detail.visits
                          .filter((x) => x.id !== v.id)
                          .map((x) => (
                            <button
                              key={x.id}
                              className="chip"
                              onClick={() => moveMedia(moving, x.id)}
                              disabled={saving}
                            >
                              {x.date}
                            </button>
                          ))}
                        {detail.visits.length === 1 && (
                          <span>{t('只有一个到访，先加一次再到别处')}</span>
                        )}
                        <button className="text-btn" onClick={() => setMoving(null)}>
                          {t('取消')}
                        </button>
                      </div>
                    )}

                    {v.note && <div className="note">{v.note}</div>}
              </div>

              </Fragment>
            ))}

            {detail.visits.length === 0 && (
              <div className="muted pad">
                {t('这个地点还没有到访记录，可以加一次或直接拖照片进来。')}
              </div>
            )}
          </div>
          )}

          {detail.kind !== 'wishlist' && (
          <div className="panel-foot column">
            {uploads.length > 0 && !queueClosed && (
              <div className="upload-queue">
                <div className="uq-head">
                  <span>
                    {t('上传队列')} <span className="uq-count">{uploadDone}/{uploads.length}</span>
                  </span>
                  <div className="uq-actions">
                    {uploadActive && (
                      <button className="text-btn" onClick={onCancelAllUploads}>
                        {t('全部取消')}
                      </button>
                    )}
                    {uploadHasFinished && (
                      <button className="text-btn" onClick={onClearFinishedUploads}>
                        {t('清除已完成')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon uq-close"
                      onClick={() => {
                        // D-261：还有失败项时先确认（关闭会清空重试入口，需要重新选文件）
                        if (uploadFailed > 0) {
                          setCloseQueueAsk(true);
                          return;
                        }
                        // 本地先收起（保证点了立刻有反馈），再通知 App 清空队列/取消未完成项
                        setQueueClosed(true);
                        onCloseUploadQueue?.();
                      }}
                      title={t('关闭上传队列（未完成项会被取消）')}
                      aria-label={t('关闭上传队列')}
                    >
                      <CloseIcon size={12} />
                    </button>
                  </div>
                </div>
                <div className="uq-list">
                  {uploads.map((it) => {
                    const pct = Math.round(it.progress * 100);
                    const statusText =
                      it.status === 'uploading' && it.progress >= 1
                        ? t('处理中（缩略图）…')
                        : uploadStatusLabel(it.status);
                    // 进度到 100% 后服务端还在生成缩略图/封面帧，此时中止也停不下服务端，隐藏取消
                    const cancelable =
                      it.status === 'queued' || (it.status === 'uploading' && it.progress < 1);
                    return (
                      <div key={it.key} className={`uq-item ${it.status}`}>
                        <div className="uq-line">
                          <span className="uq-name" title={it.file.name}>
                            {it.file.name}
                          </span>
                          <span className="uq-status">
                            {statusText}
                            {it.status === 'uploading' && it.progress < 1 ? ` ${pct}%` : ''}
                          </span>
                          {cancelable && (
                            <button className="text-btn" onClick={() => onCancelUpload(it.key)}>
                              {t('取消')}
                            </button>
                          )}
                          {it.status === 'error' && (
                            <button className="text-btn" onClick={() => onRetryUpload(it.key)}>
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
                                    ? Math.max(4, pct)
                                    : 0
                              }%`,
                            }}
                          />
                        </div>
                        {it.status === 'error' && it.error && (
                          <div className="uq-err">{it.error}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {/* D-261：还有失败项时关闭上传队列 → 先确认（失败项会丢，需要重新选文件） */}
            {closeQueueAsk && uploadFailed > 0 && (
              <ConfirmDialog
                title={t('还有 {n} 个文件上传失败，仍要关闭上传队列？', { n: uploadFailed })}
                confirmText={t('仍然关闭')}
                onCancel={() => setCloseQueueAsk(false)}
                onConfirm={() => {
                  setCloseQueueAsk(false);
                  setQueueClosed(true);
                  onCloseUploadQueue?.();
                }}
              >
                <p>{t('关闭后，失败的文件需要重新选择上传（不会自动重试）。')}</p>
              </ConfirmDialog>
            )}
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,video/*,.heic,.heif"
              hidden
              onChange={(e) => {
                onFilesPicked(e.target.files);
                e.target.value = '';
              }}
            />
            <button className="ghost full" onClick={startAddVisit} disabled={addingVisit}>
              {t('+ 添加一次到访')}
            </button>

            {askDeletePlace ? (
              <div className="confirm-del">
                <div className="confirm-text">
                  {t('这是最后一个到访，地点还在。')}
                  <small>{t('要连这个地点一起移到回收站吗？地点里的内容也会一起进去，可恢复。')}</small>
                </div>
                <div className="row">
                  <button
                    className="ghost"
                    onClick={() => setAskDeletePlace(false)}
                    disabled={saving}
                  >
                    {t('保留地点')}
                  </button>
                  <button className="danger-btn" onClick={deletePlaceNow} disabled={saving}>
                    {saving ? t('删除中…') : t('删除地点')}
                  </button>
                </div>
              </div>
            ) : confirmingPlace ? (
              <div className="confirm-del">
                <div className="confirm-text">
                  {t('删除「{name}」？', { name: detail.name })}
                  <small>
                    {t('{n} 次到访 · {m} 个照片/视频会一起移到回收站，可恢复', {
                      n: detail.visits.length,
                      m: total,
                    })}
                  </small>
                </div>
                <div className="row">
                  <button
                    className="ghost"
                    onClick={() => setConfirmingPlace(false)}
                    disabled={saving}
                  >
                    {t('取消')}
                  </button>
                  <button className="danger-btn" onClick={deletePlaceNow} disabled={saving}>
                    {saving ? t('删除中…') : t('确认删除')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="text-btn danger"
                style={{ alignSelf: 'flex-end' }}
                onClick={() => setConfirmingPlace(true)}
              >
                {t('删除这个地点')}
              </button>
            )}

            {err && !editingVisit && !editingPlace && <p className="hint err">{err}</p>}
          </div>
          )}
      </>
    </aside>
  );
}
