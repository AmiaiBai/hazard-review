/**
 * 发布前把线上评分数据合并回本地 —— 防止发布时用旧的本地 submissions.json 覆盖线上真实评分。
 *
 * 用法：
 *   node tools/sync_live.js                # 合并（会先备份到 outputs/hazard-review-backup/）
 *   node tools/sync_live.js --dry          # 只看差异，不写盘
 *   node tools/sync_live.js --url <地址>    # 指定线上地址
 *
 * 合并规则：按 评审人 + 记录编号 + 隐患序号 取并集，同一条取 updatedAt 更新的那份。
 * 因此本地比线上新的数据也不会被冲掉，双向都安全。
 *
 * /api/raw 是管理员接口（含全部填写人员真名），所以这里要先拿令牌：
 * 密码优先取环境变量 HR_ADMIN_PW，否则读本地 data/admin.json（线上改过密码时用环境变量覆盖）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.resolve(ROOT, '..');            // D:\Project\AI眼镜
const LOCAL = path.join(ROOT, 'data', 'submissions.json');
const BACKUP_DIR = path.join(PROJECT, 'outputs', 'hazard-review-backup');
const DEFAULT_URL = 'https://da782378ef0146348f92b5c66301a892.sg.agentos-app.run';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const urlIdx = args.indexOf('--url');
const BASE = urlIdx >= 0 ? args[urlIdx + 1] : DEFAULT_URL;
const adminPw = () => {
  if (process.env.HR_ADMIN_PW) return process.env.HR_ADMIN_PW;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'admin.json'), 'utf8')).password || ''; }
  catch (e) { return ''; }
};

const keyOf = (it) => `${it.reviewer}#${it.recordId}#${it.hazardNo}`;
const atOf = (it) => Date.parse(it.updatedAt || it.createdAt || 0) || 0;
/** 本地时间戳，形如 2026-09-21-13-53-41（用本地时间，方便对照） */
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

function loadJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; }
}

(async () => {
  console.log(`线上地址：${BASE}`);

  // /api/raw 要管理员令牌：先用密码换一个
  let token = '';
  try {
    const r = await fetch(BASE + '/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: adminPw() }),
    });
    const j = await r.json();
    if (j && j.token) token = j.token;
  } catch (e) { /* 下面拉数据时会报出来 */ }

  let live;
  try {
    const res = await fetch(BASE + '/api/raw', {
      headers: token ? { 'x-admin-token': token } : {}, cache: 'no-store',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 403 ? '（管理员密码不对：设 HR_ADMIN_PW 覆盖）' : ''));
    live = await res.json();
  } catch (e) {
    console.error(`❌ 拉取线上数据失败：${e.message}`);
    console.error('   线上没起来 / 地址不对 / 网络不通时，请勿发布 —— 本地数据可能是旧的。');
    process.exit(1);
  }

  const local = loadJson(LOCAL, { reviewers: {}, items: [] });
  const liveItems = Array.isArray(live.items) ? live.items : [];
  const localItems = Array.isArray(local.items) ? local.items : [];

  console.log(`线上：${liveItems.length} 条评分 / ${Object.keys(live.reviewers || {}).length} 人`);
  console.log(`本地：${localItems.length} 条评分 / ${Object.keys(local.reviewers || {}).length} 人`);

  // 按 key 取并集，同 key 取 updatedAt 更新的
  const merged = new Map();
  for (const it of localItems) merged.set(keyOf(it), it);
  let fromLive = 0, liveNewer = 0;
  for (const it of liveItems) {
    const k = keyOf(it);
    const cur = merged.get(k);
    if (!cur) { merged.set(k, it); fromLive++; continue; }
    if (atOf(it) > atOf(cur)) { merged.set(k, it); liveNewer++; }
  }

  const localOnly = localItems.filter((it) => !liveItems.some((x) => keyOf(x) === keyOf(it))).length;
  const items = [...merged.values()];

  // reviewers 合并：两边取并集，线上优先；generals（按 部门 / 时间范围 分档的意见）逐档取并集。
  // 注意：只登记了姓名、还没提交任何评分（或只写了意见）的人也要保留，否则会丢数据。
  const reviewers = {};
  const names = new Set([...Object.keys(local.reviewers || {}), ...Object.keys(live.reviewers || {})]);
  for (const n of names) {
    const a = (local.reviewers || {})[n] || {};
    const b = (live.reviewers || {})[n] || {};
    reviewers[n] = Object.assign({}, a, b, {
      generals: Object.assign({}, a.generals || {}, b.generals || {}),
      general: String(b.general || '').trim() ? b.general : (a.general || ''),
      dept: b.dept || a.dept || '',
    });
  }

  const idle = Object.keys(reviewers).filter((n) => !items.some((x) => x.reviewer === n));
  const withGeneral = idle.filter((n) => {
    const r = reviewers[n] || {};
    return String(r.general || '').trim() || Object.keys(r.generals || {}).length;
  });
  if (idle.length) {
    console.log(`  保留未评分登记人 ${idle.length} 人` + (withGeneral.length ? `（其中 ${withGeneral.length} 人写了处理意见）` : ''));
  }
  const scopeCount = Object.values(reviewers).reduce((a, r) => a + Object.keys(r.generals || {}).length, 0);
  if (scopeCount) console.log(`  分档处理意见 ${scopeCount} 条（按 部门 / 时间范围）`);

  const byPerson = {};
  for (const it of items) byPerson[it.reviewer] = (byPerson[it.reviewer] || 0) + 1;

  console.log('\n合并结果：');
  console.log(`  仅线上有  ${fromLive} 条（本地缺，会补上）`);
  console.log(`  仅本地有  ${localOnly} 条（线上没有，发布后会新增）`);
  console.log(`  线上更新  ${liveNewer} 条（同一条两边都改了，取线上）`);
  console.log(`  合计      ${items.length} 条 / ${Object.keys(reviewers).length} 人`);
  console.log(`  按人：    ${JSON.stringify(byPerson)}`);

  if (!items.length) {
    console.log('\n⚠️ 合并后是空的。如果线上本来就没有评分，继续发布没问题；否则请检查地址。');
  }

  if (DRY) {
    console.log('\n（--dry 模式，未写盘）');
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = stamp();
  const liveFile = path.join(BACKUP_DIR, `submissions-live-${ts}.json`);
  const localFile = path.join(BACKUP_DIR, `submissions-local-${ts}.json`);
  fs.writeFileSync(liveFile, JSON.stringify(live, null, 0), 'utf8');
  fs.writeFileSync(localFile, JSON.stringify(local, null, 0), 'utf8');

  fs.writeFileSync(LOCAL, JSON.stringify({ reviewers, items }, null, 0), 'utf8');

  console.log('\n✅ 已写回本地 data/submissions.json');
  console.log(`   备份：${path.relative(PROJECT, liveFile)}（线上原样）`);
  console.log(`         ${path.relative(PROJECT, localFile)}（本地原样）`);
  console.log('\n现在可以发布了。');
})();
