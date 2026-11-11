#!/usr/bin/env node
/**
 * Tread Horizon · 跨平台停止脚本（Windows / macOS / Linux 通用）
 * 2026-11-11 D-385（本地端跨平台）：配合 scripts/launch.mjs 使用。
 *
 * 用法：
 *   node scripts/stop.mjs           # 停止由 launch.mjs 启动的后台服务
 *   PORT=4001 node scripts/stop.mjs # 数据目录 / 端口跟 launch 用同一套规则（含 .env.local）
 *
 * 逻辑：
 *   1. 读 <数据目录>/server.pid（launch.mjs 写入的 pid / port / dataDir）
 *   2. 用 /api/health 校验：端口上确实是 Tread Horizon、而且是【当前数据目录】的实例，
 *      避免误停另一个副本（数据目录不同时只提示、不结束）
 *   3. 优先按 PID 文件结束（launch 写入的进程号）；PID 文件缺失 / 过期时按端口兜底查找
 *      （Windows: netstat -ano；macOS / Linux: lsof -ti）
 *   4. Windows：taskkill /PID <pid> /T /F；macOS / Linux：SIGTERM（超时再 SIGKILL）
 *   5. 结束后再探一次 health：如果端口上还有本实例在响应（极少数 PID 复用 / 双实例情况），
 *      按端口找到真正的监听进程再停一次
 *   6. 清理 PID 文件；重复执行安全（没在运行也返回 0）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 程序根目录：scripts/ 的上一级（不依赖当前工作目录） */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────── 读取 .env.local（与 server/config.mjs 保持一致） ─────────────
const envFile = join(ROOT, '.env.local');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    console.warn(`[stop] .env.local 读取失败（忽略，继续用环境变量）：${e.message}`);
  }
}

const rawPort = Number(process.env.PORT || 4000);
const PORT = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 4000;
/** 数据目录：与 server/config.mjs 的 DATA_DIR 规则一致（相对路径按程序根目录算） */
const DATA_DIR = process.env.DATA_DIR ? resolve(ROOT, process.env.DATA_DIR) : resolve(ROOT, 'data');
const PID_FILE = join(DATA_DIR, 'server.pid');

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

/** 进程是否还活着（EPERM = 没有权限但进程存在，视为活着） */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** 读 server.pid；文件不存在 / 内容不合法返回 null */
function readPidFile() {
  if (!existsSync(PID_FILE)) return null;
  try {
    // 去掉可能存在的 UTF-8 BOM（手动编辑过 PID 文件时）
    const raw = JSON.parse(readFileSync(PID_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const pid = Number(raw?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, port: Number(raw?.port) || 0, dataDir: raw?.dataDir || '', startedAt: raw?.startedAt || '' };
  } catch (e) {
    console.warn(`[stop] PID 文件内容无法解析（${e.message}），将按端口兜底查找。`);
    return null;
  }
}

function removePidFile() {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch (e) {
    console.warn(`[stop] 删除 PID 文件失败：${e.message}`);
  }
}

/**
 * 执行一个外部命令并收集 stdout（netstat / lsof / tasklist / ps 这类系统自带命令）。
 * 输出用临时文件接住而不是 pipe，兼容部分受限环境（例如不允许匿名管道的沙箱）。
 * @returns {{status:number|null, out:string, error:Error|null}}
 */
function captureCommand(cmd, args, timeoutMs = 15_000) {
  const tmpFile = join(
    tmpdir(),
    `tread-horizon-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  let fd;
  try {
    fd = openSync(tmpFile, 'w');
    const r = spawnSync(cmd, args, { stdio: ['ignore', fd, 'ignore'], windowsHide: true, timeout: timeoutMs });
    closeSync(fd);
    fd = undefined;
    return { status: r.status, out: readFileSync(tmpFile, 'utf8'), error: r.error || null };
  } catch (e) {
    return { status: null, out: '', error: e };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

/** 判断某个 PID 是否是 node 进程（health 完全不可用时，避免误杀无关进程） */
function looksLikeNode(pid) {
  try {
    if (IS_WIN) {
      const r = captureCommand('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 10_000);
      return /node\.exe/i.test(r.out);
    }
    const r = captureCommand('ps', ['-p', String(pid), '-o', 'comm='], 10_000);
    return /node/i.test(r.out);
  } catch {
    return false;
  }
}

/** 按端口找监听进程的 PID（Windows: netstat -ano；macOS / Linux: lsof -ti） */
function findPidByPort(port) {
  const pids = new Set();
  try {
    if (IS_WIN) {
      const r = captureCommand('netstat', ['-ano']);
      if (r.error) {
        console.warn(`[stop] 无法执行 netstat（${r.error.code || r.error.message}），按端口查找失败。`);
        return [];
      }
      // 形如：TCP    127.0.0.1:4000    0.0.0.0:0    LISTENING    12345
      const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
      for (const line of r.out.split(/\r?\n/)) {
        const m = re.exec(line);
        if (m) pids.add(Number(m[1]));
      }
    } else {
      const args = ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'];
      let r = captureCommand('lsof', args);
      if (r.error && IS_MAC) {
        // Mac 从 Finder / 双击启动时 PATH 可能不全，兜底试绝对路径
        r = captureCommand('/usr/sbin/lsof', args);
      }
      if (r.error) {
        console.warn(`[stop] 无法执行 lsof（${r.error.code || r.error.message}），按端口查找失败。`);
        return [];
      }
      for (const line of r.out.split(/\r?\n/)) {
        const n = Number(line.trim());
        if (Number.isInteger(n) && n > 0) pids.add(n);
      }
    }
  } catch (e) {
    console.warn(`[stop] 按端口查找进程失败：${e.message}`);
  }
  return [...pids];
}

/** 杀进程 / 进程树；返回是否已成功发出结束指令 */
function killProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (IS_WIN) {
    // /T 连同子进程；/F 强制结束（服务没有优雅退出的需求，SQLite WAL 会自动恢复）
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 20_000,
    });
    if (r.status === 0) return true;
    if (!isProcessAlive(pid)) return true; // 已经退出了
    // 兜底：process.kill 在 Windows 上直接 TerminateProcess（服务是单进程，不需要杀进程树）。
    // 个别受限环境（如禁止 taskkill 的沙箱）里 taskkill 会被拒绝，这里仍能把服务停掉。
    try {
      process.kill(pid);
      return true;
    } catch (e) {
      if (e?.code === 'ESRCH') return true;
      if (r.error) console.warn(`[stop] 无法执行 taskkill（${r.error.code || r.error.message}）。`);
      else console.warn(`[stop] taskkill 失败（PID ${pid}，退出码 ${r.status}）：${e?.message || e}`);
      return false;
    }
  }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (e) {
    if (e?.code === 'ESRCH') return true; // 已经退出了
    console.warn(`[stop] 结束进程失败（PID ${pid}）：${e?.message || e}`);
    return false;
  }
}

/** 等进程退出；非 Windows 上 SIGTERM 超时后升级为 SIGKILL */
async function waitForExit(pid, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await sleep(200);
  }
  if (!IS_WIN) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退出 */
    }
    const t1 = Date.now();
    while (Date.now() - t1 < 3000) {
      if (!isProcessAlive(pid)) return true;
      await sleep(150);
    }
  }
  return false;
}

/** 停一个 PID（含等待退出），返回是否已退出 */
async function stopPid(pid) {
  if (!killProcess(pid)) return false;
  return waitForExit(pid, IS_WIN ? 15_000 : 8000);
}

/** 等 health 不再响应；返回最后一次看到的响应（null = 已无响应） */
async function waitHealthGone(port, timeoutMs) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await probeHealth(port, 800);
    if (!last) return null;
    await sleep(150);
  }
  return last;
}

async function main() {
  console.log('Tread Horizon · 停止服务');
  console.log(`  数据目录：${DATA_DIR}`);
  console.log(`  端口：${PORT}`);

  const pidInfo = readPidFile();
  const pidFromFile = pidInfo?.pid ?? null;
  const port = pidInfo?.port && pidInfo.port >= 1 && pidInfo.port <= 65535 ? pidInfo.port : PORT;

  // ───────────── 1. 端口上是哪个实例？ ─────────────
  const health = await probeHealth(port);
  const healthOk = Boolean(health?.ok && health.body?.ok === true);
  const healthDataDir = healthOk ? health.body?.dataDir || null : null;

  if (healthOk && healthDataDir && !pathsEqual(healthDataDir, DATA_DIR)) {
    console.error('');
    console.error(`❌ 端口 ${port} 上运行的是另一个 Tread Horizon 实例（数据目录：${healthDataDir}），`);
    console.error(`   不是当前副本的数据目录（${DATA_DIR}）。为避免误停，本次不处理。`);
    console.error(`   如确认要停止它，请到那个程序目录执行 stop，或设置 DATA_DIR=${healthDataDir} 再运行本脚本。`);
    process.exit(1);
  }

  // ───────────── 2. 找目标进程：优先 PID 文件（launch 刚写入，最新最准） ─────────────
  let targetPid = null;
  let targetNote = '';

  if (pidFromFile && isProcessAlive(pidFromFile)) {
    targetPid = pidFromFile;
    targetNote = '按 PID 文件';
    // health 完全不可用时没有别的证据，粗略确认是 node 进程，避免 PID 复用误杀
    if (!healthOk && !looksLikeNode(pidFromFile)) {
      console.error('');
      console.error(`❌ PID 文件记录的进程 ${pidFromFile} 仍存在，但看起来不是 Tread Horizon 的 node 进程；`);
      console.error('   为避免误杀，本次不结束。可手动确认后删除 PID 文件：');
      console.error(`   ${PID_FILE}`);
      process.exit(1);
    }
  } else if (healthOk) {
    // PID 文件缺失 / 过期：按端口兜底，找真正的监听进程
    const portPids = findPidByPort(port);
    if (portPids.length === 1) {
      targetPid = portPids[0];
      targetNote = '按端口兜底';
    } else if (portPids.length > 1) {
      console.error('');
      console.error(`❌ 端口 ${port} 上有多个监听进程（PID ${portPids.join(', ')}），请手动处理。`);
      process.exit(1);
    } else {
      console.error('');
      console.error(`❌ 检测到 Tread Horizon 正在端口 ${port} 上运行（http://127.0.0.1:${port}/api/health），但查不到它的进程号。`);
      console.error('   可能是权限不足（Windows 可尝试以管理员身份运行）或系统缺少 netstat / lsof。');
      console.error(`   请手动结束该 node 进程后再试（PID 文件：${PID_FILE}）。`);
      process.exit(1);
    }
  }

  // ───────────── 3. 没有可停止的进程 → 清理后正常退出（重复执行安全） ─────────────
  if (!targetPid) {
    if (pidFromFile) {
      console.log(`ℹ️ PID 文件是旧的（PID ${pidFromFile} 已不存在），已清理。`);
      removePidFile();
    }
    const portPids = findPidByPort(port);
    if (portPids.length) {
      console.log(`ℹ️ Tread Horizon 没有在运行；端口 ${port} 被其它程序（PID ${portPids.join(', ')}）占用，未处理。`);
    } else {
      console.log(`ℹ️ Tread Horizon 没有在运行（未找到 PID 文件，端口 ${port} 空闲）。`);
    }
    process.exit(0);
  }

  // ───────────── 4. 结束进程 ─────────────
  console.log('');
  console.log(`⏹ 正在停止 Tread Horizon（PID ${targetPid}，端口 ${port}，${targetNote}）…`);
  if (!(await stopPid(targetPid))) {
    console.error('');
    console.error(`❌ 进程 ${targetPid} 未能停止。请手动结束它后再试。`);
    process.exit(1);
  }

  // ───────────── 5. 确认端口上不再有本实例响应（处理 PID 复用 / 双实例的极端情况） ─────────────
  let still = await waitHealthGone(port, 3000);
  if (still && still.ok && still.body?.ok === true && pathsEqual(still.body?.dataDir || '', DATA_DIR)) {
    const portPids = findPidByPort(port).filter((p) => p !== targetPid);
    if (portPids.length === 1) {
      console.log(`ℹ️ 端口 ${port} 上还有本实例在响应（PID ${portPids[0]}），继续停止…`);
      await stopPid(portPids[0]);
      still = await waitHealthGone(port, 3000);
    } else if (portPids.length > 1) {
      console.warn(`[stop] 端口 ${port} 上还有多个进程（PID ${portPids.join(', ')}），请手动处理。`);
    }
  }

  removePidFile();

  // ───────────── 6. 收尾提示 ─────────────
  const finalHealth = await probeHealth(port, 1200);
  if (finalHealth && finalHealth.ok && finalHealth.body?.ok === true) {
    console.error('');
    console.error(`❌ 进程已结束，但端口 ${port} 上仍有 Tread Horizon 在响应（可能是另一个副本）。`);
    console.error('   请再运行一次 stop，或确认端口占用后手动处理。');
    process.exit(1);
  }
  if (finalHealth) {
    console.log(`ℹ️ 端口 ${port} 现在被其它程序占用（不是 Tread Horizon），未处理。`);
  }

  console.log('');
  console.log(`✅ Tread Horizon 已停止（端口 ${port} 已释放）。`);
  process.exit(0);
}

main().catch((e) => {
  console.error('');
  console.error('❌ 停止失败：', e?.message || e);
  process.exit(1);
});
