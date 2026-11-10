/**
 * M3 照片墙（F-BRW-04）隔离冒烟测试
 *
 *   node scripts/smoke-m3-photos.mjs
 *
 * 全隔离：空临时 DATA_DIR + 空临时素材库 + 4199 端口独立实例（SMOKE_M3_PHOTOS_PORT 可覆盖），跑完清理。
 * 不碰真实 data/travel.db、.dev-media、.env.local。
 *
 * 覆盖：total / items 排序与分页 / years / province·city·place_id·kind·from·to 筛选 /
 * secret 透出 / 软删媒体·到访·地点不出现 / 参数校验 400。
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_M3_PHOTOS_PORT || 4199);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
};
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? '' : `实际=${a} 期望=${b}`);
};
const section = (title) => console.log(`\n── ${title} ──`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const j = async (r) => {
  const t = await r.text();
  if (!r.ok) {
    let msg = `HTTP ${r.status}: ${t.slice(0, 300)}`;
    try {
      const b = JSON.parse(t);
      if (b?.error) msg = `HTTP ${r.status}: ${b.error}`;
    } catch {
      /* keep */
    }
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return JSON.parse(t);
};

const getJson = (path) => fetch(BASE + path).then(j);
const postJson = (path, body) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);
const patchJson = (path, body) =>
  fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);
const delJson = (path) => fetch(BASE + path, { method: 'DELETE' }).then(j);

const expectStatus = async (label, status, fn) => {
  let actual = null;
  let msg = '';
  try {
    await fn();
    actual = 200;
  } catch (e) {
    actual = e.status ?? null;
    msg = e.message;
  }
  check(
    `${label} → HTTP ${status}`,
    actual === status,
    actual === status ? '' : `实际=${actual ?? '无'}${msg ? `（${msg.slice(0, 120)}）` : ''}`
  );
};

const createPlace = (name, extra = {}) =>
  postJson('/api/places', {
    name,
    lng: 120.1 + Math.random() * 0.1,
    lat: 30.2 + Math.random() * 0.1,
    kind: 'visited',
    ...extra,
  });
const addVisit = (placeId, body = {}) => postJson(`/api/places/${placeId}/visits`, body);
const findVisit = (detail, date) => (detail.visits || []).find((v) => v.date === date);

const makeJpg = (r, g, b) =>
  sharp({ create: { width: 240, height: 180, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 80 })
    .toBuffer();
const uploadOne = async (visitId, name, buf, type = 'image/jpeg') => {
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type }), name);
  return fetch(`${BASE}/api/media/upload?visitId=${encodeURIComponent(visitId)}`, {
    method: 'POST',
    body: fd,
  }).then(j);
};
const uploadPhoto = async (visitId, name, rgb = [120, 60, 30]) => {
  const up = await uploadOne(visitId, name, await makeJpg(...rgb));
  return up.added?.[0]?.id ?? null;
};
/** 假 mp4：只要扩展名是视频即可落一条 kind='video' 的媒体记录（无 ffmpeg 时不会生成封面帧）。
 *  2026-11-10 D-359：尾部拼上文件名，保证两次上传的内容不同——D-354 起上传按「同账号全库」
 *  sha256 查重，完全相同字节的第二个假视频会被判重复跳过，导致本冒烟造数少一条。 */
const uploadVideo = async (visitId, name) => {
  const buf = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypmp42'),
    Buffer.alloc(64, 7),
    Buffer.from(name),
  ]);
  const up = await uploadOne(visitId, name, buf, 'video/mp4');
  return up.added?.[0]?.id ?? null;
};

const PLA = { province: '浙江省', city: '杭州市', county: '西湖区', province_code: '330000', city_code: '330100', county_code: '330106' };
const NBO = { province: '浙江省', city: '宁波市', county: '海曙区', province_code: '330000', city_code: '330200', county_code: '330203' };
const BJ = { province: '北京市', city: '北京市', county: '东城区', province_code: '110000', city_code: '110100', county_code: '110101' };

const sortDesc = (arr) => [...arr].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
const yearsOf = (items) => {
  const m = new Map();
  for (const it of items) m.set(it.date.slice(0, 4), (m.get(it.date.slice(0, 4)) || 0) + 1);
  return sortDesc([...m.keys()]).map((y) => ({ year: y, count: m.get(y) }));
};
/** 按 items 聚合省份（D-359 校验 /api/photos 新增的 provinces 字段用） */
const provincesOf = (items) => {
  const m = new Map();
  for (const it of items) {
    const name = it.place?.province;
    if (!name) continue;
    m.set(name, (m.get(name) || 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, count]) => ({ name, count }));
};

const run = async () => {
  console.log(`\nM3 照片墙冒烟（F-BRW-04，隔离实例 :${PORT}）`);
  console.log('─'.repeat(64));

  const tmp = mkdtempSync(join(ROOT, '.smoke-m3-photos-'));
  const dataDir = join(tmp, 'data');
  const mediaRoot = join(tmp, 'media');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });

  let child = null;
  let logFd = null;
  const logPath = join(tmp, 'server.log');
  const readLogs = () => {
    try {
      return readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };

  try {
    logFd = openSync(logPath, 'a');
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        STARTER_DATA: '0',
        PORT: String(PORT),
        DATA_DIR: dataDir,
        MEDIA_ROOT: mediaRoot,
        MEDIA_ROOT_DEV: mediaRoot,
      },
      // 沙箱不允许 pipe：stdout/stderr 一律重定向到日志文件
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });

    let health = null;
    for (let i = 0; i < 60; i++) {
      try {
        health = await getJson('/api/health');
        if (health?.ok) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(250);
    }
    if (!health?.ok) throw new Error('服务没起来：\n' + readLogs().slice(-2000));
    check('隔离实例在线且素材库指向临时目录', resolve(health.mediaRoot) === resolve(mediaRoot), health.mediaRoot);

    // ── 1) 造数据 ──────────────────────────────────────────────
    section('1) 造数据：3 个地点、4 次到访、5 照片 + 2 视频 + 1 条软删地点素材');
    const F1 = await createPlace('照片-西湖', { ...PLA, date: '2020-05-01' });
    const v1 = F1.visits[0].id;
    let d = await patchJson(`/api/visits/${v1}`, { title: '西湖春游' });
    check('设置到访标题', d.visits.some((v) => v.id === v1 && v.title === '西湖春游'));
    d = await addVisit(F1.id, { date: '2024-01-15' });
    const v2 = findVisit(d, '2024-01-15').id;

    const F2 = await createPlace('照片-天一阁', { ...NBO, date: '2022-08-08' });
    const v3 = F2.visits[0].id;

    const F3 = await createPlace('照片-故宫', { ...BJ, date: '2024-06-01' });
    const v4 = F3.visits[0].id;

    const F4 = await createPlace('照片-已删地点', { ...PLA, date: '2021-01-01' });
    const v5 = F4.visits[0].id;

    const a1 = await uploadPhoto(v1, 'ph-a1.jpg', [10, 20, 30]);
    const a2 = await uploadPhoto(v1, 'ph-a2.jpg', [40, 50, 60]);
    const vid1 = await uploadVideo(v1, 'ph-vid1.mp4');
    const b1 = await uploadPhoto(v2, 'ph-b1.jpg', [70, 80, 90]);
    const c1 = await uploadPhoto(v3, 'ph-c1.jpg', [11, 22, 33]);
    const d1 = await uploadPhoto(v4, 'ph-d1.jpg', [44, 55, 66]);
    const vid2 = await uploadVideo(v4, 'ph-vid2.mp4');
    const e1 = await uploadPhoto(v5, 'ph-e1.jpg', [99, 99, 99]);
    eq('上传 5 张照片', [a1, a2, b1, c1, d1].filter(Boolean).length, 5);
    eq('上传 2 个视频', [vid1, vid2].filter(Boolean).length, 2);
    check('已删地点的素材也上传成功', Boolean(e1));

    const sec = await patchJson(`/api/places/${F3.id}`, { secret: true });
    eq('PATCH 秘密基地 secret=true', sec.secret, 1);
    await delJson(`/api/places/${F4.id}`);
    await delJson(`/api/media/${a1}`);
    await delJson(`/api/visits/${v3}`);
    // 剩余 alive：F1（a2 + vid1 + b1 = 3）、F2（0，到访被删）、F3（d1 + vid2 = 2）→ 5
    // 含软删 a1 / 软删到访 v3 的 c1 / 软删地点 F4 的 e1 已全部排除

    // ── 2) 默认列表 + 排序 + 字段 ──────────────────────────────
    section('2) 默认列表：total / 排序 / 字段');
    const p = await getJson('/api/photos');
    eq('total = 5（软删媒体/到访/地点不算）', p.total, 5);
    eq('items 长度 = 5', p.items.length, 5);
    const dates = p.items.map((it) => it.date);
    check('items 按 visit.date 倒序', dates.every((d, i) => i === 0 || dates[i - 1] >= d), JSON.stringify(dates));
    eq('第一页首个 date = 2024-06-01（F3）', p.items[0].date, '2024-06-01');
    eq('2024-06-01 两条', p.items.filter((it) => it.date === '2024-06-01').length, 2);
    eq('末尾 date = 2020-05-01', p.items[p.items.length - 1].date, '2020-05-01');
    check('软删的 a1 不出现', !p.items.some((it) => it.id === a1));
    check('软删到访的 c1 不出现', !p.items.some((it) => it.id === c1));
    check('软删地点的 e1 不出现', !p.items.some((it) => it.id === e1));
    eq('years = 2024:3 / 2020:2', p.years, [
      { year: '2024', count: 3 },
      { year: '2020', count: 2 },
    ]);
    eq('years 与 items 分布一致', p.years, yearsOf(p.items));
    // D-359：新增 provinces（省份下拉的服务端数据源；全部省份聚合，不受省份筛选本身影响）
    eq('provinces = 北京市 2 / 浙江省 3', p.provinces, [
      { name: '北京市', count: 2 },
      { name: '浙江省', count: 3 },
    ]);
    eq('provinces 与 items 分布一致', p.provinces, provincesOf(p.items));

    const photoItem = p.items.find((it) => it.id === b1);
    eq('照片 item 字段', {
      id: photoItem.id,
      kind: photoItem.kind,
      date: photoItem.date,
      visit_id: photoItem.visit_id,
      visit_title: photoItem.visit_title,
      place: photoItem.place,
      secret: photoItem.secret,
    }, {
      id: b1,
      kind: 'photo',
      date: '2024-01-15',
      visit_id: v2,
      visit_title: null,
      place: { id: F1.id, name: '照片-西湖', province: '浙江省', city: '杭州市', county: '西湖区' },
      secret: 0,
    });
    check('照片 item 带 width/height/bytes', photoItem.width > 0 && photoItem.height > 0 && photoItem.bytes > 0);
    check('照片 item created_at 是数字', typeof photoItem.created_at === 'number');
    eq('照片 duration = null', photoItem.duration, null);
    const videoItem = p.items.find((it) => it.id === vid2);
    eq('视频 item kind', videoItem.kind, 'video');
    eq('视频 item date = 2024-06-01', videoItem.date, '2024-06-01');
    const secretItem = p.items.find((it) => it.place.id === F3.id);
    eq('秘密基地地点 item 带 secret=1', secretItem.secret, 1);
    const titleItem = p.items.find((it) => it.id === a2);
    eq('visit_title 透出', titleItem.visit_title, '西湖春游');

    // ── 3) 分页 ────────────────────────────────────────────────
    section('3) limit / offset 分页，total 不受分页影响');
    const page1 = await getJson('/api/photos?limit=2&offset=0');
    eq('limit=2 total 仍是 5', page1.total, 5);
    eq('limit=2 items 长度 2', page1.items.length, 2);
    eq('第一页两条都是 2024-06-01', page1.items.map((it) => it.date), ['2024-06-01', '2024-06-01']);
    const page2 = await getJson('/api/photos?limit=2&offset=2');
    eq('offset=2 第二页日期', page2.items.map((it) => it.date), ['2024-01-15', '2020-05-01']);
    eq('offset=2 total 仍是 5', page2.total, 5);
    const page3 = await getJson('/api/photos?limit=200&offset=4');
    eq('offset=4 只剩 1 条', page3.items.length, 1);
    eq('offset 超出 → 空数组', (await getJson('/api/photos?offset=99')).items, []);
    const pageAll = await getJson('/api/photos?limit=1');
    eq('limit=1 也能拿到 total', pageAll.total, 5);

    // ── 4) 筛选 ─────────────────────────────────────────────────
    section('4) province / city / place_id / kind / from / to 筛选');
    const byProv = await getJson('/api/photos?province=' + encodeURIComponent('浙江省'));
    eq('province=浙江省 total=3（软删后）', byProv.total, 3);
    eq('province=浙江省 years', byProv.years, [{ year: '2024', count: 1 }, { year: '2020', count: 2 }]);
    // D-359：省份筛选不影响 provinces 列表本身（否则选了省下拉就只剩当前省）
    eq('province 筛选时 provinces 仍列全部省份', byProv.provinces, p.provinces);
    const byCity = await getJson('/api/photos?city=' + encodeURIComponent('杭州市'));
    eq('city=杭州市 total=3', byCity.total, 3);
    eq('city 不符 → 0', (await getJson('/api/photos?city=' + encodeURIComponent('三亚市'))).total, 0);
    const byPlace = await getJson('/api/photos?place_id=' + F1.id);
    eq('place_id=F1 total=3', byPlace.total, 3);
    check('place_id 筛选只含 F1 的素材', byPlace.items.every((it) => it.place.id === F1.id));
    const byKind = await getJson('/api/photos?kind=video');
    eq('kind=video total=2（vid1 + vid2）', byKind.total, 2);
    eq('kind=photo total=3', (await getJson('/api/photos?kind=photo')).total, 3);
    const byRange = await getJson('/api/photos?from=2024-01-01');
    eq('from=2024-01-01 total=3', byRange.total, 3);
    // D-359：provinces 跟随「其它筛选」，只列该时间范围内有素材的省份
    eq('from=2024 provinces 只列该范围内省份', byRange.provinces, [
      { name: '北京市', count: 2 },
      { name: '浙江省', count: 1 },
    ]);
    const byRange2 = await getJson('/api/photos?to=2020-12-31');
    eq('to=2020-12-31 total=2', byRange2.total, 2);
    const byRange3 = await getJson('/api/photos?from=2020-06-01&to=2023-12-31');
    eq('2020-06..2023-12 无素材 → 0', byRange3.total, 0);
    const byCombo = await getJson(
      '/api/photos?province=' +
        encodeURIComponent('浙江省') +
        '&from=2024-01-01&kind=photo'
    );
    eq('组合筛选 total=1（b1）', byCombo.total, 1);
    eq('组合筛选 items[0] = b1', byCombo.items[0]?.id, b1);
    eq('组合筛选 years', byCombo.years, [{ year: '2024', count: 1 }]);
    // D-359：组合筛选（含 province）时 provinces 仍按「其它筛选」聚合（北京 1 / 浙江 1）
    eq('组合筛选 provinces 不受省份筛选影响', byCombo.provinces, [
      { name: '北京市', count: 1 },
      { name: '浙江省', count: 1 },
    ]);

    // ── 5) 参数校验 ─────────────────────────────────────────────
    section('5) 参数白名单校验（400）');
    await expectStatus('from 格式非法', 400, () => getJson('/api/photos?from=2024-1-1'));
    await expectStatus('to 格式非法', 400, () => getJson('/api/photos?to=2024/01/01'));
    await expectStatus('from 晚于 to', 400, () => getJson('/api/photos?from=2024-12-31&to=2024-01-01'));
    await expectStatus('kind 非法', 400, () => getJson('/api/photos?kind=image'));
    await expectStatus('limit=0', 400, () => getJson('/api/photos?limit=0'));
    await expectStatus('limit=201', 400, () => getJson('/api/photos?limit=201'));
    await expectStatus('limit=abc', 400, () => getJson('/api/photos?limit=abc'));
    await expectStatus('offset=-1', 400, () => getJson('/api/photos?offset=-1'));
    await expectStatus('offset=abc', 400, () => getJson('/api/photos?offset=abc'));

    // ── 6) 已删数据不出现 ──────────────────────────────────────
    section('6) 软删媒体 / 到访 / 地点不出现');
    eq('删除 a2 后 total=4', (await delJson(`/api/media/${a2}`)) && (await getJson('/api/photos')).total, 4);
    check('a2 不出现', !(await getJson('/api/photos')).items.some((it) => it.id === a2));
    await delJson(`/api/visits/${v2}`);
    const p5 = await getJson('/api/photos');
    eq('删除到访 v2 后 total=3', p5.total, 3);
    check('v2 的 b1 不出现', !p5.items.some((it) => it.id === b1));
    eq('删除后 years', p5.years, [{ year: '2024', count: 2 }, { year: '2020', count: 1 }]);
    eq('删除后 years 与 items 一致', p5.years, yearsOf(p5.items));
    // D-359：软删后的 provinces（北京 2 / 浙江 1）
    eq('删除后 provinces', p5.provinces, [
      { name: '北京市', count: 2 },
      { name: '浙江省', count: 1 },
    ]);
    eq('删除后 provinces 与 items 一致', p5.provinces, provincesOf(p5.items));

    console.log('\n' + '─'.repeat(64));
    console.log(`通过 ${pass} 项，失败 ${fail} 项 ${fail === 0 ? '✅' : '❌'}`);
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(100);
    }
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
        /* ignore */
      }
    }
    await sleep(150);
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.log(`  (临时目录清理失败，可手动删：${tmp} — ${e.message})`);
    }
  }
};

run().catch((e) => {
  console.error('\nM3 照片墙冒烟异常：', e?.message || e);
  process.exitCode = 1;
});
