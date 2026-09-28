'use strict';
// 起临时服务拉 /api/stats 落盘，供 test_admin.js 使用。
// 注意：/api/stats 现在对非管理员不下发 deptRows（部门视图是管理员专属），
// 所以这里必须先登录拿 token，否则 fixture 里部门表永远是空的，test_admin.js 会误报失败。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3198;
const ROOT = path.join(__dirname, '..');
const OUT = process.argv[2] || path.join(ROOT, 'data', 'stats-snapshot.json');
const DEFAULT_PASSWORD = require('./_adminpw').adminPassword();   // 见 tools/_adminpw.js

function get(p, headers) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers: headers || {} }, (r) => {
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res(Buffer.concat(c)));
    }).on('error', rej);
  });
}
function post(p, payload) {
  return new Promise((res, rej) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (r) => {
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res(Buffer.concat(c)));
    });
    req.on('error', rej);
    req.end(body);
  });
}
/** 密码取值统一走 tools/_adminpw.js（data/admin.json → HR_ADMIN_PW） */
function readPassword() { return DEFAULT_PASSWORD; }

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  });
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    try { await get('/api/meta'); ok = true; } catch (e) { await new Promise((r) => setTimeout(r, 150)); }
  }
  try {
    // 先以管理员身份登录，拿到能看部门汇总的 token
    let token = '';
    try {
      const r = JSON.parse((await post('/api/admin/login', { password: readPassword() })).toString('utf8'));
      if (r.ok) token = r.token;
    } catch (e) { /* 登录失败就退化成匿名快照，下面会提示 */ }

    const buf = await get('/api/stats', token ? { 'x-admin-token': token } : {});
    fs.writeFileSync(OUT, buf);
    const s = JSON.parse(buf.toString('utf8'));
    console.log('已写入 ' + OUT);
    console.log('  隐患行 ' + s.hazardRows.length + ' / 漏检行 ' + s.noneRows.length +
      ' / 月份行 ' + (s.monthRows || []).length +
      ' / 部门行 ' + (s.deptRows || []).length + (s.deptUnlocked ? '（管理员视图）' : '（匿名视图，部门表为空）') +
      ' / 时间跨度 ' + (s.timeSpan ? s.timeSpan.first + '~' + s.timeSpan.last : '—'));
    if (!s.deptUnlocked) console.log('  ⚠ 没拿到管理员 token，fixture 里没有部门数据');
  } finally {
    child.kill();
  }
})();
