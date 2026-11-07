/**
 * 冒烟测试 —— 跑一遍完整的「建点 → 上传 → 缩略图 → 读回」链路
 *
 *   node scripts/smoke.mjs
 *
 * 需要先启动服务：npm run serve 或 node server/index.mjs --dev
 */
import sharp from 'sharp';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4000';

const j = async (r) => {
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
  try {
    return JSON.parse(t);
  } catch {
    throw new Error('返回不是 JSON: ' + t.slice(0, 200));
  }
};

let failed = 0;
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};

const main = async () => {
  console.log('\n冒烟测试  ' + BASE);
  console.log('─'.repeat(52));

  // 0. 健康检查
  const health = await fetch(`${BASE}/api/health`).then(j);
  check('服务在线', health.ok === true);
  check('已配置天地图 key', health.hasTk === true);
  console.log(`     素材库：${health.mediaRoot}`);

  // 1. 建地点
  const place = await fetch(`${BASE}/api/places`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '西湖（冒烟测试）',
      lng: 120.15,
      lat: 30.28,
      province: '浙江省',
      city: '杭州市',
      county: '西湖区',
      province_code: '156330000',
      city_code: '156330100',
      county_code: '156330105',
      kind: 'visited',
      date: '2024-10-02',
    }),
  }).then(j);

  check('创建地点', Boolean(place.id), place.name);
  check('自动创建了到访', place.visits?.length === 1, place.visits?.[0]?.date);
  const visitId = place.visits?.[0]?.id;

  // 1.5 编辑地点：名称 / 类型（F-PLC-04）
  const patched = await fetch(`${BASE}/api/places/${place.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '西湖（冒烟改名）', kind: 'wishlist' }),
  }).then(j);

  check('改名生效', patched.name === '西湖（冒烟改名）', patched.name);
  check('改类型生效', patched.kind === 'wishlist', patched.kind);

  // 2. 上传一张生成的图
  const buf = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r: 210, g: 150, b: 90 } },
  })
    .jpeg({ quality: 88 })
    .toBuffer();

  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: 'image/jpeg' }), 'smoke-test.jpg');
  const up = await fetch(`${BASE}/api/media/upload?visitId=${visitId}`, {
    method: 'POST',
    body: fd,
  }).then(j);

  check('上传成功', up.added?.length === 1, JSON.stringify(up.errors || []));
  const mediaId = up.added?.[0]?.id;

  // 3. 缩略图
  if (mediaId) {
    const thumb = await fetch(`${BASE}/api/media/${mediaId}/thumb`);
    const tb = await thumb.arrayBuffer();
    check('缩略图可访问', thumb.ok && thumb.headers.get('content-type') === 'image/webp',
      `${(tb.byteLength / 1024).toFixed(1)} KB`);
    check('缩略图体积合理（< 200KB）', tb.byteLength < 200 * 1024);

    // 4. 原图支持 Range（视频拖动必需）
    const range = await fetch(`${BASE}/api/media/${mediaId}/orig`, {
      headers: { range: 'bytes=0-1023' },
    });
    check('原图支持 Range', range.status === 206, 'HTTP ' + range.status);
  }

  // 5. 读回详情
  const detail = await fetch(`${BASE}/api/places/${place.id}`).then(j);
  check('详情包含媒体', detail.visits?.[0]?.media?.length === 1);

  // 6. 列表带封面
  const list = await fetch(`${BASE}/api/places`).then(j);
  const mine = list.find((x) => x.id === place.id);
  check('列表返回了封面 id', Boolean(mine?.cover_id));
  check('列表统计正确', mine?.visit_count === 1);

  // 7. 清理
  const del = await fetch(`${BASE}/api/places/${place.id}`, { method: 'DELETE' }).then(j);
  check('软删除成功', del.ok === true);

  const after = await fetch(`${BASE}/api/places`).then(j);
  check('删除后列表不再出现', !after.some((x) => x.id === place.id));

  console.log('─'.repeat(52));
  console.log(failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`);
  // 不调用 process.exit()：sharp 的 libvips 线程还在收尾时硬退会触发
  // libuv 断言崩溃（Windows）。设置 exitCode 让进程自然结束。
  process.exitCode = failed === 0 ? 0 : 1;
};

main().catch((e) => {
  console.error('\n冒烟测试异常：', e.message);
  process.exit(1);
});
