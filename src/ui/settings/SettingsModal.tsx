import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { BackupStatus, UpdateCheckResult, UploadItem } from '../../lib/types';
import type { AppFont, FontSize, FontWeight, Slogan, Theme, ThemeLevel } from './types';
import type { HomeColor } from '../../lib/homeIcon';
import type { MarkerColorPrefs } from '../../lib/markerColors';
import { useT, type Lang } from '../../i18n';
import CloseIcon from '../CloseIcon';
import type { AuthMode, AuthUser } from '../../lib/types';
import GeneralSettings from './GeneralSettings';
import BackupSettings from './BackupSettings';
import LibrarySettings from './LibrarySettings';
import TrashSettings from './TrashSettings';
import TdtSettings from './TdtSettings';
import SecuritySettings from './SecuritySettings';
import AccountSettings from './AccountSettings';
import UserManagementSettings from './UserManagementSettings';
import UploadSettings from './UploadSettings';
import AboutSettings from './AboutSettings';
import './SettingsModal.css';

export type { AppFont, Theme, ThemeLevel } from './types';

interface Props {
  onClose: () => void;
  /** 素材库 / 秘密基地 / 回收站等设置变化后通知 App 刷新 */
  onChanged: () => void;
  /** 从备份恢复成功后由 App 清浮层并全量刷新 */
  onRestored: () => void;
  /** 备份状态变化（导出 / 稍后提醒 / 改阈值）同步给 App，顶栏红点即时更新 */
  onBackupStatus?: (s: BackupStatus) => void;
  /**
   * 2026-11-09 D-331（用户反馈）：秘密基地密码被设置 / 修改 / 重置后通知 App，
   * 清掉当前会话的「已解锁」状态——改完密码后再打开秘密基地需要重新输入新密码。
   */
  onSecretPasswordChanged?: () => void;
  /** 回收站数量：显示在左下角「回收站」入口旁的小角标 */
  trashCount?: number;
  theme: Theme;
  /** 当前实际生效的档位（跟随系统时取系统深浅色对应的 light / dark） */
  effectiveTheme: ThemeLevel;
  onTheme: (t: Theme) => void;
  /** 界面字体（2026-11-04，D-92），取值见 APP_FONTS（2026-11-07 D-227 精简为 2 款 OFL + 系统 4 款） */
  font: AppFont;
  onFont: (f: AppFont) => void;
  /** 界面字号（2026-11-05，D-142）：小 / 中 / 大三档，只存本机浏览器 */
  fontSize: FontSize;
  onFontSize: (s: FontSize) => void;
  /** 界面字重（2026-11-06 用户要求）：常规 / 加粗，只存本机浏览器 */
  fontWeight: FontWeight;
  onFontWeight: (w: FontWeight) => void;
  /** 应用主题标语（2026-11-05，D-146）：顶栏两段自定义文字；null = 默认文案 */
  slogan: Slogan | null;
  onSlogan: (s: Slogan | null) => void;
  /** 界面语言（2026-11-04，D-138）：简体中文 / English，只存本机浏览器 */
  lang: Lang;
  onLang: (l: Lang) => void;
  /** 「家」图标配色（2026-11-05，D-161）：7 色可选，只存本机浏览器 */
  homeColor: HomeColor;
  onHomeColor: (c: HomeColor) => void;
  /** 去过 / 想去 / 秘密基地图标配色（2026-11-05，D-164）：同一套 7 色，null = 原色 */
  markerColors: MarkerColorPrefs;
  onMarkerColors: (p: MarkerColorPrefs) => void;
  /** 账号模式（2026-11-06 M6 P2-1，D-200）：multi 时左侧多出「账号」分类 */
  authMode?: AuthMode;
  /** 当前登录用户（multi 模式）：账号信息 / 改密码 / 邀请码管理用 */
  currentUser?: AuthUser | null;
  /** 退出登录（清会话后 App 回登录页） */
  onLoggedOut?: () => void;
  /** 设置里换了头像 / 显示名后通知 App 刷新顶栏（2026-11-07 D-224） */
  onProfileChanged?: () => void;
  /** 打开时默认落在哪个分类（2026-11-07 D-224：点顶栏头像 / 名称 → 直接打开「账号」） */
  initialTab?: TabId;
  /**
   * 左侧分类上的红点（2026-11-07 D-260）：值 = 悬停提示文案。
   * 目前用于把顶栏「设置」的备份提醒红点延续到「备份与恢复」分类上，
   * 让用户点进设置后能按级找到红点对应的待办；后续其它待办也可复用。
   */
  navDots?: Partial<Record<TabId, string>>;
  /** 应用更新检查结果（2026-11-09 D-327）：关于页展示 + 设置导航「关于」红点，由 App 统一持有 */
  updateCheck?: UpdateCheckResult | null;
  /** 正在检查更新 */
  updateChecking?: boolean;
  /** 「再检查一次」按钮 / 打开关于页时刷新 */
  onCheckUpdate?: () => void;
  /** 用户已忽略的版本号（本机 localStorage） */
  ignoredUpdateVersion?: string;
  onIgnoreUpdate?: (version: string) => void;
  onRestoreUpdateReminder?: () => void;
  /**
   * 只读样板会话（2026-11-09 D-335，云端「浏览样板展示（只读）」入口）：
   * 只保留「通用 / 天地图 Key / 关于」三个分类；隐藏备份恢复 / 素材库 / 回收站 / 安全 / 账号。
   * 服务端对只读会话的写请求一律 403，这里只是不展示入口（退出登录在顶栏「只读」标识旁）。
   */
  readOnly?: boolean;
  /**
   * 2026-11-10 D-350（用户要求）：上传队列从到访点侧栏拆到「设置 → 上传」。
   * 队列状态由 App 持有，这里只负责展示与操作（关设置 / 切地点都不中断上传）。
   */
  uploads?: UploadItem[];
  onCancelUpload?: (key: string) => void;
  onCancelAllUploads?: () => void;
  onRetryUpload?: (key: string) => void;
  onClearFinishedUploads?: () => void;
  onCloseUploadQueue?: () => void;
}

export type TabId =
  | 'general'
  | 'backup'
  | 'library'
  | 'upload'
  | 'trash'
  | 'tdt'
  | 'security'
  | 'account'
  | 'users'
  | 'about';

/** 账号：只在 AUTH_MODE=multi 时出现；2026-11-07 用户要求固定在设置左下角单独显示（D-221） */
const ACCOUNT_TAB: { id: TabId; label: string; desc: string } = {
  id: 'account',
  label: '账号',
  desc: '账号信息与登录密码',
};

/** 用户管理分类：只在 AUTH_MODE=multi 且当前账号是管理员时出现（P2-3，D-204；2026-11-07 起含邀请码管理） */
const USERS_TAB: { id: TabId; label: string; desc: string } = {
  id: 'users',
  label: '用户管理',
  desc: '账号、状态、已用空间、重置密码与邀请码',
};

/** 通用分类（不含回收站 / 账号 / 关于：回收站在「关于」上面，账号固定在左下角） */
const MAIN_TABS: { id: TabId; label: string; desc: string }[] = [
  { id: 'general', label: '通用', desc: '外观明暗、界面语言、主题与字体' },
  { id: 'backup', label: '备份与恢复', desc: '导出备份 / 从备份恢复 / 备份提醒' },
  { id: 'library', label: '素材库', desc: '素材库路径、重新关联与视频封面' },
  // 2026-11-10 D-350（用户要求）：上传队列单独成板块，按地点 · 到访分组显示进度 / 失败重试
  { id: 'upload', label: '上传', desc: '上传队列、进度与失败重试' },
  { id: 'tdt', label: '天地图 Key', desc: '天地图 Key（Key 只存本机）' },
  { id: 'security', label: '安全', desc: '秘密基地密码' },
];

const ABOUT_TAB: { id: TabId; label: string; desc: string } = {
  id: 'about',
  label: '关于',
  desc: '版本、运行环境与数据位置',
};

/** 回收站：2026-11-07 用户要求放回分类列表、位于「关于」上面（D-221） */
const TRASH_TAB: { id: TabId; label: string; desc: string } = {
  id: 'trash',
  label: '回收站',
  desc: '已删除的地点 / 到访 / 照片视频',
};

/** 窗口默认大小与拖拽下限（实际还会被视口大小限制） */
const DEFAULT_SIZE = { w: 980, h: 760 };
const MIN_W = 760;
const MIN_H = 520;
const SIZE_KEY = 'tm-settings-size';

const clampSize = (w: number, h: number) => {
  const maxW = Math.max(MIN_W, window.innerWidth - 48);
  const maxH = Math.max(MIN_H, window.innerHeight - 48);
  return { w: Math.min(Math.max(w, MIN_W), maxW), h: Math.min(Math.max(h, MIN_H), maxH) };
};

function readSize() {
  try {
    const raw = localStorage.getItem(SIZE_KEY);
    if (!raw) return DEFAULT_SIZE;
    const parsed = JSON.parse(raw);
    if (Number.isFinite(parsed?.w) && Number.isFinite(parsed?.h)) {
      return clampSize(Number(parsed.w), Number(parsed.h));
    }
  } catch {
    /* 读不到就用默认大小 */
  }
  return DEFAULT_SIZE;
}

function saveSize(size: { w: number; h: number }) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(size));
  } catch {
    /* 隐私模式下可能写不进去，忽略 */
  }
}

/** 左侧导航小图标（统一 16px 线性图标，避免 emoji 在不同字体下不居中） */
function NavIcon({ id }: { id: TabId }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <svg className="set-nav-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <g {...common}>
        {id === 'general' && (
          <>
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 2.2v1.4M8 12.4v1.4M2.2 8h1.4M12.4 8h1.4M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1" />
          </>
        )}
        {id === 'backup' && (
          <>
            <ellipse cx="8" cy="4.2" rx="4.8" ry="1.8" />
            <path d="M3.2 4.2v7.6c0 1 2.1 1.8 4.8 1.8s4.8-.8 4.8-1.8V4.2" />
            <path d="M3.2 8c0 1 2.1 1.8 4.8 1.8S12.8 9 12.8 8" />
          </>
        )}
        {id === 'library' && (
          <>
            <path d="M2.4 5.2a1 1 0 0 1 1-1h2.4l1.2 1.4h5.6a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1V5.2Z" />
          </>
        )}
        {id === 'trash' && (
          <>
            <path d="M3 4.6h10" />
            <path d="M6.2 4.6V3.4a1 1 0 0 1 1-1h1.6a1 1 0 0 1 1 1v1.2" />
            <path d="M4.4 4.6l.5 8a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.5-8" />
            <path d="M6.8 7.2v3.8M9.2 7.2v3.8" />
          </>
        )}
        {id === 'tdt' && (
          <>
            <path d="M8 14s4.3-4.1 4.3-7.2a4.3 4.3 0 1 0-8.6 0C3.7 9.9 8 14 8 14Z" />
            <circle cx="8" cy="6.8" r="1.5" />
          </>
        )}
        {id === 'security' && (
          <>
            <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.4" />
            <path d="M5.4 7V5.3a2.6 2.6 0 0 1 5.2 0V7" />
            <path d="M8 9.6v1.6" />
          </>
        )}
        {id === 'account' && (
          <>
            <circle cx="8" cy="5.6" r="2.4" />
            <path d="M3.4 13.4c.5-2.4 2.4-3.8 4.6-3.8s4.1 1.4 4.6 3.8" />
          </>
        )}
        {id === 'users' && (
          <>
            <circle cx="5.5" cy="5.9" r="2.1" />
            <path d="M2.4 13.2c.5-2.1 1.9-3.3 3.1-3.3s2.6 1.2 3.1 3.3" />
            <circle cx="11" cy="5.4" r="1.7" />
            <path d="M8.6 12.8c.4-1.8 1.5-2.9 2.4-2.9s2 1.1 2.4 2.9" />
          </>
        )}
        {id === 'upload' && (
          <>
            <path d="M8 10.6V2.8" />
            <path d="M5.2 5.4 8 2.6l2.8 2.8" />
            <path d="M2.8 9.4v2.4a1.4 1.4 0 0 0 1.4 1.4h7.6a1.4 1.4 0 0 0 1.4-1.4V9.4" />
          </>
        )}
        {id === 'about' && (
          <>
            <circle cx="8" cy="8" r="5.8" />
            <path d="M8 7.2v3.2" />
            <path d="M8 4.9v.2" />
          </>
        )}
      </g>
    </svg>
  );
}

/** 独立设置窗口（F-SYS-02 重构）：左侧分类 + 右侧内容，可拖右下角缩放 */
export default function SettingsModal({
  onClose,
  onChanged,
  onRestored,
  onBackupStatus,
  onSecretPasswordChanged,
  trashCount = 0,
  theme,
  effectiveTheme,
  onTheme,
  font,
  onFont,
  fontSize,
  onFontSize,
  fontWeight,
  onFontWeight,
  slogan,
  onSlogan,
  lang,
  onLang,
  homeColor,
  onHomeColor,
  markerColors,
  onMarkerColors,
  authMode = 'local',
  currentUser = null,
  onLoggedOut,
  onProfileChanged,
  initialTab,
  navDots,
  updateCheck = null,
  updateChecking = false,
  onCheckUpdate,
  ignoredUpdateVersion = '',
  onIgnoreUpdate,
  onRestoreUpdateReminder,
  readOnly = false,
  uploads = [],
  onCancelUpload = () => {},
  onCancelAllUploads = () => {},
  onRetryUpload = () => {},
  onClearFinishedUploads = () => {},
  onCloseUploadQueue = () => {},
}: Props) {
  const t = useT();
  const [tab, setTab] = useState<TabId>(initialTab ?? 'general');
  const [size, setSize] = useState(readSize);
  const sizeRef = useRef(size);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ sx: number; sy: number; w: number; h: number } | null>(null);
  // 账号 / 用户管理分类只在多用户模式出现；本地模式（默认）左侧导航与以前完全一致。
  // 2026-11-11 D-369（用户要求）：云端普通用户的「备份 / 恢复」整体取消，改为 设置 → 账号 →「下载我的数据」；
  // 「备份与恢复」分类只对 本地模式 / 云端管理员 显示。
  // 2026-11-07（D-211）：按用户要求「让普通用户也能看到素材库信息」——素材库分类改为所有角色可见；
  // 普通用户只读（LibrarySettings 内部分流），路径 / 重新关联 / 切换路径仍仅管理员。
  const multi = authMode === 'multi';
  const isAdmin = currentUser?.role === 'admin';
  const backupTabVisible = !multi || isAdmin;
  // 2026-11-09 D-335：只读样板会话只保留「通用 / 天地图 Key / 关于」——
  // 备份恢复、素材库、回收站、安全、账号都涉及写操作或会暴露隐藏内容，直接不展示。
  const visibleMainTabs = backupTabVisible
    ? MAIN_TABS
    : MAIN_TABS.filter((item) => item.id !== 'backup');
  const mainTabs = readOnly
    ? visibleMainTabs.filter((item) => item.id === 'general' || item.id === 'tdt')
    : visibleMainTabs;
  // 2026-11-07 用户要求（D-221 修订）：回收站放回分类列表、位于「关于」上面；multi 下「账号」固定到左下角单独显示。
  const tabs = readOnly
    ? [...mainTabs, ABOUT_TAB]
    : multi
      ? [
          ...mainTabs,
          ...(isAdmin ? [USERS_TAB] : []),
          TRASH_TAB,
          ABOUT_TAB,
        ]
      : [...mainTabs, TRASH_TAB, ABOUT_TAB];
  // 2026-11-11 D-370（用户要求）：云端（multi）素材库只读——不显示服务器路径、不能切换路径，
  // 分类说明统一改成「我的素材使用量」；本地模式说明不变。
  const tabsShown = multi
    ? tabs.map((item) =>
        item.id === 'library' ? { ...item, desc: t('我的素材使用量') } : item
      )
    : tabs;
  // 账号不在上面的分类列表里（固定在左下角），但标题栏仍要能显示它的名称 / 说明
  const allTabs = multi && !readOnly ? [...tabsShown, ACCOUNT_TAB] : tabsShown;
  const activeTab: TabId = allTabs.some((item) => item.id === tab) ? tab : allTabs[0].id;
  const current = allTabs.find((item) => item.id === activeTab) ?? allTabs[0];

  // Esc 关闭 + 打开期间锁住 body 滚动
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // 浏览器窗口变化时把设置窗口夹回可视区域
  useEffect(() => {
    const onWinResize = () => setSize((cur) => clampSize(cur.w, cur.h));
    window.addEventListener('resize', onWinResize);
    return () => window.removeEventListener('resize', onWinResize);
  }, []);

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, w: size.w, h: size.h };
    setResizing(true);
  };

  const moveResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = clampSize(d.w + (e.clientX - d.sx), d.h + (e.clientY - d.sy));
    sizeRef.current = next;
    setSize(next);
  };

  const endResize = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setResizing(false);
    saveSize(sizeRef.current);
  };

  const resetSize = () => {
    const next = clampSize(DEFAULT_SIZE.w, DEFAULT_SIZE.h);
    sizeRef.current = next;
    setSize(next);
    saveSize(next);
  };

  return (
    <div
      className={resizing ? 'set-overlay resizing' : 'set-overlay'}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="set-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('设置')}
        onClick={(e) => e.stopPropagation()}
        style={
          {
            '--set-w': `${size.w}px`,
            '--set-h': `${size.h}px`,
          } as CSSProperties
        }
      >
        <aside className="set-nav">
          <div className="set-nav-title">{t('设置')}</div>
          <nav className="set-nav-list" aria-label={t('设置分类')}>
            {tabsShown.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === activeTab ? 'set-nav-item on' : 'set-nav-item'}
                onClick={() => setTab(item.id)}
                aria-current={item.id === tab ? 'page' : undefined}
              >
                <NavIcon id={item.id} />
                <span>{t(item.label)}</span>
                {item.id === 'trash' && trashCount > 0 && (
                  <span
                    className="set-nav-count"
                    aria-label={t('{n} 项待处理', { n: trashCount })}
                  >
                    {trashCount > 99 ? '99+' : trashCount}
                  </span>
                )}
                {/* 2026-11-07 D-260：分类级红点（顶栏红点的下一级指引） */}
                {navDots?.[item.id] && (
                  <span
                    className="set-nav-dot"
                    title={navDots[item.id]}
                    aria-label={navDots[item.id]}
                  />
                )}
              </button>
            ))}
          </nav>

          {/* 2026-11-07 用户要求（D-221）：多用户模式下「账号」固定在设置左下角单独显示
              （2026-11-09 D-335：只读样板会话不显示账号分类，退出登录走顶栏只读标识） */}
          {multi && !readOnly && (
            <div className="set-nav-bottom">
              <button
                type="button"
                className={activeTab === 'account' ? 'set-nav-item on' : 'set-nav-item'}
                onClick={() => setTab('account')}
                aria-current={activeTab === 'account' ? 'page' : undefined}
              >
                <NavIcon id="account" />
                <span>{t(ACCOUNT_TAB.label)}</span>
                {currentUser?.displayName && (
                  <span className="set-nav-account-name" title={currentUser.displayName}>
                    {currentUser.displayName}
                  </span>
                )}
              </button>
            </div>
          )}
        </aside>

        <section className="set-main">
          <header className="set-head">
            <div className="set-head-text">
              <div className="set-title">{t(current.label)}</div>
              <div className="set-sub">{t(current.desc)}</div>
            </div>
            <button type="button" className="icon set-close" onClick={onClose} aria-label={t('关闭设置')}>
              <CloseIcon />
            </button>
          </header>

          <div className="set-body">
            {activeTab === 'general' && (
              <GeneralSettings
                theme={theme}
                effectiveTheme={effectiveTheme}
                onTheme={onTheme}
                font={font}
                onFont={onFont}
                fontSize={fontSize}
                onFontSize={onFontSize}
                fontWeight={fontWeight}
                onFontWeight={onFontWeight}
                slogan={slogan}
                onSlogan={onSlogan}
                lang={lang}
                onLang={onLang}
                homeColor={homeColor}
                onHomeColor={onHomeColor}
                markerColors={markerColors}
                onMarkerColors={onMarkerColors}
              />
            )}
            {activeTab === 'backup' && (
              <BackupSettings
                onRestored={onRestored}
                onBackupStatus={onBackupStatus}
                multi={multi}
                isAdmin={isAdmin}
              />
            )}
            {activeTab === 'library' && (
              <LibrarySettings onChanged={onChanged} multi={multi} isAdmin={isAdmin} />
            )}
            {/* 2026-11-10 D-350（用户要求）：上传队列独立板块（按地点 · 到访分组，可收起 / 展开） */}
            {activeTab === 'upload' && (
              <UploadSettings
                uploads={uploads}
                onCancelUpload={onCancelUpload}
                onCancelAllUploads={onCancelAllUploads}
                onRetryUpload={onRetryUpload}
                onClearFinishedUploads={onClearFinishedUploads}
                onCloseUploadQueue={onCloseUploadQueue}
                readOnly={readOnly}
              />
            )}
            {activeTab === 'trash' && <TrashSettings onChanged={onChanged} />}
            {activeTab === 'tdt' && <TdtSettings multi={multi} />}
            {activeTab === 'security' && (
              <SecuritySettings
                onChanged={onChanged}
                onPasswordChanged={onSecretPasswordChanged}
                multi={multi}
              />
            )}
            {activeTab === 'account' &&
              (currentUser ? (
                <AccountSettings
                  user={currentUser}
                  markerColors={markerColors}
                  onProfileChanged={onProfileChanged}
                  onLoggedOut={onLoggedOut ?? (() => window.location.reload())}
                />
              ) : (
                <p className="hint">{t('当前没有登录账号。')}</p>
              ))}
            {activeTab === 'users' &&
              (currentUser && isAdmin ? (
                <UserManagementSettings currentUser={currentUser} />
              ) : (
                <p className="hint">{t('只有管理员可以管理账号。')}</p>
              ))}
            {activeTab === 'about' && (
              <AboutSettings
                multi={multi}
                isAdmin={isAdmin}
                currentUser={currentUser}
                updateCheck={updateCheck}
                updateChecking={updateChecking}
                onCheckUpdate={onCheckUpdate}
                ignoredUpdateVersion={ignoredUpdateVersion}
                onIgnoreUpdate={onIgnoreUpdate}
                onRestoreUpdateReminder={onRestoreUpdateReminder}
              />
            )}
          </div>
        </section>

        <div
          className="set-resize"
          role="separator"
          aria-label={t('拖动调整设置窗口大小；双击恢复默认大小')}
          title={t('拖动调整大小（双击恢复默认）')}
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={resetSize}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
            <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M12 6.6 6.6 12" />
              <path d="M12 9.8 9.8 12" />
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}
