'use strict';
/**
 * 管理员鉴权 + 按部门统计 / 导出的端到端自检。
 *
 * 为什么单独一个测试文件：这是**权限**功能，测试的重点不是「功能能不能用」，
 * 而是「不该看到的人是不是真的看不到」。所以除了正向路径，必须覆盖：
 *   - 无 token / 伪造 token → 必须被拒（403），不能只是前端藏起来
 *   - 非管理员的 /api/stats 里 deptRows 必须是空的（接口一扒就出来的事，不能靠 UI 挡）
 *   - 错误密码必须失败，且不能返回 token
 *
 * 密码从 data/admin.json 读，不写死 —— 老板改过密码后这个测试仍然应该通过。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

/**
 * 极简 zip 读取器 —— 只为了在测试里看 xlsx 里到底有哪些工作表。
 * xlsx 的每个部件都是 deflate 压缩的，直接在字节流里搜字符串是搜不到的（踩过这个坑）。
 */
function zipEntries(buf) {
  const out = new Map();
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;      // 本地文件头签名
    const method = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    if (nlen === 0 || nlen > 512) continue;
    const name = buf.slice(i + 30, i + 30 + nlen).toString('utf8');
    const dataStart = i + 30 + nlen + elen;
    if (dataStart + csize > buf.length) continue;
    const raw = buf.slice(dataStart, dataStart + csize);
    let content = null;
    try { content = method === 0 ? raw : zlib.inflateRawSync(raw); } catch (e) { content = null; }
    if (content && !out.has(name)) out.set(name, content);
    i = dataStart + csize - 1;
  }
  return out;
}

const PORT = 3198;
const ROOT = path.join(__dirname, '..');
const SUBS_FILE = path.join(ROOT, 'data', 'submissions.json');
const ADMIN_FILE = path.join(ROOT, 'data', 'admin.json');
const DEFAULT_PASSWORD = require('./_adminpw').adminPassword();   // 见 tools/_adminpw.js

function call(method, p, body, headers) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, (x) => {
      const c = []; x.on('data', (d) => c.push(d));
      x.on('end', () => {
        const buf = Buffer.concat(c);
        let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch (e) { /* 二进制导出 */ }
        res({ code: x.statusCode, buf, j, ct: x.headers['content-type'] });
      });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}
const get = (p, h) => call('GET', p, null, h);
const post = (p, b, h) => call('POST', p, b, h);

let pass = 0, fail = 0;
const check = (m, c, e) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? '  → ' + e : '')); } };

(async () => {
  // 本测试会写一条处理意见，先备份数据，finally 里无条件还原
  let subsBackup = null;
  try { subsBackup = fs.readFileSync(SUBS_FILE, 'utf8'); } catch (e) { subsBackup = null; }
  // 密码：DEFAULT_PASSWORD 已经是「data/admin.json → HR_ADMIN_PW」的取值结果
  const password = DEFAULT_PASSWORD;
  if (!password) throw new Error('拿不到管理员密码：先跑一次 server.js，或设 HR_ADMIN_PW');

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { await get('/api/meta'); up = true; } catch (e) { await new Promise((r) => setTimeout(r, 150)); }
    }
    check('服务已就绪', up);
    if (!up) throw new Error('服务没起来');

    // ---------------- 1. 非管理员看全量统计 ----------------
    console.log('\n【1】非管理员：全部统计照常可见，部门汇总不下发');
    const st = await get('/api/stats');
    check('/api/stats 无需鉴权即可访问（全员可见）', st.code === 200, 'HTTP ' + st.code);
    check('非管理员 deptUnlocked = false', st.j.deptUnlocked === false, JSON.stringify(st.j.deptUnlocked));
    check('非管理员 deptRows 为空数组（部门数据根本没下发）',
      Array.isArray(st.j.deptRows) && st.j.deptRows.length === 0, '长度 ' + (st.j.deptRows || []).length);
    check('其余统计不受影响：逐条隐患仍在', Array.isArray(st.j.hazardRows) && st.j.hazardRows.length > 0,
      (st.j.hazardRows || []).length + ' 条');
    check('其余统计不受影响：维度表现在', Array.isArray(st.j.dimensionsStat) && st.j.dimensionsStat.length === 4);
    check('其余统计不受影响：评审人表在', Array.isArray(st.j.reviewerRows) && st.j.reviewerRows.length > 0);
    check('其余统计不受影响：漏检复核表在', Array.isArray(st.j.noneRows));

    // ---------------- 2. 无 token 访问管理员接口 ----------------
    console.log('\n【2】无 token：管理员接口必须被拒（不能只靠前端藏）');
    const ds0 = await get('/api/dept-stats');
    check('/api/dept-stats 无 token → 403', ds0.code === 403, 'HTTP ' + ds0.code + ' ' + JSON.stringify(ds0.j));
    const ex0 = await get('/api/export-dept.xlsx');
    check('/api/export-dept.xlsx 无 token → 403', ex0.code === 403, 'HTTP ' + ex0.code + ' ' + JSON.stringify(ex0.j));
    const bad = await get('/api/dept-stats', { 'X-Admin-Token': 'deadbeef' });
    check('伪造 token → 403', bad.code === 403, 'HTTP ' + bad.code);
    const empty = await get('/api/dept-stats', { 'X-Admin-Token': '' });
    check('空 token → 403', empty.code === 403, 'HTTP ' + empty.code);

    // ---------------- 3. 登录 ----------------
    console.log('\n【3】登录');
    const w1 = await post('/api/admin/login', { password: 'definitely-wrong' });
    check('错误密码 → 401', w1.code === 401, 'HTTP ' + w1.code);
    check('错误密码不返回 token', !(w1.j && w1.j.token), JSON.stringify(w1.j));
    const w2 = await post('/api/admin/login', { password: '' });
    check('空密码 → 401', w2.code === 401, 'HTTP ' + w2.code);
    const w3 = await post('/api/admin/login', {});
    check('缺 password 字段 → 401', w3.code === 401, 'HTTP ' + w3.code);

    const login = await post('/api/admin/login', { password });
    check('正确密码 → 200', login.code === 200, 'HTTP ' + login.code);
    const token = login.j && login.j.token;
    check('正确密码返回 token', typeof token === 'string' && token.length >= 32, String(token).slice(0, 12) + '…');

    // ---------------- 4. 带 token 访问 ----------------
    console.log('\n【4】带 token：管理员视图解锁');
    const chk = await get('/api/admin/check', { 'X-Admin-Token': token });
    check('/api/admin/check 带有效 token → ok', chk.code === 200 && chk.j.ok === true, JSON.stringify(chk.j));
    const chkBad = await get('/api/admin/check', { 'X-Admin-Token': 'nope' });
    check('/api/admin/check 带无效 token → ok=false', chkBad.code === 200 && chkBad.j.ok === false, JSON.stringify(chkBad.j));

    const ds1 = await get('/api/dept-stats', { 'X-Admin-Token': token });
    check('/api/dept-stats 带 token → 200', ds1.code === 200, 'HTTP ' + ds1.code);
    check('返回部门汇总行', Array.isArray(ds1.j.deptRows) && ds1.j.deptRows.length > 0,
      (ds1.j.deptRows || []).length + ' 个部门');
    const d0 = (ds1.j.deptRows || [])[0];
    if (d0) {
      check('部门行含部门名 / 隐患数 / 已评 / 进度',
        typeof d0.dept === 'string' && typeof d0.hazards === 'number'
        && typeof d0.reviewed === 'number' && typeof d0.progress === 'number',
        JSON.stringify({ dept: d0.dept, hazards: d0.hazards, reviewed: d0.reviewed, progress: d0.progress }));
      check('部门行含四个维度均分', d0.dimAvg && ['real', 'desc', 'basis', 'cite'].every((k) => k in d0.dimAvg),
        JSON.stringify(d0.dimAvg));
    }
    check('部门汇总与全量统计口径一致（带 token 的 stats 也是这些行）',
      (await get('/api/stats', { 'X-Admin-Token': token })).j.deptRows.length === ds1.j.deptRows.length);

    const stAdmin = await get('/api/stats', { 'X-Admin-Token': token });
    check('带 token 时 /api/stats 的 deptUnlocked = true', stAdmin.j.deptUnlocked === true);
    check('带 token 时 deptRows 非空', stAdmin.j.deptRows.length > 0);

    // ---------------- 5. 导出按部门清单 ----------------
    console.log('\n【5】导出「隐患统计清单」');
    const t0 = Date.now();
    const xl = await get('/api/export-dept.xlsx', { 'X-Admin-Token': token });
    const ms = Date.now() - t0;
    check('带 token 导出 → 200', xl.code === 200, 'HTTP ' + xl.code);
    check('Content-Type 是 xlsx',
      String(xl.ct).includes('spreadsheetml.sheet'), String(xl.ct));
    check('是合法 zip（xlsx 的 PK 头）', xl.buf.slice(0, 2).toString() === 'PK', xl.buf.slice(0, 4).toString('hex'));
    check('体积合理（纯文本清单，应远小于含图的全量导出）', xl.buf.length > 2000 && xl.buf.length < 3 * 1024 * 1024,
      (xl.buf.length / 1024).toFixed(1) + ' KB');
    check('导出耗时可接受（< 3s）', ms < 3000, ms + 'ms');
    const z = zipEntries(xl.buf);
    const wbXml = z.get('xl/workbook.xml') ? z.get('xl/workbook.xml').toString('utf8') : '';
    check('zip 结构完整（有 workbook.xml）', !!wbXml, '共 ' + z.size + ' 个部件');
    check('含「按部门统计」工作表', wbXml.includes('按部门统计'), wbXml.match(/name="[^"]*"/g) || '');
    check('含「按部门隐患明细」工作表', wbXml.includes('按部门隐患明细'));
    check('不含内嵌图片（纯文本清单）',
      ![...z.keys()].some((k) => k.startsWith('xl/media/')), [...z.keys()].filter((k) => k.includes('media')).join(','));
    // 第一张表的内容：表头 + 合计行必须在
    const sh1 = z.get('xl/worksheets/sheet1.xml') ? z.get('xl/worksheets/sheet1.xml').toString('utf8') : '';
    const sst = z.get('xl/sharedStrings.xml') ? z.get('xl/sharedStrings.xml').toString('utf8') : '';
    const allText = sh1 + sst;
    check('表头含「隐患总数 / 进度 / 综合均分」等列',
      allText.includes('隐患总数') && allText.includes('进度') && allText.includes('综合均分'));
    check('有「合计」行', allText.includes('合计'));
    check('四个维度列都在',
      ['隐患真实性', '隐患描述符合性', '法规依据适用性', '依据引用准确性'].every((k) => allText.includes(k)));

    // ---------------- 6. 处理意见按「关键词」分档 ----------------
    console.log('\n【6】搜索批次的处理意见（scope 含「关键词:」）');
    const scope = '关键词:电气';
    const put = await post('/api/submit', { reviewer: '__t_admin__', scope, general: '电气类隐患共若干条，建议统一整改配电箱。' });
    check('提交带 scope 的处理意见 → ok', put.code === 200 && put.j.ok === true, JSON.stringify(put.j).slice(0, 120));
    const mine = await get('/api/my?reviewer=' + encodeURIComponent('__t_admin__'));
    check('读回 generals 里有「关键词:电气」这一档',
      !!(mine.j.generals && mine.j.generals[scope]), JSON.stringify(Object.keys(mine.j.generals || {})));
    check('处理意见内容正确',
      (mine.j.generals || {})[scope] === '电气类隐患共若干条，建议统一整改配电箱。',
      String((mine.j.generals || {})[scope]).slice(0, 40));

    const st2 = await get('/api/stats');
    check('generalNotes 计数照常（这是「有几条整体意见」的计数，不是明细）',
      typeof (st2.j.summary || {}).generalNotes === 'number', typeof (st2.j.summary || {}).generalNotes);

    // scope 的标签映射只在导出里体现（「处理意见」表）—— 去全量导出里验一下。
    // ⚠️ 别按下标猜工作表序号（我第一次就猜错了，处理意见是第 8 张不是第 9 张）——
    // 把全部 sheet + sharedStrings 拼起来搜，最稳。
    const tX = Date.now();
    const full = await get('/api/export.xlsx');
    const zx = zipEntries(full.buf);
    const text9 = [...zx.entries()]
      .filter(([k]) => /^xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml)$/.test(k))
      .map(([, v]) => v.toString('utf8')).join('\n');
    check('全量导出仍可生成（全员可见，未受影响）', full.code === 200, 'HTTP ' + full.code + ' ' + ((Date.now() - tX) + 'ms'));
    check('「处理意见」表把 scope 解析成了「关键词」类型', text9.includes('关键词'), '表内关键词字样：' + (text9.match(/关键词/g) || []).length + ' 处');
    check('标签写成「含「电气」」形式', /含.{0,2}电气/.test(text9),
      (text9.match(/含.{0,4}电气.{0,2}/g) || []).slice(0, 3).join(' / '));
    check('处理意见正文也进了导出表', text9.includes('电气类隐患共若干条'));

    // 清理这条测试意见
    await post('/api/delete', { reviewer: '__t_admin__', all: true });

    // ---------------- 7. 全量导出里的「部门汇总」也要挡 ----------------
    // 这是最容易漏的一处：界面和 /api/stats 都锁了，但全量导出是全员可见的，
    // 里面照旧带一张部门汇总表 —— 下载个 Excel 就看到刚锁上的东西，锁就成了摆设。
    console.log('\n【7】全量导出（全员可见）不得带「部门汇总」表');
    const sheetNames = (buf) => {
      const wb = zipEntries(buf).get('xl/workbook.xml');
      return (wb ? wb.toString('utf8').match(/<sheet[^>]*name="([^"]*)"/g) || [] : [])
        .map((s) => (s.match(/name="([^"]*)"/) || [])[1]);
    };
    const anonXl = await get('/api/export.xlsx');
    const anonSheets = sheetNames(anonXl.buf);
    check('匿名全量导出 → 200（全员可见）', anonXl.code === 200, 'HTTP ' + anonXl.code);
    check('匿名全量导出不含「部门汇总」', !anonSheets.includes('部门汇总'), anonSheets.join(','));
    check('匿名全量导出其余表照常（评分明细 / 漏检复核 / 处理意见都在）',
      ['评分明细', '漏检复核', '处理意见'].every((n) => anonSheets.includes(n)), anonSheets.join(','));

    const admXl = await get('/api/export.xlsx', { 'X-Admin-Token': token });
    const admSheets = sheetNames(admXl.buf);
    check('管理员全量导出 → 200', admXl.code === 200, 'HTTP ' + admXl.code);
    check('管理员全量导出含「部门汇总」', admSheets.includes('部门汇总'), admSheets.join(','));
    check('管理员版比匿名版正好多一张表', admSheets.length === anonSheets.length + 1,
      anonSheets.length + ' vs ' + admSheets.length);
    check('多出来的那张就是「部门汇总」',
      admSheets.filter((n) => !anonSheets.includes(n)).join(',') === '部门汇总',
      admSheets.filter((n) => !anonSheets.includes(n)).join(','));

    // 缓存别串味：两份结果各缓存一份，先来的那个人不能决定后来的人看到什么
    const anonXl2 = await get('/api/export.xlsx');
    check('取过管理员版之后再匿名取，仍不含「部门汇总」',
      !sheetNames(anonXl2.buf).includes('部门汇总'), sheetNames(anonXl2.buf).join(','));
    check('匿名版两次结果一致（走的是同一份缓存）',
      sheetNames(anonXl2.buf).join(',') === anonSheets.join(','),
      sheetNames(anonXl2.buf).join(','));

    // ---------------- 7.2 「所属部门」列同样按管理员身份增删 ----------------
    // 只挡「部门汇总」那张表是不够的：「评审人汇总」「处理意见」两张表里也有「所属部门」列，
    // 一样能把人绕过锁看到部门维度。
    console.log('\n【7.2】「所属部门」列同样按管理员身份增删');
    const exportText = (buf) => [...zipEntries(buf).entries()]
      .filter(([k]) => /^xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml)$/.test(k))
      .map(([, v]) => v.toString('utf8')).join('\n');
    const cnt = (t) => (t.match(/所属部门/g) || []).length;
    const anonTxt = exportText(anonXl.buf);
    const admTxt = exportText(admXl.buf);
    check('匿名全量导出不含「所属部门」列', cnt(anonTxt) === 0, '出现 ' + cnt(anonTxt) + ' 次');
    check('管理员全量导出含「所属部门」列', cnt(admTxt) >= 2, '出现 ' + cnt(admTxt) + ' 次');
    check('管理员版正好多两处「所属部门」（评审人汇总 + 处理意见）',
      cnt(admTxt) - cnt(anonTxt) === 2, cnt(admTxt) + ' - ' + cnt(anonTxt));
    check('匿名版「处理意见」表内容仍完整（只是少一列）',
      anonTxt.includes('意见归属') && anonTxt.includes('意见内容'), '表头缺失');

    // ---------------- 8. 密码文件与数据文件不得能通过网络直接读 ----------------
    // 静态服务只挂 public/ 和 data/images/，但这条太关键了 —— 一旦哪天有人把 DATA_DIR
    // 也挂出去，密码就等于公开了。所以钉一条回归测试，别靠「我记得是这样」。
    console.log('\n【8】敏感文件不可通过 HTTP 读取');
    for (const [label, p] of [
      ['密码文件 /data/admin.json', '/data/admin.json'],
      ['提交数据 /data/submissions.json', '/data/submissions.json'],
      ['隐患数据 /data/hazards.json', '/data/hazards.json'],
      ['服务端源码 /server.js', '/server.js'],
      ['目录穿越 /../server.js', '/../server.js'],
    ]) {
      const r = await get(p);
      check(label + ' → 拒绝访问', r.code === 404 || r.code === 403, 'HTTP ' + r.code);
    }
    const adm = await get('/admin.html');
    check('管理页本身仍可访问（锁在数据接口层，不靠藏页面）', adm.code === 200, 'HTTP ' + adm.code);

    // ---------------- 9. 字段级脱敏：部门 / 检查人 / 评审人姓名 ----------------
    // 只挡「按部门」那张表、只挡「部门汇总」那张 sheet 都不够 ——
    // 统计结果里有十几处埋着这三类字段（hazardRows / reviewerRows / agreement.pairs /
    // monthRows / freqRows / quality.none …），**漏一处就等于没锁**。
    console.log('\n【9】非管理员的字段级脱敏');
    const anonSt = (await get('/api/stats')).j;
    const admSt = (await get('/api/stats', { 'X-Admin-Token': token })).j;
    const names = admSt.reviewerRows.map((r) => r.reviewer);
    const depts = [...new Set(admSt.hazardRows.map((h) => h.dept).filter(Boolean))];
    const insps = [...new Set(admSt.hazardRows.map((h) => h.inspector).filter(Boolean))];
    check('管理员视图确实有真名可对照（否则下面的断言是空转）',
      names.length > 0 && depts.length > 0 && insps.length > 0,
      names.length + ' 人 / ' + depts.length + ' 部门 / ' + insps.length + ' 检查人');
    const leak = [...names, ...depts, ...insps].filter((n) => JSON.stringify(anonSt).includes(n));
    check('匿名 stats 里没有任何真名 / 部门 / 检查人残留', leak.length === 0, leak.join(', '));
    check('匿名 reviewerRows 是代号', anonSt.reviewerRows.every((r) => /^评审人\d+$/.test(r.reviewer)),
      anonSt.reviewerRows.map((r) => r.reviewer).join(','));
    check('匿名 hazardRows 的部门 / 检查人为空',
      anonSt.hazardRows.every((h) => !h.dept && !h.inspector));
    check('匿名 monthRows 的覆盖部门为空', anonSt.monthRows.every((m) => (m.depts || []).length === 0));
    check('匿名 agreement.reviewers 是代号',
      (anonSt.agreement.reviewers || []).every((r) => /^评审人\d+$/.test(r)),
      JSON.stringify(anonSt.agreement.reviewers));
    check('匿名 agreement.pairs 的 a/b 也是代号',
      (anonSt.agreement.pairs || []).every((p) => /^评审人\d+$/.test(p.a) && /^评审人\d+$/.test(p.b)));
    check('匿名 quality 明细的部门字段被抹掉',
      (anonSt.quality.items || []).every((it) => !it.p) && (anonSt.quality.none || []).every((it) => !it.p));
    check('匿名 freqRows 的部门 / 检查人为空', anonSt.freqRows.every((f) => !f.dept && !f.inspector));
    check('匿名 criticalStat.wrongRows 的部门为空',
      (anonSt.criticalStat.wrongRows || []).every((w) => !w.dept));
    // 以下几条是「字段名不叫 dept / reviewer」或「埋在数组里」的位置，
    // 递归脱敏虽然也能兜住，但它们是历史上真漏过的几处，值得逐条钉住。
    check('匿名 noneRows 的部门 / 检查人为空',
      (anonSt.noneRows || []).every((n) => !n.dept && !n.inspector),
      JSON.stringify((anonSt.noneRows || [])[0] || {}).slice(0, 120));
    check('匿名 noneRows 的评审人也换成代号',
      (anonSt.noneRows || []).every((n) => (n.reviewers || []).every((r) => /^评审人\d+$/.test(r))),
      JSON.stringify((anonSt.noneRows || [])[0] && (anonSt.noneRows || [])[0].reviewers));
    check('匿名 hazardRows 的评审人也换成代号',
      anonSt.hazardRows.every((h) => (h.reviewers || []).every((r) => /^评审人\d+$/.test(r))));
    check('匿名 reviewerDaily 的评审人是代号',
      (anonSt.reviewerDaily || []).every((d) => /^评审人\d+$/.test(d.reviewer)),
      JSON.stringify((anonSt.reviewerDaily || []).slice(0, 3)));
    check('匿名 agreement.spreads 的部门为空',
      (anonSt.agreement.spreads || []).every((s) => !s.dept));
    check('匿名 agreement.spreads 里每个评审人也是代号',
      (anonSt.agreement.spreads || []).every((s) => (s.reviewers || []).every((x) => /^评审人\d+$/.test(x.reviewer))));
    check('匿名 reviewerRows 的部门为空', anonSt.reviewerRows.every((r) => !r.dept));
    check('匿名 deptRows 直接是空数组（部门汇总整块不给）',
      Array.isArray(anonSt.deptRows) && anonSt.deptRows.length === 0,
      JSON.stringify(anonSt.deptRows).slice(0, 80));
    check('匿名 deptUnlocked 是 false（前端不会误以为已解锁）', anonSt.deptUnlocked === false, String(anonSt.deptUnlocked));
    // 管理员版必须原样保留：脱敏别把管理员的视图也一起削了
    check('管理员 stats 的 deptRows 非空', (admSt.deptRows || []).length > 0, (admSt.deptRows || []).length);
    check('管理员 stats 的 deptUnlocked 是 true', admSt.deptUnlocked === true, String(admSt.deptUnlocked));
    check('管理员 stats 的 reviewerRows 是真名', admSt.reviewerRows.some((r) => names.includes(r.reviewer)));

    const anonMeta2 = (await get('/api/meta')).j;
    check('匿名 meta 的检查人 / 填写人员 / 部门清单都为空',
      anonMeta2.inspectors.length === 0 && anonMeta2.reviewers.length === 0 && anonMeta2.meta.depts.length === 0,
      anonMeta2.inspectors.length + ' / ' + anonMeta2.reviewers.length + ' / ' + anonMeta2.meta.depts.length);
    const anonHz = (await get('/api/hazards')).j;
    check('匿名 hazards 不含部门 / 检查人', anonHz.records.every((r) => !r.dept && !r.inspector));
    check('匿名 hazards 的 meta.batches 里也没有部门',
      (anonHz.meta.batches || []).every((b) => (b.depts || []).length === 0));

    check('匿名读 /api/raw → 403（含全部填写人员真名）', (await get('/api/raw')).code === 403);
    check('管理员读 /api/raw → 200', (await get('/api/raw', { 'X-Admin-Token': token })).code === 200);

    // 代号必须全局一致：同一个人在页面和 Excel 里得是同一个代号，否则对不上账
    const xlAnonText = exportText((await get('/api/export.xlsx')).buf);
    const pageAliases = new Set(anonSt.reviewerRows.map((r) => r.reviewer));
    const xlAliases = new Set(xlAnonText.match(/评审人\d+/g) || []);
    check('导出里的评审人代号与页面一致',
      xlAliases.size > 0 && [...xlAliases].every((a) => pageAliases.has(a)),
      [...xlAliases].join(',') + ' vs ' + [...pageAliases].join(','));
    check('匿名导出里没有评审人真名', !names.some((n) => xlAnonText.includes(n)), names.join(', '));

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  } catch (e) {
    console.error('\n测试异常：', e && e.stack || e);
    fail++;
  } finally {
    child.kill();
    // 无条件还原数据，别把测试数据留在正式库里
    if (subsBackup !== null) { try { fs.writeFileSync(SUBS_FILE, subsBackup); console.log('（已还原 data/submissions.json）'); } catch (e) { /* ignore */ } }
  }
  process.exit(fail ? 1 : 0);
})();
