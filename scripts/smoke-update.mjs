/**
 * 应用更新检查的缓存 / 强制刷新冒烟（2026-11-15 D-435）。
 *
 *   node scripts/smoke-update.mjs
 *
 * 背景：`server/update.mjs` 为省 GitHub API 限额，成功结果缓存 6 小时、失败缓存 10 分钟。
 * 于是「设置 → 关于 → 再检查一次」在 tag 刚推上去时怎么点都还是旧结果（v1.2.1 实测踩到）。
 * D-435 起该按钮带 `force=1` 跳过缓存，这个脚本就是这条链路的回归。
 *
 * 全隔离、不联网：
 * - 把 DATA_DIR / 素材库指到临时目录（import update.mjs 会连带 backup.mjs → db.mjs 开库）；
 * - 把 globalThis.fetch 换成假的 GitHub API，记录调用次数。
 *
 * 覆盖：失败缓存 → force 绕过失败缓存 → 成功缓存 → force 绕过成功缓存并写回 → 之后的普通检查命中新缓存。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'th-update-'));
mkdirSync(join(tmp, 'data'), { recursive: true });
process.env.DATA_DIR = join(tmp, 'data');
process.env.MEDIA_ROOT = join(tmp, 'media');
process.env.MEDIA_ROOT_DEV = join(tmp, 'media');
process.env.STARTER_DATA = '0';
process.env.UPDATE_CHECK = '1';
process.env.UPDATE_REPO = 'smoke/update';
delete process.env.UPDATE_FAKE_LATEST;

let pass = 0;
let fail = 0;
const failures = [];
const check = (label, cond, extra = '') => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label + (extra ? `（${extra}）` : ''));
  }
  console.log(`  ${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
};
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, a === b ? '' : `实际=${a} 期望=${b}`);
};
const section = (title) => console.log(`\n── ${title} ──`);

// ── 假 GitHub API ─────────────────────────────────────────────
/** 当前假 tag 列表（可随时改） */
let tags = [];
/** 假 API 是否不可用（模拟断网 / 超时） */
let offline = false;
/** fetch 调用次数（含 releases/latest 与 tags 两个请求） */
let calls = 0;

globalThis.fetch = async (url) => {
  calls += 1;
  if (offline) throw new Error('offline');
  const u = String(url);
  if (u.includes('/releases/latest')) {
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
  }
  if (u.includes('/tags')) {
    return { ok: true, status: 200, json: async () => tags.map((name) => ({ name })) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const current = String(pkg.version || '');
const parts = current.split('.').map((n) => Number(n) || 0);
const newer = `${parts[0]}.${parts[1] + 1}.0`;
const { checkForUpdate } = await import(new URL('../server/update.mjs', import.meta.url).href);

try {
  section('1) 首次检查失败 → 失败结果缓存 10 分钟');
  offline = true;
  const failed = await checkForUpdate();
  eq('断网时 ok=false', failed.ok, false);
  eq('断网时带当前版本', failed.currentVersion, current);
  const callsAfterFail = calls;
  check('失败也发起了 2 个请求（release + tags）', callsAfterFail === 2, String(callsAfterFail));

  section('2) 未 force：失败缓存内不再请求');
  offline = false;
  tags = ['v1.2.0'];
  const stillFailed = await checkForUpdate();
  eq('恢复网络但仍在失败缓存内 → ok=false', stillFailed.ok, false);
  eq('没有再次请求 GitHub', calls, callsAfterFail);

  section('3) force：跳过失败缓存，立刻拿到 tag');
  const forced1 = await checkForUpdate({ force: true });
  eq('force 后 ok=true', forced1.ok, true);
  eq('force 后 latestVersion=1.2.0', forced1.latestVersion, '1.2.0');
  check('force 重新请求 GitHub', calls > callsAfterFail, String(calls));

  section('4) 未 force：成功缓存 6 小时内返回旧结果');
  tags = ['v1.2.0', `v${newer}`];
  const callsAfterForced1 = calls;
  const cached = await checkForUpdate();
  eq('未 force 仍返回缓存里的 1.2.0', cached.latestVersion, '1.2.0');
  eq('缓存命中也要有 hasUpdate（D-435 修复前是 undefined）', cached.hasUpdate, false);
  eq('未 force 不再请求 GitHub', calls, callsAfterForced1);

  section(`5) force：跳过成功缓存，看到刚推的 v${newer}`);
  const forced2 = await checkForUpdate({ force: true });
  eq(`force 拿到 v${newer}`, forced2.latestVersion, newer);
  eq('hasUpdate=true', forced2.hasUpdate, true);
  check('force 重新请求 GitHub', calls > callsAfterForced1, String(calls));

  section('6) force 的结果写回缓存：之后的普通检查直接用它');
  const callsAfterForced2 = calls;
  const afterForce = await checkForUpdate();
  eq(`普通检查也变成 v${newer}`, afterForce.latestVersion, newer);
  eq('普通检查没有额外请求', calls, callsAfterForced2);
  eq('hasUpdate 仍然为 true', afterForce.hasUpdate, true);
} catch (e) {
  fail += 1;
  failures.push('未捕获异常：' + (e?.stack || e));
  console.error('\n💥', e?.stack || e);
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  if (fail) {
    console.log('失败项：\n- ' + failures.join('\n- '));
    process.exitCode = 1;
  }
}
