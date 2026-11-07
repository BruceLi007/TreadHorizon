import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { UserUsage } from '../../lib/types';
import { formatBytes } from '../../lib/bytes';
import { tr, useT } from '../../i18n';

interface Props {
  /** 素材库路径 / 关联关系变化后通知 App 刷新地点与侧栏 */
  onChanged: () => void;
  /** 多用户模式（2026-11-07 用户要求：普通用户也要能看到素材库信息，只读） */
  multi?: boolean;
  /** 多用户模式下的管理员：保留原来的路径 / 重新关联 / 切换路径界面 */
  isAdmin?: boolean;
}

/**
 * 普通用户（multi + 非管理员）的素材库页（2026-11-07 D-211 / D-212）。
 * 用户要求「普通用户也要能看到并操作素材库信息（路径输入框 / 切换按钮）」——按账号独立：
 * - 看自己的用量 / 状态；
 * - 可以把**自己账号**的素材库根目录切到自己的文件夹（存 user_setting.media_root，不影响其他账号）；
 * - 可以重新关联自己的文件 / 恢复默认路径；
 * - 看自己的用量 / 状态；当前路径直接显示本机文件夹（D-215 用户要求），可打开本地文件夹；
 */
function UserLibraryInfo({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [usage, setUsage] = useState<UserUsage | null>(null);
  const [lib, setLib] = useState<{
    root: string;
    customized: boolean;
    total: number;
    deleted: number;
    missing: number;
    thumbMissing: number;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [sum, s] = await Promise.all([api.accountSummary(), api.library()]);
      setUsage(sum.usage);
      setLib({
        root: s.root,
        customized: Boolean(s.customized),
        total: s.total,
        deleted: s.deleted ?? 0,
        missing: s.missing,
        thumbMissing: s.thumbMissing,
      });
      setErr(null);
    } catch (e: any) {
      setErr(tr('读取失败：') + (e?.message || e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const doRelink = async () => {
    setBusy(t('正在扫描素材库…'));
    setMsg(null);
    try {
      const r = await api.relink();
      setMsg(
        t('扫描 {scanned} 个文件 · 重新关联 {matched} 个（按文件名 {byName}，按内容 {byHash}） · 仍缺失 {stillMissing} 个 · {ms}ms', {
          scanned: r.scanned,
          matched: r.matched,
          byName: r.byName,
          byHash: r.byHash,
          stillMissing: r.stillMissing,
          ms: r.ms,
        })
      );
      await load();
      onChanged();
    } catch (e: any) {
      setMsg(t('失败：') + (e?.message || e));
    } finally {
      setBusy(null);
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
      setMsg(t('已在资源管理器中打开你的素材库文件夹（若没看到，请查看任务栏）'));
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
      setMsg(t('失败：') + (e?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const resetRoot = async () => {
    setBusy(t('切换路径…'));
    setMsg(null);
    try {
      const r = await api.resetLibraryRoot();
      await load();
      onChanged();
      setMsg(t('已恢复默认素材库位置 · ') + syncText(r.synced));
    } catch (e: any) {
      setMsg(t('失败：') + (e?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const ok = (lib?.missing ?? 0) === 0;

  return (
    <div className="set-pane">
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('我的素材')}</h3>
        </div>
        <p className="set-section-desc">
          {t('你的照片 / 视频保存在你账号专属的素材库里（按账号隔离，其他账号看不到也访问不到），按「省 / 市 / 区县 / 日期_地点名」归档。当前路径就是素材库在你电脑上的文件夹，可以直接打开，也可以换成别的文件夹（只影响你自己的账号）。')}
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
          </>
        )}
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('素材库路径（仅你的账号）')}</h3>
        </div>
        <p className="set-section-desc">
          {t('每个账号可以把自己素材库的存放位置切到自己的文件夹；切换只影响你自己的账号，其他账号的素材库不受影响。')}
        </p>

        <div className="field-static">
          <span>{t('当前路径')}</span>
          <div className="value" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="lib-path-text">{lib ? lib.root : '…'}</span>
            {/* 2026-11-07（D-213 / D-214 / D-215）：直接显示本机文件夹路径 + 打开文件夹按钮 */}
            <button className="lib-open-btn" onClick={() => void openFolder()} disabled={!!busy}>
              {t('打开本地文件夹')}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            {t('提示：素材实际存放在这个文件夹里、以你的账号 ID 命名的子目录中；点「打开本地文件夹」会直接打开那个子目录。')}
          </p>
        </div>

        {lib && (
          <div className="field-static">
            <span>{t('状态')}</span>
            <div className="value">
              {t('{total} 个文件 · 丢失 ', { total: lib.total })}
              <b style={{ color: ok ? '#4cc38a' : '#e06c75' }}>{lib.missing}</b>
              {t(' 个')}
              {lib.deleted > 0 && t(' · 回收站 {n} 个', { n: lib.deleted })}
              {lib.thumbMissing > 0 && t(' · {n} 张缩略图待重建', { n: lib.thumbMissing })}
            </div>
          </div>
        )}

        <button className="ghost full" onClick={() => void doRelink()} disabled={!!busy}>
          {busy ? busy : t('重新关联（按文件名 → 大小 → 内容哈希）')}
        </button>

        <label className="field" style={{ marginTop: 18 }}>
          <span>{t('换电脑 / 想放到自己的文件夹？输入你的素材库新路径')}</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="E:\Photos\MyTravelMedia"
            spellCheck={false}
          />
        </label>

        <button className="primary full" onClick={useNewRoot} disabled={!!busy || !input.trim()}>
          {t('切换路径（自动同步素材）')}
        </button>
        <p className="hint" style={{ marginTop: 8 }}>
          {t('所选文件夹下会自动创建你的账号专属目录（<路径>/<账号ID>/省/市/…）；切换时会自动把当前账号的素材同步到新位置。')}
        </p>

        {lib?.customized && (
          <button className="text-btn" onClick={() => void resetRoot()} disabled={!!busy} style={{ marginTop: 8 }}>
            {t('恢复默认路径')}
          </button>
        )}

        {msg && (
          <p className="hint" style={{ marginTop: 14 }}>
            {msg}
          </p>
        )}
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('说明')}</h3>
        </div>
        <p className="set-section-desc">
          {t('视频封面、1600 预览和缩略图由服务器统一生成；上传只是把电脑里的原件复制一份到素材库（应用副本），你电脑上的原文件不会被移动、修改或删除。')}
        </p>
        <p className="set-section-desc">
          {t('想完整带走素材：到「备份与恢复」里导出含原片的 zip（也可以再恢复回来）。')}
        </p>
      </section>
    </div>
  );
}

/** 素材库分类：路径、状态、重新关联、切换路径，以及视频封面（ffmpeg）状态 */
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
  /** 多用户：当前账号是否自定义过素材库路径（可「恢复默认路径」） */
  const [customized, setCustomized] = useState(false);

  // 普通用户（multi 非管理员）：按账号独立的素材库页（可看自己的路径 / 状态 / 重新关联 / 切换自己的路径）
  const userOnly = multi && !isAdmin;

  const load = useCallback(async () => {
    if (userOnly) return;
    try {
      const [s, h] = await Promise.all([api.library(), api.health()]);
      setRoot(s.root);
      setCustomized(Boolean(s.customized));
      setTotal(s.total);
      setDeleted(s.deleted ?? 0);
      setMissing(s.missing);
      setThumbMissing(s.thumbMissing);
      setFfmpeg(Boolean(h.ffmpeg));
    } catch (e: any) {
      setMsg(tr('读取失败：') + (e?.message || e));
    }
  }, [userOnly]);

  useEffect(() => {
    load();
  }, [load]);

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
          t('扫描 {scanned} 个文件 · 重新关联 {matched} 个（按文件名 {byName}，按内容 {byHash}） · 仍缺失 {stillMissing} 个 · {ms}ms', {
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
      setMsg(t('已在资源管理器中打开素材库文件夹（若没看到，请查看任务栏）'));
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

  const resetRoot = async () => {
    setBusy(t('切换路径…'));
    setMsg(null);
    try {
      const r = await api.resetLibraryRoot();
      await load();
      onChanged();
      setMsg(t('已恢复默认素材库位置 · ') + syncText(r.synced));
    } catch (e: any) {
      setMsg(t('失败：') + (e?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const ok = missing === 0;

  // 普通用户：按账号独立的素材库页
  if (userOnly) return <UserLibraryInfo onChanged={onChanged} />;

  return (
    <div className="set-pane">
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('素材库')}</h3>
        </div>
        <p className="set-section-desc">
          {multi
            ? t('多用户模式下素材库按账号独立：这里显示/修改的是你自己账号的素材库位置；切换路径会把你的素材同步过去，不影响其他账号。照片 / 视频上传时从本地原件 A 复制一份到 B，缩略图、预览和播放都读 B，A 永远不动。')
            : t('应用库 B 的位置。照片 / 视频上传时从本地原件 A 复制到 B；缩略图、预览和播放都读 B，A 永远不动。切换路径时会把整个素材库同步到新位置。')}
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
          {multi && (
            <p className="hint" style={{ marginTop: 6 }}>
              {t('提示：素材实际存放在这个文件夹里、以你的账号 ID 命名的子目录中；点「打开本地文件夹」会直接打开那个子目录。')}
            </p>
          )}
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
          {busy ? busy : t('重新关联（按文件名 → 大小 → 内容哈希）')}
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
        {multi && customized && (
          <button className="text-btn" onClick={() => void resetRoot()} disabled={!!busy} style={{ marginTop: 8 }}>
            {t('恢复默认路径')}
          </button>
        )}

        {msg && (
          <p className="hint" style={{ marginTop: 14 }}>
            {msg}
          </p>
        )}

        <p className="hint" style={{ marginTop: 18 }}>
          {multi
            ? t('切换路径时会把你自己账号的素材同步到新位置（自动创建 <新路径>/<账号ID>/省/市/…）；换电脑后也可以先把素材库拷过去、再切换路径。')
            : t('切换路径时会把整个素材库同步到新位置；换电脑也可以先把素材库文件夹拷到新机器，再切换路径并重新关联。')}
        </p>
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('视频 · 封面帧')}</h3>
        </div>
        <div className="field-static">
          <span>ffmpeg</span>
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
            {t('装好 ffmpeg 后重启服务即可；也可以设置 FFMPEG_PATH 环境变量指向 exe。没装也不影响播放视频本身。')}
          </p>
        )}
      </section>
    </div>
  );
}
