/**
 * 目录解析 / 扫描单元测试（F-IMP-01）
 *
 *   node scripts/test-parse.mjs
 *
 * 不启动服务、不碰真实数据库和素材库：全部在系统临时目录里造数据。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  parseVisitFolderName,
  parseRegionHint,
  scanLibrary,
  hashFile16,
  normPath,
} from '../server/importer.mjs';

let fail = 0;
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? '' : `实际=${a} 期望=${b}`);
};

console.log('\n目录解析 / 扫描测试');
console.log('─'.repeat(60));

// ── 1. 末级文件夹名解析 ──
eq('解析 2024-10-02_杭州', parseVisitFolderName('2024-10-02_杭州'), {
  ok: true,
  date: '2024-10-02',
  name: '杭州',
});
eq('地点名里的下划线保留', parseVisitFolderName('2024-10-02_杭州_西湖').name, '杭州_西湖');
eq('地点名前后空格去掉', parseVisitFolderName('2024-10-02_ 杭州 ').name, '杭州');
eq('闰日 2024-02-29 合法', parseVisitFolderName('2024-02-29_闰日').ok, true);
eq('非闰年 2023-02-29 非法', parseVisitFolderName('2023-02-29_x').ok, false);
eq('月份 13 非法', parseVisitFolderName('2024-13-01_杭州').ok, false);
eq('月份 00 非法', parseVisitFolderName('2024-00-01_杭州').ok, false);
eq('日 00 非法', parseVisitFolderName('2024-10-00_杭州').ok, false);
eq('非两位月份不认', parseVisitFolderName('2024-1-02_杭州').ok, false);
eq('只有地名不认', parseVisitFolderName('杭州').ok, false);
eq('下划线后为空不认', parseVisitFolderName('2024-10-02_').ok, false);
eq('年份越界不认', parseVisitFolderName('1800-01-01_古').ok, false);

// ── 2. 地区提示 ──
eq('标准三级', parseRegionHint(['浙江省', '杭州市', '西湖区']), {
  province: '浙江省',
  city: '杭州市',
  county: '西湖区',
});
eq('「未标注」视为缺级', parseRegionHint(['浙江省', '未标注', '西湖区']), {
  province: '浙江省',
  city: null,
  county: '西湖区',
});
eq('全未标注 → null', parseRegionHint(['未标注', '未标注', '未标注']), null);
eq('旧结构年份目录不算地区', parseRegionHint(['2024']), null);
eq('只有两级不给提示', parseRegionHint(['浙江省', '杭州市']), null);
eq('空路径 → null', parseRegionHint([]), null);

// ── 3. 扫一个临时素材库 ──
const tmp = mkdtempSync(join(tmpdir(), 'tm-parse-'));
const w = (rel, content = 'fake-bytes') => {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

try {
  // 标准结构：省/市/区县/日期_地点名，含子目录相册、_cover、note.md、视频、无关文件
  w('浙江省/杭州市/西湖区/2024-10-02_杭州/IMG_1.JPG', 'one');
  w('浙江省/杭州市/西湖区/2024-10-02_杭州/西湖/IMG_2.JPG', 'two');
  w('浙江省/杭州市/西湖区/2024-10-02_杭州/VID_1.MP4', 'video');
  w('浙江省/杭州市/西湖区/2024-10-02_杭州/_cover.jpg', 'cover');
  w('浙江省/杭州市/西湖区/2024-10-02_杭州/note.md', '\uFEFF第一天\n第二行\n');
  w('浙江省/杭州市/西湖区/2024-10-02_杭州/说明.txt', 'ignore');
  // 旧结构：年/日期_地点名
  w('2024/2024-10-02_旧结构/IMG.JPG');
  // 平铺日期文件夹
  w('2024-01-01_平铺/IMG.JPG');
  // 日期非法（仍当到访，mtime 兜底 + 待确认）
  w('2024-13-01_非法日期/IMG.JPG');
  // _inbox 散图（含嵌套）
  w('_inbox/a.jpg');
  w('_inbox/子目录/c.jpg');
  // 非日期目录里直接放媒体 → 未归类
  w('随手拍/b.jpg');
  // 隐藏文件 / 系统文件
  w('.DS_Store');
  w('浙江省/杭州市/西湖区/2024-10-02_杭州/Thumbs.db');

  const scan = scanLibrary(tmp);
  check('扫描无致命错误', scan.errors.length === 0, JSON.stringify(scan.errors));

  console.log('  (按文件夹逐项核对)');
  const byName = new Map(scan.visits.map((v) => [v.name, v]));
  eq('到访文件夹数量', scan.visits.length, 4);
  check('识别 杭州', byName.has('杭州'));
  check('识别 平铺', byName.has('平铺'));
  check('识别 旧结构', byName.has('旧结构'));
  check('识别 非法日期', byName.has('非法日期'));

  const hz = byName.get('杭州');
  eq('杭州 日期', hz.date, '2024-10-02');
  eq('杭州 dateFrom=folder', hz.dateFrom, 'folder');
  eq('杭州 needsConfirm=false', hz.needsConfirm, false);
  eq('杭州 地区提示', hz.region, { province: '浙江省', city: '杭州市', county: '西湖区' });
  eq('杭州 文件数（含子目录）', hz.files.length, 3);
  eq('杭州 照片数', hz.files.filter((x) => x.kind === 'photo').length, 2);
  eq('杭州 视频数', hz.files.filter((x) => x.kind === 'video').length, 1);
  eq('杭州 封面被识别', hz.cover?.name, '_cover.jpg');
  eq('杭州 note 去掉 BOM 并保留换行', hz.note, '第一天\n第二行');

  const legacy = byName.get('旧结构');
  eq('旧结构 地区提示为 null', legacy.region, null);
  eq('平铺 地区提示为 null', byName.get('平铺').region, null);

  const bad = byName.get('非法日期');
  eq('非法日期 needsConfirm=true', bad.needsConfirm, true);
  eq('非法日期 dateFrom=mtime', bad.dateFrom, 'mtime');
  check('非法日期 日期形如 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(bad.date), bad.date);

  eq(
    '未归类文件（_inbox 两个 + 随手拍一个）',
    scan.unclassified.map((x) => x.name).sort(),
    ['a.jpg', 'b.jpg', 'c.jpg']
  );
  eq('_inbox 的 reason', scan.unclassified.find((x) => x.name === 'a.jpg')?.reason, 'inbox');
  eq('普通目录的 reason', scan.unclassified.find((x) => x.name === 'b.jpg')?.reason, 'folder');
  check('忽略非媒体文件 >= 1', scan.ignored.count >= 1, String(scan.ignored.count));

  // ── 4. hash ──
  w('hash/a.bin', 'same-content');
  w('hash/b.bin', 'same-content');
  w('hash/c.bin', 'different');
  const [ha, hb, hc] = await Promise.all([
    hashFile16(join(tmp, 'hash/a.bin')),
    hashFile16(join(tmp, 'hash/b.bin')),
    hashFile16(join(tmp, 'hash/c.bin')),
  ]);
  check('hash 长度 16', ha.length === 16, ha);
  check('同内容 hash 相同', ha === hb);
  check('不同内容 hash 不同', ha !== hc);
  eq('normPath 统一分隔符', normPath('a\\b\\c.jpg'), 'a/b/c.jpg');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('─'.repeat(60));
console.log(fail === 0 ? '全部通过 ✅' : `${fail} 项失败 ❌`);
process.exitCode = fail === 0 ? 0 : 1;
