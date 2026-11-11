#!/usr/bin/env node
/**
 * Tread Horizon · 跨平台启动脚本（Windows / macOS / Linux 通用）
 * 2026-11-11 D-385（本地端跨平台）：日常使用的「一键启动」入口。
 *
 * 用法：
 *   node scripts/launch.mjs                 # 正常启动（会自动装依赖 / 构建 / 后台运行 / 打开浏览器）
 *   node scripts/launch.mjs --no-open       # 不自动打开浏览器（测试 / 服务器环境）
 *   LAUNCH_NO_OPEN=1 node scripts/launch.mjs
 *   PORT=4001 node scripts/launch.mjs       # 换端口（也可以写在 .env.local 里）
 *
 * 流程：
 *   1. 检查 Node 版本（>= 22.13，推荐 24 LTS；更低的版本 node:sqlite 需要实验开关，跑不起来）
 *   2. 没有 node_modules → 先 npm install
 *   3. 没有 dist/index.html → 先 npm run build
 *   4. 探 /api/health：端口上已有【同一数据目录】的实例 → 直接开浏览器并退出（避免双开）
 *      端口被其它程序 / 其它数据目录的实例占用 → 提示后退出
 *   5. 后台启动 server/index.mjs（detached；关掉终端 / 窗口服务继续跑）
 *   6. 轮询 /api/health 直到就绪（最长 60 秒）
 *   7. 写 <数据目录>/server.pid（JSON：pid / port / dataDir / startedAt）
 *   8. 打开浏览器（--no-open / LAUNCH_NO_OPEN=1 可跳过），打印地址后退出
 *
 * 停止：node scripts/stop.mjs（Windows 双击 TreadHorizon-Stop.bat / macOS 双击 TreadHorizon-Stop.command）
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 程序根目录：scripts/ 的上一级（不依赖当前工作目录） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
/** 最低 Node 版本（22.13 起 node:sqlite 不需要 --experimental-sqlite） */
const MIN_NODE = [22, 13];
const RECOMMENDED_NODE = '24 LTS';
/** 启动就绪的最长等待时间（首次启动 / 生成示例数据可能慢一点） */
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────── 0. Node 版本检查 ─────────────
{
  const [major, minor] = process.versions.node.split('.').map((n) => Number(n));
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    console.error('');
    console.error(`❌ 需要 Node.js ≥ ${MIN_NODE[0]}.${MIN_NODE[1]}（推荐 ${RECOMMENDED_NODE}），当前版本 v${process.versions.node}。`);
    console.error('   请到 https://nodejs.org/ 下载安装 Node.js 24 LTS 后重新启动。');
    console.error(`   （Node ${MIN_NODE[0]}.${MIN_NODE[1]} 以下没有内置稳定的 node:sqlite，应用无法启动）`);
    process.exit(1);
  }
}

// ───────────── 1. 读取 .env.local（与 server/config.mjs 保持一致） ─────────────
const envFile = join(ROOT, '.env.local');
if (existsSync(envFile)) {
  try {
    // Node 20.12+ 原生支持；launch 已经做了版本检查，这里直接调用
    process.loadEnvFile(envFile);
  } catch (e) {
    console.warn(`[launch] .env.local 读取失败（忽略，继续用环境变量）：${e.message}`);
  }
}

const rawPort = Number(process.env.PORT || 4000);
if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
  console.error(`❌ 端口不合法（PORT=${process.env.PORT}），请用 1~65535 之间的整数，例如 PORT=4001。`);
  process.exit(1);
}
const PORT = rawPort;
/** 数据目录：与 server/config.mjs 的 DATA_DIR 规则一致（相对路径按程序根目录算） */
const DATA_DIR = process.env.DATA_DIR ? resolve(ROOT, process.env.DATA_DIR) : resolve(ROOT, 'data');
const PID_FILE = join(DATA_DIR, 'server.pid');
const URL_BASE = `http://127.0.0.1:${PORT}`;
const SERVER_ENTRY = join(ROOT, 'server', 'index.mjs');

const noOpen = process.argv.slice(2).includes('--no-open') || process.env.LAUNCH_NO_OPEN === '1';

/**
 * 探测 /api/health。
 * @returns {Promise<{ok:boolean,status:number,body:any}|null>} 无响应（连接失败 / 超时）返回 null
 */
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

/** 比较两个路径是否指向同一个目录（Windows 不区分大小写） */
function pathsEqual(a, b) {
  if (!a || !b) return false;
  const na = resolve(String(a));
  const nb = resolve(String(b));
  return IS_WIN ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** 运行 npm（Windows 上 npm 是 .cmd，需要 shell） */
function runNpm(args, label) {
  console.log(`\n${label}`);
  const r = spawnSync('npm', args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WIN,
    env: process.env,
  });
  return r.status === 0;
}

/** 用系统默认浏览器打开地址 */
function openBrowser(url) {
  try {
    if (IS_WIN) {
      // start 是 cmd 内置命令；空标题参数 "" 必须保留
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (IS_MAC) {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    console.warn(`[launch] 无法自动打开浏览器（${e?.message || e}），请手动访问 ${url}`);
  }
}

async function main() {
  console.log('Tread Horizon · 启动器');
  console.log(`  程序目录：${ROOT}`);
  console.log(`  数据目录：${DATA_DIR}`);
  console.log(`  端口：${PORT}`);

  if (!existsSync(SERVER_ENTRY)) {
    console.error('');
    console.error('❌ 找不到 server/index.mjs —— 启动脚本需要放在 Tread Horizon 程序目录的 scripts/ 下运行。');
    process.exit(1);
  }

  // ───────────── 2. 依赖 ─────────────
  if (!existsSync(join(ROOT, 'node_modules'))) {
    console.log('');
    console.log('📦 首次启动：没有找到 node_modules，正在安装依赖（npm install）…');
    console.log('   首次安装可能需要 1~3 分钟，请耐心等待。');
    const ok = runNpm(['install'], '   执行：npm install');
    if (!ok) {
      console.error('');
      console.error('❌ 依赖安装失败。请检查网络后重试，或在程序目录打开终端手动运行：npm install');
      console.error('   （国内网络慢可先设置镜像：npm config set registry https://registry.npmmirror.com）');
      process.exit(1);
    }
  }

  // ───────────── 3. 前端构建产物 ─────────────
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    console.log('');
    console.log('🔨 没有找到前端构建产物 dist/index.html，正在构建（npm run build）…');
    console.log('   首次构建可能需要 1~2 分钟，请耐心等待。');
    const ok = runNpm(['run', 'build'], '   执行：npm run build');
    if (!ok) {
      console.error('');
      console.error('❌ 前端构建失败。请在程序目录打开终端手动运行“npm run build”查看具体报错。');
      console.error('   常见原因：Node 版本过低（需要 ≥ 22.13 / 推荐 24 LTS）、依赖安装不完整、磁盘空间不足。');
      process.exit(1);
    }
  }

  // ───────────── 4. 端口上是否已有实例 ─────────────
  const existing = await probeHealth(PORT);
  if (existing) {
    const isOurHealth = existing.ok && existing.body?.ok === true;
    const existingDataDir = isOurHealth ? existing.body?.dataDir : null;
    if (isOurHealth && existingDataDir && !pathsEqual(existingDataDir, DATA_DIR)) {
      console.error('');
      console.error(`❌ 端口 ${PORT} 上已经有一个 Tread Horizon 实例在运行，但数据目录不同：`);
      console.error(`   正在运行的实例：${existingDataDir}`);
      console.error(`   当前副本的数据目录：${DATA_DIR}`);
      console.error('   为避免两个副本同时写同一端口，本次不启动。');
      console.error(`   请先停止那个实例；或用 PORT=4001 node scripts/launch.mjs 换一个端口。`);
      process.exit(1);
    }
    if (isOurHealth) {
      console.log('');
      console.log(`✅ Tread Horizon 已经在运行：${URL_BASE}${existingDataDir ? `（数据目录 ${existingDataDir}）` : ''}`);
      if (!noOpen) openBrowser(URL_BASE);
      console.log('   本次不重复启动。要停止：node scripts/stop.mjs');
      process.exit(0);
    }
    console.error('');
    console.error(`❌ 端口 ${PORT} 已被其它程序占用（/api/health 返回 HTTP ${existing.status}），Tread Horizon 无法启动。`);
    console.error('   请关掉占用端口的程序，或换端口启动（例如 PORT=4001 node scripts/launch.mjs）。');
    console.error('   Windows 查看占用：netstat -ano | findstr :4000    macOS 查看占用：lsof -i :4000');
    process.exit(1);
  }

  // ───────────── 5. 后台启动服务 ─────────────
  console.log('');
  console.log('🚀 正在后台启动服务…');
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    detached: true, // 脱离当前终端：关掉窗口服务继续跑
    windowsHide: true, // Windows 不弹新的控制台窗口
    stdio: 'ignore', // 日志不接管，避免占住管道
    env: process.env,
  });
  let childExited = false;
  let spawnError = null;
  child.once('exit', () => {
    childExited = true;
  });
  child.once('error', (e) => {
    childExited = true;
    spawnError = e;
  });
  child.unref();

  // ───────────── 6. 轮询 /api/health 直到就绪 ─────────────
  // 注意：如果探测期间发现监听者其实是另一个刚起来的实例（比如快速双击了两次启动器），
  // 本进程 spawn 的 child 会因为端口被占用而退出；这时按「已经在运行」处理，不要重复启动。
  const startedAt = Date.now();
  let health = null;
  let alreadyRunning = false;
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    health = await probeHealth(PORT, 1000);
    if (health && health.ok && health.body?.ok === true) break;
    health = null;
    if (childExited) {
      // 我们 spawn 的进程退出了：端口上是不是别的实例已经起来了？
      const again = await probeHealth(PORT, 1000);
      if (again && again.ok && again.body?.ok === true) {
        health = again;
        alreadyRunning = true;
        break;
      }
      console.error('');
      console.error('❌ 服务进程启动后立刻退出了（未能就绪）。');
      if (spawnError) console.error(`   进程错误：${spawnError.message}`);
      console.error('   常见原因：端口被占用、数据目录不可写、依赖 / 构建产物缺失。');
      console.error('   请在程序目录打开终端运行“node server/index.mjs”查看完整报错。');
      process.exit(1);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!health) {
    console.error('');
    console.error(`❌ 等待 ${Math.round(READY_TIMEOUT_MS / 1000)} 秒后服务仍未就绪（${URL_BASE}/api/health 无响应）。`);
    console.error('   后台进程没有退出，但可能启动很慢或卡住了。请在程序目录打开终端运行：');
    console.error('   node server/index.mjs');
    console.error('   查看完整日志后再重试。');
    process.exit(1);
  }

  if (alreadyRunning) {
    const d = health.body?.dataDir;
    console.log('');
    console.log(`✅ Tread Horizon 已经在运行：${URL_BASE}${d ? `（数据目录 ${d}）` : ''}`);
    if (!noOpen) openBrowser(URL_BASE);
    console.log('   本次不重复启动。要停止：node scripts/stop.mjs');
    process.exit(0);
  }

  // 再确认一下「响应的是我们刚启动的进程」：极短竞态下端口上可能是另一个实例，
  // 我们 spawn 的进程因端口被占用刚退出（快速双击两次启动器时可能遇到）。
  await sleep(200);
  if (childExited) {
    const again = await probeHealth(PORT, 1000);
    if (again && again.ok && again.body?.ok === true) {
      const d = again.body?.dataDir;
      console.log('');
      console.log(`✅ Tread Horizon 已经在运行：${URL_BASE}${d ? `（数据目录 ${d}）` : ''}`);
      if (!noOpen) openBrowser(URL_BASE);
      console.log('   本次不重复启动（刚启动的进程已因端口被占用退出）。要停止：node scripts/stop.mjs');
      process.exit(0);
    }
    console.error('');
    console.error('❌ 服务进程在就绪后意外退出了，请重新启动。');
    console.error('   可在程序目录打开终端运行“node server/index.mjs”查看完整报错。');
    process.exit(1);
  }

  const actualDataDir = health.body?.dataDir || DATA_DIR;
  if (!pathsEqual(actualDataDir, DATA_DIR)) {
    console.warn(`[launch] 注意：服务实际使用的数据目录是 ${actualDataDir}，与启动器判断的 ${DATA_DIR} 不一致。`);
  }

  // ───────────── 7. 写 PID 文件（stop.mjs 靠它停止服务） ─────────────
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const pidPayload = {
      pid: child.pid,
      port: PORT,
      dataDir: actualDataDir,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(PID_FILE, JSON.stringify(pidPayload, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.warn(`[launch] 写入 PID 文件失败（不影响本次启动，但 stop 脚本可能要用端口兜底）：${e.message}`);
  }

  // ───────────── 8. 打开浏览器 + 收尾 ─────────────
  if (!noOpen) openBrowser(URL_BASE);

  console.log('');
  console.log(`✅ Tread Horizon 已启动：${URL_BASE}`);
  console.log(`   数据目录：${actualDataDir}`);
  console.log(`   服务在后台运行，关掉这个窗口不影响使用。`);
  console.log('   停止服务：node scripts/stop.mjs（Windows 双击 TreadHorizon-Stop.bat / macOS 双击 TreadHorizon-Stop.command）');
  process.exit(0);
}

main().catch((e) => {
  console.error('');
  console.error('❌ 启动失败：', e?.message || e);
  process.exit(1);
});
