#!/usr/bin/env node
/**
 * Tread Horizon · 更新脚本（Windows / macOS / Linux 通用）
 * 2026-11-11 D-385（本地端跨平台）：只适用于 **git clone 的源码目录**。
 *
 * 用法：
 *   node scripts/update.mjs              # 拉取最新代码 → 安装依赖 → 构建 → 重启服务
 *   node scripts/update.mjs --no-restart # 只更新文件，不停止 / 不重启服务
 *   也可以：npm run update [-- --no-restart]
 *
 * 流程：
 *   1. 检查 Node 版本（>= 22.13）
 *   2. 检查程序目录里有 .git（安装版 / 解压发布包没有 .git，不能用这个脚本更新）
 *   3. git pull --ff-only（有本地改动 / 没配远端 / 网络问题会明确报错）
 *   4. 服务正在运行的话先停止（Windows 上 node_modules 里的原生模块会被占用，
 *      不先停的话 npm ci 可能失败；停止后构建完再自动启动）
 *   5. npm ci（失败回落到 npm install）
 *   6. npm run build
 *   7. 启动服务（调用 scripts/launch.mjs；--no-restart 时跳过第 4、7 步）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 程序根目录：scripts/ 的上一级（不依赖当前工作目录） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const MIN_NODE = [22, 13];
const argv = process.argv.slice(2);
const noRestart = argv.includes('--no-restart');
const wantHelp = argv.includes('--help') || argv.includes('-h');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function printHelp() {
  console.log(`
Tread Horizon · 更新脚本

用法：
  node scripts/update.mjs                拉取最新代码并重启服务
  node scripts/update.mjs --no-restart   只更新文件，不停止 / 不重启服务

说明：
  - 只有 git clone 的源码目录才能用本脚本（目录里需要有 .git）。
  - 解压发布包 / 安装版请下载新版本覆盖，保留 data/ 与素材库目录；
    跨电脑 / 跨系统迁移请用应用内「设置 → 备份与恢复」。
  - 数据目录（data/）与素材库不会被更新脚本改动。
`);
}

if (wantHelp) {
  printHelp();
  process.exit(0);
}

// ───────────── 0. Node 版本检查 ─────────────
{
  const [major, minor] = process.versions.node.split('.').map((n) => Number(n));
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    console.error('');
    console.error(`❌ 需要 Node.js ≥ ${MIN_NODE[0]}.${MIN_NODE[1]}（推荐 24 LTS），当前版本 v${process.versions.node}。`);
    console.error('   请到 https://nodejs.org/ 下载安装 Node.js 24 LTS 后重试。');
    process.exit(1);
  }
}

// ───────────── 读取 .env.local（PORT / DATA_DIR 等，与 server/config.mjs 一致） ─────────────
const envFile = join(ROOT, '.env.local');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    console.warn(`[update] .env.local 读取失败（忽略，继续用环境变量）：${e.message}`);
  }
}
const rawPort = Number(process.env.PORT || 4000);
const PORT = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 4000;
const DATA_DIR = process.env.DATA_DIR ? resolve(ROOT, process.env.DATA_DIR) : resolve(ROOT, 'data');

/** 运行命令（输出直接透传到终端） */
function run(cmd, cmdArgs, label) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WIN, // Windows 上 npm / git 可能是 .cmd 包装
    env: process.env,
  });
  return r.status === 0;
}

/** 运行命令并返回 stdout（失败返回空串） */
function capture(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: IS_WIN,
    env: process.env,
    timeout: 30_000,
  });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))?.version || '?';
  } catch {
    return '?';
  }
}

/** 探测 /api/health；无响应返回 null */
async function probeHealth(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return null;
  }
}

function pathsEqual(a, b) {
  if (!a || !b) return false;
  const na = resolve(String(a));
  const nb = resolve(String(b));
  return IS_WIN ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** 调用同目录下的 stop / launch 脚本，返回退出码 */
function runScript(name, args) {
  console.log(`\n$ node scripts/${name} ${args.join(' ')}`.trimEnd());
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', name), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  return r.status ?? 1;
}

async function main() {
  console.log('Tread Horizon · 更新');
  console.log(`  程序目录：${ROOT}`);

  // ───────────── 1. 必须是 git 源码目录 ─────────────
  if (!existsSync(join(ROOT, '.git'))) {
    console.error('');
    console.error('❌ 当前目录不是 Git 源码目录（没有 .git），不能用 npm run update 更新。');
    console.error('   解压发布包 / 安装版：请下载新版本，解压覆盖程序文件；');
    console.error('   并保留 data/ 与素材库目录（默认 .dev-media/），数据不会丢。');
    console.error('   源码版：请先用 git clone 获取仓库，之后直接用 npm run update 即可。');
    process.exit(1);
  }

  const versionBefore = readPackageVersion();
  const headBefore = capture('git', ['rev-parse', '--short', 'HEAD']) || '?';
  console.log(`  当前版本：v${versionBefore}（git ${headBefore}）`);

  // ───────────── 2. git pull --ff-only ─────────────
  if (!run('git', ['pull', '--ff-only'], '拉取最新代码')) {
    console.error('');
    console.error('❌ 更新失败：git pull --ff-only 没有成功。');
    console.error('   常见原因：本地有未提交改动 / 没有配置远端 / 网络问题。');
    console.error('   可先运行“git status”检查本地改动；如需保留请先提交或备份。');
    process.exit(1);
  }
  const headAfterPull = capture('git', ['rev-parse', '--short', 'HEAD']) || '?';
  if (headBefore !== headAfterPull) {
    console.log(`\n✅ 代码已更新：${headBefore} → ${headAfterPull}`);
  } else {
    console.log('\nℹ️ 代码已是最新（没有新的提交）。');
  }

  // ───────────── 3. 先停服务（避免 Windows 上 node_modules 被占用） ─────────────
  const health = await probeHealth(PORT);
  const healthOk = Boolean(health?.ok && health.body?.ok === true);
  const healthDataDir = healthOk ? health.body?.dataDir || null : null;
  let runningHere = false;
  let runningElsewhere = false;
  if (healthOk) {
    if (healthDataDir && !pathsEqual(healthDataDir, DATA_DIR)) {
      runningElsewhere = true;
      console.warn('');
      console.warn(`⚠️ 端口 ${PORT} 上运行的是另一个 Tread Horizon 实例（数据目录：${healthDataDir}），`);
      console.warn(`   不是当前副本（${DATA_DIR}）。本次不会停止它；更新完成后如果启动失败请留意端口冲突。`);
    } else {
      runningHere = true;
    }
  } else if (health) {
    console.warn('');
    console.warn(`⚠️ 端口 ${PORT} 被其它程序占用（/api/health 返回 HTTP ${health.status}），继续更新文件。`);
  }

  if (runningHere && !noRestart) {
    console.log('');
    console.log('⏸ 先停止正在运行的服务（避免 Windows 上 node_modules 被占用）…');
    const code = runScript('stop.mjs', []);
    if (code !== 0) {
      console.warn('');
      console.warn('⚠️ 停止旧服务失败，继续更新依赖与构建；更新完成后可手动停止再启动。');
    }
  } else if (runningHere && noRestart) {
    console.warn('');
    console.warn('⚠️ 服务正在运行，--no-restart 不会停止它；Windows 上 npm ci 可能因 node_modules 被占用而失败，建议先手动停止。');
  }

  // ───────────── 4. 安装依赖（npm ci 失败回落 npm install） ─────────────
  const hasLock = existsSync(join(ROOT, 'package-lock.json'));
  if (hasLock && run('npm', ['ci'], '安装依赖（npm ci）')) {
    // ok
  } else {
    if (hasLock) {
      console.warn('');
      console.warn('⚠️ npm ci 失败（常见原因：node_modules 被占用 / 网络问题），改用 npm install 重试…');
    }
    if (!run('npm', ['install'], '安装依赖（npm install）')) {
      console.error('');
      console.error('❌ 依赖安装失败。请检查网络后重试，或手动运行：npm install');
      console.error('   （国内网络慢可先设置镜像：npm config set registry https://registry.npmmirror.com）');
      process.exit(1);
    }
  }

  // ───────────── 5. 构建 ─────────────
  if (!run('npm', ['run', 'build'], '构建前端（npm run build）')) {
    console.error('');
    console.error('❌ 前端构建失败，更新未完成。请运行“npm run build”查看具体报错。');
    if (runningHere && !noRestart) {
      console.error('   （服务目前已停止；修复后双击 TreadHorizon-Start.bat / .command，或 npm run launch 重新启动）');
    }
    process.exit(1);
  }

  const versionAfter = readPackageVersion();
  const headAfter = capture('git', ['rev-parse', '--short', 'HEAD']) || headAfterPull;

  // ───────────── 6. 重启服务 ─────────────
  let restartOk = true;
  if (noRestart) {
    console.log('');
    console.log('ℹ️ 已按 --no-restart 跳过重启。稍后双击启动器（或 npm run launch）启动即可。');
  } else {
    const code = runScript('launch.mjs', []);
    restartOk = code === 0;
    if (!restartOk) {
      console.error('');
      console.error('⚠️ 文件已更新，但服务启动失败，请查看上面的提示（常见原因：端口被占用 / 数据目录不可写）。');
    }
  }

  console.log('');
  if (restartOk) {
    console.log(`✅ 更新完成：v${versionBefore} → v${versionAfter}（git ${headAfter}）`);
    if (!noRestart) console.log('   服务已重新启动；浏览器没自动打开的话，手动访问地址即可。');
  } else {
    console.log(`ℹ️ 更新文件已完成：v${versionBefore} → v${versionAfter}（git ${headAfter}），但服务未能重新启动。`);
  }
  process.exit(restartOk ? 0 : 1);
}

main().catch((e) => {
  console.error('');
  console.error('❌ 更新失败：', e?.message || e);
  process.exit(1);
});
