/** 检查构建产物是否被正确提供 */
const BASE = process.env.BASE || 'http://127.0.0.1:4100';

const main = async () => {
  console.log('\n构建产物检查  ' + BASE);
  console.log('─'.repeat(46));

  const r = await fetch(BASE + '/');
  const html = await r.text();
  console.log(`GET /                HTTP ${r.status}  ${(html.length / 1024).toFixed(1)} KB`);
  console.log(`  含 <div id="root">    ${html.includes('id="root"')}`);

  const m = html.match(/src="(\/assets\/[^"]+\.js)"/);
  console.log(`  入口脚本              ${m ? m[1] : '(未找到)'}`);

  if (m) {
    const js = await fetch(BASE + m[1]);
    const t = await js.text();
    console.log(`GET ${m[1]}  HTTP ${js.status}  ${(t.length / 1024).toFixed(1)} KB`);
    console.log(`  含天地图 API 地址      ${t.includes('api.tianditu.gov.cn')}`);
    console.log(`  含 service.js         ${t.includes('v4.0/service.js')}`);
    console.log(`  含 components.js      ${t.includes('v4.0/components.js')}`);
  }

  const css = html.match(/href="(\/assets\/[^"]+\.css)"/);
  if (css) {
    const c = await fetch(BASE + css[1]);
    console.log(`GET ${css[1]}  HTTP ${c.status}`);
  }

  const mv = await fetch(BASE + '/marker.svg');
  console.log(`GET /marker.svg       HTTP ${mv.status}  ${mv.headers.get('content-type')}`);

  const mw = await fetch(BASE + '/marker-wish.svg');
  console.log(`GET /marker-wish.svg  HTTP ${mw.status}`);

  const api404 = await fetch(BASE + '/api/nope');
  const ct = api404.headers.get('content-type') || '';
  console.log(`GET /api/nope         HTTP ${api404.status}  ${ct}`);

  const spa = await fetch(BASE + '/some/deep/route');
  const spaHtml = await spa.text();
  console.log(`GET /some/deep/route  HTTP ${spa.status}  SPA 回退: ${spaHtml.includes('id="root"')}`);
};

main().catch((e) => {
  console.error('检查失败：', e.message);
  process.exitCode = 1;
});
