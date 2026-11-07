/**
 * M3 随行人员（F-BRW-06）隔离冒烟测试
 *
 *   node scripts/smoke-m3-companions.mjs
 *
 * 全隔离：空临时 DATA_DIR + 空临时素材库 + 4200 端口独立实例（SMOKE_M3_COMPANIONS_PORT 可覆盖），跑完清理。
 * 不碰真实 data/travel.db、.dev-media、.env.local。
 *
 * 覆盖：/api/companions 的 name·visits·places·first·last / 排序 / 同名去重 /
 * /api/places?companion 与 /api/map/visits?companion 过滤（含 total_visit_count 口径）/ 软删后消失。
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_M3_COMPANIONS_PORT || 4200);
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
const companionNames = (r) => r.items.map((it) => it.name);
const placeIds = (places) => places.map((p) => p.id).sort();

const PLA = { province: '浙江省', city: '杭州市', county: '西湖区', province_code: '330000', city_code: '330100' };
const NBO = { province: '浙江省', city: '宁波市', county: '海曙区', province_code: '330000', city_code: '330200' };
const BJ = { province: '北京市', city: '北京市', county: '东城区', province_code: '110000', city_code: '110100' };
const CD = { province: '四川省', city: '成都市', county: '青羊区', province_code: '510000', city_code: '510100' };

const run = async () => {
  console.log(`\nM3 随行人员冒烟（F-BRW-06，隔离实例 :${PORT}）`);
  console.log('─'.repeat(64));

  const tmp = mkdtempSync(join(ROOT, '.smoke-m3-companions-'));
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

    // ── 1) 造数据 ──────────────────────────────────────────────
    section('1) 造数据：多地点、多次到访、重复写法、空 companions、想去地点');
    const P1 = await createPlace('随行-西湖', { ...PLA, date: '2019-05-01' });
    const v1 = P1.visits[0].id; // 2019-05-01 小明、小红
    let d = await addVisit(P1.id, { date: '2023-02-01' }); // 无同行人
    const v2 = findVisit(d, '2023-02-01').id;
    d = await addVisit(P1.id, { date: '2024-03-01', companions: ['小明'] });
    const v3 = findVisit(d, '2024-03-01').id;

    const P2 = await createPlace('随行-天一阁', { ...NBO, date: '2020-06-01' });
    const v4 = P2.visits[0].id; // 2020-06-01 小红、小明、小明（重复）

    const P3 = await createPlace('随行-故宫', { ...BJ, date: '2021-07-01' });
    const v5 = P3.visits[0].id; // 无 companions

    const P4 = await createPlace('随行-宽窄巷', { ...CD, date: '2022-01-01' });
    const v6 = P4.visits[0].id; // 小刚，稍后软删到访

    // 想去地点 + 手动到访（历史脏数据）：既有 companions，也不该算进「去过地点」的同行聚合
    const P5 = await createPlace('随行-想去地点', { ...PLA, kind: 'wishlist' });
    d = await addVisit(P5.id, { date: '2020-01-01', companions: ['小明'] });
    check('想去地点也能有手动到访（历史数据）', (d.visits || []).some((v) => v.date === '2020-01-01'));

    // 修正 initial visits 的 companions（创建地点时自动建的到访没有companions，用 PATCH 补）
    await fetch(`${BASE}/api/visits/${v1}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companions: ['小明', '小红'] }),
    }).then(j);
    await fetch(`${BASE}/api/visits/${v4}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ companions: ['小红', '小明', '小明'] }),
    }).then(j);
    check('P1 首次到访写入 2 个同行人', (await getJson(`/api/places/${P1.id}`)).visits.find((v) => v.id === v1).companions.length === 2);
    await delJson(`/api/visits/${v6}`);
    eq('软删到访 v6 后 P4 无 alive 到访', (await getJson(`/api/places/${P4.id}`)).visits.length, 0);

    // ── 2) /api/companions 聚合 ────────────────────────────────
    section('2) /api/companions：name / visits / places / first / last / 排序');
    const c = await getJson('/api/companions');
    check('响应含 items 数组', Array.isArray(c.items));
    eq('排序：小明(2 地点 3 次) → 小红(2 地点 2 次)', companionNames(c), ['小明', '小红']);
    eq('小明行', c.items[0], {
      name: '小明',
      visits: 3,
      places: 2,
      first_date: '2019-05-01',
      last_date: '2024-03-01',
    });
    eq('小红行', c.items[1], {
      name: '小红',
      visits: 2,
      places: 2,
      first_date: '2019-05-01',
      last_date: '2020-06-01',
    });
    check('同一条到访里重复写「小明」只算一次', c.items[0].visits === 3);
    check('已软删到访的小刚不出现', !companionNames(c).includes('小刚'));
    check('没有空名字行', c.items.every((it) => it.name && it.name.trim()));

    // ── 3) /api/places?companion ───────────────────────────────
    section('3) /api/places?companion 过滤');
    const allPlaces = await getJson('/api/places');
    eq('不带 companion 返回全部 5 个地点（含想去）', allPlaces.length, 5);
    const byMing = await getJson('/api/places?companion=' + encodeURIComponent('小明'));
    eq('companion=小明 只返回 P1/P2', placeIds(byMing), [P1.id, P2.id].sort());
    const p1Row = byMing.find((p) => p.id === P1.id);
    eq('companion 筛选把 visit_count 收紧为「只算含该同行人的到访」', p1Row.visit_count, 2);
    eq('companion 筛选把 first_date/last_date 收紧', [p1Row.first_date, p1Row.last_date], [
      '2019-05-01',
      '2024-03-01',
    ]);
    eq('place 行带 secret=0', p1Row.secret, 0);
    const p1RowAll = allPlaces.find((p) => p.id === P1.id);
    eq('不带 companion 时 visit_count 仍是全量 3 次', p1RowAll.visit_count, 3);
    const byHong = await getJson('/api/places?companion=' + encodeURIComponent('小红'));
    const p1Hong = byHong.find((p) => p.id === P1.id);
    eq('小红 只和 2019 那次同行：P1 visit_count=1', p1Hong.visit_count, 1);
    eq('小红 的 first/last 都指向 2019-05-01', [p1Hong.first_date, p1Hong.last_date], [
      '2019-05-01',
      '2019-05-01',
    ]);
    eq(
      'companion=小红 只返回 P1/P2',
      placeIds(await getJson('/api/places?companion=' + encodeURIComponent('小红'))),
      [P1.id, P2.id].sort()
    );
    const byGang = await getJson('/api/places?companion=' + encodeURIComponent('小刚'));
    eq('companion=小刚（到访已软删）→ 空', byGang, []);
    eq(
      'companion 空串 = 不筛选',
      (await getJson('/api/places?companion=')).length,
      5
    );
    const byNobody = await getJson('/api/places?companion=' + encodeURIComponent('不存在的人'));
    eq('不存在的同行人 → 空', byNobody, []);

    // ── 4) /api/map/visits?companion ───────────────────────────
    section('4) /api/map/visits?companion（区间与 total_* 都按同行人过滤）');
    const range = 'from=2019-01-01&to=2024-12-31';
    const mapAll = await getJson(`/api/map/visits?${range}`);
    const allP1 = mapAll.find((p) => p.id === P1.id);
    eq('不带 companion：P1 区间到访 3 次', allP1.visit_count, 3);
    eq('不带 companion：P1 total 3 次', allP1.total_visit_count, 3);
    check('不带 companion 时区间内有 P1/P2/P3/P5', [P1.id, P2.id, P3.id, P5.id].every((id) => mapAll.some((p) => p.id === id)));

    const mapMing = await getJson(`/api/map/visits?${range}&companion=` + encodeURIComponent('小明'));
    eq('companion=小明：只返回 P1/P2', placeIds(mapMing), [P1.id, P2.id].sort());
    const mP1 = mapMing.find((p) => p.id === P1.id);
    eq('P1 区间到访 = 2（不含无同行人的 2023）', mP1.visit_count, 2);
    eq('P1 total_visit_count = 2（全部同行人到访）', mP1.total_visit_count, 2);
    eq('P1 first/last', [mP1.first_date, mP1.last_date], ['2019-05-01', '2024-03-01']);
    eq('P1 total_first/last', [mP1.total_first_date, mP1.total_last_date], ['2019-05-01', '2024-03-01']);
    const mP2 = mapMing.find((p) => p.id === P2.id);
    eq('P2 区间到访 = 1', mP2.visit_count, 1);
    eq('P2 total = 1', mP2.total_visit_count, 1);

    const mapMing2 = await getJson(
      '/api/map/visits?from=2022-01-01&to=2024-12-31&companion=' + encodeURIComponent('小明')
    );
    eq('窗口 2022..2024：只剩 P1', placeIds(mapMing2), [P1.id]);
    const mP1b = mapMing2[0];
    eq('P1 区间内只有 2024 这条', mP1b.visit_count, 1);
    eq('P1 区间 first = 2024-03-01', mP1b.first_date, '2024-03-01');
    eq('P1 total 仍是全部同行人到访 2 次', mP1b.total_visit_count, 2);
    eq('P1 total_first = 2019-05-01', mP1b.total_first_date, '2019-05-01');
    const mapNoComp = await getJson('/api/map/visits?from=2022-01-01&to=2024-12-31');
    const noCompP1 = mapNoComp.find((p) => p.id === P1.id);
    eq('同窗口不带 companion：P1 区间 2 次', noCompP1.visit_count, 2);
    eq('同窗口不带 companion：P1 total 3 次', noCompP1.total_visit_count, 3);

    eq(
      'map/visits?companion 空串 = 不筛选',
      (await getJson('/api/map/visits?' + range + '&companion=')).length,
      mapAll.length
    );
    eq(
      'map/visits?companion=不存在的人 → 空',
      await getJson('/api/map/visits?' + range + '&companion=' + encodeURIComponent('不存在的人')),
      []
    );

    // ── 5) 软删后消失 ─────────────────────────────────────────
    section('5) 软删到访 / 地点后同行人聚合与筛选同步消失');
    await delJson(`/api/visits/${v3}`);
    const c2 = await getJson('/api/companions');
    eq('删掉 2024 到访后：小明 2 次', c2.items[0], {
      name: '小明',
      visits: 2,
      places: 2,
      first_date: '2019-05-01',
      last_date: '2020-06-01',
    });
    eq('小红不受影响', c2.items[1], {
      name: '小红',
      visits: 2,
      places: 2,
      first_date: '2019-05-01',
      last_date: '2020-06-01',
    });

    await delJson(`/api/places/${P2.id}`);
    const c3 = await getJson('/api/companions');
    eq('删掉 P2 后：只剩 1 个地点 1 次到访', c3.items.map((it) => [it.name, it.visits, it.places]), [
      ['小明', 1, 1],
      ['小红', 1, 1],
    ]);
    eq('小明 first/last 都是 2019-05-01', [c3.items[0].first_date, c3.items[0].last_date], ['2019-05-01', '2019-05-01']);
    eq(
      'places?companion=小明 只剩 P1',
      placeIds(await getJson('/api/places?companion=' + encodeURIComponent('小明'))),
      [P1.id]
    );
    const p1After = (await getJson('/api/places?companion=' + encodeURIComponent('小明')))[0];
    eq('删到访后 places 的 visit_count 同步收紧为 1', p1After.visit_count, 1);
    eq('删到访后 first/last 同步收紧为 2019-05-01', [p1After.first_date, p1After.last_date], [
      '2019-05-01',
      '2019-05-01',
    ]);
    const mapAfter = await getJson(`/api/map/visits?${range}&companion=` + encodeURIComponent('小明'));
    eq('map/visits?companion=小明 只剩 P1，且 total 1 次', mapAfter.map((p) => [p.id, p.visit_count, p.total_visit_count]), [
      [P1.id, 1, 1],
    ]);

    // ── 6) 多选 companion（并集 / 逗号 / 空格 / 重复名字）──────────
    section('6) 多选 companion：OR 并集、逗号分隔、重复名字去重');
    const P6 = await createPlace('随行-多选甲', { ...PLA, date: '2018-01-01' });
    await addVisit(P6.id, { date: '2018-02-01', companions: ['多选甲'] });
    const P7 = await createPlace('随行-多选乙', { ...NBO, date: '2018-03-01' });
    await addVisit(P7.id, { date: '2018-04-01', companions: ['多选乙'] });

    const onlyJia = await getJson('/api/places?companion=' + encodeURIComponent('多选甲'));
    eq('单选 多选甲 只回 P6', placeIds(onlyJia), [P6.id]);
    eq('单选 多选甲 的 visit_count 只算含甲到访', onlyJia.map((p) => [p.id, p.visit_count]), [
      [P6.id, 1],
    ]);

    const multiPlaces = await getJson(
      '/api/places?companion=' + encodeURIComponent(' 多选乙 ,多选甲, 多选甲 ') // 空格 + 重复名字
    );
    eq('多选 多选甲,多选乙 → 并集 P6/P7', placeIds(multiPlaces), [P6.id, P7.id].sort());
    eq(
      '多选下每个地点的 visit_count 仍只算含任一选中人的到访',
      multiPlaces.map((p) => [p.id, p.visit_count]).sort(),
      [
        [P6.id, 1],
        [P7.id, 1],
      ].sort()
    );

    const mapMulti = await getJson(
      `/api/map/visits?from=2018-01-01&to=2018-12-31&companion=` +
        encodeURIComponent('多选甲,多选乙')
    );
    eq('map/visits 多选 → P6/P7', placeIds(mapMulti), [P6.id, P7.id].sort());
    eq('map/visits 多选 P6 区间与 total 都为 1', mapMulti.find((p) => p.id === P6.id)?.visit_count, 1);
    eq(
      '不选 companion 时 P6/P7 也正常返回',
      placeIds(await getJson('/api/places')).includes(P6.id) &&
        placeIds(await getJson('/api/places')).includes(P7.id),
      true
    );

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
  console.error('\nM3 随行人员冒烟异常：', e?.message || e);
  process.exitCode = 1;
});
