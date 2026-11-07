import { useLayoutEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AppFont, FontSize, FontWeight, Slogan, Theme, ThemeLevel } from './types';
import {
  DEFAULT_HOME_COLOR,
  homeMarkerSrc,
  type HomeColor,
} from '../../lib/homeIcon';
import {
  DEFAULT_MARKER_COLOR_ID,
  MARKER_COLOR_CHOICES,
  MARKER_KIND_LABEL,
  MARKER_KINDS,
  markerColorOf,
  markerPreviewSrc,
  type MarkerColorId,
  type MarkerColorPrefs,
  type MarkerKind,
} from '../../lib/markerColors';
import {
  APP_FONTS,
  DEFAULT_FONT,
  FONT_SIZES,
  FONT_SIZE_LABEL,
  FONT_WEIGHTS,
  FONT_WEIGHT_LABEL,
  SLOGAN_MAX_LEN,
  THEME_LEVELS,
  THEME_LEVEL_LABEL,
} from './types';
import Segmented from '../Segmented';
import { LANGS, useT, type Lang } from '../../i18n';

interface Props {
  theme: Theme;
  /** 当前实际生效的档位（跟随系统时 = light / dark） */
  effectiveTheme: ThemeLevel;
  onTheme: (t: Theme) => void;
  /** 界面字体（2026-11-04，D-92） */
  font: AppFont;
  onFont: (f: AppFont) => void;
  /** 界面字号（2026-11-05，D-142）：小 / 中 / 大 */
  fontSize: FontSize;
  onFontSize: (s: FontSize) => void;
  /** 界面字重（2026-11-06 用户要求）：常规 / 加粗 */
  fontWeight: FontWeight;
  onFontWeight: (w: FontWeight) => void;
  /** 应用主题标语（2026-11-05，D-146）：顶栏两段自定义文字；null = 默认文案 */
  slogan: Slogan | null;
  onSlogan: (s: Slogan | null) => void;
  /** 界面语言（2026-11-04，D-138）：简体中文 / English */
  lang: Lang;
  onLang: (l: Lang) => void;
  /** 「家」图标配色（2026-11-05，D-161）：7 色可选，只存本机 */
  homeColor: HomeColor;
  onHomeColor: (c: HomeColor) => void;
  /** 去过 / 想去 / 秘密基地图标配色（2026-11-05，D-164）：同一套 7 色，null = 原色 */
  markerColors: MarkerColorPrefs;
  onMarkerColors: (p: MarkerColorPrefs) => void;
}

/**
 * 通用设置：语言（D-138）+ 主题标语（D-146）+ 外观明暗轴（纯白→浅色→深色→纯黑 4 档）+
 * 跟随系统 + 界面字体与字号（D-92 / D-142）+ 图标配色（D-161 / D-164）。
 * 照片网格（D-116）只保留在地点侧栏顶部的快捷切换里，不再在设置里出现（D-165）。
 */
export default function GeneralSettings({
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
}: Props) {
  const t = useT();
  // D-164 修订：12 种色相名（用字面量 t()，保证 i18n 自检能收录英文词条）
  const colorLabel: Record<MarkerColorId, string> = {
    red: t('红'),
    orange: t('橙'),
    yellow: t('黄'),
    lime: t('黄绿'),
    green: t('绿'),
    teal: t('青绿'),
    cyan: t('青'),
    sky: t('天蓝'),
    indigo: t('靛蓝'),
    violet: t('紫罗兰'),
    fuchsia: t('品红'),
    coral: t('珊瑚红'),
  };
  // 正在配色的图标类型（色条只有一条，先选类型、再点色条；默认从「去过」开始）
  const [activeType, setActiveType] = useState<'home' | MarkerKind>('visited');
  const levelIndex = Math.max(0, THEME_LEVELS.indexOf(effectiveTheme));
  const systemOn = theme === 'system';
  const fontLabel = t(
    (APP_FONTS.find((f) => f.id === font) ?? APP_FONTS.find((f) => f.id === DEFAULT_FONT)!).label
  );
  // 2026-11-05 D-146 / D-147：主题标语（顶栏大按钮组上方那一句）。
  // 未自定义时输入框显示 i18n 默认文案；任意一次编辑就转成「自定义」；留空 = 顶栏不显示标语。
  const defaultSlogan = `${t('世界辣 ~ ~ ~ 么大')} ${t('我想 · · · 总得去看一看吧 ! ! !')}`;
  const effectiveSlogan: Slogan = slogan ?? defaultSlogan;
  const updateSlogan = (value: string) => {
    onSlogan(value.slice(0, SLOGAN_MAX_LEN));
  };
  const sloganEmpty = effectiveSlogan.trim() === '';

  // 2026-11-05 D-164（用户反馈修订）：四组图标共用**一条 12 色相条**——
  // 家（D-161，默认青）+ 去过 / 想去 / 秘密基地（默认绿 / 红 / 品红，2026-11-05 深夜用户指定）。
  // 交互：先点上面的图标类型选中「正在配色的图标」，再点下面色条上的颜色；
  // 默认色本身就在色条里，所以默认时色条上会选中对应色段。
  type IconColorGroup = {
    id: 'home' | MarkerKind;
    label: string;
    preview: string;
    /** 当前生效的颜色（默认色也在 12 色条里，不会是 null） */
    current: MarkerColorId;
    defaultId: MarkerColorId;
    onPick: (id: MarkerColorId) => void;
    onReset: () => void;
  };
  const iconColorGroups: IconColorGroup[] = [
    {
      id: 'home',
      label: t('家'),
      preview: homeMarkerSrc(homeColor),
      current: homeColor,
      defaultId: DEFAULT_HOME_COLOR,
      onPick: onHomeColor,
      onReset: () => onHomeColor(DEFAULT_HOME_COLOR),
    },
    ...MARKER_KINDS.map((kind): IconColorGroup => ({
      id: kind,
      label: t(MARKER_KIND_LABEL[kind]),
      preview: markerPreviewSrc(kind, markerColors),
      current: markerColorOf(kind, markerColors),
      defaultId: DEFAULT_MARKER_COLOR_ID[kind],
      onPick: (id) => onMarkerColors({ ...markerColors, [kind]: id }),
      onReset: () => onMarkerColors({ ...markerColors, [kind]: null }),
    })),
  ];
  const activeGroup = iconColorGroups.find((g) => g.id === activeType) ?? iconColorGroups[0];
  const activeColorName = colorLabel[activeGroup.current];
  // 色条上的「滑动选中块」：12 段等宽，用 index 百分比平移（0..11 段）
  const activeHueIndex = Math.max(
    0,
    MARKER_COLOR_CHOICES.findIndex((o) => o.id === activeGroup.current)
  );
  // 首帧只定位、不播动画（避免滑块从最左边滑进来），下一帧再开启过渡（同 Segmented / D-158）
  const [hueReady, setHueReady] = useState(false);
  useLayoutEffect(() => {
    const raf = window.requestAnimationFrame(() => setHueReady(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="set-pane">
      {/* ── 语言（2026-11-04，D-138）── */}
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('语言')}</h3>
          <span className="set-section-tag">{lang === 'en' ? 'English' : '简体中文'}</span>
        </div>
        <p className="set-section-desc">
          {t('界面语言，点一下立即生效；和主题、字体一样只存在本机浏览器里，不写 data/、不进备份。')}
        </p>
        <Segmented
          size="sm"
          variant="radio"
          ariaLabel={t('界面语言')}
          options={LANGS.map((l) => ({ id: l.id, label: l.label }))}
          value={lang}
          onChange={(id) => onLang(id as Lang)}
        />
      </section>

      {/* ── 主题标语（2026-11-05，D-146 / D-147）：顶栏大按钮组上方那一句，可自定义 ── */}
      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('主题')}</h3>
          <span className="set-section-tag">{t('顶栏标语')}</span>
        </div>
        <p className="set-section-desc">
          {t('显示在顶栏大按钮组上方，作为这个应用的主题标语（一句话）。留空则不显示标语。只存本机浏览器（不写 data/、不进备份）；自定义内容不随界面语言翻译；窄屏（<1420px）下标语本来就不显示。')}
        </p>
        <label className="field">
          <span>{t('标语')}</span>
          <input
            value={effectiveSlogan}
            maxLength={SLOGAN_MAX_LEN}
            spellCheck={false}
            placeholder={defaultSlogan}
            onChange={(e) => updateSlogan(e.target.value)}
          />
        </label>
        <div className="set-slogan-preview" aria-label={t('顶栏标语预览')}>
          {sloganEmpty ? (
            <span className="set-slogan-empty">{t('留空 → 顶栏不显示标语')}</span>
          ) : (
            <span>{effectiveSlogan}</span>
          )}
        </div>
        <div className="set-slogan-actions">
          <button
            type="button"
            className="set-slogan-reset"
            onClick={() => onSlogan(null)}
            disabled={slogan === null}
          >
            {t('恢复默认标语')}
          </button>
          <span className="set-slogan-hint">
            {slogan === null ? t('当前使用默认文案') : t('已自定义（只存本机）')}
          </span>
          <span className="set-slogan-limit">
            {t('最多 40 字')}
            {slogan !== null && `（${slogan.length}/${SLOGAN_MAX_LEN}）`}
          </span>
        </div>
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('外观')}</h3>
          <button
            type="button"
            role="switch"
            aria-checked={systemOn}
            className={systemOn ? 'set-sys-toggle on' : 'set-sys-toggle'}
            onClick={() => onTheme(systemOn ? effectiveTheme : 'system')}
            title={t('跟随操作系统的深浅色自动切换')}
          >
            <span className="set-sys-track">
              <span className="set-sys-thumb" />
            </span>
            {t('跟随系统')}
          </button>
        </div>
        <p className="set-section-desc">
          {t('左右拖动选择界面明暗：最左「纯白」、最右「纯黑」，中间是「浅色 / 深色」，共 4 档。 偏好只存在本机浏览器里，下一次打开自动沿用。')}
        </p>

        <div className="set-axis">
          <input
            type="range"
            className="set-axis-range"
            min={1}
            max={THEME_LEVELS.length}
            step={1}
            value={levelIndex + 1}
            aria-label={t('界面明暗档位（纯白 / 浅色 / 深色 / 纯黑）')}
            onChange={(e) => onTheme(THEME_LEVELS[Number(e.target.value) - 1])}
          />
          <div className="set-axis-ticks">
            {THEME_LEVELS.map((lvl) => (
              <button
                key={lvl}
                type="button"
                className={effectiveTheme === lvl ? 'set-axis-tick on' : 'set-axis-tick'}
                onClick={() => onTheme(lvl)}
              >
                {t(THEME_LEVEL_LABEL[lvl])}
              </button>
            ))}
          </div>
        </div>
        <p className="set-theme-note">
          {systemOn
            ? t('跟随系统：当前显示「{level}」（随 Windows 设置 → 个性化 → 颜色 变化）；拖动滑块会退出跟随系统。', {
                level: t(THEME_LEVEL_LABEL[effectiveTheme]),
              })
            : t('当前：{level}', { level: t(THEME_LEVEL_LABEL[effectiveTheme]) })}
        </p>

        {/* 2026-11-05 D-161 / D-164（用户反馈修订）：图标配色——
            上面四组 = 家 / 去过 / 想去 / 秘密基地（先点一组选中「正在配色的图标」），
            下面一条 12 色相条供选择，四组共用、不再重复四遍。 */}
        <div className="set-markercolor">
          <div className="set-markercolor-head">
            <span className="set-markercolor-title">{t('图标配色')}</span>
            <span className="set-markercolor-hint">
              {t('先点一种图标，再点下面色条里的颜色；「恢复默认颜色」回到每种图标的默认色；只改地图、聚合点和列表里的图标颜色；只存本机浏览器，不写 data/、不进备份。')}
            </span>
          </div>

          {/* 类型选择 = 项目统一的分段控件（轨道 + 滑动选中块，D-98 / D-158 同款动效） */}
          <Segmented
            className="set-markercolor-types"
            fill
            variant="radio"
            ariaLabel={t('选择要配色的图标')}
            value={activeType}
            onChange={(id) => setActiveType(id)}
            options={iconColorGroups.map((g) => ({
              id: g.id,
              title: `${g.label} · ${colorLabel[g.current]}`,
              label: (
                <span className="set-markercolor-type-content">
                  <span className="set-markercolor-preview" aria-hidden="true">
                    <img src={g.preview} alt="" />
                  </span>
                  <span className="set-markercolor-type-text">
                    <span className="set-markercolor-name">{g.label}</span>
                    <span className="set-markercolor-value">{colorLabel[g.current]}</span>
                  </span>
                </span>
              ),
            }))}
          />

          {/* 12 色相条 = 轨道；选中块是覆盖在上面的一块半透明白色滑块，随颜色滑动 */}
          <div className="set-markercolor-scale" role="radiogroup" aria-label={t('色相条')}>
            <span
              className={hueReady ? 'set-markercolor-hue-thumb ready' : 'set-markercolor-hue-thumb'}
              aria-hidden="true"
              style={{ transform: `translateX(${activeHueIndex * 100}%)` }}
            />
            {MARKER_COLOR_CHOICES.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={activeGroup.current === o.id}
                className="set-markercolor-hue"
                style={{ '--hue': o.hex } as CSSProperties}
                onClick={() => activeGroup.onPick(o.id)}
                title={`${colorLabel[o.id]} ${o.hex}`}
                aria-label={colorLabel[o.id]}
              />
            ))}
          </div>

          <div className="set-markercolor-foot">
            <span className="set-markercolor-editing">
              {t('正在改：{name} · {color}', {
                name: activeGroup.label,
                color: activeColorName,
              })}
            </span>
            <button
              type="button"
              className="set-markercolor-reset"
              onClick={activeGroup.onReset}
              disabled={activeGroup.current === activeGroup.defaultId}
              title={t('恢复默认颜色')}
            >
              {t('恢复默认颜色')}
            </button>
          </div>
        </div>
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h3 className="set-section-title">{t('字体')}</h3>
          <span className="set-section-tag">{fontLabel}</span>
        </div>
        <p className="set-section-desc">
          {t('选择界面文字使用的常规字体，点一下立即生效。偏好和主题一样只存在本机浏览器里， 不写进 data/、不进备份；代码和等宽数字仍保持等宽字体。')}
        </p>

        <div className="set-font-grid" role="radiogroup" aria-label={t('界面字体')}>
          {APP_FONTS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="radio"
              aria-checked={font === f.id}
              className={font === f.id ? 'set-font-opt on' : 'set-font-opt'}
              data-font={f.id}
              style={{ fontFamily: `var(--font-opt-${f.id})` }}
              onClick={() => onFont(f.id)}
            >
              <span className="set-font-label">{t(f.label)}</span>
              <span className="set-font-sample">{t('Tread Horizon Aa 2026')}</span>
            </button>
          ))}
        </div>
        <p className="set-font-note">
          {t('当前：{font} · 预览：山河远阔，人间烟火。 2026.11.04', { font: fontLabel })}
        </p>

        {/* 2026-11-05 D-142：界面字号三档（小 / 中 / 大），只缩放文字；
            2026-11-06 用户要求：字号旁边加「字重（常规 / 加粗）」 */}
        <div className="set-fontsize-row">
          <span className="set-fontsize-title">{t('字号')}</span>
          <Segmented
            size="sm"
            variant="radio"
            ariaLabel={t('界面字号')}
            options={FONT_SIZES.map((id) => ({ id, label: t(FONT_SIZE_LABEL[id]) }))}
            value={fontSize}
            onChange={(id) => onFontSize(id as FontSize)}
          />
          <span className="set-fontsize-title set-fontweight-title">{t('字重')}</span>
          <Segmented
            size="sm"
            variant="radio"
            ariaLabel={t('界面字重')}
            options={FONT_WEIGHTS.map((id) => ({ id, label: t(FONT_WEIGHT_LABEL[id]) }))}
            value={fontWeight}
            onChange={(id) => onFontWeight(id as FontWeight)}
          />
          <span className="set-fontsize-hint">
            {t('只改界面文字大小与粗细，不动图片 / 图标 / 布局比例')}
          </span>
        </div>
      </section>
    </div>
  );
}
