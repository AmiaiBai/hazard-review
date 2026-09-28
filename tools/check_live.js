// 核对线上页面与本地文件是否一致（剔除发布平台注入的埋点脚本后比对）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = process.argv[2] || 'https://da782378ef0146348f92b5c66301a892.sg.agentos-app.run';
const ROOT = path.resolve(__dirname, '..');

// 平台会在 </style> 后注入 beacon 埋点，比对时剔掉
const strip = (s) => s.replace(/<script src="https:\/\/beacon[\s\S]*?<\/script>\s*<script>[\s\S]*?<\/script>\s*/, '');
const hash = (s) => crypto.createHash('md5').update(s).digest('hex').slice(0, 12);

const TARGETS = [
  ['/', 'public/index.html'],
  ['/admin', 'public/admin.html'],
];

// /api/raw 是管理员接口（含全部填写人员真名）—— 先拿令牌。
// 密码优先取环境变量 HR_ADMIN_PW，否则读本地 data/admin.json。
const adminPw = () => {
  if (process.env.HR_ADMIN_PW) return process.env.HR_ADMIN_PW;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'admin.json'), 'utf8')).password || ''; }
  catch (e) { return ''; }
};

(async () => {
  let ok = true;
  const token = await fetch(BASE + '/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: adminPw() }),
  }).then((r) => r.json()).then((j) => j.token || '').catch(() => '');
  const auth = token ? { 'x-admin-token': token } : {};

  for (const [urlPath, file] of TARGETS) {
    const res = await fetch(BASE + urlPath, { cache: 'no-store' });
    const remote = strip(await res.text());
    const local = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const same = remote === local;
    if (!same) ok = false;
    console.log(`${urlPath.padEnd(8)} HTTP ${res.status}  线上 ${hash(remote)} / 本地 ${hash(local)}  ${same ? '✅ 一致' : '⚠️ 有差异'}`);
  }

  const stats = await fetch(BASE + '/api/stats', { headers: auth, cache: 'no-store' }).then((r) => r.json());
  const raw = await fetch(BASE + '/api/raw', { headers: auth, cache: 'no-store' }).then((r) => r.json());
  const by = {};
  for (const it of (raw.items || [])) by[it.reviewer] = (by[it.reviewer] || 0) + 1;
  console.log('\n线上数据：');
  console.log('  评分条数', stats.summary.itemCount, '| 参评工程师', stats.summary.reviewerCount, '| 进度', stats.summary.progress + '%');
  console.log('  按人：', JSON.stringify(by));
  console.log('  维度 cite 说明：', stats.dimensions.find((d) => d.key === 'cite').hint);
  process.exit(ok ? 0 : 1);
})();
