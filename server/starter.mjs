/**
 * 首次初始化示例足迹（2026-11-09 D-324，用户要求；D-328 追加「家」+「秘密基地」）：
 * 「本地版 / 云端版第一次初始化登录进去后，地图默认已在 34 个省级行政区（含港澳台）省会打上标点，
 *   每个地点 1 次到访、日期 2022~2026 随机、每个到访 1 张照片（照片 = 34 省卡通贴）」
 * D-328 追加两个标点：**家**（浙江衢州，place.home=1）与**秘密基地**（新疆赛里木湖，place.secret=1），
 * 并在首次初始化时把秘密基地初始密码设为 12345678（可用 STARTER_SECRET_PASSWORD 覆盖；
 * 之后可在 设置 → 安全 修改 / 重置），合计 36 条示例足迹。
 *
 * 设计要点：
 * - 幂等：seed_marker 表按作用域记录（local = 'local'，云端 = 'user:<userId>'）；
 *   已记录 → 直接跳过；没有标记但账号已有未删除地点 → 只补标记、不生成（保护老用户 / 安装版真实数据 /
 *   开发库里的既有数据）；只有「无标记且无地点」的新库 / 新账号才生成 36 条。
 * - CONFIG.starterData=false（.env.local 里 STARTER_DATA=0）时整体跳过。
 * - 照片资源：server/starter-photos/<key>.png（由 scripts/build-starter-photos.mjs 生成，只引用文件名）。
 *   复制到素材库结构 `<省>/<市或未标注>/<区县或未标注>/<date>_<省会名>/<key>.png`
 *   （multi 前面多一级 `<owner>/`，/api/media/:id/orig 按 mediaBaseFor(owner) + rel_path 就能读回）。
 * - 缩略图 / 预览用 sharp 现场生成到 data/thumbs[<owner>]/（thumb 400 webp q78 → `<id>.webp`，
 *   preview 1600 webp q82 → `<id>_p.webp`），与上传路由的缓存约定一致。
 * - DB 写入放在一个事务里（BEGIN / COMMIT / 异常 ROLLBACK），异常时不写 marker，下次登录重试。
 *
 * 调用方（server/index.mjs）：
 * - local 模式：服务启动、app.listen 之前调一次；
 * - multi 模式：/api/auth/login、/api/auth/register 成功后按 user.id 调用。
 */
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { CONFIG } from './config.mjs';
import { db, now } from './db.mjs';
import { mediaBaseFor } from './media-root.mjs';
import { hashFile16 } from './importer.mjs';
import { isSecretConfigured, setInitialSecretPassword } from './secret.mjs';

/** 34 个省级行政区省会 / 首府 / 特别行政区的示例数据（顺序 = 照片 key 顺序） */
const PROVINCE_DATA = [
  // key,          省份全称,         adcode, 省会名,   地级市名,   区县名,   经度,     纬度
  ['beijing',      '北京市',          110000, '北京',     '北京市',     '东城区',   116.4074, 39.9042],
  ['tianjin',      '天津市',          120000, '天津',     '天津市',     '和平区',   117.2008, 39.0842],
  ['hebei',        '河北省',          130000, '石家庄',   '石家庄市',   '长安区',   114.5149, 38.0428],
  ['shanxi',       '山西省',          140000, '太原',     '太原市',     '杏花岭区', 112.5489, 37.8706],
  ['neimenggu',    '内蒙古自治区',    150000, '呼和浩特', '呼和浩特市', '新城区',   111.7492, 40.8426],
  ['liaoning',     '辽宁省',          210000, '沈阳',     '沈阳市',     '沈河区',   123.4315, 41.8057],
  ['jilin',        '吉林省',          220000, '长春',     '长春市',     '南关区',   125.3235, 43.8171],
  ['heilongjiang', '黑龙江省',        230000, '哈尔滨',   '哈尔滨市',   '南岗区',   126.5350, 45.8023],
  ['shanghai',     '上海市',          310000, '上海',     '上海市',     '黄浦区',   121.4737, 31.2304],
  ['jiangsu',      '江苏省',          320000, '南京',     '南京市',     '玄武区',   118.7969, 32.0603],
  ['zhejiang',     '浙江省',          330000, '杭州',     '杭州市',     '西湖区',   120.1551, 30.2741],
  ['anhui',        '安徽省',          340000, '合肥',     '合肥市',     '庐阳区',   117.2272, 31.8206],
  ['fujian',       '福建省',          350000, '福州',     '福州市',     '鼓楼区',   119.2965, 26.0745],
  ['jiangxi',      '江西省',          360000, '南昌',     '南昌市',     '东湖区',   115.8582, 28.6829],
  ['shandong',     '山东省',          370000, '济南',     '济南市',     '历下区',   117.1201, 36.6512],
  ['henan',        '河南省',          410000, '郑州',     '郑州市',     '金水区',   113.6254, 34.7466],
  ['hubei',        '湖北省',          420000, '武汉',     '武汉市',     '武昌区',   114.3054, 30.5931],
  ['hunan',        '湖南省',          430000, '长沙',     '长沙市',     '岳麓区',   112.9388, 28.2282],
  ['guangdong',    '广东省',          440000, '广州',     '广州市',     '越秀区',   113.2644, 23.1291],
  ['guangxi',      '广西壮族自治区',  450000, '南宁',     '南宁市',     '青秀区',   108.3669, 22.8170],
  ['hainan',       '海南省',          460000, '海口',     '海口市',     '龙华区',   110.1983, 20.0440],
  ['chongqing',    '重庆市',          500000, '重庆',     '重庆市',     '渝中区',   106.5516, 29.5630],
  ['sichuan',      '四川省',          510000, '成都',     '成都市',     '锦江区',   104.0665, 30.5723],
  ['guizhou',      '贵州省',          520000, '贵阳',     '贵阳市',     '云岩区',   106.6302, 26.6477],
  ['yunnan',       '云南省',          530000, '昆明',     '昆明市',     '五华区',   102.8329, 24.8801],
  ['xizang',       '西藏自治区',      540000, '拉萨',     '拉萨市',     '城关区',   91.1322,  29.6604],
  ['shaanxi',      '陕西省',          610000, '西安',     '西安市',     '新城区',   108.9398, 34.3416],
  ['gansu',        '甘肃省',          620000, '兰州',     '兰州市',     '城关区',   103.8343, 36.0611],
  ['qinghai',      '青海省',          630000, '西宁',     '西宁市',     '城中区',   101.7782, 36.6171],
  ['ningxia',      '宁夏回族自治区',  640000, '银川',     '银川市',     '兴庆区',   106.2309, 38.4872],
  ['xinjiang',     '新疆维吾尔自治区', 650000, '乌鲁木齐', '乌鲁木齐市', '天山区',   87.6168,  43.8256],
  ['taiwan',       '台湾省',          710000, '台北',     '台北市',     '中正区',   121.5654, 25.0330],
  // D-283：港澳天地图只给省级，city / county 保持为空（前端的港澳台规则会扁平显示）
  ['hongkong',     '香港特别行政区',  810000, '香港',     '',           '',         114.1734, 22.3193],
  ['macau',        '澳门特别行政区',  820000, '澳门',     '',           '',         113.5439, 22.1987],
].map(([key, province, adcode, capital, city, county, lng, lat]) => ({
  key,
  province,
  adcode,
  capital,
  city,
  county,
  lng,
  lat,
}));

if (PROVINCE_DATA.length !== 34) {
  throw new Error(`[starter] 示例数据应有 34 条，实际 ${PROVINCE_DATA.length} 条`);
}

/**
 * 额外示例标点（2026-11-09 D-328，用户要求）：
 * - **家**：浙江省衢州市（全库唯一，place.home=1）；
 * - **秘密基地**：新疆赛里木湖（place.secret=1；首次初始化同时把秘密基地密码设为 12345678，
 *   之后可在 设置 → 安全 修改 / 重置）。
 * 照片复用对应省份的卡通贴（家 = 浙江、秘密基地 = 新疆）。
 */
const EXTRA_PLACES = [
  {
    key: 'zhejiang',
    name: '家',
    province: '浙江省',
    adcode: 330000,
    city: '衢州市',
    county: '柯城区',
    lng: 118.8742,
    lat: 28.9358,
    home: 1,
    secret: 0,
  },
  {
    key: 'xinjiang',
    name: '赛里木湖',
    province: '新疆维吾尔自治区',
    adcode: 650000,
    city: '博尔塔拉蒙古自治州',
    county: '博乐市',
    lng: 81.1615,
    lat: 44.6019,
    home: 0,
    secret: 1,
  },
];

if (EXTRA_PLACES.length !== 2) {
  throw new Error(`[starter] 额外示例数据应有 2 条，实际 ${EXTRA_PLACES.length} 条`);
}

/** 首次初始化的全部示例地点：34 个省会 + 家 + 秘密基地 = 36 条 */
const STARTER_PLACES = [
  ...PROVINCE_DATA.map((p) => ({ ...p, name: p.capital, home: 0, secret: 0 })),
  ...EXTRA_PLACES,
];

/** 卡通贴照片资源目录（由 scripts/build-starter-photos.mjs 生成；这里只引用文件名） */
const STARTER_PHOTO_DIR = join(CONFIG.root, 'server', 'starter-photos');

/** 进程内防并发重复：同作用域同一时间只跑一次（多进程部署不在支持范围） */
const inFlight = new Set();

// ── 路径清洗：与 server/index.mjs 上传路由 safeSeg / safeName / uniquePath 完全同口径 ──

const safeName = (s) =>
  String(s || '地点').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '').slice(0, 60) || '地点';

/** 目录级名称（省/市/区县）：清洗非法字符、限长，缺省用「未标注」 */
const safeSeg = (s) =>
  String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 48) || '未标注';

/** 不覆盖已有文件：目标已存在时在文件名后加 -1 / -2 … */
function uniquePath(dir, filename) {
  const ext = extname(filename);
  const base = basename(filename, ext);
  let p = join(dir, filename);
  let i = 1;
  while (existsSync(p)) p = join(dir, `${base}-${i++}${ext}`);
  return p;
}

// ── 工具 ───────────────────────────────────────────────────

const scopeOf = (owner) => (owner ? `user:${owner}` : 'local');

/** 缩略图 / 预览根目录：multi = data/thumbs/<owner>/；local = data/thumbs（与 index.mjs 一致） */
const thumbRootFor = (owner) =>
  owner ? join(CONFIG.thumbDir, String(owner)) : CONFIG.thumbDir;

const pad = (n) => String(n).padStart(2, '0');

/** 本地时区 YYYY-MM-DD（避免 UTC 跨日） */
function localDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 随机一个访问日期（本地时区）：在该年份内随机取一天，不超过「今天」。
 * 返回 { date: 'YYYY-MM-DD', ts: 当天 12:00 本地时间戳 }。
 */
function randomDateInYear(year) {
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  let maxOffset;
  if (year > today.getFullYear()) {
    maxOffset = 0;
  } else if (year === today.getFullYear()) {
    maxOffset = Math.max(0, Math.floor((todayUtc - Date.UTC(year, 0, 1)) / 86400000));
  } else {
    maxOffset = Math.floor((Date.UTC(year, 11, 31) - Date.UTC(year, 0, 1)) / 86400000);
  }
  const offset = Math.floor(Math.random() * (maxOffset + 1));
  const day = new Date(year, 0, 1 + offset);
  return {
    date: localDateStr(day),
    // created_at 统一用访问当天 12:00 的本地时间戳（place / visit / media 三者一致）
    ts: new Date(year, 0, 1 + offset, 12, 0, 0, 0).getTime(),
  };
}

/**
 * 一批 34 条数据里尽量分散年份：把 2022..todayYear 轮流分配给各条（同一年最多 7~8 条）。
 * 例如 2026 年运行时 → 2022/2023/2024/2025/2026 各 7/7/7/7/6 条。
 */
function pickYears(count) {
  const firstYear = 2022;
  const lastYear = Math.max(firstYear, new Date().getFullYear());
  const years = [];
  for (let y = firstYear; y <= lastYear; y++) years.push(y);
  return Array.from({ length: count }, (_, i) => years[i % years.length]);
}

function markerRow(scope) {
  return db.prepare('SELECT scope, created_at, places FROM seed_marker WHERE scope = ?').get(scope) || null;
}

function writeMarker(scope, places) {
  db.prepare('INSERT OR REPLACE INTO seed_marker (scope, created_at, places) VALUES (?,?,?)').run(
    scope,
    now(),
    places
  );
}

/** 该作用域下是否已有未删除的地点（local = user_id IS NULL；multi = 该账号） */
function hasPlaces(owner) {
  const row = owner
    ? db.prepare('SELECT COUNT(*) AS n FROM place WHERE deleted_at IS NULL AND user_id = ?').get(owner)
    : db.prepare('SELECT COUNT(*) AS n FROM place WHERE deleted_at IS NULL AND user_id IS NULL').get();
  return Number(row?.n) > 0;
}

/** 删除本次尝试新建的文件（只删自己建的：uniquePath 保证没有覆盖别人的文件） */
function cleanupFiles(paths) {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      /* 删不掉就留着，不影响数据正确性 */
    }
  }
}

/**
 * 生成 36 个地点（34 省会 + 家 + 秘密基地）+ 每地点 1 次到访 + 每到访 1 张照片（含缩略图 / 预览）。
 * 调用前已确认：开关打开、无 marker、该作用域无地点。
 * @returns {Promise<{seeded:true, places:number}>}
 */
async function seed({ owner, scope }) {
  // 照片资源不齐就不生成（保证「每个到访 1 张照片」），只报错不写 marker，下次再试。
  const missing = STARTER_PLACES.map((p) => join(STARTER_PHOTO_DIR, `${p.key}.png`)).filter(
    (abs) => !existsSync(abs)
  );
  if (missing.length) {
    const names = missing.map((p) => basename(p)).join(', ');
    throw new Error(`示例照片资源缺失（${missing.length} 个）：${names}；目录 ${STARTER_PHOTO_DIR}`);
  }

  // D-212：multi 下每个账号可能有自己自定义的素材库根目录；local 用服务器默认
  const mediaBase = resolve(mediaBaseFor(owner));
  const mediaRootForOwner = owner ? join(mediaBase, String(owner)) : mediaBase;
  const thumbRoot = thumbRootFor(owner);
  mkdirSync(mediaRootForOwner, { recursive: true });
  mkdirSync(thumbRoot, { recursive: true });

  const years = pickYears(STARTER_PLACES.length);
  const createdFiles = [];
  const createdCacheFiles = [];
  const entries = [];

  try {
    // 1) 先落盘：复制原图 + 生成 thumb / preview（文件系统操作不放进 DB 事务，避免长事务里 await）
    for (let i = 0; i < STARTER_PLACES.length; i++) {
      const p = STARTER_PLACES[i];
      const { date, ts } = randomDateInYear(years[i]);
      const placeId = randomUUID();
      const visitId = randomUUID();
      const mediaId = randomUUID();

      const dir = join(
        mediaRootForOwner,
        safeSeg(p.province),
        safeSeg(p.city),
        safeSeg(p.county),
        `${date}_${safeName(p.name || p.capital || '地点')}`
      );
      mkdirSync(dir, { recursive: true });
      const dest = uniquePath(dir, `${p.key}.png`);
      copyFileSync(join(STARTER_PHOTO_DIR, `${p.key}.png`), dest);
      createdFiles.push(dest);

      const hash = await hashFile16(dest);
      const bytes = statSync(dest).size;

      const thumbOut = join(thumbRoot, `${mediaId}.webp`);
      await sharp(dest, { failOn: 'none' })
        .rotate()
        .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(thumbOut);
      createdCacheFiles.push(thumbOut);

      const previewOut = join(thumbRoot, `${mediaId}_p.webp`);
      await sharp(dest, { failOn: 'none' })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(previewOut);
      createdCacheFiles.push(previewOut);

      // rel_path 一律相对素材库根：multi 带 `<owner>/` 前缀并用 `/` 分隔（与上传路由一致，D-202）；
      // local 不带前缀、保持平台分隔符（Windows 反斜杠），与旧行为一致。
      const relToRoot = relative(mediaBase, dest);
      const relPath = owner ? relToRoot.split(sep).join('/') : relToRoot;

      entries.push({
        p,
        date,
        ts,
        placeId,
        visitId,
        mediaId,
        relPath,
        hash,
        bytes,
        thumb: relative(thumbRoot, thumbOut),
        preview: relative(thumbRoot, previewOut),
      });
    }

    // 2) 同一个事务里写 place / visit / media / seed_marker
    const insertPlace = db.prepare(`
      INSERT INTO place (id, user_id, name, lng, lat, province, city, county, province_code,
                         city_code, county_code, kind, home, secret, cover_media_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertVisit = db.prepare(`
      INSERT INTO visit (id, user_id, place_id, date, title, note, rating, companions, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    const insertMedia = db.prepare(`
      INSERT INTO media (id, user_id, visit_id, kind, rel_path, hash, bytes, width, height,
                         duration, thumb, preview, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    try {
      db.exec('BEGIN');
      // 事务内再查一次：万一等待期间用户/别的进程已经写了数据，就放弃本次生成（仍写 marker 防重试）
      if (markerRow(scope) || hasPlaces(owner)) {
        db.exec('ROLLBACK');
        writeMarker(scope, 0);
        cleanupFiles([...createdFiles, ...createdCacheFiles]);
        return { seeded: false, places: 0, reason: 'existing' };
      }
      for (const e of entries) {
        insertPlace.run(
          e.placeId,
          owner,
          e.p.name || e.p.capital,
          e.p.lng,
          e.p.lat,
          e.p.province,
          e.p.city || null,
          e.p.county || null,
          String(e.p.adcode),
          null,
          null,
          'visited',
          e.p.home ? 1 : 0,
          e.p.secret ? 1 : 0,
          e.mediaId,
          e.ts,
          e.ts
        );
        insertVisit.run(
          e.visitId,
          owner,
          e.placeId,
          e.date,
          null,
          null,
          null,
          null,
          e.ts,
          e.ts
        );
        insertMedia.run(
          e.mediaId,
          owner,
          e.visitId,
          'photo',
          e.relPath,
          e.hash,
          e.bytes,
          640,
          480,
          null,
          e.thumb,
          e.preview,
          e.ts
        );
      }
      writeMarker(scope, entries.length);
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 事务可能已经结束，忽略 */
      }
      cleanupFiles([...createdFiles, ...createdCacheFiles]);
      throw e;
    }

    // 3) 本地版首次初始化同时设置「秘密基地」初始密码（默认 12345678，可用 STARTER_SECRET_PASSWORD 覆盖）。
    //    2026-11-09 D-332：云端版（owner 非空）改用「登录账号密码」解锁秘密基地，不再种单独的初始秘密基地密码。
    //    密码只存 scrypt 哈希（local 在 data/config.json）；这里失败不影响已写入的示例数据，只打日志
    //    （用户可在 设置 → 安全 自行修改 / 重置）。
    try {
      if (!owner && !isSecretConfigured(owner)) {
        setInitialSecretPassword(CONFIG.starterSecretPassword, owner);
      }
    } catch (e) {
      console.warn('[starter] 初始秘密基地密码设置失败（不影响示例数据）：', e?.message || e);
    }

    return { seeded: true, places: entries.length };
  } catch (e) {
    // 未进入事务的失败（复制 / sharp）：清掉本次已落盘的文件，下次重试
    if (createdFiles.length || createdCacheFiles.length) {
      cleanupFiles([...createdFiles, ...createdCacheFiles]);
    }
    throw e;
  }
}

/**
 * 幂等初始化示例足迹。
 *
 * @param {{owner?: string|null}} [options] owner = null 表示本地单机模式；multi 模式传 user.id
 * @returns {Promise<{seeded:boolean, places?:number, reason?:string}>}
 *   reason: 'disabled'（开关关）| 'marked'（已种过）| 'existing'（已有地点，只补标记）| 'busy'（并发中）
 */
export async function ensureStarterData({ owner = null } = {}) {
  if (!CONFIG.starterData) return { seeded: false, reason: 'disabled' };
  const ownerId = owner ? String(owner) : null;
  const scope = scopeOf(ownerId);

  // 2026-11-09 D-335（用户要求）：只给「样板展示账号」跳过示例足迹——
  // 样板窗口展示的是用户自己准备的内容，首次登录不要混入 36 条示例足迹。
  if (ownerId && CONFIG.demoUsername) {
    const row = db.prepare('SELECT username FROM user WHERE id = ?').get(ownerId);
    if (row && row.username === CONFIG.demoUsername) {
      writeMarker(scope, 0);
      return { seeded: false, places: 0, reason: 'demo' };
    }
  }

  if (inFlight.has(scope)) return { seeded: false, reason: 'busy' };
  inFlight.add(scope);
  try {
    if (markerRow(scope)) return { seeded: false, reason: 'marked' };
    if (hasPlaces(ownerId)) {
      // 老用户 / 安装版真实数据 / 开发库：只补标记，不写入任何示例数据
      writeMarker(scope, 0);
      return { seeded: false, places: 0, reason: 'existing' };
    }
    return await seed({ owner: ownerId, scope });
  } finally {
    inFlight.delete(scope);
  }
}
