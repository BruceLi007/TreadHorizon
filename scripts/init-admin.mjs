#!/usr/bin/env node
/**
 * 创建 / 重置管理员账号（M6 P2-1，D-200）
 *
 * 用法：
 *   node scripts/init-admin.mjs <用户名> <密码>
 *   node scripts/init-admin.mjs <用户名> <密码> --reset      # 已存在则重置密码并设为管理员
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD=... node scripts/init-admin.mjs
 *
 * 注意：密码放在命令行参数里会出现在进程列表 / shell 历史；正式服务器建议用环境变量，
 * 或等 P2-3 的管理后台 / 部署脚本方式。脚本只读写 DATA_DIR 下的 travel.db，不启动服务。
 */
import { CONFIG } from '../server/config.mjs';
import { createUser, findUserByUsername, getUserById, resetPassword } from '../server/auth.mjs';
import { db } from '../server/db.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const reset = argv.includes('--reset');
const positional = argv.filter((a) => !a.startsWith('--'));
const username = String(positional[0] ?? process.env.ADMIN_USERNAME ?? '').trim();
const password = String(positional[1] ?? process.env.ADMIN_PASSWORD ?? '');

function usage(code = 1) {
  console.error(
    [
      '用法：node scripts/init-admin.mjs <用户名> <密码> [--reset]',
      '  或：ADMIN_USERNAME=admin ADMIN_PASSWORD=secret node scripts/init-admin.mjs',
      '',
      '说明：',
      '  - 需要 AUTH_MODE 无关；脚本直接操作 DATA_DIR 下的 travel.db。',
      '  - 用户名 3~24 位字母 / 数字 / 下划线 / 点 / 横线；密码至少 8 位。',
      '  - 加 --reset 时：账号已存在 → 重置密码并保证角色是管理员。',
    ].join('\n')
  );
  process.exit(code);
}

if (!username || !password) usage();

try {
  const existing = findUserByUsername(username);
  if (existing) {
    if (!reset) {
      console.error(`已存在同名账号「${username}」。如果忘了密码，加 --reset 重置。`);
      process.exit(1);
    }
    resetPassword(existing.id, password);
    db.prepare("UPDATE user SET role = 'admin', status = 'active' WHERE id = ?").run(existing.id);
    console.log(`✅ 已重置管理员密码：${username}（数据库：${CONFIG.dataDir}）`);
  } else {
    const user = createUser({
      username,
      password,
      displayName: username,
      role: 'admin',
    });
    console.log(`✅ 已创建管理员账号：${user.username}（数据库：${CONFIG.dataDir}）`);
  }
  const admins = db.prepare("SELECT COUNT(*) AS n FROM user WHERE role = 'admin'").get().n;
  console.log(`   当前管理员数量：${admins}；账号数量：${db.prepare('SELECT COUNT(*) AS n FROM user').get().n}`);
} catch (e) {
  console.error('❌ 创建 / 重置管理员失败：', e?.message || e);
  process.exitCode = 1;
} finally {
  // 等 WAL 落盘后退出（node:sqlite 同步 API，正常情况下直接结束即可）
  await sleep(30);
  process.exit();
}
