'use strict';
/**
 * 隐患识别结果评分器 —— 服务端
 * 零外部依赖，数据以 JSON 文件持久化在 data/ 下。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { buildXlsx } = require('./lib/xlsx');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const IMG_DIR = path.join(DATA_DIR, 'images');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');   // 320px 缩略图，供导出内嵌
const HAZARDS_FILE = path.join(DATA_DIR, 'hazards.json');
const SUBS_FILE = path.join(DATA_DIR, 'submissions.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const PORT = Number(process.env.PORT) || 3000;

// ---------------- 管理员密码 ----------------
// 密码只存在 data/admin.json，**代码里不留任何明文默认值** ——
// 这个仓库是要推出去的，写死一个「大家都知道」的密码等于没有密码。
//
// 首次运行（data/admin.json 不存在）时的密码来源，按优先级：
//   1. 环境变量 HR_ADMIN_PW —— 部署 / 自动化用，和 tools/sync_live.js 的约定一致
//   2. 随机生成一个并打印到控制台，请立刻记下
// 换密码：改 data/admin.json 里的 password，重启服务生效。
const ENV_ADMIN_PASSWORD = process.env.HR_ADMIN_PW || '';

/** 生成好抄写的随机密码：剔掉 0/O、1/l/I 这类容易看错的字符。 */
function randomPassword(n) {
  const AB = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(n || 16);
  let s = '';
  for (let i = 0; i < buf.length; i++) s += AB[buf[i] % AB.length];
  return s;
}

function loadAdmin() {
  try {
    const j = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    if (j && typeof j.password === 'string' && j.password) return j;
  } catch (e) { /* 首次运行还没有这个文件，往下走生成一个 */ }
  const pw = ENV_ADMIN_PASSWORD || randomPassword(16);
  const init = {
    password: pw,
    _note: '改密码就改上面的 password，保存后重启服务生效。这个文件不要提交到公开仓库。',
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });   // 全新克隆时 data/ 还不存在
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(init, null, 2));
    console.log('[admin] 首次运行：管理员密码已写入 data/admin.json → ' + pw);
  } catch (e) {
    console.log('[admin] 写不了 data/admin.json（' + e.message + '），本次运行的管理员密码是 → ' + pw);
  }
  return init;
}

/**
 * 管理员令牌。
 *
 * 用「服务端内存里的一次性随机串」而不是签名 —— 零依赖、够用，而且**重启即全部失效**，
 * 万一密码泄露改完密码重启就把所有人的会话踢掉了。代价是多实例部署不通用，
 * 但这个工具就是单进程跑在一台机器上。
 */
const adminTokens = new Map();          // token -> 过期时间戳
const ADMIN_TTL = 12 * 60 * 60 * 1000;  // 12 小时，够一天评审用

function issueAdminToken() {
  const now = Date.now();
  for (const [k, v] of adminTokens) if (v < now) adminTokens.delete(k);   // 顺手清过期
  const t = crypto.randomBytes(24).toString('hex');
  adminTokens.set(t, now + ADMIN_TTL);
  return t;
}

function isAdmin(req) {
  const t = String((req.headers && req.headers['x-admin-token']) || '');
  if (!t) return false;
  const exp = adminTokens.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { adminTokens.delete(t); return false; }
  return true;
}

// 评分维度定义（前端也读这份，保持口径一致）
const DIMENSIONS = [
  { key: 'real', label: '隐患真实性', hint: '画面中是否确实存在这条隐患', low: '不存在', high: '确实存在' },
  { key: 'desc', label: '隐患描述符合性', hint: '描述内容是否与画面事实一致', low: '完全不符', high: '完全符合' },
  { key: 'basis', label: '法规依据适用性', hint: '引用条款是否适用于该隐患', low: '不适用', high: '完全适用' },
  { key: 'cite', label: '依据引用准确性', hint: '引用条款是否适用于该区域、行业', low: '不适用', high: '完全适用' },
];
const INIT_SCORE = 90;

// ---------------- 隐患严重度（用于「重大漏检」加权） ----------------
// 漏检的代价跟隐患严重度强相关：漏掉一条重大隐患和漏掉一条杂物乱放完全不是一回事。
// 权重刻意拉开量级 —— 一条重大漏检 = 10 条一般漏检，让它在加权召回率里无法被稀释。
const SEVERITIES = [
  { key: 'general', label: '一般隐患', weight: 1, color: '#6a7488' },
  { key: 'major', label: '较大隐患', weight: 3, color: '#c2410c' },
  { key: 'critical', label: '重大隐患', weight: 10, color: '#b91c1c' },
];
const SEV_KEYS = SEVERITIES.map((s) => s.key);
const SEV_WEIGHT = Object.fromEntries(SEVERITIES.map((s) => [s.key, s.weight]));
const SEV_LABEL = Object.fromEntries(SEVERITIES.map((s) => [s.key, s.label]));
const sevOf = (v) => (SEV_KEYS.includes(v) ? v : 'general');
/**
 * 已识别隐患的严重度是「可选项」—— 未标注必须和「一般隐患」区分开。
 * 全部兜底成 general 会让严重度分布失真（一堆从没人看过的记录冒充「一般隐患」）。
 */
const sevOpt = (v) => (SEV_KEYS.includes(v) ? v : '');
/** 多人复核取最高严重度 —— 召回率口径宁可多报、不可漏报 */
const sevMax = (list) => (list || []).reduce((a, b) => (SEV_WEIGHT[b] > SEV_WEIGHT[a] ? b : a), 'general');

// ---------------- 模型质量评估：隐患主题归类 ----------------
// 隐患名称有 390+ 种、长尾极碎，直接按名称统计样本太少没法看趋势。
// 这里按关键词归到 10 个主题 + 其他，作为「查准率 / 召回率」的分析粒度。
const QUALITY_TOPICS = [
  { key: '消防通道与疏散', kw: ['通道', '疏散', '出口', '楼梯', '堵塞', '逃生', '占用'] },
  { key: '消防设施器材', kw: ['消火栓', '消防栓', '灭火器', '喷淋', '应急照明', '疏散指示', '防火门', '消防泵', '水带', '烟感', '消防'] },
  { key: '电气与用电', kw: ['配电', '电线', '线路', '插座', '开关', '漏电', '接地', '用电', '电缆', '裸露', '电闸'] },
  { key: '电动车管理', kw: ['电动车', '电瓶车', '自行车', '充电', '飞线'] },
  { key: '机械防护装置', kw: ['防护罩', '防护栏', '护栏', '护罩', '联锁', '限位', '砂轮', '传动', '皮带', '齿轮'] },
  { key: '高处与脚手架', kw: ['高处', '坠落', '脚手架', '临边', '洞口', '安全带', '登高', '梯'] },
  { key: '危化与易燃', kw: ['危化', '易燃', '易爆', '气瓶', '氧气', '乙炔', '油漆', '化学品', '酒精', '溶剂'] },
  { key: '个人防护用品', kw: ['安全帽', '劳保', '防护用品', '口罩', '护目', '反光', '工作服', '手套'] },
  { key: '现场管理与标识', kw: ['标识', '警示', '标志', '卫生', '杂物', '垃圾', '饮料', '工具', '摆放', '作业现场', '堆放'] },
  { key: '设备与容器', kw: ['压力', '容器', '锅炉', '储罐', '管道', '阀门', '机械', '设备', '起重', '行车', '叉车'] },
];
function topicOf(name) {
  const s = String(name || '');
  for (const t of QUALITY_TOPICS) {
    for (const k of t.kw) if (s.includes(k)) return t.key;
  }
  return '其他';
}

// 质量指标里「低于认可线」的判定基准（对标诊断用，与混淆矩阵阈值相互独立）
const QUALITY_LINE = INIT_SCORE;

// ---------------- 存储 ----------------
let statsCache = null, statsAt = 0;
// 按身份分的两份统计缓存 + 评审人代号映射缓存。
// 声明放前面：saveSubs() 里要清它们，别踩 TDZ。
let adminStatsCache = null, adminStatsAt = 0, anonStatsCache = null, anonStatsAt = 0;
let aliasCache = null, aliasAt = 0;
let exportCache = null;   // { buf, at } —— 导出含几百张图片，重建一次要读盘几百次
let deptExportCache = null;   // 按部门统计清单（纯文本，轻量），管理员专用

let hazardsCache = null;
function loadHazards() {
  if (hazardsCache) return hazardsCache;
  hazardsCache = JSON.parse(fs.readFileSync(HAZARDS_FILE, 'utf8'));
  return hazardsCache;
}

/** 列表版记录：去掉详情才需要的长文本（法规依据全文），首屏体积砍一半以上 */
function slimRecord(r, admin) {
  // 部门 / 检查人 = 管理员信息：非管理员直接不下发（不是前端藏），其余照常
  const out = {
    id: r.id, dept: admin ? r.dept : '', inspector: admin ? r.inspector : '',
    device: r.device, time: r.time, image: r.image,
  };
  if (!r.hazards.length) out.summary = r.summary;      // AI 画面描述只有空场景卡片要用
  out.hazards = r.hazards.map((h) => ({
    no: h.no, name: h.name, desc: h.desc, advice: h.advice, std: h.std,
    basis: h.basis.length > 56 ? h.basis.slice(0, 56) + '…' : h.basis,
    more: h.basis.length > 56,
  }));
  return out;
}

/** 元信息脱敏：depts（部门清单）和 batches[].depts（每批覆盖的部门）都是部门信息，非管理员不下发 */
function metaFor(admin) {
  const m = loadHazards().meta;
  if (admin) return m;
  return Object.assign({}, m, {
    depts: [],
    batches: (m.batches || []).map((b) => Object.assign({}, b, { depts: [] })),
  });
}

// 全量列表预构建 + 预压缩，请求时直接吐 buffer，零 CPU 开销
// 按身份缓存两份：管理员版含部门/检查人，匿名版不含 —— 共用一份会让先来的人决定后来的人看到什么
let listCache = null, listCacheAnon = null;
function getListPayload(admin) {
  if (admin ? listCache : listCacheAnon) return admin ? listCache : listCacheAnon;
  const hz = loadHazards();
  const json = Buffer.from(JSON.stringify({
    meta: metaFor(admin),
    records: hz.records.map((r) => slimRecord(r, admin)),
  }), 'utf8');
  const c = {
    json,
    gzip: zlib.gzipSync(json, { level: 9 }),
    etag: '"L' + crypto.createHash('md5').update(json).digest('hex').slice(0, 16) + '"',
  };
  if (admin) listCache = c; else listCacheAnon = c;
  console.log(`列表数据预压缩${admin ? '（管理员版）' : '（匿名版）'}：${(json.length / 1024).toFixed(0)}KB → ${(c.gzip.length / 1024).toFixed(0)}KB`);
  return c;
}

let inspectorsCache = null;
let basisIndex = null;
function getBasis(k) {
  if (!basisIndex) {
    basisIndex = new Map();
    for (const r of loadHazards().records) for (const h of r.hazards) basisIndex.set(r.id + '#' + h.no, h.basis);
  }
  return basisIndex.get(k) || '';
}

// 评分数据常驻内存，避免每个请求都同步读盘（多端并发时尤其明显）
let subsCache = null;
function loadSubs() {
  if (subsCache) return subsCache;
  try {
    subsCache = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch (e) {
    subsCache = { reviewers: {}, items: [] };
  }
  if (!subsCache.reviewers) subsCache.reviewers = {};
  if (!subsCache.items) subsCache.items = [];
  return subsCache;
}

let writeQueue = Promise.resolve();
let writePending = false;
function saveSubs(data) {
  subsCache = data;
  statsCache = null;                    // 数据变了，统计缓存作废
  // 按身份分的两份缓存也要一起清：它们靠「生成时间 >= statsAt」判断是否过期，
  // 而 statsAt 只在 statsCached() 真重建时才更新 —— 只清主缓存会让这两份一直返回旧数据。
  adminStatsCache = null; anonStatsCache = null;
  exportCache = null;                   // 导出（含图片，体积大）同样作废
  deptExportCache = null;               // 按部门清单导出也要跟着作废
  aliasCache = null;                    // 评审人代号映射要跟着重算（可能来了新人）
  if (writePending) return writeQueue;  // 120ms 内的多次提交合并成一次落盘
  writePending = true;
  writeQueue = writeQueue.then(() => new Promise((resolve) => {
    setTimeout(() => {
      writePending = false;
      const snapshot = JSON.stringify(subsCache);   // 落盘时取最新状态
      const tmp = SUBS_FILE + '.tmp';
      fs.writeFile(tmp, snapshot, (err) => {
        if (err) { console.error('写盘失败', err); return resolve(); }
        fs.rename(tmp, SUBS_FILE, () => resolve());
      });
    }, 120);
  }));
  return writeQueue;
}

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

// ---------------- 传输优化 ----------------
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg)/;

function wantsGzip(req) {
  return /\bgzip\b/i.test((req && req.headers['accept-encoding']) || '');
}

/** 统一出口：能压就压，省流量也省跨境等待 */
function sendBody(res, buf, type, code = 200, extraHeaders = {}) {
  const headers = Object.assign({ 'Content-Type': type, Vary: 'Accept-Encoding' }, extraHeaders);
  let out = buf;
  if (buf.length >= 1024 && COMPRESSIBLE.test(type) && wantsGzip(res.req)) {
    out = zlib.gzipSync(buf, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = out.length;
  res.writeHead(code, headers);
  res.end(out);
}

function sendJson(res, obj, code = 200, extraHeaders = {}) {
  sendBody(res, Buffer.from(JSON.stringify(obj), 'utf8'), 'application/json; charset=utf-8', code,
    Object.assign({ 'Cache-Control': 'no-store' }, extraHeaders));
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp',
};

function serveFile(res, filePath, cacheSec = 0) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const cc = cacheSec ? `public, max-age=${cacheSec}` : 'no-cache';

    if (res.req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cc });
      return res.end();
    }

    const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': cc, Vary: 'Accept-Encoding' };
    if (COMPRESSIBLE.test(type) && wantsGzip(res.req)) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      return fs.createReadStream(filePath).pipe(zlib.createGzip({ level: 6 })).pipe(res);
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

function norm(s, max = 500) {
  if (s == null) return '';
  return String(s).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normMulti(s, max = 3000) {
  if (s == null) return '';
  return String(s).replace(/\r\n/g, '\n').trim().slice(0, max);
}

// ---------------- 统计 ----------------
function computeStats() {
  const { records } = loadHazards();
  const subs = loadSubs();

  const recMap = new Map();
  const hzMap = new Map();
  for (const r of records) {
    recMap.set(r.id, r);
    for (const h of r.hazards) hzMap.set(r.id + '#' + h.no, { rec: r, hz: h });
  }

  const perHazard = new Map();   // key -> {scores:{}, reviewers:[], passes, issues}
  const perReviewer = new Map();
  const perDept = new Map();
  const noneRec = new Map();     // 记录ID -> 漏检复核结果（hazardNo === 0）
  const reviewByKey = new Map(); // key -> Map(reviewer -> {verdict, overall}) —— 算评价人一致性
  const perRevDay = new Map();   // reviewer|day -> {count, noneCount} —— 算评价人操作频率

  for (const it of subs.items) {
    const key = it.recordId + '#' + it.hazardNo;
    const reviewer = it.reviewer || '匿名';

    // 评价人操作频率：按「评审人 × 操作日期」聚合（用 updatedAt，改分也算一次操作）
    const actDay = String(it.updatedAt || it.createdAt || '').slice(0, 10);
    if (actDay) {
      const rk = reviewer + '|' + actDay;
      let rd = perRevDay.get(rk);
      if (!rd) { rd = { reviewer, day: actDay, count: 0, noneCount: 0 }; perRevDay.set(rk, rd); }
      rd.count++;
      if (it.hazardNo === 0) rd.noneCount++;
    }

    // 漏检复核单独走一条线，不混进隐患评分
    if (it.hazardNo === 0) {
      let nr = noneRec.get(it.recordId);
      if (!nr) { nr = { recordId: it.recordId, reviewers: [], confirmed: 0, suspected: 0, notes: [], sevs: [] }; noneRec.set(it.recordId, nr); }
      const rec0 = recMap.get(it.recordId);
      if (rec0) {
        nr.dept = rec0.dept || '未标注'; nr.inspector = rec0.inspector;
        nr.time = rec0.time; nr.summary = rec0.summary;
      }
      nr.reviewers.push(reviewer);
      if (it.verdict === 'issue') { nr.suspected++; nr.sevs.push(sevOf(it.severity)); }
      else nr.confirmed++;
      if (it.advice || it.note) nr.notes.push({ reviewer, desc: it.advice || '', basis: it.note || '', sev: sevOf(it.severity) });

      let pr0 = perReviewer.get(reviewer);
      if (!pr0) { pr0 = { reviewer, count: 0, dims: {}, passes: 0, issues: 0, lastAt: '', dept: '', noneCount: 0 }; perReviewer.set(reviewer, pr0); }
      pr0.noneCount = (pr0.noneCount || 0) + 1;
      pr0.lastAt = it.updatedAt || it.createdAt || pr0.lastAt;
      if (it.dept) pr0.dept = it.dept;
      continue;
    }

    const meta = hzMap.get(key);

    let ph = perHazard.get(key);
    if (!ph) { ph = { key, recordId: it.recordId, hazardNo: it.hazardNo, dims: {}, passes: 0, issues: 0, reviewers: [], comments: [], sevs: [], sevNotes: [] }; perHazard.set(key, ph); }
    ph.reviewers.push(reviewer);
    if (it.verdict === 'pass') ph.passes++;
    else if (it.verdict === 'issue') ph.issues++;

    // 已识别隐患同样要能标严重度 —— AI「报错了」和「没报」一样危险：
    // 一条被识别成一般问题的重大隐患，危害不比漏检小。标了重大 + 判定识别有误 = 红线。
    const sv = sevOpt(it.severity);
    if (sv) {
      ph.sevs.push(sv);
      ph.sevNotes.push({ reviewer, sev: sv, verdict: it.verdict === 'issue' ? 'issue' : 'pass' });
    }
    for (const d of DIMENSIONS) {
      const v = it.scores && it.scores[d.key];
      if (typeof v === 'number' && isFinite(v)) {
        if (!ph.dims[d.key]) ph.dims[d.key] = [];
        ph.dims[d.key].push(v);
      }
    }
    if (it.advice || it.note) {
      ph.comments.push({ reviewer, advice: it.advice || '', note: it.note || '' });
    }
    if (meta) {
      ph.name = meta.hz.name; ph.dept = meta.rec.dept;
      ph.time = meta.rec.time || '';
      ph.scene = meta.rec.scene || '';
      ph.inspector = meta.rec.inspector || '';    // 检查人 —— 管理端按人切分任务用
    }

    let pr = perReviewer.get(reviewer);
    if (!pr) { pr = { reviewer, count: 0, dims: {}, passes: 0, issues: 0, lastAt: '', dept: '', noneCount: 0 }; perReviewer.set(reviewer, pr); }
    pr.count++;
    pr.lastAt = it.updatedAt || it.createdAt || pr.lastAt;
    if (it.dept) pr.dept = it.dept;
    if (it.verdict === 'pass') pr.passes++;
    else if (it.verdict === 'issue') pr.issues++;
    for (const d of DIMENSIONS) {
      const v = it.scores && it.scores[d.key];
      if (typeof v === 'number' && isFinite(v)) {
        if (!pr.dims[d.key]) pr.dims[d.key] = [];
        pr.dims[d.key].push(v);
      }
    }

    // 同一隐患「谁怎么判的」——评价人一致性的原始素材
    const vals0 = DIMENSIONS.map((d) => (it.scores && it.scores[d.key])).filter((v) => typeof v === 'number' && isFinite(v));
    let rk0 = reviewByKey.get(key);
    if (!rk0) { rk0 = new Map(); reviewByKey.set(key, rk0); }
    rk0.set(reviewer, {
      verdict: it.verdict === 'issue' ? 'issue' : 'pass',
      overall: vals0.length ? Math.round((vals0.reduce((a, b) => a + b, 0) / vals0.length) * 10) / 10 : null,
    });
  }

  const avg = (arr) => (arr && arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null);
  const std = (arr) => {
    if (!arr || arr.length < 2) return null;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.round(Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length) * 10) / 10;
  };

  // 按部门
  for (const r of records) {
    for (const h of r.hazards) {
      const dept = r.dept || '未标注';
      if (!perDept.has(dept)) perDept.set(dept, { dept, hazards: 0, reviewed: 0, dims: {}, passes: 0, issues: 0 });
      perDept.get(dept).hazards++;
    }
  }
  for (const ph of perHazard.values()) {
    const dept = ph.dept || '未标注';
    const pd = perDept.get(dept);
    if (!pd) continue;
    pd.reviewed++;
    pd.passes += ph.passes;
    pd.issues += ph.issues;
    for (const d of DIMENSIONS) if (ph.dims[d.key]) { (pd.dims[d.key] = pd.dims[d.key] || []).push(...ph.dims[d.key]); }
  }

  const totalHazards = records.reduce((a, r) => a + r.hazards.length, 0);

  const hazardRows = [...perHazard.values()].map((ph) => {
    const dimAvg = {};
    for (const d of DIMENSIONS) dimAvg[d.key] = avg(ph.dims[d.key]);
    const all = Object.values(dimAvg).filter((v) => v !== null);
    const severity = ph.sevs.length ? sevMax(ph.sevs) : '';
    // 「重大隐患识别出错」= 有人标了重大，且判定 AI 识别有误（描述不符 / 依据不适用 / 严重度低估）
    const criticalWrong = ph.sevNotes.some((x) => x.sev === 'critical' && x.verdict === 'issue');
    const criticalOk = ph.sevNotes.some((x) => x.sev === 'critical' && x.verdict === 'pass');
    return {
      key: ph.key,
      recordId: ph.recordId,
      hazardNo: ph.hazardNo,
      name: ph.name || '',
      dept: ph.dept || '',
      inspector: ph.inspector || '',
      time: ph.time || '',
      scene: ph.scene || '',
      reviewers: ph.reviewers,
      reviewerCount: ph.reviewers.length,
      dimAvg,
      dimStd: Object.fromEntries(DIMENSIONS.map((d) => [d.key, std(ph.dims[d.key])])),
      overall: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10 : null,
      passes: ph.passes,
      issues: ph.issues,
      comments: ph.comments,
      severity,                                        // 人工认定的真实严重度；未标注为空
      severityLabel: severity ? SEV_LABEL[severity] : '',
      weight: severity ? SEV_WEIGHT[severity] : 1,
      labeled: !!severity,
      criticalWrong,                                   // 红线：报出来了但报错
      criticalOk,                                      // 报出来了且报对了
      sevNotes: ph.sevNotes,
    };
  }).sort((a, b) => (a.overall === null ? 999 : a.overall) - (b.overall === null ? 999 : b.overall));

  // ---- 重大隐患风险面 ----
  // 两个口子都要堵：漏检 = 没报出来；识别出错 = 报出来了但报错（描述不符 / 依据不适用 / 严重度低估）。
  // 后者在传统指标里会被当成 TP 混过去，所以必须单列。
  const labeledRows = hazardRows.filter((r) => r.labeled);
  const criticalStat = {
    total: hazardRows.length,
    labeled: labeledRows.length,
    unlabeled: hazardRows.length - labeledRows.length,
    bySeverity: Object.fromEntries(SEV_KEYS.map((k) => [k, hazardRows.filter((r) => r.severity === k).length])),
    critical: hazardRows.filter((r) => r.severity === 'critical').length,
    criticalWrong: hazardRows.filter((r) => r.criticalWrong).length,      // 红线
    criticalOk: hazardRows.filter((r) => r.severity === 'critical' && !r.criticalWrong).length,
    majorWrong: hazardRows.filter((r) => r.severity === 'major' && r.criticalWrong).length,
    weightedWrong: hazardRows.reduce((a, r) => a + (r.criticalWrong ? r.weight : 0), 0),
    wrongRows: hazardRows.filter((r) => r.criticalWrong)
      .map((r) => ({ key: r.key, recordId: r.recordId, hazardNo: r.hazardNo, name: r.name, dept: r.dept,
        inspector: r.inspector, time: r.time,
        severity: r.severity, severityLabel: r.severityLabel, weight: r.weight,
        reviewers: r.reviewers, comments: r.comments, overall: r.overall, sevNotes: r.sevNotes }))
      .sort((a, b) => (b.weight - a.weight) || ((a.overall === null ? 999 : a.overall) - (b.overall === null ? 999 : b.overall))),
  };

  // 评价人活跃度：近 7 天动作数 + 停滞天数（用于督促评价人补齐分母）
  const todayStr = new Date().toISOString().slice(0, 10);
  const dayDiff = (a, b) => Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);
  const actByRev = new Map();
  for (const rd of perRevDay.values()) {
    let a = actByRev.get(rd.reviewer);
    if (!a) { a = { days: 0, last: '', recent7: 0 }; actByRev.set(rd.reviewer, a); }
    a.days++;
    if (rd.day > a.last) a.last = rd.day;
    const gap = dayDiff(todayStr, rd.day);
    if (gap >= 0 && gap < 7) a.recent7 += rd.count;
  }

  const reviewerRows = [...perReviewer.values()].map((pr) => {
    const dimAvg = {};
    for (const d of DIMENSIONS) dimAvg[d.key] = avg(pr.dims[d.key]);
    const all = Object.values(dimAvg).filter((v) => v !== null);
    const act = actByRev.get(pr.reviewer) || { days: 0, last: '', recent7: 0 };
    const lastDay = act.last || String(pr.lastAt || '').slice(0, 10);
    const stalled = lastDay ? Math.max(0, dayDiff(todayStr, lastDay)) : null;
    return {
      ...pr,
      dimAvg,
      overall: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10 : null,
      passRate: pr.count ? Math.round((pr.passes / pr.count) * 1000) / 10 : null,
      activeDays: act.days,
      recent7: act.recent7,
      lastDay,
      stalledDays: stalled,
      // 活跃 / 观察 / 停滞 —— 管理页据此排序督促
      state: stalled == null ? 'none' : stalled <= 2 ? 'active' : stalled <= 7 ? 'watch' : 'stalled',
    };
  }).sort((a, b) => b.count - a.count);

  const deptRows = [...perDept.values()].map((pd) => {
    const dimAvg = {};
    for (const d of DIMENSIONS) dimAvg[d.key] = avg(pd.dims[d.key]);
    const all = Object.values(dimAvg).filter((v) => v !== null);
    return {
      ...pd,
      dimAvg,
      overall: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10 : null,
      progress: pd.hazards ? Math.round((pd.reviewed / pd.hazards) * 1000) / 10 : 0,
    };
  }).sort((a, b) => b.hazards - a.hazards);

  const dimRows = DIMENSIONS.map((d) => {
    const arr = [];
    for (const ph of perHazard.values()) if (ph.dims[d.key]) arr.push(...ph.dims[d.key]);
    const dist = { '0-59': 0, '60-79': 0, '80-89': 0, '90-100': 0 };
    for (const v of arr) {
      if (v < 60) dist['0-59']++;
      else if (v < 80) dist['60-79']++;
      else if (v < 90) dist['80-89']++;
      else dist['90-100']++;
    }
    return { key: d.key, label: d.label, avg: avg(arr), std: std(arr), count: arr.length, dist };
  });

  // ---- 漏检复核 ----
  const noneRecords = records.filter((r) => !r.hazards.length);
  const noneRows = noneRecords.map((r) => {
    const nr = noneRec.get(r.id) || { reviewers: [], confirmed: 0, suspected: 0, notes: [], sevs: [] };
    const severity = nr.suspected > 0 ? sevMax(nr.sevs) : '';
    return {
      recordId: r.id,
      dept: r.dept || '未标注',
      inspector: r.inspector || '',
      time: r.time || '',
      image: r.image || '',
      summary: r.summary || '',
      reviewerCount: nr.reviewers.length,
      reviewers: nr.reviewers,
      confirmed: nr.confirmed,
      suspected: nr.suspected,
      severity,                                        // 多人复核取最高严重度；未判漏检为空
      severityLabel: severity ? SEV_LABEL[severity] : '',
      weight: severity ? SEV_WEIGHT[severity] : 1,
      status: !nr.reviewers.length ? 'todo' : nr.suspected > 0 ? 'suspected' : 'confirmed',
      notes: nr.notes,
    };
  }).sort((a, b) => (b.weight - a.weight) || (b.suspected - a.suspected) || String(a.recordId).localeCompare(String(b.recordId)));

  const noneStat = {
    total: noneRecords.length,
    reviewed: noneRows.filter((r) => r.reviewerCount > 0).length,
    confirmed: noneRows.filter((r) => r.status === 'confirmed').length,
    suspected: noneRows.filter((r) => r.status === 'suspected').length,
    progress: noneRecords.length ? Math.round((noneRows.filter((r) => r.reviewerCount > 0).length / noneRecords.length) * 1000) / 10 : 0,
    // 严重度分布 + 加权漏检量：重大漏检 1 条 = 一般漏检 10 条
    bySeverity: Object.fromEntries(SEV_KEYS.map((k) => [k, noneRows.filter((r) => r.severity === k).length])),
    criticalMiss: noneRows.filter((r) => r.severity === 'critical').length,
    majorMiss: noneRows.filter((r) => r.severity === 'major').length,
    weightedMiss: noneRows.reduce((a, r) => a + (r.status === 'suspected' ? r.weight : 0), 0),
  };

  const generalNotes = Object.values(subs.reviewers || {}).filter((r) => r.general && String(r.general).trim()).length;

  // ---- 评价人一致性 ----
  // 同一条隐患被多人评过，才能谈一致性。这里给出三样东西：
  //   ① 判定一致率（都认可 / 都存疑）—— 最直观
  //   ② Cohen's κ —— 扣掉「碰巧一致」后的真实一致程度
  //   ③ 平均分歧度（同一隐患多人综合分的极差）—— 连续分上的分歧
  // 再加一张评审人两两一致率矩阵，用来找出「和所有人都不一致」的那位。
  const agreeRate = { dualHazards: 0, allSame: 0, rate: null };
  const pairAgg = new Map();     // "a|b" -> {a,b,n,agree}
  const spreadRows = [];
  let kappaN = 0, kappaAgree = 0, kappaAIssue = 0, kappaBIssue = 0;

  for (const [key, m] of reviewByKey) {
    const list = [...m.entries()];                 // [[reviewer, {verdict, overall}]]
    if (list.length < 2) continue;
    agreeRate.dualHazards++;
    const issueCnt = list.filter(([, v]) => v.verdict === 'issue').length;
    if (issueCnt === 0 || issueCnt === list.length) agreeRate.allSame++;

    // 两两配对
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [ra, va] = list[i], [rb, vb] = list[j];
        const [x, y] = ra <= rb ? [ra, rb] : [rb, ra];
        const pk = x + '|' + y;
        let pa = pairAgg.get(pk);
        if (!pa) { pa = { a: x, b: y, n: 0, agree: 0 }; pairAgg.set(pk, pa); }
        const same = va.verdict === vb.verdict;
        pa.n++; if (same) pa.agree++;
        kappaN++; if (same) kappaAgree++;
        if (va.verdict === 'issue') kappaAIssue++;
        if (vb.verdict === 'issue') kappaBIssue++;
      }
    }

    // 分歧度：同一隐患各人综合分的极差
    const ovs = list.map(([, v]) => v.overall).filter((v) => v != null);
    const sp = ovs.length >= 2 ? Math.round((Math.max(...ovs) - Math.min(...ovs)) * 10) / 10 : null;
    const meta0 = hzMap.get(key);
    spreadRows.push({
      key,
      recordId: String(key).split('#')[0],
      hazardNo: Number(String(key).split('#')[1]) || 0,
      name: (meta0 && meta0.hz.name) || '',
      dept: (meta0 && meta0.rec.dept) || '',
      reviewers: list.map(([r, v]) => ({ reviewer: r, verdict: v.verdict, overall: v.overall })),
      spread: sp,
      min: ovs.length ? Math.min(...ovs) : null,
      max: ovs.length ? Math.max(...ovs) : null,
    });
  }

  if (agreeRate.dualHazards) agreeRate.rate = Math.round((agreeRate.allSame / agreeRate.dualHazards) * 1000) / 10;
  const agreePairs = [...pairAgg.values()]
    .map((p) => ({ ...p, rate: p.n ? Math.round((p.agree / p.n) * 1000) / 10 : null }))
    .sort((a, b) => b.n - a.n || String(a.a).localeCompare(String(b.a)));

  // Cohen's κ =（实际一致率 − 期望一致率）/（1 − 期望一致率）
  let kappa = null, po = null, pe = null;
  if (kappaN) {
    po = kappaAgree / kappaN;
    const pa1 = kappaAIssue / kappaN, pb1 = kappaBIssue / kappaN;
    pe = pa1 * pb1 + (1 - pa1) * (1 - pb1);
    kappa = pe < 1 ? Math.round(((po - pe) / (1 - pe)) * 1000) / 1000 : null;
  }

  const spreadVals = spreadRows.map((r) => r.spread).filter((v) => v != null);
  const agreement = {
    reviewers: [...new Set([...reviewByKey.values()].flatMap((m) => [...m.keys()]))].sort(),
    dualHazards: agreeRate.dualHazards,
    reviewedHazards: hazardRows.length,
    coverage: hazardRows.length ? Math.round((agreeRate.dualHazards / hazardRows.length) * 1000) / 10 : 0,
    allSame: agreeRate.allSame,
    agreeRate: agreeRate.rate,
    pairObservations: kappaN,
    po: po == null ? null : Math.round(po * 1000) / 1000,
    pe: pe == null ? null : Math.round(pe * 1000) / 1000,
    kappa,
    avgSpread: spreadVals.length ? Math.round((spreadVals.reduce((a, b) => a + b, 0) / spreadVals.length) * 10) / 10 : null,
    maxSpread: spreadVals.length ? Math.max(...spreadVals) : null,
    pairs: agreePairs,
    spreads: spreadRows.filter((r) => r.spread != null).sort((a, b) => b.spread - a.spread),
  };

  // ---- 评价人操作频率（按天）----
  const reviewerDaily = [...perRevDay.values()].sort((a, b) =>
    String(a.day).localeCompare(String(b.day)) || String(a.reviewer).localeCompare(String(b.reviewer)));

  // ---- 按时间聚合（月 / 周）----
  // 同一套聚合逻辑跑两遍，只是把「时间 → 分桶 key」换掉。分开写两份必然漂（改一处忘一处），
  // 而这两张表的口径必须完全一致 —— 用户会拿它们互相对照。
  const monthOf = (t) => String(t || '').slice(0, 7);
  /** 以周一为一周之首；返回该周周一的日期，排序和显示区间都靠它 */
  const weekOf = (t) => {
    const d = String(t || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '未标注时间';
    const dt = new Date(d + 'T00:00:00');
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));      // 周一 = 0
    const p = (n) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  };

  function bucketize(keyOf, labelOf) {
    const per = new Map();
    for (const r of records) {
      const k = keyOf(r.time) || '未标注时间';
      if (!per.has(k)) {
        per.set(k, { key: k, hazards: 0, records: 0, reviewed: 0, dims: {}, passes: 0, issues: 0, depts: new Set(), firstTime: '', lastTime: '' });
      }
      const b = per.get(k);
      b.records++;
      b.hazards += r.hazards.length;
      b.depts.add(r.dept || '未标注');
      const t = r.time || '';
      if (t) {
        if (!b.firstTime || t < b.firstTime) b.firstTime = t;
        if (!b.lastTime || t > b.lastTime) b.lastTime = t;
      }
    }
    for (const ph of perHazard.values()) {
      const b = per.get(keyOf(ph.time) || '未标注时间');
      if (!b) continue;
      b.reviewed++;
      b.passes += ph.passes;
      b.issues += ph.issues;
      for (const d of DIMENSIONS) if (ph.dims[d.key]) (b.dims[d.key] = b.dims[d.key] || []).push(...ph.dims[d.key]);
    }
    return [...per.values()].map((b) => {
      const dimAvg = {};
      for (const d of DIMENSIONS) dimAvg[d.key] = avg(b.dims[d.key]);
      const all = Object.values(dimAvg).filter((v) => v !== null);
      return {
        key: b.key,
        month: b.key,                            // 兼容既有字段名（导出的月度表按它排）
        label: labelOf(b.key),
        records: b.records,
        hazards: b.hazards,
        reviewed: b.reviewed,
        progress: b.hazards ? Math.round((b.reviewed / b.hazards) * 1000) / 10 : 0,
        dimAvg,
        overall: all.length ? Math.round((all.reduce((a, c) => a + c, 0) / all.length) * 10) / 10 : null,
        passes: b.passes,
        issues: b.issues,
        depts: [...b.depts].sort(),
        firstTime: b.firstTime,
        lastTime: b.lastTime,
      };
    }).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  }

  const monthRows = bucketize(monthOf, (k) =>
    (/^\d{4}-\d{2}$/.test(k) ? k.slice(0, 4) + '年' + Number(k.slice(5, 7)) + '月' : k));
  const weekRows = bucketize(weekOf, (k) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return k;
    const end = new Date(k + 'T00:00:00');
    end.setDate(end.getDate() + 6);
    const p = (n) => String(n).padStart(2, '0');
    return `${k.slice(5).replace('-', '/')} ~ ${p(end.getMonth() + 1)}/${p(end.getDate())}`;
  });

  // 识别频率：按「日期 × 部门 × 检查人」聚合 —— 反映 AI 眼镜的使用频率
  // 返回扁平行，前端按需再分组（换维度不用回服务端）
  const perFreq = new Map();
  for (const r of records) {
    const day = String(r.time || '').slice(0, 10) || '未标注时间';
    const dept = r.dept || '未标注';
    const inspector = r.inspector || '未标注';
    const k = day + '|' + dept + '|' + inspector;
    let fr = perFreq.get(k);
    if (!fr) { fr = { day, dept, inspector, records: 0, hazards: 0 }; perFreq.set(k, fr); }
    fr.records++;
    fr.hazards += r.hazards.length;
  }
  const freqRows = [...perFreq.values()].sort((a, b) =>
    String(a.day).localeCompare(String(b.day)) ||
    String(a.dept).localeCompare(String(b.dept)) ||
    String(a.inspector).localeCompare(String(b.inspector)));

  // ---------------- 模型质量指标（混淆矩阵口径） ----------------
  // 把「评分」二值化成检测问题，才算得出查准率 / 召回率 / 准确率：
  //   TP 有隐患 + 人工判「主体确实存在」（real ≥ 阈值）
  //   FP 有隐患 + 人工判「主体不成立」  → 误报
  //   FN AI 没报 + 人工复核发现确实有隐患 → 漏检
  //   TN AI 没报 + 人工确认无隐患
  // 只吐明细、不做阈值扫描 —— 阈值扫描放前端，拖阈值时指标即时联动、不用回服务端。
  const qItems = [];
  for (const ph of perHazard.values()) {
    const ra = avg(ph.dims.real);
    if (ra === null) continue;                    // 没打真实性分的不进矩阵
    const meta = hzMap.get(ph.key);
    qItems.push({
      d: String((meta && meta.rec.time) || '').slice(0, 10),
      t: topicOf(ph.name),
      p: (meta && meta.rec.dept) || '未标注',
      s: (meta && meta.hz.std) || '',
      m: ph.name || '',
      ra,
      da: avg(ph.dims.desc),
      ba: avg(ph.dims.basis),
      ca: avg(ph.dims.cite),
      sd: std(ph.dims.real),                      // 评价人分歧度（≥2 人才有意义）
      n: ph.reviewers.length,
    });
  }
  qItems.sort((a, b) => String(a.d).localeCompare(String(b.d)) || String(a.t).localeCompare(String(b.t)));

  const qNone = [];
  for (const nr of noneRec.values()) {
    // 漏检记录本身没有隐患名称，主题只能从复核人写的「漏检说明」里反推关键词。
    // 归不出来的算「未分类」，不硬塞进某个主题，否则会把召回率算歪。
    const txt = (nr.notes || []).map((x) => x.desc || '').join(' ');
    const hit = txt ? topicOf(txt) : '未分类';
    const sev = nr.suspected > 0 ? sevMax(nr.sevs) : 'general';
    qNone.push({
      d: String(nr.time || '').slice(0, 10),
      t: hit === '其他' ? '未分类' : hit,
      p: nr.dept || '未标注',
      // 多人复核按多数票；平票算漏检 —— 召回率口径宁可多报不可漏报
      v: (nr.suspected >= nr.confirmed && nr.suspected > 0) ? 1 : 0,
      // 严重度加权：重大漏检 1 条 = 一般漏检 10 条，让它在加权召回率里无法被稀释
      sv: sev,
      w: nr.suspected > 0 ? SEV_WEIGHT[sev] : 1,
      n: nr.reviewers.length,
    });
  }
  qNone.sort((a, b) => String(a.d).localeCompare(String(b.d)));

  return {
    generatedAt: new Date().toISOString(),
    dimensions: DIMENSIONS,
    timeSpan: (() => {
      const ds = records.map((r) => String(r.time || '').slice(0, 10)).filter(Boolean).sort();
      return ds.length ? { first: ds[0], last: ds[ds.length - 1], days: new Set(ds).size } : { first: '', last: '', days: 0 };
    })(),
    summary: {
      totalHazards,
      reviewedHazards: hazardRows.length,
      progress: totalHazards ? Math.round((hazardRows.length / totalHazards) * 1000) / 10 : 0,
      reviewerCount: reviewerRows.length,
      itemCount: subs.items.length,
      recordCount: records.length,
      totalFreqHazards: records.reduce((a, r) => a + r.hazards.length, 0),
      inspectorCount: new Set(records.map((r) => r.inspector || '未标注')).size,
      avgScore: (() => {
        const all = dimRows.map((d) => d.avg).filter((v) => v !== null);
        return all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10 : null;
      })(),
      flaggedCount: hazardRows.filter((h) => h.issues > 0).length,
      generalNotes,
      noneTotal: noneStat.total,
      noneReviewed: noneStat.reviewed,
      noneConfirmed: noneStat.confirmed,
      noneSuspected: noneStat.suspected,
      noneProgress: noneStat.progress,
      criticalMiss: noneStat.criticalMiss,     // 重大隐患漏检 —— 硬指标，出现即为不可接受
      majorMiss: noneStat.majorMiss,
      weightedMiss: noneStat.weightedMiss,
      criticalLabeled: criticalStat.labeled,   // 已标注严重度的已识别隐患
      criticalHazard: criticalStat.critical,   // 人工认定为重大的已识别隐患
      criticalWrong: criticalStat.criticalWrong, // 重大隐患识别出错 —— 红线
      criticalOk: criticalStat.criticalOk,
      monthCount: monthRows.length,
    },
    dimensionsStat: dimRows,
    hazardRows,
    reviewerRows,
    reviewerDaily,
    agreement,
    deptRows,
    monthRows,
    weekRows,
    noneRows,
    noneStat,
    criticalStat,
    freqRows,
    quality: {
      line: QUALITY_LINE,                       // 对标诊断的「认可线」（与混淆矩阵阈值独立）
      topics: QUALITY_TOPICS.map((t) => t.key).concat(['其他', '未分类']),
      items: qItems,                            // 已评隐患明细（可对任意阈值重算矩阵）
      none: qNone,                              // 漏检复核明细（含严重度 sv / 权重 w）
      severities: SEVERITIES,                   // 严重度定义 + 权重，前端直接读
    },
  };
}

/** 统计结果短时缓存：管理页 30 秒轮询 + 多人同时查看时不重复全量计算 */
function statsCached() {
  if (statsCache && Date.now() - statsAt < 4000) return statsCache;
  statsCache = computeStats();
  statsAt = Date.now();
  return statsCache;
}

/**
 * 评审人代号映射：全局一份。
 * 为什么要全局而不是每次现算：页面（/api/stats）和导出（Excel）里同一个人的代号必须一致，
 * 否则「评审人3」在页面是一个人、在 Excel 里是另一个人，对不上就没法核对了。
 * 编号按**姓名排序**，不按评分条数 —— 后者会让「评审人1」恒等于评得最多的人，等于留下排行榜。
 */
function reviewerAlias() {
  const st = statsCached();                       // 先取（可能刷新 statsAt），再判缓存是否过期
  if (aliasCache && aliasAt >= statsAt) return aliasCache;
  const names = new Set(st.reviewerRows.map((r) => r.reviewer));
  for (const name of Object.keys(loadSubs().reviewers || {})) names.add(name);
  aliasCache = new Map([...names].sort().map((n, i) => [n, '评审人' + (i + 1)]));
  aliasAt = Date.now();
  return aliasCache;
}

/**
 * 非管理员视图：把「部门 / 检查人 / 评审人姓名」三类信息从统计结果里抹掉。
 *
 * 为什么在服务端做：接口一扒就出来了，前端藏等于没藏（「按部门」当初就是这么定的）。
 * 为什么用「递归按字段名替换」而不是逐个字段手删：computeStats() 的返回结构里有十几处
 * 埋着这三类字段 —— hazardRows / reviewerRows / reviewerDaily / agreement.pairs /
 * agreement.spreads / monthRows / freqRows / noneRows / criticalStat.wrongRows / quality.items
 * —— 而且以后还会加。手写清单必漏，**漏一处就等于没锁**。递归只认字段名，新增字段自动覆盖。
 */
const ANON_DEPT_KEYS = new Set(['dept', 'depts', 'inspector', 'inspectors']);
function anonymizeStats(s) {
  const clone = JSON.parse(JSON.stringify(s));
  const alias = reviewerAlias();
  const as = (n) => (alias.has(n) ? alias.get(n) : n);

  (function scrub(v) {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (typeof v[i] === 'string') { if (alias.has(v[i])) v[i] = alias.get(v[i]); }
        else scrub(v[i]);
      }
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (ANON_DEPT_KEYS.has(k)) { v[k] = Array.isArray(val) ? [] : ''; continue; }
      if (k === 'reviewer' && typeof val === 'string') { v[k] = as(val); continue; }
      scrub(val);
    }
  })(clone);

  // 字段名不叫 dept / reviewer 的几处，递归认不出来，单独处理
  if (clone.agreement && Array.isArray(clone.agreement.pairs)) {
    for (const p of clone.agreement.pairs) { p.a = as(p.a); p.b = as(p.b); }
  }
  // quality 的两份明细里，部门用的是短字段名 p（为省体积）——
  // ⚠️ 以后往 quality 下加新的明细数组时，记得把它也加进来，否则就是一个漏口子。
  if (clone.quality) {
    for (const key of ['items', 'none']) {
      if (Array.isArray(clone.quality[key])) for (const it of clone.quality[key]) if (it) it.p = '';
    }
  }
  clone.deptRows = [];
  clone.deptUnlocked = false;
  return clone;
}

/** 按身份取统计：管理员拿完整版，其余拿脱敏版。两份各缓存一份，别互相串味。 */
function statsFor(admin) {
  if (admin) {
    if (adminStatsCache && adminStatsAt >= statsAt) return adminStatsCache;
    adminStatsCache = Object.assign({}, statsCached(), { deptUnlocked: true });
    adminStatsAt = Date.now();
    return adminStatsCache;
  }
  if (anonStatsCache && anonStatsAt >= statsAt) return anonStatsCache;
  anonStatsCache = anonymizeStats(statsCached());
  anonStatsAt = Date.now();
  return anonStatsCache;
}

// ---------------- 导出 ----------------
/**
 * 匿名导出的列裁剪表。
 * 为什么不「在每处 push 里写条件」：十几张表、几十个下标，改一处漏一处；
 * 而且 wrap / images 的列号会跟着位移，写死必错位。
 * 所以：行按完整版生成 → 这里统一删列 → 用同一份映射重算 wrap / images 的列号。
 * 值 = 要删掉的列下标（完整版的列号）。
 */
const ANON_DROP_COLS = {
  '评分明细': [1, 2],              // 部门 / 检查人员
  '现场图片': [1, 2],
  '隐患汇总': [1, 2],              // 部门 / 检查人
  '漏检复核': [1, 2],              // 部门 / 检查人员
  '重大隐患识别出错': [1],          // 部门
  '月度汇总': [5],                 // 覆盖部门
};
const shiftCol = (col, drop) => col - drop.filter((d) => d < col).length;

function buildExport(includeDept) {
  // 匿名版直接用脱敏后的统计（部门抹掉、评审人换代号），再统一裁掉敏感列
  const stats = includeDept ? statsCached() : anonymizeStats(statsCached());
  const { records } = loadHazards();
  const subs = loadSubs();
  const alias = includeDept ? null : reviewerAlias();
  const rev = (n) => (alias && alias.has(n) ? alias.get(n) : n);   // 提交记录里的评审人真名 → 代号

  const recMap = new Map(records.map((r) => [r.id, r]));
  const hzMap = new Map();
  for (const r of records) for (const h of r.hazards) hzMap.set(r.id + '#' + h.no, { rec: r, hz: h });

  // Sheet 1 评分明细
  const s1 = [['记录编号', '部门', '检查人员', '识别时间', '隐患序号', '隐患名称', '隐患描述', '整改建议', '法规依据',
    '评审人', '隐患真实性', '隐患描述符合性', '法规依据适用性', '依据引用准确性', '综合判定', '修改建议', '其他问题', '评分时间']];
  const sorted = [...subs.items]
    .filter((i) => i.hazardNo !== 0)                 // 漏检复核单独一张表
    .sort((a, b) => String(a.recordId).localeCompare(String(b.recordId)) || a.hazardNo - b.hazardNo || String(a.reviewer).localeCompare(String(b.reviewer)));
  for (const it of sorted) {
    const meta = hzMap.get(it.recordId + '#' + it.hazardNo);
    const rec = meta ? meta.rec : recMap.get(it.recordId);
    const hz = meta ? meta.hz : null;
    s1.push([
      it.recordId,
      rec ? rec.dept : '',
      rec ? rec.inspector : '',
      rec ? rec.time : '',
      it.hazardNo,
      hz ? hz.name : '',
      hz ? hz.desc : '',
      hz ? hz.advice : '',
      hz ? hz.basis : '',
      rev(it.reviewer),
      it.scores ? it.scores.real : '',
      it.scores ? it.scores.desc : '',
      it.scores ? it.scores.basis : '',
      it.scores ? it.scores.cite : '',
      it.verdict === 'pass' ? '认可' : it.verdict === 'issue' ? '有问题' : '',
      it.advice || '',
      it.note || '',
      (it.updatedAt || it.createdAt || '').replace('T', ' ').slice(0, 19),
    ]);
  }

  // Sheet 2 现场图片：全部隐患逐条一行，内嵌该记录的现场缩略图（看图核对的入口）
  const sImg = [['记录编号', '部门', '检查人员', '识别时间', '隐患序号', '隐患名称', '现场图片',
    '参评人数', '综合均分', '认可', '存疑']];
  const imgPlan = [];
  const statByKey = new Map(stats.hazardRows.map((h) => [h.key, h]));
  const allHazards = [];
  for (const rec of records) for (const hz of rec.hazards) allHazards.push({ rec, hz });
  allHazards.sort((a, b) =>
    String(a.rec.time || '').localeCompare(String(b.rec.time || '')) ||
    String(a.rec.id).localeCompare(String(b.rec.id)) || a.hz.no - b.hz.no);
  allHazards.forEach(({ rec, hz }, i) => {
    const st = statByKey.get(rec.id + '#' + hz.no);
    sImg.push([
      rec.id, rec.dept || '', rec.inspector || '', rec.time || '',
      hz.no, hz.name || '', '',
      st ? st.reviewerCount : 0,
      st && st.overall !== null ? st.overall : '',
      st ? st.passes : 0,
      st ? st.issues : 0,
    ]);
    const p = thumbPathFor(rec.id);
    if (p) imgPlan.push({ col: 6, row: i + 1, path: p, width: 180 });
  });

  // Sheet 2 隐患汇总
  const s2 = [['记录编号', '部门', '检查人', '识别时间', '隐患序号', '隐患名称', '人工认定严重度', '识别结论', '参评人数', '隐患真实性', '隐患描述符合性', '法规依据适用性', '依据引用准确性', '综合均分', '认可人数', '存疑人数', '修改建议 / 补充意见']];
  for (const h of stats.hazardRows) {
    const comments = h.comments.map((c) => [c.reviewer, c.advice, c.note].filter(Boolean).join('：')).join('\n');
    s2.push([
      h.recordId, h.dept, h.inspector || '', h.time || '', h.hazardNo, h.name,
      h.severityLabel || '未标注',
      h.criticalWrong ? '识别出错（红线）' : h.issues > 0 ? '有存疑' : h.passes > 0 ? '认可' : '',
      h.reviewerCount,
      h.dimAvg.real === null ? '' : h.dimAvg.real,
      h.dimAvg.desc === null ? '' : h.dimAvg.desc,
      h.dimAvg.basis === null ? '' : h.dimAvg.basis,
      h.dimAvg.cite === null ? '' : h.dimAvg.cite,
      h.overall === null ? '' : h.overall,
      h.passes, h.issues, comments,
    ]);
  }

  // Sheet 3 评审人汇总
  // 「所属部门」和「部门汇总」表同源，都是管理员专属的部门维度 —— 一起挡，否则又是一个绕过口子。
  // 列位置会跟着变，所以下面所有下标都要用同一套条件推，别写死。
  const s3 = [['评审人'].concat(includeDept ? ['所属部门'] : [])
    .concat(['评分条数', '隐患真实性均分', '隐患描述符合性均分', '法规依据适用性均分', '依据引用准确性均分', '综合均分', '认可率(%)', '最后提交时间'])];
  for (const r of stats.reviewerRows) {
    s3.push([r.reviewer].concat(includeDept ? [r.dept] : []).concat([r.count,
      r.dimAvg.real === null ? '' : r.dimAvg.real,
      r.dimAvg.desc === null ? '' : r.dimAvg.desc,
      r.dimAvg.basis === null ? '' : r.dimAvg.basis,
      r.dimAvg.cite === null ? '' : r.dimAvg.cite,
      r.overall === null ? '' : r.overall,
      r.passRate === null ? '' : r.passRate,
      (r.lastAt || '').replace('T', ' ').slice(0, 19)]));
  }

  // Sheet 4 部门汇总
  const s4 = [['部门', '隐患总数', '已评条数', '进度(%)', '隐患真实性', '隐患描述符合性', '法规依据适用性', '依据引用准确性', '综合均分', '认可数', '存疑数']];
  for (const d of stats.deptRows) {
    s4.push([d.dept, d.hazards, d.reviewed, d.progress,
      d.dimAvg.real === null ? '' : d.dimAvg.real,
      d.dimAvg.desc === null ? '' : d.dimAvg.desc,
      d.dimAvg.basis === null ? '' : d.dimAvg.basis,
      d.dimAvg.cite === null ? '' : d.dimAvg.cite,
      d.overall === null ? '' : d.overall, d.passes, d.issues]);
  }

  // Sheet 5 维度汇总
  const s5 = [['评分维度', '参评样本数', '平均分', '标准差', '0-59分', '60-79分', '80-89分', '90-100分']];
  for (const d of stats.dimensionsStat) {
    s5.push([d.label, d.count, d.avg === null ? '' : d.avg, d.std === null ? '' : d.std,
      d.dist['0-59'], d.dist['60-79'], d.dist['80-89'], d.dist['90-100']]);
  }

  // Sheet 6 漏检复核
  const s6 = [['记录编号', '部门', '检查人员', '识别时间', 'AI 对画面的描述', '复核人数', '复核结论', '漏检严重度', '严重度权重', '疑似漏检说明', '对应法规依据', '复核人', '现场图片']];
  const imgPlan6 = [];
  stats.noneRows.forEach((n, i) => {
    const detail = n.notes.length
      ? n.notes.map((x) => [x.reviewer, x.desc, x.basis].filter(Boolean).join('：')).join('\n')
      : '';
    const basisOnly = n.notes.map((x) => x.basis).filter(Boolean).join('\n');
    s6.push([
      n.recordId, n.dept, n.inspector, n.time, n.summary, n.reviewerCount,
      n.status === 'suspected' ? '疑似漏检' : n.status === 'confirmed' ? '确认无隐患' : '未复核',
      n.status === 'suspected' ? (n.severityLabel || '一般隐患') : '',
      n.status === 'suspected' ? n.weight : '',
      n.status === 'suspected' ? detail : '',
      n.status === 'suspected' ? basisOnly : '',
      n.reviewers.join('、'),
      '',
    ]);
    const p = thumbPathFor(n.recordId);
    if (p) imgPlan6.push({ col: 12, row: i + 1, path: p, width: 180 });
  });

  const ns = stats.noneStat;
  const s6s = [['漏检复核总览', '数量'],
    ['AI 未识别到隐患的记录数', ns.total],
    ['已复核', ns.reviewed],
    ['其中：确认无隐患', ns.confirmed],
    ['其中：疑似漏检', ns.suspected],
    ['其中：较大隐患漏检', ns.majorMiss],
    ['其中：重大隐患漏检', ns.criticalMiss],
    ['加权漏检量（一般×1 / 较大×3 / 重大×10）', ns.weightedMiss],
    ['复核进度(%)', ns.progress]];

  // Sheet 10 重大隐患识别出错
  // 「漏检」是没报出来，「识别出错」是报出来了但报错 —— 传统指标会把它当 TP 混过去，必须单列。
  const cs = stats.criticalStat;
  const s10 = [['记录编号', '部门', '识别时间', '隐患序号', '隐患名称', '人工认定严重度', '严重度权重', '综合均分', '评审人', '评审意见']];
  for (const w of cs.wrongRows) {
    const cm = w.comments.map((c) => [c.reviewer, c.advice, c.note].filter(Boolean).join('：')).join('\n');
    s10.push([w.recordId, w.dept, w.time || '', w.hazardNo, w.name,
      w.severityLabel || '未标注', w.weight, w.overall === null ? '' : w.overall,
      w.reviewers.join('、'), cm]);
  }
  const s10s = [['重大隐患风险总览', '数量', '说明'],
    ['已标注严重度的隐患', cs.labeled, `共 ${cs.total} 条已评隐患`],
    ['其中：一般隐患', cs.bySeverity.general, '权重 ×1'],
    ['其中：较大隐患', cs.bySeverity.major, '权重 ×3'],
    ['其中：重大隐患', cs.bySeverity.critical, '权重 ×10'],
    ['重大隐患 · 识别出错', cs.criticalWrong, '红线：报出来了但报错（描述不符 / 依据不适用 / 严重度低估）'],
    ['重大隐患 · 识别正确', cs.criticalOk, 'AI 正确抓到'],
    ['重大隐患 · 完全漏检', ns.criticalMiss, '红线：AI 没报出来'],
    ['加权识别出错量', cs.weightedWrong, '识别出错的隐患权重之和'],
    ['未标注严重度的隐患', cs.unlabeled, '严重度标注率低时，上面的数字参考价值有限']];

  // Sheet 8 月度汇总（数据按时间顺承，按月横向比较）
  const s8 = [['月份', '记录数', '隐患总数', '已评条数', '进度(%)', '覆盖部门', '时间范围',
    '隐患真实性', '隐患描述符合性', '法规依据适用性', '依据引用准确性', '综合均分', '认可数', '存疑数']];
  for (const m of stats.monthRows) {
    s8.push([
      m.label, m.records, m.hazards, m.reviewed, m.progress, m.depts.join('、'),
      m.firstTime ? m.firstTime.slice(0, 10) + ' ~ ' + m.lastTime.slice(0, 10) : '',
      m.dimAvg.real === null ? '' : m.dimAvg.real,
      m.dimAvg.desc === null ? '' : m.dimAvg.desc,
      m.dimAvg.basis === null ? '' : m.dimAvg.basis,
      m.dimAvg.cite === null ? '' : m.dimAvg.cite,
      m.overall === null ? '' : m.overall,
      m.passes, m.issues,
    ]);
  }

  // Sheet 9 处理意见：按「关键词 / 部门 + 时间范围」分档的评审意见
  // 「所属部门」同「评审人汇总」的处理：管理员才有这一列。
  const s9 = [['意见归属', '归属类型', '评审人'].concat(includeDept ? ['所属部门'] : [])
    .concat(['意见内容', '提交时间'])];
  const s9TextCol = includeDept ? 4 : 3;         // 「意见内容」的列下标（换行样式要按它来）
  const scopeRows = [];
  for (const [name, rv] of Object.entries(subs.reviewers || {})) {
    const gens = rv.generals && Object.keys(rv.generals).length
      ? rv.generals
      : (rv.general ? { '全部': rv.general } : {});
    for (const [scope, text] of Object.entries(gens)) {
      if (!String(text || '').trim()) continue;
      scopeRows.push({ scope, reviewer: name, dept: rv.dept || '', text, at: rv.at || '' });
    }
  }
  scopeRows.sort((a, b) => String(a.scope).localeCompare(String(b.scope)) || String(a.reviewer).localeCompare(String(b.reviewer)));
  for (const s of scopeRows) {
    const parsed = parseScope(s.scope);
    s9.push([parsed.label, parsed.type, rev(s.reviewer)].concat(includeDept ? [s.dept] : [])
      .concat([s.text, (s.at || '').replace('T', ' ').slice(0, 19)]));
  }

  // 「部门汇总」是管理员专属的聚合视图。全量导出是全员可见的 —— 如果照旧带上这张表，
  // 等于把刚锁上的东西又从另一个门放出去（下载个 Excel 就看到了），锁就成了摆设。
  // 注意只挡这张聚合表；逐行数据里的「部门」列是记录自身的属性，界面上本来就看得到，不算泄露。
  const sheets = [
    { name: '评分明细', rows: s1, wrap: [6, 7, 8, 15, 16] },
    { name: '现场图片', rows: sImg, images: imgPlan, wrap: [5] },
    { name: '隐患汇总', rows: s2, wrap: [4, 16] },
    { name: '评审人汇总', rows: s3 },
  ];
  if (includeDept) sheets.push({ name: '部门汇总', rows: s4 });
  sheets.push(
    { name: '月度汇总', rows: s8, wrap: [5] },
    { name: '维度汇总', rows: s5 },
    { name: '处理意见', rows: s9, wrap: [s9TextCol] },
    { name: '漏检复核', rows: s6, images: imgPlan6, wrap: [4, 9, 10] },
    { name: '漏检总览', rows: s6s },
    { name: '重大隐患识别出错', rows: s10, wrap: [4, 9] },
    { name: '重大隐患总览', rows: s10s },
  );

  // 匿名版：把「部门 / 检查人」整列裁掉。留空列会让人以为数据缺了，还占版面；
  // 逐处写条件又极易错位 —— 所以行先按完整版生成，这里统一裁，并把 wrap / 图片列号一起挪。
  if (!includeDept) {
    for (const sh of sheets) {
      const drop = ANON_DROP_COLS[sh.name];
      if (!drop || !drop.length) continue;
      sh.rows = sh.rows.map((row) => row.filter((_, i) => !drop.includes(i)));
      if (sh.wrap) sh.wrap = sh.wrap.filter((c) => !drop.includes(c)).map((c) => shiftCol(c, drop));
      if (sh.images) sh.images = sh.images.map((im) => Object.assign({}, im, { col: shiftCol(im.col, drop) }));
    }
  }
  return buildXlsx(sheets);
}

/**
 * 解析意见归属 key（客户端生成），兼容旧的「批次:」格式。
 *   '全部'                                   → { type:'全部',  label:'全部数据' }
 *   '部门:某某单位'                            → { type:'部门',  label:'某某单位' }
 *   '时间:2026-09-15~2026-09-21'              → { type:'时间段', label:'2026-09-15 ~ 2026-09-21' }
 *   '部门:某某单位|时间:2026-09-15~2026-09-21'  → { type:'部门+时间段', label:'某某单位 · 2026-09-15 ~ 2026-09-21' }
 */
function parseScope(scope) {
  const s = String(scope || '').trim();
  if (!s || s === '全部') return { type: '全部', label: '全部数据' };
  const parts = s.split('|').map((x) => x.trim()).filter(Boolean);
  const labels = [];
  const types = [];
  for (const p of parts) {
    const i = p.indexOf(':');
    const kind = i > 0 ? p.slice(0, i) : '';
    const val = i > 0 ? p.slice(i + 1) : p;
    if (kind === '部门') { labels.push(val); types.push('部门'); }
    else if (kind === '时间') { labels.push(val.replace('~', ' ~ ')); types.push('时间段'); }
    else if (kind === '批次') { labels.push(val); types.push('批次'); }
    // 隐患搜索批次：按关键词搜出来的一批隐患，处理意见单独分档
    // （如「关键词:电气」→ 标签「含「电气」」，与「电气 · 09-15 ~ 09-21」区分得开）
    else if (kind === '关键词') { labels.push('含「' + val + '」'); types.push('关键词'); }
    else { labels.push(val); types.push('其他'); }
  }
  if (!labels.length) return { type: '全部', label: s };
  return { type: [...new Set(types)].join('+'), label: labels.join(' · ') };
}

/** 导出内嵌用图：优先 320px 缩略图，缺失时退回原图，都没有则跳过 */
function thumbPathFor(recordId) {
  const t = path.join(THUMB_DIR, recordId + '.jpg');
  if (fs.existsSync(t)) return t;
  const o = path.join(IMG_DIR, recordId + '.jpg');
  return fs.existsSync(o) ? o : '';
}

/**
 * 导出结果缓存：含几百张图片，重建一次要读盘几百次、耗时明显。
 * 管理员版（含「部门汇总」表）和匿名版分开缓存 —— 两者只差一张表，
 * 但共用一份缓存会让先来的那个人决定后来的人看到什么。
 */
function exportCached(includeDept) {
  const key = includeDept ? 'withDept' : 'public';
  const hit = exportCache && exportCache[key];
  if (hit && Date.now() - hit.at < 60000) return hit.buf;
  const buf = buildExport(!!includeDept);
  exportCache = exportCache || {};
  exportCache[key] = { buf, at: Date.now() };
  return buf;
}

/**
 * 「隐患统计清单」导出 —— 按部门汇总 + 按部门明细，管理员专用。
 *
 * 为什么不复用全量导出：全量导出是全员可见的，按部门汇总不是，两者必须分开鉴权。
 * 而且全量导出含几百张内嵌图、重建一次要读盘几百次；这份清单是纯文本，几百毫秒就出，
 * 老板临时要个数不用等。
 */
function buildDeptExport() {
  const stats = statsCached();
  const n1 = (v) => (v === null || v === undefined ? '' : v);
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : '');

  const rows = [['部门', '隐患总数', '已评条数', '未评条数', '进度(%)',
    '隐患真实性', '隐患描述符合性', '法规依据适用性', '依据引用准确性', '综合均分',
    '认可数', '存疑数', '认可率(%)']];
  const sum = { hazards: 0, reviewed: 0, passes: 0, issues: 0 };
  const dimSum = { real: [], desc: [], basis: [], cite: [], overall: [] };
  for (const d of stats.deptRows) {
    rows.push([
      d.dept, d.hazards, d.reviewed, Math.max(0, d.hazards - d.reviewed), d.progress,
      n1(d.dimAvg.real), n1(d.dimAvg.desc), n1(d.dimAvg.basis), n1(d.dimAvg.cite), n1(d.overall),
      d.passes, d.issues, pct(d.passes, d.reviewed),
    ]);
    sum.hazards += d.hazards; sum.reviewed += d.reviewed;
    sum.passes += d.passes; sum.issues += d.issues;
    for (const k of Object.keys(dimSum)) if (d.dimAvg[k] !== null) dimSum[k].push(d.dimAvg[k]);
  }
  // 合计行 —— 汇报时最需要的那一行；维度分取各部门的算术平均（不是加权，避免大部门吃掉小部门）
  const mean = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : '');
  rows.push(['合计', sum.hazards, sum.reviewed, Math.max(0, sum.hazards - sum.reviewed),
    pct(sum.reviewed, sum.hazards),
    mean(dimSum.real), mean(dimSum.desc), mean(dimSum.basis), mean(dimSum.cite), mean(dimSum.overall),
    sum.passes, sum.issues, pct(sum.passes, sum.reviewed)]);

  // 第二张表：逐条明细（带部门），方便按部门翻
  const detail = [['部门', '记录编号', '识别时间', '隐患序号', '隐患名称', '参评人数',
    '真实性', '描述符合性', '依据适用性', '引用准确性', '综合均分', '认可', '存疑', '修改建议 / 补充意见']];
  const sorted = stats.hazardRows.slice().sort((a, b) =>
    String(a.dept || '').localeCompare(String(b.dept || ''), 'zh') ||
    String(a.recordId).localeCompare(String(b.recordId)) ||
    (a.hazardNo - b.hazardNo));
  for (const h of sorted) {
    detail.push([
      h.dept || '未标注', h.recordId, String(h.time || '').replace('T', ' ').slice(0, 19), h.hazardNo, h.name,
      h.reviewerCount,
      n1(h.dimAvg.real), n1(h.dimAvg.desc), n1(h.dimAvg.basis), n1(h.dimAvg.cite), n1(h.overall),
      h.passes, h.issues,
      h.comments.map((c) => [c.reviewer, c.advice, c.note].filter(Boolean).join('：')).join(' | '),
    ]);
  }

  return buildXlsx([
    { name: '按部门统计', rows, widths: [16, 10, 10, 10, 10, 12, 14, 14, 14, 10, 8, 8, 10] },
    { name: '按部门隐患明细', rows: detail, widths: [14, 18, 18, 8, 30, 10, 9, 12, 12, 12, 10, 7, 7, 44], wrap: [4, 13] },
  ]);
}

function deptExportCached() {
  if (deptExportCache && Date.now() - deptExportCache.at < 60000) return deptExportCache.buf;
  const buf = buildDeptExport();
  deptExportCache = { buf, at: Date.now() };
  return buf;
}

// ---------------- 路由 ----------------
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/meta' && req.method === 'GET') {
    const admin = isAdmin(req);
    const subs = loadSubs();
    if (!inspectorsCache) {
      const inspectorCount = new Map();
      for (const r of loadHazards().records) {
        const n = (r.inspector || '').trim();
        if (n) inspectorCount.set(n, (inspectorCount.get(n) || 0) + 1);
      }
      inspectorsCache = [...inspectorCount.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    }
    // 「检查人清单」和「全部填写人员」都是管理员信息：非管理员拿到空数组，
    // 登录页就不会冒出历史姓名下拉（不然谁都能看到一共有谁在用）。
    return sendJson(res, {
      meta: metaFor(admin),
      dimensions: DIMENSIONS,
      initScore: INIT_SCORE,
      admin,
      inspectors: admin ? inspectorsCache : [],
      reviewers: admin
        ? Object.values(subs.reviewers || {}).map((r) => ({ name: r.name, dept: r.dept, at: r.at }))
        : [],
    });
  }

  if (p === '/api/hazards' && req.method === 'GET') {
    const admin = isAdmin(req);
    const dept = url.searchParams.get('dept');

    // 指定部门时走过滤分支（数据量大时可缩小首屏体积）
    if (dept && dept !== 'all') {
      const hz = loadHazards();
      const recs = hz.records.filter((r) => r.dept === dept);
      return sendJson(res, { meta: metaFor(admin), records: recs.map((r) => slimRecord(r, admin)) });
    }

    // 全量：直接吐预压缩好的 buffer
    const c = getListPayload(admin);
    if (req.headers['if-none-match'] === c.etag) {
      res.writeHead(304, { ETag: c.etag });
      return res.end();
    }
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      // 按身份内容不同，所以是 private：别让中间缓存把管理员版发给匿名用户。
      // ⚠️ 光有 private 不够 —— private 只管「共享缓存（代理）」，
      // 浏览器自己的私有缓存照样按 max-age 直接用。而 URL 是不变的，
      // 于是「先匿名打开 → 再解锁」就会吃到 10 分钟前的匿名版（部门 / 检查人还是空的）。
      // 所以必须把 X-Admin-Token 列进 Vary：让浏览器按令牌分槽存两份。
      'Cache-Control': 'private, max-age=600',
      ETag: c.etag, Vary: 'Accept-Encoding, X-Admin-Token',
    };
    let out = c.json;
    if (wantsGzip(req)) { out = c.gzip; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = out.length;
    res.writeHead(200, headers);
    return res.end(out);
  }

  // 法规依据全文按需加载（列表里只带了开头）
  if (p === '/api/basis' && req.method === 'GET') {
    const keys = String(url.searchParams.get('keys') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 80);
    const out = {};
    for (const k of keys) { const b = getBasis(k); if (b) out[k] = b; }
    return sendJson(res, out, 200, { 'Cache-Control': 'public, max-age=3600' });
  }

  if (p === '/api/my' && req.method === 'GET') {
    const reviewer = norm(url.searchParams.get('reviewer'), 60);
    if (!reviewer) return sendJson(res, { items: [] });
    const subs = loadSubs();
    const rv = subs.reviewers[reviewer] || {};
    return sendJson(res, {
      items: subs.items.filter((i) => i.reviewer === reviewer),
      general: rv.general || '',
      generals: rv.generals || {},      // 按 部门 / 时间范围分别记录的意见
    });
  }

  if (p === '/api/submit' && req.method === 'POST') {
    const body = await readBody(req);
    const reviewer = norm(body.reviewer, 60);
    if (!reviewer) return sendJson(res, { ok: false, error: '缺少评审人姓名' }, 400);

    const subs = loadSubs();
    subs.reviewers = subs.reviewers || {};
    subs.items = subs.items || [];

    const prev = subs.reviewers[reviewer] || {};
    const scope = norm(body.scope, 80);          // 例如「部门:某某单位|时间:2026-09-15~2026-09-21」「全部」
    const generals = Object.assign({}, prev.generals || {});
    const text = normMulti(body.general, 2000);
    if (scope && text) generals[scope] = text;

    subs.reviewers[reviewer] = {
      name: reviewer,
      dept: norm(body.dept, 40) || prev.dept || '',
      generals,
      // general 保留为「最近一次填写的意见」，兼容旧的统计与线上合并逻辑
      general: text || prev.general || '',
      at: new Date().toISOString(),
    };

    const now = new Date().toISOString();
    let saved = 0;
    for (const raw of (body.items || [])) {
      const recordId = norm(raw.recordId, 60);
      const hazardNo = Number(raw.hazardNo);
      if (!recordId || !isFinite(hazardNo)) continue;

      const scores = {};
      for (const d of DIMENSIONS) {
        const v = raw.scores ? Number(raw.scores[d.key]) : NaN;
        if (isFinite(v)) scores[d.key] = Math.max(0, Math.min(100, Math.round(v)));
      }
      const item = {
        recordId, hazardNo,
        reviewer,
        dept: norm(body.dept, 40),
        verdict: raw.verdict === 'issue' ? 'issue' : raw.verdict === 'pass' ? 'pass' : '',
        // 严重度与「识别对错」是两件独立的事，分开存：
        //   漏检（hazardNo=0）必须有严重度 —— 它是加权召回率的分母，兜底「一般」；
        //   已识别隐患的严重度是可选标注 —— 未标注要保持为空，不能冒充「一般隐患」把分布冲淡。
        severity: hazardNo === 0 ? sevOf(raw.severity) : sevOpt(raw.severity),
        scores,
        advice: normMulti(raw.advice, 1500),
        note: normMulti(raw.note, 1500),
        createdAt: now, updatedAt: now,
      };

      const i = subs.items.findIndex((x) => x.reviewer === reviewer && x.recordId === recordId && x.hazardNo === hazardNo);
      if (i >= 0) {
        item.createdAt = subs.items[i].createdAt || now;
        subs.items[i] = item;
      } else {
        item.id = uid();
        subs.items.push(item);
      }
      saved++;
    }

    await saveSubs(subs);
    return sendJson(res, { ok: true, saved, total: subs.items.length });
  }

  if (p === '/api/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const reviewer = norm(body.reviewer, 60);
    const subs = loadSubs();
    let removed = 0;

    if (body.all) {
      // 删除该评审人的全部评分
      const before = subs.items.length;
      subs.items = subs.items.filter((x) => x.reviewer !== reviewer);
      removed = before - subs.items.length;
    } else {
      const recordId = norm(body.recordId, 60);
      const hazardNo = Number(body.hazardNo);
      const before = subs.items.length;
      subs.items = subs.items.filter((x) => !(x.reviewer === reviewer && x.recordId === recordId && x.hazardNo === hazardNo));
      removed = before - subs.items.length;
    }

    // 没有评分残留了，就把评审人记录也清掉
    if (reviewer && !subs.items.some((x) => x.reviewer === reviewer)) {
      delete subs.reviewers[reviewer];
    }

    await saveSubs(subs);
    return sendJson(res, { ok: true, removed });
  }

  // ---------------- 管理员 ----------------
  if (p === '/api/admin/login' && req.method === 'POST') {
    const body = await readBody(req);
    const pw = norm(body.password, 100);
    const admin = loadAdmin();
    if (!pw || pw !== admin.password) {
      // 固定延迟：挡一下暴力穷举，也让「密码不对」和「服务卡了」在体感上有区别
      await new Promise((r) => setTimeout(r, 400));
      return sendJson(res, { ok: false, error: '管理员密码不对' }, 401);
    }
    return sendJson(res, { ok: true, token: issueAdminToken() });
  }

  if (p === '/api/admin/logout' && req.method === 'POST') {
    // 主动作废令牌：前端「退出管理员」时调。拿不到响应也不影响本地已退出，
    // 但服务端清掉更干净（公用电脑上别留着一个 12 小时有效的令牌）。
    const t = req.headers['x-admin-token'];
    if (t) adminTokens.delete(String(t));
    return sendJson(res, { ok: true });
  }

  /** 前端拿本地存的 token 探一下还有没有效（比如服务重启过就失效了） */
  if (p === '/api/admin/check' && req.method === 'GET') {
    return sendJson(res, { ok: isAdmin(req) });
  }

  if (p === '/api/dept-stats' && req.method === 'GET') {
    if (!isAdmin(req)) return sendJson(res, { ok: false, error: '需要管理员密码' }, 403);
    const s = statsCached();
    return sendJson(res, { ok: true, deptRows: s.deptRows, updatedAt: new Date().toISOString() });
  }

  if (p === '/api/export-dept.xlsx' && req.method === 'GET') {
    if (!isAdmin(req)) return sendJson(res, { ok: false, error: '需要管理员密码' }, 403);
    const buf = deptExportCached();
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="dept-hazard-stats-${Date.now()}.xlsx"`,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  if (p === '/api/stats' && req.method === 'GET') {
    // 「部门 / 检查人 / 评审人姓名」都是管理员视图：非管理员拿到的是脱敏版
    // （字段抹掉、姓名换代号），而不是靠前端藏 —— 接口一扒就出来了。
    return sendJson(res, statsFor(isAdmin(req)));
  }

  if (p === '/api/export.xlsx' && req.method === 'GET') {
    // 全员可见，但「部门汇总」那张表只给管理员 —— 详见 buildExport() 里的说明
    const buf = exportCached(isAdmin(req));
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="hazard-review-${Date.now()}.xlsx"`,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  if (p === '/api/export.csv' && req.method === 'GET') {
    const admin = isAdmin(req);
    // 匿名版同样走脱敏统计：部门抹掉、评审人换代号，并把「部门」列整列去掉
    const stats = statsFor(admin);
    const lines = [['记录编号'].concat(admin ? ['部门'] : [])
      .concat(['隐患序号', '隐患名称', '参评人数', '真实性', '描述符合性', '依据适用性', '引用准确性', '综合均分', '认可', '存疑', '意见']).join(',')];
    for (const h of stats.hazardRows) {
      const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""').replace(/\n/g, ' ')}"`;
      lines.push([h.recordId].concat(admin ? [h.dept] : []).concat([h.hazardNo, h.name, h.reviewerCount,
        h.dimAvg.real, h.dimAvg.desc, h.dimAvg.basis, h.dimAvg.cite, h.overall, h.passes, h.issues,
        h.comments.map((c) => [c.reviewer, c.advice, c.note].filter(Boolean).join('：')).join(' | ')]).map(cell).join(','));
    }
    const buf = Buffer.from('\ufeff' + lines.join('\r\n'), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="hazard-review-${Date.now()}.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  if (p === '/api/raw' && req.method === 'GET') {
    // 这是「全部填写人员的原始提交」，含评审人真名 —— 属于管理员信息。
    // 前端评分页不调它（评分端读自己的数据走 /api/my），只有发布前的同步脚本要用，
    // 那两个脚本（sync_live.js / check_live.js）自己带令牌。
    if (!isAdmin(req)) return sendJson(res, { ok: false, error: '需要管理员密码' }, 403);
    return sendJson(res, loadSubs());
  }

  if (p === '/api/health') return sendJson(res, { ok: true, uptime: process.uptime() });

  return sendJson(res, { error: 'not found' }, 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (url.pathname.startsWith('/images/')) {
      const name = path.basename(decodeURIComponent(url.pathname));
      return serveFile(res, path.join(IMG_DIR, name), 86400 * 30);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    if (url.pathname === '/admin' || url.pathname === '/admin.html') return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    // 没放图标文件，但浏览器一定会来要一次 —— 直接 204 掉，
    // 免得每个页面都在控制台留一条红字 404（排查真问题时很吵）。
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.join(PUBLIC_DIR, rel);
    if (!target.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    return serveFile(res, target);
  } catch (e) {
    console.error(e);
    sendJson(res, { error: String(e.message || e) }, 500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const hz = loadHazards();
  console.log(`隐患评分器已启动 http://0.0.0.0:${PORT}`);
  console.log(`数据：${hz.meta.recordCount} 条记录 / ${hz.meta.hazardCount} 条隐患`);
  console.log(`管理端：http://localhost:${PORT}/admin`);
  // 把局域网地址打出来 —— 同事连同一个 WiFi 就能访问，省得每次自己去 ipconfig 里翻
  const lan = Object.values(require('os').networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  if (lan.length) {
    console.log('');
    console.log('同一局域网（办公室 WiFi）内，同事可以访问：');
    for (const ip of lan) console.log(`  手机端 http://${ip}:${PORT}     管理端 http://${ip}:${PORT}/admin`);
  } else {
    console.log('（没检测到局域网地址，同事暂时只能在你本机访问）');
  }
});
