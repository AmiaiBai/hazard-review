// 手机端「管理员模式」冒烟：部门 / 检查人 / 填写人员三类信息只对管理员可见
//
// 为什么单独一个文件：这条链路跨越「服务端按身份下发 → 前端按身份显隐 → 重拉数据」三段，
// 和 test_ui.js（交互）/ test_admin_auth.js（服务端脱敏）的关注点都不同，
// 混进任何一边都会让那个文件变得难读。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');   // 别写死绝对路径，换台机器就找不到
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const hzData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'hazards.json'), 'utf8'));

const DIMS = [
  { key: 'real', label: '隐患真实性', hint: 'a', low: 'x', high: 'y' },
  { key: 'desc', label: '隐患描述符合性', hint: 'b', low: 'x', high: 'y' },
  { key: 'basis', label: '法规依据适用性', hint: 'c', low: 'x', high: 'y' },
  { key: 'cite', label: '依据引用准确性', hint: 'd', low: 'x', high: 'y' },
];

const TOKEN = 'TEST-TOKEN-UI';
const PW = require('./_adminpw').adminPassword();   // 别再硬编码密码，见 tools/_adminpw.js

const withHz = hzData.records.filter((r) => r.hazards.length).slice(0, 4);
const INSPECTORS = [...new Set(withHz.map((r) => r.inspector).filter(Boolean))];
const DEPTS = [...new Set(withHz.map((r) => r.dept).filter(Boolean))];
const REVIEWERS = [{ name: '历史填写人甲', dept: '乙车间', at: '2026-09-20T10:00:00' },
  { name: '历史填写人乙', dept: '巴城', at: '2026-09-21T10:00:00' }];

const slim = (r) => ({
  id: r.id, dept: r.dept, inspector: r.inspector, device: r.device, time: r.time, image: r.image,
  hazards: r.hazards.map((h) => ({
    no: h.no, name: h.name, desc: h.desc, advice: h.advice, std: h.std,
    basis: h.basis.slice(0, 56), more: h.basis.length > 56,
  })),
});
const fullRecords = withHz.map(slim);
// 服务端对非管理员就是这样下发的：部门 / 检查人字段直接抹空（不是前端藏）
const anonRecords = fullRecords.map((r) => Object.assign({}, r, { dept: '', inspector: '' }));

const SAMPLE_DEPT = DEPTS[0];
const SAMPLE_INSP = INSPECTORS[0];

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 有状态的 fetch 桩：令牌决定服务端下发完整版还是脱敏版。
 * 这是这个测试的关键 —— 断言必须打在「服务端返回什么」之上，
 * 而不是「前端有没有把字符串藏起来」（那种写法换个页面就失效了）。
 */
function makeFetch(state) {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    const u = String(url);
    const headers = (opt && opt.headers) || {};
    const tok = headers['x-admin-token'] || '';
    calls.push({ url: u, token: tok });
    const admin = !!state.token && tok === state.token;

    if (u.includes('/api/admin/login')) {
      const body = JSON.parse((opt && opt.body) || '{}');
      if (body.password === PW) { state.token = TOKEN; return { ok: true, json: async () => ({ ok: true, token: TOKEN }) }; }
      return { ok: true, json: async () => ({ ok: false, error: '管理员密码不对' }) };
    }
    if (u.includes('/api/admin/logout')) {
      state.logoutCalls++;
      state.token = '';
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (u.includes('/api/meta')) {
      return { ok: true, json: async () => ({
        meta: admin ? hzData.meta : Object.assign({}, hzData.meta, { depts: [] }),
        dimensions: DIMS, initScore: 90, admin,
        inspectors: admin ? INSPECTORS : [],
        reviewers: admin ? REVIEWERS : [],
      }) };
    }
    if (u.includes('/api/hazards')) {
      return { ok: true, json: async () => ({ meta: hzData.meta, records: admin ? fullRecords : anonRecords }) };
    }
    if (u.includes('/api/my')) return { ok: true, json: async () => ({ items: [], general: '', generals: {} }) };
    return { ok: true, json: async () => ({}) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function boot(state, presetToken) {
  const fetchMock = makeFetch(state);
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = fetchMock;
      if (presetToken) { try { w.sessionStorage.setItem('hr_admin_token', presetToken); } catch (e) { /* ignore */ } }
      w.addEventListener('error', (e) => errors.push(e.message || String(e.error)));
      w.onerror = (m) => errors.push(String(m));
      w.onunhandledrejection = (e) => errors.push('unhandled: ' + e.reason);
    },
  });
  await wait(400);
  const { window } = dom;
  const doc = window.document;
  const $ = (id) => doc.getElementById(id);
  return { window, doc, $, errors, calls: fetchMock.calls, close: () => window.close() };
}

(async () => {
  const state = { token: '', logoutCalls: 0 };
  const { window, doc, $, errors, calls } = await boot(state);
  const tok = () => { try { return window.sessionStorage.getItem('hr_admin_token') || ''; } catch (e) { return ''; } };
  const on = () => doc.body.classList.contains('admin');
  // 卡片上的部门 / 检查人标签
  const adminNodes = () => [...$('card').querySelectorAll('.adminonly')];
  const shown = (el) => window.getComputedStyle(el).display !== 'none';
  const cardTxt = () => $('card').textContent;

  console.log('\n【1】未解锁：部门 / 检查人 / 填写人员都拿不到');
  check('顶部解锁按钮显示「🔒 管理员」', /🔒\s*管理员/.test($('btnLock').textContent), $('btnLock').textContent);
  check('body 上没有 admin class', !on());
  check('解锁面板默认收起', !$('lockbox').classList.contains('show'));
  check('卡片上有部门 / 检查人两个 adminonly 节点（不是干脆不渲染）',
    adminNodes().length >= 2, adminNodes().length);
  check('未解锁时它们在样式上都不显示',
    adminNodes().every((el) => !shown(el)),
    adminNodes().map((el) => window.getComputedStyle(el).display).join(','));
  check('未解锁时卡片正文里没有部门名', !DEPTS.some((d) => cardTxt().includes(d)), cardTxt().slice(0, 200));
  check('未解锁时卡片正文里没有检查人姓名', !INSPECTORS.some((n) => cardTxt().includes(n)), cardTxt().slice(0, 200));
  check('未解锁时 /api/meta、/api/hazards 都不带令牌',
    calls.filter((c) => !c.url.includes('/api/admin/')).every((c) => !c.token),
    JSON.stringify(calls.map((c) => c.url + ':' + c.token)));
  // 登录页的姓名补全：非管理员不该看到「一共有谁在用」
  check('未解锁时姓名补全是空的（看不到全部填写人员）',
    $('nameList').children.length === 0, $('nameList').children.length);
  check('未解锁时姓名输入框仍然可用（自己填自己的名字）', !$('gName').disabled);

  console.log('\n【2】打开解锁面板');
  $('btnLock').click();
  await wait(60);
  check('点顶部按钮后解锁面板打开', $('lockbox').classList.contains('show'));
  $('btnLock').click();
  await wait(60);
  check('再点一次收起', !$('lockbox').classList.contains('show'));

  console.log('\n【3】空密码 / 错密码');
  $('btnLock').click();
  await wait(60);
  $('lockGo').click();
  await wait(60);
  check('空密码给出提示', $('lockErr').hidden === false && /请输入管理员密码/.test($('lockErr').textContent),
    $('lockErr').textContent);
  check('空密码不写令牌', tok() === '', tok());
  $('lockPw').value = 'nope';
  $('lockGo').click();
  await wait(150);
  check('错密码显示服务端返回的提示', /密码不对/.test($('lockErr').textContent), $('lockErr').textContent);
  check('错密码不写令牌', tok() === '', tok());
  check('错密码后面板仍然开着（可以重试）', $('lockbox').classList.contains('show'));
  check('错密码后清空输入框', $('lockPw').value === '', $('lockPw').value);

  console.log('\n【4】正确密码：解锁');
  // 先记下当前这张卡，解锁后要停在原地（重拉数据不能把人甩回第一张）
  const beforeRid = ($('card').querySelector('.recid') || {}).textContent || '';
  $('lockPw').value = PW;
  $('lockGo').click();
  await wait(300);
  check('写入令牌', tok() === TOKEN, tok());
  check('body 挂上 admin class', on());
  check('顶部按钮变成「🔓 已解锁」', /已解锁/.test($('btnLock').textContent), $('btnLock').textContent);
  check('解锁面板自动收起', !$('lockbox').classList.contains('show'));
  check('解锁后重拉数据带上令牌',
    calls.some((c) => c.url.includes('/api/hazards') && c.token === TOKEN),
    JSON.stringify(calls.filter((c) => c.url.includes('/api/hazards')).map((c) => c.token)));
  check('解锁后卡片上的部门 / 检查人节点显示出来',
    adminNodes().length >= 2 && adminNodes().every(shown),
    adminNodes().map((el) => window.getComputedStyle(el).display).join(','));
  check('解锁后卡片上能看到部门名', DEPTS.some((d) => cardTxt().includes(d)), cardTxt().slice(0, 200));
  check('解锁后卡片上能看到检查人姓名', INSPECTORS.some((n) => cardTxt().includes(n)), cardTxt().slice(0, 200));
  check('解锁后姓名补全列出全部填写人员',
    $('nameList').children.length === INSPECTORS.length + REVIEWERS.length,
    $('nameList').children.length + ' vs ' + (INSPECTORS.length + REVIEWERS.length));
  check('解锁后停在原来那张卡（不把人甩回第一张）',
    (($('card').querySelector('.recid') || {}).textContent || '') === beforeRid,
    beforeRid + ' → ' + (($('card').querySelector('.recid') || {}).textContent || ''));
  check('解锁后给出提示', /已进入管理员模式/.test($('toast').textContent), $('toast').textContent);
  check('解锁后清空密码框（不把明文留在页面上）', $('lockPw').value === '', $('lockPw').value);

  console.log('\n【5】退出管理员');
  $('btnLock').click();
  await wait(300);
  check('通知服务端作废令牌', state.logoutCalls > 0, state.logoutCalls);
  check('清掉本地令牌', tok() === '', tok());
  check('body 摘掉 admin class', !on());
  check('顶部按钮回到「🔒 管理员」', /🔒\s*管理员/.test($('btnLock').textContent), $('btnLock').textContent);
  check('卡片上的部门 / 检查人又藏起来', adminNodes().every((el) => !shown(el)));
  check('卡片上不再出现部门名', !DEPTS.some((d) => cardTxt().includes(d)), cardTxt().slice(0, 200));
  check('姓名补全重新清空', $('nameList').children.length === 0, $('nameList').children.length);
  check('给出退出提示', /已退出管理员模式/.test($('toast').textContent), $('toast').textContent);

  console.log('\n【6】死令牌（服务重启过）自动回到上锁');
  const stale = await boot({ token: '', logoutCalls: 0 }, 'STALE-TOKEN');
  check('带着死令牌访问 → 自动清除本地令牌',
    !stale.window.sessionStorage.getItem('hr_admin_token'),
    String(stale.window.sessionStorage.getItem('hr_admin_token')));
  check('带着死令牌访问 → body 不带 admin class', !stale.doc.body.classList.contains('admin'));
  check('带着死令牌访问 → 按钮仍是「🔒 管理员」', /🔒\s*管理员/.test(stale.$('btnLock').textContent),
    stale.$('btnLock').textContent);
  check('带着死令牌访问 → 卡片上部门仍藏住',
    [...stale.$('card').querySelectorAll('.adminonly')].every(
      (el) => stale.window.getComputedStyle(el).display === 'none'));
  stale.close();

  check('无 JS 运行时错误', errors.length === 0, errors.join(' | '));
  window.close();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
