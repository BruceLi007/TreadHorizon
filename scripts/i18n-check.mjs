#!/usr/bin/env node
/**
 * 中英文切换自检（2026-11-04，D-138）：`node scripts/i18n-check.mjs`
 *
 * 检查四件事：
 * 1) **缺词条**：src 里 `t('中文')` / `tr('中文')` 用到的 key，在 `src/i18n/en/*.ts` 里没有 →
 *    英文模式会回退中文。必须为 0（退出码 1）。
 * 2) **占位符不一致**：中文 key 和英文译文里的 `{name}` 集合不同 → 英文模式会缺参数。必须为 0。
 * 3) **未使用词条**：字典里有、但代码里既没被 t() 引用、也没以字符串常量形式出现在 src
 *    （`t(常量)` 这种动态 key 检测不到字面量，所以「代码里出现过这个中文串」也算引用；提示，可忽略）。
 * 4) **残留中文**：非注释、非 i18n 文件里带中文但没出现 `t(` / `tr(` 的行 → 人工复核
 *    （白名单：省名归一、主题/字体标签常量等「数据/查表用」中文，见 ALLOW_CJK）。
 *
 * 用法：在项目根目录 `node scripts/i18n-check.mjs`（不需要起服务，纯静态扫描）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const EN_DIR = join(SRC, 'i18n', 'en');

/** 这些文件里的中文是数据 / 查表 key，不是界面文案（渲染处会再包 t(...)） */
const ALLOW_CJK = new Set([
  'src/i18n/index.ts',
  'src/i18n/provinces.ts',
  'src/i18n/en/index.ts',
  'src/ui/settings/types.ts', // 主题档位 / 字体名：常量保留中文，GeneralSettings 渲染时包 t(...)
  'src/map/provinces.ts', // 省名归一与省级行政区数据，不翻
  'src/lib/markerPalette.ts', // 7 种配色名：设置页渲染时包 t(...)
  'src/lib/markerColors.ts', // 三种标记类型名：设置页渲染时包 t(...)
  'src/lib/homeIcon.ts', // 家图标 7 种配色名（D-161）：渲染时包 t(...)
]);

const rel = (p) => relative(ROOT, p).split('\\').join('/');

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

const isI18nFile = (p) => rel(p).startsWith('src/i18n/');
const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"');

// ── 1) 收集代码里用到的 key（t('…') / tr('…') / t("…") / tr("…")）──
const used = new Map(); // key -> first file:line
const CALL_SINGLE = /\b(?:t|tr)\(\s*'((?:[^'\\]|\\.)*)'/g;
const CALL_DOUBLE = /\b(?:t|tr)\(\s*"((?:[^"\\]|\\.)*)"/g;
// 代码里出现过的任意字符串常量（给「t(常量) 动态 key」兜底，避免误报未使用）
const ANY_SINGLE = /'((?:[^'\\]|\\.)*)'/g;
const ANY_DOUBLE = /"((?:[^"\\]|\\.)*)"/g;
const referenced = new Set();

for (const file of walk(SRC)) {
  if (isI18nFile(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const re of [CALL_SINGLE, CALL_DOUBLE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const key = unescape(m[1]);
      if (!key.trim()) continue;
      if (!used.has(key)) {
        const line = text.slice(0, m.index).split(/\r?\n/).length;
        used.set(key, `${rel(file)}:${line}`);
      }
    }
  }
  for (const re of [ANY_SINGLE, ANY_DOUBLE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const s = unescape(m[1]);
      if (s && /[\u4e00-\u9fff]/.test(s)) referenced.add(s);
    }
  }
}

// ── 2) 收集英文字典词条（一行一条，或 key 换行、value 在下一行）──
const entries = new Map(); // key -> { value, where }
const dupes = [];

const addEntry = (key, value, where) => {
  const prev = entries.get(key);
  if (prev) {
    if (prev.value !== value) {
      dupes.push({ key, a: prev, b: { value, where } });
    }
  } else {
    entries.set(key, { value, where });
  }
};

for (const file of walk(EN_DIR)) {
  const where = rel(file);
  let pendingKey = null;
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return;
      let m = t.match(/^'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'\s*,?$/);
      if (m) {
        addEntry(unescape(m[1]), unescape(m[2]), `${where}:${i + 1}`);
        pendingKey = null;
        return;
      }
      m = t.match(/^'((?:[^'\\]|\\.)*)'\s*:\s*$/);
      if (m) {
        pendingKey = { key: unescape(m[1]), line: i + 1 };
        return;
      }
      if (pendingKey) {
        const v = t.match(/^'((?:[^'\\]|\\.)*)'\s*,?$/);
        if (v) {
          addEntry(pendingKey.key, unescape(v[1]), `${where}:${pendingKey.line}`);
          pendingKey = null;
        }
      }
    });
}

const placeholders = (s) => {
  const set = new Set();
  for (const m of String(s).matchAll(/\{(\w+)\}/g)) set.add(m[1]);
  return set;
};
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

const missing = [...used.keys()].filter((k) => !entries.has(k)).sort();
const unused = [...entries.keys()]
  .filter((k) => !used.has(k) && !referenced.has(k))
  .sort();
const badPlaceholders = [];
for (const [key, entry] of entries) {
  const a = placeholders(key);
  const b = placeholders(entry.value);
  if (!sameSet(a, b)) {
    badPlaceholders.push({ key, where: entry.where, zh: [...a].join(','), en: [...b].join(',') });
  }
}

// ── 3) 残留中文扫描 ──
const residue = [];
for (const file of walk(SRC)) {
  const where = rel(file);
  if (isI18nFile(file) || ALLOW_CJK.has(where)) continue;
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const t = line.trim();
      if (!/[\u4e00-\u9fff]/.test(line)) return;
      if (/^(\/\/|\/\*|\*|\{\/\*)/.test(t)) return; // 注释
      if (/\b(?:t|tr)\(/.test(line)) return; // 已包翻译
      residue.push(`${where}:${i + 1}: ${t.slice(0, 120)}`);
    });
}

// ── 输出 ──
const line = (s = '') => process.stdout.write(s + '\n');
line(`i18n-check · 代码里用到 ${used.size} 个词条 · 字典里有 ${entries.size} 个词条`);
line('');

if (missing.length) {
  line(`❌ 缺词条 ${missing.length} 个（英文模式会回退中文）：`);
  for (const k of missing) line(`   - ${k}  ← ${used.get(k)}`);
  line('');
}
if (badPlaceholders.length) {
  line(`❌ 占位符不一致 ${badPlaceholders.length} 个：`);
  for (const p of badPlaceholders) line(`   - ${p.key} [{zh: ${p.zh || '无'} | en: ${p.en || '无'}}]  ${p.where}`);
  line('');
}
if (dupes.length) {
  line(`⚠️ 同一 key 在不同域里译文不一致 ${dupes.length} 个（后合并的会覆盖前面的，建议统一）：`);
  for (const d of dupes) line(`   - ${d.key}｜${d.a.value}（${d.a.where}）vs ${d.b.value}（${d.b.where}）`);
  line('');
}
if (unused.length) {
  line(`ℹ️ 未使用词条 ${unused.length} 个（可忽略；改过文案后建议删）：`);
  for (const k of unused) line(`   - ${k}  (${entries.get(k).where})`);
  line('');
}
if (residue.length) {
  line(`⚠️ 残留中文待人工复核 ${residue.length} 行（注释 / t() 之外的中文）：`);
  for (const r of residue.slice(0, 300)) line(`   - ${r}`);
  if (residue.length > 300) line(`   …还有 ${residue.length - 300} 行`);
  line('');
}

const bad = missing.length + badPlaceholders.length;
if (bad === 0) {
  line('✅ 缺词条 / 占位符检查通过');
} else {
  line(`❌ 有 ${bad} 个问题需要修`);
}
process.exit(bad === 0 ? 0 : 1);
