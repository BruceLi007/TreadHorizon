import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { UserUsage } from '../../lib/types';
import { formatBytes } from '../../lib/bytes';
import { tr, useT } from '../../i18n';
import DuplicateMediaSettings from './DuplicateMediaSettings';

interface Props {
  /** 素材库路径 / 关联关系变化后通知 App 刷新地点与侧栏 */
  onChanged: () => void;
  /** 多用户（云端）模式：素材库改为只读展示（2026-11-11 D-370 用户要求） */
  multi?: boolean;
  /** 多用户模式下的管理员：云端同样不显示服务器路径，只在说明里多一句指引 */
  isAdmin?: boolean;
}

/**
 * 设置 → 素材库 展示「支持上传的格式」。
 * 格式清单来自 /api/config 的 mediaFormats（后端由上传白名单 PHOTO_EXT / VIDEO_EXT 生成），
 * 以后增删格式只改 server/importer.mjs 一处，设置页会自动跟着变。
 */
function UploadFormats() {
  const t = useT();
  const [formats, setFormats] = useState<{ photos: string[]; videos: string[] } | null>(null);

  useEffect(() => {
    let dead = false;
    api
      .config()
      .then((c) => {
        if (!dead) setFormats(c.mediaFormats ?? null);
      })
      .catch(() => {
        /* 配置读取失败就不显示这一段，不影响设置页其它功能 */
      });
    return () => {
      dead = true;
    };
  }, []);

  if (!formats) return null;

  return (
    <section className="set-section">
      <div className="set-section-head">
        <h3 className="set-section-title">{t('支持上传的格式')}</h3>
      </div>
      <div className="set-format-groups">
        <div className="set-format-group">
          <span className="set-format-label">{t('照片')}</span>
          <span className="set-format-chips">
            {formats.photos.map((ext) => (
              <code key={ext} className="set-format-chip">
                {ext}
              </code>
            ))}
          </span>
        </div>
        <div className="set-format-group">
          <span className="set-format-label">{t('视频')}</span>
          <span className="set-format-chips">
            {formats.videos.map((ext) => (
              <code key={ext} className="set-format-chip">
                {ext}
              </code>
            ))}
          </span>
        </div>
      </div>
      <p className="set-section-desc">
        {t('原始文件原样保存在素材库；缩略图和预览会自动生成，视频封面需要安装 ffmpeg。')}
      </p>
      <p className="set-section-desc">
        {t('相机 RAW（如 .nef）暂不支持，请先导出 JPG / TIFF 再上传。')}
      </p>
    </section>
  );
}

/**
 * 云端（multi）素材库：只读用量 + 说明（2026-11-11 D-370 用户要求）。
 *
 * 背景：2026-11-07 P2 验收时（多用户实例还在本机跑）做过「普通用户可看 / 切自己的素材库路径」
 * （D-212 / D-213 / D-215）；搬到真实云服务器后，页面会显示服务器绝对路径（如 /srv/tread-horizon/media），
 * 「打开本地文件夹」等于在服务器上开资源管理器，「切换路径」等于让网页用户往服务器写路径——都不合适。
 * 现在云端统一只读：不显示路径、不能切路径 / 打开服务器文件夹 / 重新关联（服务端接口已 403，D-370）；
 * 需要把素材带走用 设置 → 账号 →「下载我的数据」（可选包含照片视频）。
 */
function CloudLibraryInfo({ onChanged, isAdmin }: { onChanged: () => void; isAdmin: boolean }) {
  const t = useT();
  const [usage, setUsage] = useState<UserUsage | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    api
      .accountSummary()
      .then((s) => {
        if (!dead) {
          setUsage(s.usage);
          setErr(null);
        }
      })
      .catch((e: any) => {
        if (!dead) setErr(tr('读取失败：') + (e?.message || e));
      });
    return () => {
      dead = true;
    };
  }, []);

  return (
    <div className="set-pane">
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('我的素材')}</h3>
        </div>
        <p className="set-section-desc">
          {t('照片 / 视频上传时会复制一份到服务器素材库，按你的账号独立保存（其他账号看不到也访问不到）；缩略图、预览和播放都读这份副本，你电脑上的原文件不会被移动或修改。')}
        </p>
        {err && <p className="hint err">{err}</p>}
        {!usage && !err && <p className="hint">{t('读取中…')}</p>}
        {usage && (
          <>
            <div className="acc-usage-total">
              <b>{formatBytes(usage.mediaBytes)}</b>
              <span>{t('已用空间')}</span>
            </div>
            <p className="hint">
              {t('{photos} 张照片 · {videos} 段视频（共 {n} 个素材文件）', {
                photos: usage.photos,
                videos: usage.videos,
                n: usage.mediaCount,
              })}
            </p>
            <p className="hint">
              {t('想把素材拿到本地：到「账号 → 下载我的数据」里勾选「包含照片 / 视频文件」下载 zip。')}
            </p>
          </>
        )}
      </section>

      <UploadFormats />

      <DuplicateMediaSettings onChanged={onChanged} />

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('说明')}</h3>
        </div>
        <p className="set-section-desc">
          {t('云端素材库按账号隔离保存在服务器上，路径、迁移与重新关联由服务器管理员维护；网页端不提供路径设置，也不会显示服务器文件夹位置。')}
        </p>
        {isAdmin && (
          <p className="hint">
            {t('你是管理员：服务器数据目录 / 素材库路径可在「关于 → 服务器信息（仅管理员可见）」查看；调整素材库位置请按云部署流程在服务器上操作。')}
          </p>
        )}
        <p className="set-section-desc">
          {t('视频封面、预览和缩略图会自动生成；上传只是把文件复制一份到素材库，你电脑上的原文件不会被移动、修改或删除。')}
        </p>
      </section>
    </div>
  );
}

/** 本地模式素材库：路径、状态、重新关联、切换路径，以及视频封面（ffmpeg）状态 */
export default function LibrarySettings({ onChanged, multi = false, isAdmin = false }: Props) {
  const t = useT();
  const [root, setRoot] = useState('');
  const [total, setTotal] = useState(0);
  const [deleted, setDeleted] = useState(0);
  const [missing, setMissing] = useState(0);
  const [thumbMissing, setThumbMissing] = useState(0);
  const [ffmpeg, setFfmpeg] = useState<boolean | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([api.library(), api.health()]);
      setRoot(s.root);
      setTotal(s.total);
      setDeleted(s.deleted ?? 0);
      setMissing(s.missing);
      setThumbMissing(s.thumbMissing);
      setFfmpeg(Boolean(h.ffmpeg));
    } catch (e: any) {
      setMsg(tr('读取失败：') + (e?.message || e));
    }
  }, []);

  useEffect(() => {
    // 2026-11-11 D-370：云端不调 /api/library（服务端已 403），直接走只读视图
    if (!multi) void load();
  }, [multi, load]);

  const doRelink = async (silent = false) => {
    if (!silent) {
      setBusy(t('正在扫描素材库…'));
      setMsg(null);
    }
    try {
      const r = await api.relink();
      if (r.error) {
        setMsg(t('失败：') + r.error);
      } else if (!silent) {
        setMsg(
          t('扫描 {scanned} 个文件 · 重新关联 {matched} 个 · 仍缺失 {stillMissing} 个（{ms}ms）', {
            scanned: r.scanned,
            matched: r.matched,
            byName: r.byName,
            byHash: r.byHash,
            stillMissing: r.stillMissing,
            ms: r.ms,
          })
        );
      }
      await load();
      onChanged();
    } catch (e: any) {
      setMsg(t('失败：') + (e?.message || e));
    } finally {
      if (!silent) setBusy(null);
    }
  };

  const syncText = (synced?: { files: number; bytes: number } | null) => {
    if (!synced || synced.files <= 0) return t('没有需要同步的素材文件');
    return t('已同步 {n} 个素材文件（{size}）', {
      n: synced.files,
      size: formatBytes(synced.bytes),
    });
  };

  const openFolder = async () => {
    setMsg(null);
    try {
      await api.openLibraryFolder();
      setMsg(t('已在文件管理器中打开素材库文件夹（若没看到，请切换到文件管理器窗口）'));
    } catch (e: any) {
      setMsg(t('打开本地文件夹失败：{msg}', { msg: e?.message || String(e) }));
    }
  };

  const useNewRoot = async () => {
    const p = input.trim();
    if (!p) return;
    setBusy(t('切换路径…'));
    setMsg(null);
    try {
      const r = await api.setLibraryRoot(p);
      if (r.error) {
        setMsg(t('切换失败：') + r.error);
      } else {
        setInput('');
        await load();
        onChanged();
        setMsg(t('已切换素材库路径 · ') + syncText(r.synced));
      }
    } catch (e: any) {
      setMsg(t('切换失败：') + (e?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const ok = missing === 0;

  // 云端（multi）：只读展示，不暴露服务器路径、不提供路径操作
  if (multi) return <CloudLibraryInfo onChanged={onChanged} isAdmin={isAdmin} />;

  return (
    <div className="set-pane">
      <UploadFormats />

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('素材库')}</h3>
        </div>
        <p className="set-section-desc">
          {t('素材库的位置。照片 / 视频上传时会把文件复制到素材库；缩略图、预览和播放都读素材库，你电脑上的原文件永远不动。切换路径时会把整个素材库同步到新位置。')}
        </p>

        <div className="field-static">
          <span>{t('当前路径')}</span>
          <div className="value" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="lib-path-text">{root || '…'}</span>
            {/* 2026-11-07（D-213 / D-214）：当前路径边上的「打开本地文件夹」小胶囊按钮 */}
            <button className="lib-open-btn" onClick={() => void openFolder()} disabled={!!busy}>
              {t('打开本地文件夹')}
            </button>
          </div>
        </div>

        <div className="field-static">
          <span>{t('状态')}</span>
          <div className="value">
            {t('{total} 个文件 · 丢失 ', { total })}
            <b style={{ color: ok ? '#4cc38a' : '#e06c75' }}>{missing}</b>
            {t(' 个')}
            {deleted > 0 && t(' · 回收站 {n} 个', { n: deleted })}
            {thumbMissing > 0 && t(' · {n} 张缩略图待重建', { n: thumbMissing })}
          </div>
        </div>

        <button className="ghost full" onClick={() => void doRelink()} disabled={!!busy}>
          {busy ? busy : t('重新关联（按文件名 → 大小 → 内容比对）')}
        </button>

        <label className="field" style={{ marginTop: 18 }}>
          <span>{t('换电脑了？输入素材库的新路径')}</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="E:\Photos\TravelMedia"
            spellCheck={false}
          />
        </label>

        <button className="primary full" onClick={useNewRoot} disabled={!!busy || !input.trim()}>
          {t('切换路径（自动同步素材）')}
        </button>

        {msg && (
          <p className="hint" style={{ marginTop: 14 }}>
            {msg}
          </p>
        )}

        <p className="hint" style={{ marginTop: 18 }}>
          {t('切换路径时会把整个素材库同步到新位置；换电脑也可以先把素材库文件夹拷到新机器，再切换路径并重新关联。')}
        </p>
      </section>

      <DuplicateMediaSettings onChanged={onChanged} />

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('视频 · 封面帧')}</h3>
        </div>
        <div className="field-static">
          <span>{t('视频封面组件')}</span>
          <div className="value">
            {ffmpeg === null
              ? t('检测中…')
              : ffmpeg
                ? t('已就绪：视频会生成封面帧和时长')
                : t('未检测到：视频仍能播放，但没有封面帧')}
          </div>
        </div>
        {ffmpeg === false && (
          <p className="hint">
            {t('安装视频封面组件后重启应用即可；不装也不影响视频播放。')}
          </p>
        )}
      </section>
    </div>
  );
}
