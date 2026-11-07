/**
 * M3 统计（F-STA / D-60）隔离冒烟测试
 *
 *   node scripts/smoke-m3-stats.mjs
 *
 * 全隔离：空临时 DATA_DIR + 空临时素材库 + 4198 端口独立实例（SMOKE_M3_STATS_PORT 可覆盖），跑完清理。
 * 不碰真实 data/travel.db、.dev-media、.env.local。
 *
 * 覆盖：totals / first / last / time（年·季·月 + 空桶补齐 + first_visits）/ provinces·cities·places 排行 /
 * province·city·from·to 筛选 / seriesBy Top6+其他 / 参数校验 400 / alive 口径 / /api/stats/provinces /
 * 离家最远 + 离家距离排行（D-185 / D-199）。
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_M3_STATS_PORT || 4198);
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
const delJson = (path) => fetch(BASE + path, { method: 'DELETE' }).then(j);
const patchJson = (path, body) =>
  fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);

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
const getPlace = (id) => getJson(`/api/places/${id}`);
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
/** 假 mp4：只要扩展名是视频即可落一条 kind='video' 的媒体记录（无 ffmpeg 时不会生成封面帧） */
const uploadVideo = async (visitId, name) => {
  const buf = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(64, 7)]);
  const up = await uploadOne(visitId, name, buf, 'video/mp4');
  return up.added?.[0]?.id ?? null;
};

const PLA = { province: '浙江省', city: '杭州市', county: '西湖区', province_code: '330000', city_code: '330100', county_code: '330106' };
const NBO = { province: '浙江省', city: '宁波市', county: '海曙区', province_code: '330000', city_code: '330200', county_code: '330203' };
const BJ = { province: '北京市', city: '北京市', county: '东城区', province_code: '110000', city_code: '110100', county_code: '110101' };
const CD = { province: '四川省', city: '成都市', county: '青羊区', province_code: '510000', city_code: '510100', county_code: '510105' };

const run = async () => {
  console.log(`\nM3 统计冒烟（F-STA / D-60，隔离实例 :${PORT}）`);
  console.log('─'.repeat(64));

  const tmp = mkdtempSync(join(ROOT, '.smoke-m3-stats-'));
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

    // ── 1) 造数据（跨年 / 跨省 / 跨市 / 多次到访 / 照片视频）────────
    section('1) 造数据：跨年、跨省、跨市、多次到访、照片 / 视频');
    const P1 = await createPlace('统计-杭州西湖', { ...PLA, date: '2016-05-01' });
    const p1v1 = P1.visits[0].id;
    let d1 = await addVisit(P1.id, { date: '2019-06-15', title: '毕业旅行' });
    const p1v2 = findVisit(d1, '2019-06-15').id;
    d1 = await addVisit(P1.id, { date: '2024-03-10' });
    const p1v3 = findVisit(d1, '2024-03-10').id;

    const P2 = await createPlace('统计-宁波天一阁', { ...NBO, date: '2019-07-01' });
    const p2v1 = P2.visits[0].id;
    let d2 = await addVisit(P2.id, { date: '2024-03-20' });
    const p2v2 = findVisit(d2, '2024-03-20').id;

    const P3 = await createPlace('统计-北京故宫', { ...BJ, date: '2024-04-05' });
    const p3v1 = P3.visits[0].id;

    const P4 = await createPlace('统计-成都宽窄巷', { ...CD, date: '2019-08-08' });
    const p4v1 = P4.visits[0].id;

    const mPhoto2019 = await uploadPhoto(p1v2, 'stats-2019.jpg', [10, 80, 10]);
    const mPhotoNbo = await uploadPhoto(p2v2, 'stats-nbo.jpg', [80, 10, 10]);
    const mVideoNbo = await uploadVideo(p2v2, 'stats-nbo.mp4');
    const mPhotoBj = await uploadPhoto(p3v1, 'stats-bj.jpg', [10, 10, 80]);
    eq('照片上传 3 张', [mPhoto2019, mPhotoNbo, mPhotoBj].filter(Boolean).length, 3);
    check('视频上传 1 个', Boolean(mVideoNbo), String(mVideoNbo));

    // alive 口径：软删媒体 / 软删到访 / 软删地点，各自带媒体，都不应进统计
    const mDelMedia = await uploadPhoto(p1v3, 'stats-del-media.jpg', [200, 0, 0]);
    await delJson(`/api/media/${mDelMedia}`);
    const d4 = await addVisit(P4.id, { date: '2022-02-02' });
    const p4v2 = findVisit(d4, '2022-02-02').id;
    await uploadPhoto(p4v2, 'stats-del-visit.jpg', [0, 200, 0]);
    await delJson(`/api/visits/${p4v2}`);
    const PD = await createPlace('统计-已删地点', { ...PLA, date: '2024-05-01' });
    await uploadPhoto(PD.visits[0].id, 'stats-del-place.jpg', [0, 0, 200]);
    await delJson(`/api/places/${PD.id}`);

    // ── 2) 默认全量统计 ─────────────────────────────────────────
    section('2) 默认全量：totals / first / last / time（year）');
    const s = await getJson('/api/stats');
    eq('range 全为 null', s.range, { from: null, to: null, province: null, city: null });
    eq('totals 只算 alive', s.totals, {
      provinces: 3,
      cities: 4,
      places: 4,
      visits: 7,
      photos: 3,
      videos: 1,
    });
    eq('first = 2016 杭州西湖', s.first, {
      date: '2016-05-01',
      place_id: P1.id,
      place_name: '统计-杭州西湖',
      province: '浙江省',
      city: '杭州市',
      lng: P1.lng,
      lat: P1.lat,
    });
    eq('last = 2024 北京故宫', s.last, {
      date: '2024-04-05',
      place_id: P3.id,
      place_name: '统计-北京故宫',
      province: '北京市',
      city: '北京市',
      lng: P3.lng,
      lat: P3.lat,
    });
    eq('time 桶数 2016..2024 补齐 = 9', s.time.length, 9);
    eq('time[0] = 2016', s.time[0], {
      bucket: '2016',
      label: '2016',
      visits: 1,
      places: 1,
      first_visits: 1,
      photos: 0,
      videos: 0,
    });
    eq('2017 空桶补 0', s.time[1], {
      bucket: '2017',
      label: '2017',
      visits: 0,
      places: 0,
      first_visits: 0,
      photos: 0,
      videos: 0,
    });
    eq('2019 桶（含首访与照片）', s.time[3], {
      bucket: '2019',
      label: '2019',
      visits: 3,
      places: 3,
      first_visits: 2,
      photos: 1,
      videos: 0,
    });
    eq('2024 桶（照片 + 视频）', s.time[8], {
      bucket: '2024',
      label: '2024',
      visits: 3,
      places: 3,
      first_visits: 1,
      photos: 2,
      videos: 1,
    });
    eq('time 的 visits 合计 = 总到访', s.time.reduce((n, t) => n + t.visits, 0), 7);
    eq('time 的 first_visits 合计 = 地点数', s.time.reduce((n, t) => n + t.first_visits, 0), 4);
    eq('time 的 photos 合计 = 总照片', s.time.reduce((n, t) => n + t.photos, 0), 3);
    eq('time 的 videos 合计 = 总视频', s.time.reduce((n, t) => n + t.videos, 0), 1);

    // ── 3) 排行 ─────────────────────────────────────────────────
    section('3) provinces / cities / places 排行');
    eq('provinces 行数 3', s.provinces.length, 3);
    eq('provinces[0] = 浙江省', s.provinces[0], {
      name: '浙江省',
      code: '330000',
      places: 2,
      visits: 5,
      photos: 2,
      videos: 1,
      first_date: '2016-05-01',
      last_date: '2024-03-20',
    });
    eq('provinces[1] = 北京市（同分按名）', s.provinces[1], {
      name: '北京市',
      code: '110000',
      places: 1,
      visits: 1,
      photos: 1,
      videos: 0,
      first_date: '2024-04-05',
      last_date: '2024-04-05',
    });
    eq('provinces[2] = 四川省', s.provinces[2].name, '四川省');
    check('已删地点不计入省排行（浙江 places=2）', s.provinces[0].places === 2);

    eq('cities 行数 4', s.cities.length, 4);
    eq('cities[0] = 杭州市 / 3 次', s.cities[0], {
      name: '杭州市',
      province: '浙江省',
      places: 1,
      visits: 3,
      photos: 1,
      videos: 0,
      first_date: '2016-05-01',
      last_date: '2024-03-10',
    });
    eq('cities[1] = 宁波市 / 2 次', s.cities[1].name, '宁波市');
    eq('cities[2] = 北京市', s.cities[2].name, '北京市');
    eq('cities[3] = 成都市（last_date 更早排后）', s.cities[3].name, '成都市');

    eq('places 行数 4', s.places.length, 4);
    eq('places[0] = 杭州西湖 3 次', s.places[0], {
      id: P1.id,
      name: '统计-杭州西湖',
      province: '浙江省',
      city: '杭州市',
      secret: 0,
      visits: 3,
      photos: 1,
      videos: 0,
      first_date: '2016-05-01',
      last_date: '2024-03-10',
    });
    eq('places[1] = 宁波天一阁 2 次', s.places[1].id, P2.id);
    eq('places[2] = 北京故宫', s.places[2].id, P3.id);
    eq('places[3] = 成都宽窄巷', s.places[3].id, P4.id);

    // ── 4) 季度 / 月度桶 ────────────────────────────────────────
    section('4) bucket=quarter / month 与空桶补齐');
    const sq = await getJson('/api/stats?bucket=quarter');
    eq('季度桶数 2016-Q2..2024-Q2 = 33', sq.time.length, 33);
    eq('2016-Q2', sq.time[0], {
      bucket: '2016-Q2',
      label: '2016.Q2',
      visits: 1,
      places: 1,
      first_visits: 1,
      photos: 0,
      videos: 0,
    });
    eq('2019-Q2（P1 一次）', sq.time.find((t) => t.bucket === '2019-Q2'), {
      bucket: '2019-Q2',
      label: '2019.Q2',
      visits: 1,
      places: 1,
      first_visits: 0,
      photos: 1,
      videos: 0,
    });
    eq('2019-Q3（P2/P4 首访）', sq.time.find((t) => t.bucket === '2019-Q3'), {
      bucket: '2019-Q3',
      label: '2019.Q3',
      visits: 2,
      places: 2,
      first_visits: 2,
      photos: 0,
      videos: 0,
    });
    eq('2024-Q1（无首访）', sq.time.find((t) => t.bucket === '2024-Q1'), {
      bucket: '2024-Q1',
      label: '2024.Q1',
      visits: 2,
      places: 2,
      first_visits: 0,
      photos: 1,
      videos: 1,
    });
    eq('2024-Q2（P3 首访）', sq.time.find((t) => t.bucket === '2024-Q2'), {
      bucket: '2024-Q2',
      label: '2024.Q2',
      visits: 1,
      places: 1,
      first_visits: 1,
      photos: 1,
      videos: 0,
    });
    eq('2020-Q1 空桶', sq.time.find((t) => t.bucket === '2020-Q1')?.visits, 0);

    const sm = await getJson('/api/stats?bucket=month');
    eq('月度桶数 2016-05..2024-04 = 96', sm.time.length, 96);
    eq('2016-05', sm.time[0], {
      bucket: '2016-05',
      label: '2016.05',
      visits: 1,
      places: 1,
      first_visits: 1,
      photos: 0,
      videos: 0,
    });
    eq('2019-06（照片）', sm.time.find((t) => t.bucket === '2019-06'), {
      bucket: '2019-06',
      label: '2019.06',
      visits: 1,
      places: 1,
      first_visits: 0,
      photos: 1,
      videos: 0,
    });
    eq('2024-03（照片 + 视频）', sm.time.find((t) => t.bucket === '2024-03'), {
      bucket: '2024-03',
      label: '2024.03',
      visits: 2,
      places: 2,
      first_visits: 0,
      photos: 1,
      videos: 1,
    });
    eq('2024-04（首访）', sm.time.find((t) => t.bucket === '2024-04')?.first_visits, 1);
    eq('2020-01 空桶', sm.time.find((t) => t.bucket === '2020-01')?.visits, 0);

    // ── 5) seriesBy ────────────────────────────────────────────
    section('5) seriesBy=province / city（与 time 桶对齐）');
    const sp = await getJson('/api/stats?seriesBy=province');
    eq('seriesBy=province 3 条（无其他）', sp.series.length, 3);
    eq('series[0] = 浙江省', sp.series[0].name, '浙江省');
    eq('series points 与 time 桶数一致', sp.series[0].points.length, sp.time.length);
    eq('浙江省 2019 点', sp.series[0].points.find((p) => p.bucket === '2019'), {
      bucket: '2019',
      visits: 2,
      places: 2,
    });
    eq('浙江省 2024 点', sp.series[0].points.find((p) => p.bucket === '2024'), {
      bucket: '2024',
      visits: 2,
      places: 2,
    });
    const sc = await getJson('/api/stats?seriesBy=city');
    eq('seriesBy=city 4 条', sc.series.length, 4);
    eq('series[0] = 杭州市 3 次', sc.series[0].name, '杭州市');
    eq('杭州市 2016 点', sc.series[0].points.find((p) => p.bucket === '2016'), {
      bucket: '2016',
      visits: 1,
      places: 1,
    });
    const scq = await getJson('/api/stats?bucket=quarter&seriesBy=city');
    eq('季度 series points 与季度桶对齐', scq.series[0].points.length, scq.time.length);

    // ── 6) 筛选 ─────────────────────────────────────────────────
    section('6) province / city / from / to 筛选');
    const sprov = await getJson('/api/stats?province=' + encodeURIComponent('浙江省'));
    eq('province=浙江省 totals', sprov.totals, {
      provinces: 1,
      cities: 2,
      places: 2,
      visits: 5,
      photos: 2,
      videos: 1,
    });
    eq('province 筛选 first', sprov.first.date, '2016-05-01');
    eq('province 筛选 last', sprov.last.date, '2024-03-20');
    eq('province 筛选 range.province', sprov.range.province, '浙江省');
    eq('province 筛选 time 桶数仍补齐 2016..2024', sprov.time.length, 9);
    eq('province 筛选 2024 桶', sprov.time.find((t) => t.bucket === '2024'), {
      bucket: '2024',
      label: '2024',
      visits: 2,
      places: 2,
      first_visits: 0,
      photos: 1,
      videos: 1,
    });

    const scity = await getJson('/api/stats?city=' + encodeURIComponent('杭州市'));
    eq('city=杭州市 totals', scity.totals, {
      provinces: 1,
      cities: 1,
      places: 1,
      visits: 3,
      photos: 1,
      videos: 0,
    });
    eq('city 筛选 first', scity.first.date, '2016-05-01');
    eq('city 筛选 last', scity.last.date, '2024-03-10');
    eq('city 筛选不匹配 → 空 time', (await getJson('/api/stats?city=' + encodeURIComponent('三亚市'))).time, []);
    eq(
      'city 筛选不匹配 → totals 0',
      (await getJson('/api/stats?city=' + encodeURIComponent('三亚市'))).totals,
      { provinces: 0, cities: 0, places: 0, visits: 0, photos: 0, videos: 0 }
    );

    const srange = await getJson('/api/stats?from=2019-01-01&to=2024-03-15');
    eq('from/to 筛选 totals', srange.totals, {
      provinces: 2,
      cities: 3,
      places: 3,
      visits: 4,
      photos: 1,
      videos: 0,
    });
    eq('from/to first', srange.first.date, '2019-06-15');
    eq('from/to last', srange.last.date, '2024-03-10');
    eq('from/to time 桶数 2019..2024 = 6', srange.time.length, 6);
    eq('from/to 2020 空桶', srange.time.find((t) => t.bucket === '2020')?.visits, 0);
    eq('from/to range.from', srange.range, {
      from: '2019-01-01',
      to: '2024-03-15',
      province: null,
      city: null,
    });

    const s2020 = await getJson('/api/stats?from=2020-01-01&to=2030-12-31');
    eq('from=2020 后 3 次到访', s2020.totals.visits, 3);
    eq('from=2020 后 2 张照片', s2020.totals.photos, 2);
    eq('from=2020 后 1 个视频', s2020.totals.videos, 1);
    eq('first = 2024-03-10', s2020.first.date, '2024-03-10');
    eq('last = 2024-04-05', s2020.last.date, '2024-04-05');

    // ── 7) limit 与参数校验 ────────────────────────────────────
    section('7) limit 与参数白名单校验（400）');
    const slim = await getJson('/api/stats?limit=2');
    eq('limit=2 → places 前 2', slim.places.length, 2);
    eq('limit=2 → provinces 前 2', slim.provinces.length, 2);
    eq('limit=2 → cities 前 2', slim.cities.length, 2);
    eq('limit=2 不影响 totals', slim.totals.places, 4);
    eq('limit=100 允许', (await getJson('/api/stats?limit=100')).places.length, 4);

    await expectStatus('from 格式非法', 400, () => getJson('/api/stats?from=2024-1-1'));
    await expectStatus('to 格式非法', 400, () => getJson('/api/stats?to=2024/01/01'));
    await expectStatus('from 晚于 to', 400, () => getJson('/api/stats?from=2024-12-31&to=2024-01-01'));
    await expectStatus('bucket 非法', 400, () => getJson('/api/stats?bucket=week'));
    await expectStatus('bucket 大小写敏感', 400, () => getJson('/api/stats?bucket=YEAR'));
    await expectStatus('seriesBy 非法', 400, () => getJson('/api/stats?seriesBy=place'));
    await expectStatus('limit=0', 400, () => getJson('/api/stats?limit=0'));
    await expectStatus('limit=101', 400, () => getJson('/api/stats?limit=101'));
    await expectStatus('limit=abc', 400, () => getJson('/api/stats?limit=abc'));
    await expectStatus('limit=1.5', 400, () => getJson('/api/stats?limit=1.5'));

    // ── 8) /api/stats/provinces 全量口径 ────────────────────────
    section('8) /api/stats/provinces（全量、不受筛选影响）');
    const light = await getJson('/api/stats/provinces');
    eq('省份数 3（已删地点不出现）', light.provinces.length, 3);
    const zj = light.provinces.find((p) => p.name === '浙江省');
    eq('浙江省行', zj, {
      name: '浙江省',
      code: '330000',
      places: 2,
      visits: 5,
      first_date: '2016-05-01',
      last_date: '2024-03-20',
    });
    eq('maxPlaces = 2', light.maxPlaces, 2);
    eq('maxVisits = 5', light.maxVisits, 5);
    check('每行都有 name/code/places/visits', light.provinces.every((p) => p.name && p.code && typeof p.places === 'number' && typeof p.visits === 'number'));

    // ── 9) seriesBy Top 6 + 其他 ───────────────────────────────
    section('9) seriesBy=province：超过 6 组时 Top 6 + 其他');
    const extra = [
      ['统计-西安', { province: '陕西省', city: '西安市', province_code: '610000', city_code: '610100', date: '2022-05-01' }],
      ['统计-武汉', { province: '湖北省', city: '武汉市', province_code: '420000', city_code: '420100', date: '2022-05-02' }],
      ['统计-昆明', { province: '云南省', city: '昆明市', province_code: '530000', city_code: '530100', date: '2022-05-03' }],
      ['统计-兰州', { province: '甘肃省', city: '兰州市', province_code: '620000', city_code: '620100', date: '2022-05-04' }],
    ];
    for (const [name, props] of extra) await createPlace(name, { kind: 'visited', ...props });
    const s7 = await getJson('/api/stats?seriesBy=province');
    eq('7 组 → 6 条 + 其他', s7.series.length, 7);
    eq('series[0] = 浙江省', s7.series[0].name, '浙江省');
    eq('series 末位 = 其他', s7.series[s7.series.length - 1].name, '其他');
    eq('其他 只聚合剩余 1 组', s7.series.reduce((n, x) => n + x.points.reduce((m, p) => m + p.visits, 0), 0), 11);
    eq('其他 的 2022 点', s7.series[s7.series.length - 1].points.find((p) => p.bucket === '2022'), {
      bucket: '2022',
      visits: 1,
      places: 1,
    });

    // ── 10) 离家最远（2026-11-06 用户需求）────────────────────
    section('10) 离家最远：按「家」直线距离 + 筛选口径');
    const HOME = await createPlace('统计-家', { lng: 120.0, lat: 30.0, date: '2020-01-01' });
    const FAR = await createPlace('统计-最远点', {
      lng: 104.06,
      lat: 30.67,
      date: '2021-01-01',
      province: '四川省',
      city: '成都市',
      province_code: '510000',
      city_code: '510100',
    });
    check('创建家与最远点', Boolean(HOME.id && FAR.id));
    const setHome = (on) => patchJson(`/api/places/${HOME.id}`, { home: on ? 1 : 0 });
    await setHome(true);

    const sf = await getJson('/api/stats');
    check('未到家 / 已到家：farthest 有值', Boolean(sf.farthest), JSON.stringify(sf.farthest));
    eq('farthest 地点 = 统计-最远点', sf.farthest?.name, '统计-最远点');
    check(
      'farthest 距离 ≈ 1530km（1500~1570）',
      Number(sf.farthest?.distance_km) > 1500 && Number(sf.farthest?.distance_km) < 1570,
      String(sf.farthest?.distance_km)
    );

    const sfzj = await getJson('/api/stats?province=' + encodeURIComponent('浙江省'));
    check(
      '浙江省筛选下最远点不是四川点',
      sfzj.farthest && sfzj.farthest.name !== '统计-最远点' && sfzj.farthest.distance_km < 100,
      JSON.stringify(sfzj.farthest)
    );

    await setHome(false);
    eq('未设置家 → farthest = null', (await getJson('/api/stats')).farthest, null);
    await setHome(true);
    eq('重新设置家 → farthest 恢复', (await getJson('/api/stats')).farthest?.name, '统计-最远点');

    // ── 11) 离家距离排行（2026-11-06 D-199：统计里加一项「按照离家距离排序」）──
    section('11) 离家距离排行：home / distance_places / 排序 / 筛选 / limit');
    const sd = await getJson('/api/stats');
    eq('home 返回「统计-家」', sd.home, { id: HOME.id, name: '统计-家' });
    eq('distance_total = 参与排行的地点数（排除家）', sd.distance_total, 9);
    eq('distance_places 行数 = distance_total（未截断）', sd.distance_places.length, 9);
    eq('distance_places[0] = 统计-最远点', sd.distance_places[0]?.name, '统计-最远点');
    eq(
      'distance_places[0].distance_km = farthest.distance_km',
      sd.distance_places[0]?.distance_km,
      sd.farthest?.distance_km
    );
    check(
      'distance_places 按距离从远到近排序',
      sd.distance_places.every(
        (r, i, a) => i === 0 || Number(a[i - 1].distance_km) >= Number(r.distance_km)
      )
    );
    check('排行不含「家」本身', sd.distance_places.every((r) => r.id !== HOME.id));
    check(
      '排行行不带 lng/lat（与 places 契约一致）',
      sd.distance_places.every((r) => !('lng' in r) && !('lat' in r))
    );
    check(
      '排行行字段齐全',
      sd.distance_places.every(
        (r) =>
          r.id &&
          r.name &&
          typeof r.distance_km === 'number' &&
          typeof r.visits === 'number' &&
          typeof r.photos === 'number'
      )
    );

    const sdzj = await getJson('/api/stats?province=' + encodeURIComponent('浙江省'));
    check(
      '浙江省筛选下排行不含四川最远点',
      sdzj.distance_places.every((r) => r.name !== '统计-最远点')
    );

    const sdlim = await getJson('/api/stats?limit=1');
    eq('limit=1 → distance_places 只 1 条', sdlim.distance_places.length, 1);
    eq('limit 截断后 distance_total 仍是全量', sdlim.distance_total, 9);

    await setHome(false);
    const sdh = await getJson('/api/stats');
    eq('未设置家 → home = null', sdh.home, null);
    eq('未设置家 → distance_places = []', sdh.distance_places, []);
    eq('未设置家 → distance_total = 0', sdh.distance_total, 0);
    await setHome(true);
    eq('重新设置家 → 排行恢复', (await getJson('/api/stats')).distance_places[0]?.name, '统计-最远点');

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
  console.error('\nM3 统计冒烟异常：', e?.message || e);
  process.exitCode = 1;
});
