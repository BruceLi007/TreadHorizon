/**
 * M1 冒烟测试 —— 到访编辑/删除、媒体（软删进回收站/移动/封面）、搜索、时间轴、归档目录
 *
 *   node scripts/smoke-m1.mjs
 *
 * 需要先启动服务（npm run dev / node server/index.mjs --dev）。
 * ⚠️ 会创建并软删一个「M1 测试点」，建议在开发期素材库上跑。
 */
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4000';

const j = async (r) => {
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
};
/** 只取响应状态码；顺手把 body 读掉，避免连接一直挂着 */
const statusOf = async (url) => {
  const r = await fetch(url);
  try {
    await r.arrayBuffer();
  } catch {
    /* ignore */
  }
  return r.status;
};

let fail = 0;
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fail++;
};

console.log('\nM1 冒烟测试  ' + BASE);
console.log('─'.repeat(56));

// 建地点 + 第一条到访
const place = await fetch(`${BASE}/api/places`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'M1 测试点', lng: 120.1, lat: 30.2, province: '浙江省', city: '杭州市',
    province_code: '156330000', city_code: '156330100', kind: 'visited', date: '2020-05-01',
  }),
}).then(j);
check('建地点', Boolean(place.id), place.name);
const v1 = place.visits[0];

// 编辑到访（F-VST-03）
const edited = await fetch(`${BASE}/api/visits/${v1.id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    title: '第一次来', note: '第一行\n第二行', rating: 5, companions: ['小王', '小李'],
  }),
}).then(j);
const ev = edited.visits.find((x) => x.id === v1.id);
check('编辑到访：标题', ev.title === '第一次来', ev.title);
check('编辑到访：笔记保留换行', ev.note === '第一行\n第二行');
check('编辑到访：评分', ev.rating === 5, String(ev.rating));
check('编辑到访：同行人数组', Array.isArray(ev.companions) && ev.companions.length === 2, JSON.stringify(ev.companions));

// 加第二次到访
const withSecond = await fetch(`${BASE}/api/places/${place.id}/visits`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ date: '2024-08-02', title: '又来了' }),
}).then(j);
check('追加到访', withSecond.visits.length === 2, String(withSecond.visits.length));
const v2 = withSecond.visits.find((x) => x.date === '2024-08-02');

// 上传一张图到 v1
const buf = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 40, g: 90, b: 160 } } })
  .jpeg().toBuffer();
const fd = new FormData();
fd.append('files', new Blob([buf], { type: 'image/jpeg' }), 'm1.jpg');
const up = await fetch(`${BASE}/api/media/upload?visitId=${v1.id}`, { method: 'POST', body: fd }).then(j);
check('上传图片', up.added?.length === 1);
const mediaId = up.added[0].id;

// 落盘结构（F-MED-08 / D-35）：省 / 市 / 区县 / 日期_地点名
const health = await fetch(`${BASE}/api/health`).then(j);
const expectedPath = resolve(
  health.mediaRoot,
  '浙江省',
  '杭州市',
  '未标注',
  '2020-05-01_M1测试点',
  'm1.jpg'
);
check('落盘在 省/市/区县/日期_地点名 下', existsSync(expectedPath), expectedPath);

// 移动到另一次到访（F-MED-05）
await fetch(`${BASE}/api/media/${mediaId}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ visit_id: v2.id }),
}).then(j);
const moved = await fetch(`${BASE}/api/places/${place.id}`).then(j);
check('移动媒体到别的到访', moved.visits.find((x) => x.id === v2.id).media.length === 1);

// 设为封面（F-MED-06）
const covered = await fetch(`${BASE}/api/places/${place.id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cover_media_id: mediaId }),
}).then(j);
check('设为封面', covered.cover_id === mediaId, covered.cover_id);

// 本地搜索：按到访笔记命中（F-BRW-02）
const byNote = await fetch(`${BASE}/api/places?q=${encodeURIComponent('第二行')}`).then(j);
check('本地搜索命中到访笔记', byNote.some((p) => p.id === place.id), `命中 ${byNote.length} 条`);

// 时间轴（F-BRW-03）
const tl = await fetch(`${BASE}/api/timeline`).then(j);
check('时间轴首末日期', tl.first === '2020-05-01' && tl.last === '2024-08-02', `${tl.first} → ${tl.last}`);
check('时间轴按季度分桶', tl.buckets.length >= 2, JSON.stringify(tl.buckets));
check(
  '时间轴返回去重后的到访日期（跳空白用）',
  Array.isArray(tl.dates) && tl.dates.join(',') === '2020-05-01,2024-08-02',
  JSON.stringify(tl.dates)
);
const ranged = await fetch(`${BASE}/api/map/visits?from=2024-01-01&to=2024-12-31`).then(j);
check('时间轴过滤只留 2024', ranged.length === 1 && ranged[0].id === place.id, `命中 ${ranged.length}`);
check(
  '区间接口同时返回总次数（区间内 1 / 共 2）',
  ranged[0]?.visit_count === 1 && ranged[0]?.total_visit_count === 2,
  JSON.stringify({ range: ranged[0]?.visit_count, total: ranged[0]?.total_visit_count })
);
const none = await fetch(`${BASE}/api/map/visits?from=2000-01-01&to=2001-01-01`).then(j);
check('区间外无结果', none.length === 0);

// 软删媒体进回收站（F-SYS-07 / D-56）：DB 记录 + B 原片 + 缓存都保留，可在回收站恢复
const libBefore = await fetch(`${BASE}/api/library`).then(j);
const delMedia = await fetch(`${BASE}/api/media/${mediaId}`, { method: 'DELETE' }).then(j);
check(
  '删除媒体：trashed=true（进回收站，不物理删除）',
  delMedia.ok === true && delMedia.trashed === true,
  JSON.stringify(delMedia)
);
check(
  '删除媒体：返回 mediaId / visitId / bytes',
  delMedia.mediaId === mediaId && delMedia.visitId === v2.id && delMedia.bytes > 0,
  JSON.stringify(delMedia)
);
check('删除后 B 库原片仍存在（软删不动文件）', existsSync(expectedPath), expectedPath);
const afterDel = await fetch(`${BASE}/api/places/${place.id}`).then(j);
check('删除后相册不再出现', afterDel.visits.every((v) => v.media.length === 0));
check('删除后封面引用被清空', afterDel.cover_id == null, String(afterDel.cover_id));
check(
  '删除后原图仍可访问（记录和文件都在回收站里）',
  (await statusOf(`${BASE}/api/media/${mediaId}/orig`)) === 200
);
check(
  '删除后缩略图缓存仍可访问（缓存没删）',
  (await statusOf(`${BASE}/api/media/${mediaId}/thumb`)) === 200
);
const lib = await fetch(`${BASE}/api/library`).then(j);
check(
  '软删后素材库 deleted +1（记录进回收站）',
  lib.deleted === libBefore.deleted + 1,
  `deleted ${libBefore.deleted}→${lib.deleted}`
);
check(
  '软删后素材库 total -1（total 只算未删媒体）',
  lib.total === libBefore.total - 1,
  `total ${libBefore.total}→${lib.total}`
);
check(
  '软删后素材库 missing 不变（文件还在，不算丢失）',
  lib.missing === libBefore.missing,
  `missing ${libBefore.missing}→${lib.missing}`
);

// 删除到访（F-VST-04）
const del1 = await fetch(`${BASE}/api/visits/${v1.id}`, { method: 'DELETE' }).then(j);
check('删除到访：lastVisit=false', del1.ok === true && del1.lastVisit === false, JSON.stringify(del1));
const del2 = await fetch(`${BASE}/api/visits/${v2.id}`, { method: 'DELETE' }).then(j);
check('删除最后一次到访：lastVisit=true', del2.lastVisit === true);

// 清理
await fetch(`${BASE}/api/places/${place.id}`, { method: 'DELETE' }).then(j);

// 想去语义（F-PLC-07 / D-31）：不自动建到访、转去过后可加访
const wish = await fetch(`${BASE}/api/places`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'M1 想去点', lng: 91.12, lat: 29.62, province: '西藏自治区', city: '拉萨市',
    kind: 'wishlist', date: '2020-05-01',
  }),
}).then(j);
check('想去地点不自动建到访', wish.visits?.length === 0, `${wish.visits?.length} 条`);

const searched = await fetch(`${BASE}/api/places?q=${encodeURIComponent('M1 想去点')}`).then(j);
check('本地搜索能搜到想去地点', searched.some((x) => x.id === wish.id && x.kind === 'wishlist'));

const converted = await fetch(`${BASE}/api/places/${wish.id}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'visited' }),
}).then(j);
check('想去转去过后仍然没有到访', converted.kind === 'visited' && converted.visits.length === 0);

const afterConvert = await fetch(`${BASE}/api/places/${wish.id}/visits`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ date: '2026-11-01', title: '终于来了' }),
}).then(j);
check('转去过后可以正常补到访', afterConvert.visits.length === 1);

await fetch(`${BASE}/api/places/${wish.id}`, { method: 'DELETE' }).then(j);

console.log('─'.repeat(56));
console.log(fail === 0 ? '全部通过 ✅' : `${fail} 项失败 ❌`);
process.exitCode = fail === 0 ? 0 : 1;
