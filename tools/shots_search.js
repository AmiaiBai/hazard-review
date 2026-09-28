'use strict';
// 用真实 Chromium 截「手机端去掉部门筛选 + 新增隐患搜索」这条链路的图，肉眼核验。
// 为什么单独一个脚本：shots.js 是全量截图（上万像素、跑很久），改一处交互时太重。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');
const { adminPassword } = require('./_adminpw');   // 别再硬编码密码，见 tools/_adminpw.js

const PORT = 3193;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(path.resolve(ROOT, '..'), 'outputs', 'hazard-review-shots');
// 环境里装的是 chromium-1234，playwright-core 期望的版本号不一致 → 直接指到已装的可执行文件
const CHROME = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const launchOpts = fs.existsSync(CHROME) ? { executablePath: CHROME } : {};
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    const a = []; r.on('data', (d) => a.push(d)); r.on('end', () => res(Buffer.concat(a)));
  }).on('error', rej);
});

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }), cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { await get('/api/meta'); up = true; } catch (e) { await new Promise((r) => setTimeout(r, 150)); } }
    if (!up) throw new Error('服务没起来');

    browser = await chromium.launch(launchOpts);
    const base = `http://127.0.0.1:${PORT}`;
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await mob.newPage();
    p.on('pageerror', (e) => console.log('  [pageerror] ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error] ' + m.text()); });

    await p.goto(base + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(500);
    // 引导页：应该只剩姓名一个输入项，没有部门按钮
    await p.screenshot({ path: path.join(OUT, 'mob-gate-no-dept.png') });
    const gateText = await p.locator('#gate').innerText();
    console.log('  引导页文案含「部门」：', /部门/.test(gateText));

    await p.fill('#gName', '截图测试');
    await p.click('#gGo');
    await p.waitForTimeout(700);
    await p.screenshot({ path: path.join(OUT, 'mob-card-hintbar.png') });
    await p.locator('.hintbar').screenshot({ path: path.join(OUT, 'mob-hintbar.png') });

    // 筛选面板：不应再有部门栏
    await p.click('#btnFilter');
    await p.waitForTimeout(450);
    await p.screenshot({ path: path.join(OUT, 'mob-filter-no-dept.png') });
    const fText = await p.locator('#filters').innerText();
    console.log('  筛选面板含「部门」：', /部门/.test(fText));
    await p.click('#fClose');
    await p.waitForTimeout(350);

    // 搜索面板
    await p.click('#btnSearch');
    await p.waitForTimeout(450);
    await p.screenshot({ path: path.join(OUT, 'mob-search-panel.png') });
    await p.fill('#sKey', '电气');
    await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(OUT, 'mob-search-panel-kw.png') });
    console.log('  搜索预告：', (await p.locator('#sHint').innerText()).replace(/\s+/g, ' '));

    await p.click('#sGo');
    await p.waitForTimeout(600);
    await p.screenshot({ path: path.join(OUT, 'mob-search-result.png') });
    await p.locator('.progwrap').screenshot({ path: path.join(OUT, 'mob-search-note.png') });
    console.log('  搜索提示条：', (await p.locator('#pSearch').innerText()).replace(/\s+/g, ' '));
    console.log('  筛选标签：', await p.locator('#filterLabel').innerText());
    console.log('  命中条数：', await p.locator('#pAll').innerText());

    // 时段总览：应标注「含「电气」」并提供统一处理意见
    await p.click('#btnOverview');
    await p.waitForTimeout(500);
    await p.locator('.ovhead').screenshot({ path: path.join(OUT, 'mob-search-overview-head.png') });
    console.log('  总览范围标注：', await p.locator('.ovscope').innerText());
    await p.locator('[data-act="general"]').click();
    await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(OUT, 'mob-search-general.png') });
    console.log('  处理意见范围：', await p.locator('#gScopeLabel').innerText());

    // ---- 手机端「管理员模式」：部门 / 检查人 / 填写人员只对管理员可见 ----
    // 单独开一个干净的 context：上面那条链路已经在搜索态、面板开着，混在一起看不出显隐
    const mob2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const q = await mob2.newPage();
    q.on('pageerror', (e) => console.log('  [mob-admin pageerror] ' + e.message));
    await q.goto(base + '/', { waitUntil: 'networkidle' });
    await q.waitForTimeout(600);
    await q.screenshot({ path: path.join(OUT, 'mob-admin-gate-locked.png') });
    console.log('  未解锁时姓名补全项数：', await q.locator('#nameList option').count());
    await q.fill('#gName', '截图测试');
    await q.click('#gGo');
    await q.waitForTimeout(700);
    await q.locator('.hintbar').screenshot({ path: path.join(OUT, 'mob-admin-hintbar-locked.png') });
    const cm = q.locator('.cmeta');
    await cm.screenshot({ path: path.join(OUT, 'mob-admin-cardmeta-locked.png') });
    const metaHidden = await q.locator('.cmeta .adminonly').first()
      .evaluate((el) => getComputedStyle(el).display);
    console.log('  未解锁时卡片元信息：', (await cm.innerText()).replace(/\s+/g, ' '), '| .adminonly display =', metaHidden);

    await q.click('#btnLock');
    await q.waitForTimeout(400);
    await q.screenshot({ path: path.join(OUT, 'mob-admin-lockbox.png') });
    console.log('  解锁面板可见：', await q.locator('#lockbox').isVisible());
    await q.fill('#lockPw', 'wrong-one');
    await q.click('#lockGo');
    await q.waitForTimeout(700);
    await q.locator('#lockbox').screenshot({ path: path.join(OUT, 'mob-admin-wrongpw.png') });
    console.log('  错密码提示：', await q.locator('#lockErr').innerText());

    await q.fill('#lockPw', adminPassword());
    await q.click('#lockGo');
    await q.waitForTimeout(1200);
    await q.locator('.hintbar').screenshot({ path: path.join(OUT, 'mob-admin-hintbar-unlocked.png') });
    await cm.screenshot({ path: path.join(OUT, 'mob-admin-cardmeta-unlocked.png') });
    console.log('  解锁后卡片元信息：', (await cm.innerText()).replace(/\s+/g, ' '));
    console.log('  解锁后 body.admin：', await q.evaluate(() => document.body.classList.contains('admin')));
    // 姓名补全只在「引导页」出现；上面已经进过引导页（S.reviewer 有值），所以不会自动重开。
    // 想看解锁后到底列出哪些名字，就把引导页手动调出来一次 —— 这正是新用户看到的那一屏。
    await q.evaluate(() => window.showGate());
    await q.waitForTimeout(300);
    await q.locator('#gate').screenshot({ path: path.join(OUT, 'mob-admin-gate-unlocked.png') });
    console.log('  解锁后引导页姓名补全项数：', await q.locator('#nameList option').count());
    console.log('  解锁后补全候选：', (await q.locator('#nameList option').evaluateAll(
      (els) => els.map((e) => e.value).join('、'))) || '（空）');
    await q.evaluate(() => { document.getElementById('gate').style.display = 'none'; });
    await q.waitForTimeout(200);
    await q.screenshot({ path: path.join(OUT, 'mob-admin-unlocked.png') });

    // 退出：卡片上的部门 / 检查人必须立刻消失（不是要刷新页面才生效）
    await q.click('#btnLock');
    await q.waitForTimeout(1000);
    console.log('  退出后卡片元信息：', (await cm.innerText()).replace(/\s+/g, ' '));
    await q.evaluate(() => window.showGate());
    await q.waitForTimeout(300);
    console.log('  退出后引导页姓名补全项数：', await q.locator('#nameList option').count());
    await q.evaluate(() => { document.getElementById('gate').style.display = 'none'; });
    await q.waitForTimeout(200);
    await q.screenshot({ path: path.join(OUT, 'mob-admin-relocked.png') });
    await mob2.close();

    await mob.close();

    // ---- 管理页：顶部管理员解锁条统一控制「部门 / 检查人 / 评审人」三类信息 ----
    const pc = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const a = await pc.newPage();
    a.on('pageerror', (e) => console.log('  [admin pageerror] ' + e.message));
    a.on('console', (m) => { if (m.type() === 'error') console.log('  [admin console.error] ' + m.text()); });
    await a.goto(base + '/admin', { waitUntil: 'networkidle' });
    await a.waitForTimeout(900);

    // 未解锁：顶部按钮是「🔒 管理员」，被锁的筛选器整块不显示
    await a.screenshot({ path: path.join(OUT, 'admin-locked-full.png') });
    console.log('  未解锁时顶部按钮：', (await a.locator('#adminBtn').innerText()).replace(/\s+/g, ' '));
    console.log('  未解锁时 body.admin：', await a.evaluate(() => document.body.classList.contains('admin')));
    const lockedFilters = {};
    for (const [name, id] of [['频率图·部门', '#fqDept'], ['频率图·检查人', '#fqInspector'],
      ['逐条隐患·部门', '#hzDept'], ['逐条隐患·检查人', '#hzInspector'],
      ['漏检复核·部门', '#nDept'], ['漏检复核·检查人', '#nInspector']]) {
      lockedFilters[name] = await a.locator(id).evaluate((el) => getComputedStyle(el).display);
    }
    console.log('  未解锁时被锁筛选器 display：', JSON.stringify(lockedFilters));

    // 表格里的「部门 / 检查人」列：整列隐藏（看计算样式，不能只看 class 在不在）
    const colState = async (sel) => a.locator(sel).first().evaluate((el) => getComputedStyle(el).display).catch(() => 'n/a');
    console.log('  未解锁时逐条隐患表「部门」列：', await colState('#tHz thead th.col-dept'));
    console.log('  未解锁时逐条隐患表「检查人」列：', await colState('#tHz thead th.col-insp'));
    console.log('  未解锁时漏检复核表「部门」列：', await colState('#tNone thead th.col-dept'));
    console.log('  未解锁时按时间汇总表「覆盖部门」列：', await colState('#tMonth thead th.col-dept'));
    console.log('  未解锁时分歧表「部门」列：', await colState('#tSpread thead th.col-dept'));
    console.log('  未解锁时依据诊断复核表「部门」列：', await colState('#basisLow thead th.col-dept'));
    await a.locator('#tHz').scrollIntoViewIfNeeded();
    await a.waitForTimeout(250);
    await a.locator('#cardHz').screenshot({ path: path.join(OUT, 'admin-hz-locked.png') });

    // 打开解锁条 → 错密码
    await a.click('#adminBtn');
    await a.waitForTimeout(400);
    await a.locator('#adminBar').screenshot({ path: path.join(OUT, 'admin-bar-open.png') });
    await a.fill('#adminPw', 'wrong-one');
    await a.click('#adminGo');
    await a.waitForTimeout(700);
    await a.locator('#adminBar').screenshot({ path: path.join(OUT, 'admin-bar-wrongpw.png') });
    console.log('  错密码提示：', await a.locator('#adminErr').innerText());

    // 正确密码 → 解锁
    await a.fill('#adminPw', adminPassword());
    await a.click('#adminGo');
    await a.waitForTimeout(1500);
    await a.screenshot({ path: path.join(OUT, 'admin-unlocked-full.png') });
    console.log('  解锁后顶部按钮：', (await a.locator('#adminBtn').innerText()).replace(/\s+/g, ' '));
    console.log('  解锁后 body.admin：', await a.evaluate(() => document.body.classList.contains('admin')));
    const unlockedFilters = {};
    for (const [name, id] of [['频率图·部门', '#fqDept'], ['频率图·检查人', '#fqInspector'],
      ['逐条隐患·部门', '#hzDept'], ['逐条隐患·检查人', '#hzInspector'],
      ['漏检复核·部门', '#nDept'], ['漏检复核·检查人', '#nInspector']]) {
      unlockedFilters[name] = await a.locator(id).evaluate((el) => getComputedStyle(el).display);
    }
    console.log('  解锁后被锁筛选器 display：', JSON.stringify(unlockedFilters));
    console.log('  解锁后逐条隐患表「部门」列：', await colState('#tHz thead th.col-dept'));
    console.log('  解锁后逐条隐患表「检查人」列：', await colState('#tHz thead th.col-insp'));
    console.log('  解锁后分歧表「部门」列：', await colState('#tSpread thead th.col-dept'));
    await a.locator('#tHz').scrollIntoViewIfNeeded();
    await a.waitForTimeout(300);
    await a.locator('#cardHz').screenshot({ path: path.join(OUT, 'admin-hz-unlocked.png') });
    console.log('  解锁后部门行数：', await a.locator('#tDept tbody tr').count());
    console.log('  解锁后提示：', await a.locator('#deptUnlockNote').innerText());

    // 表头与数据列数必须一致：锁列最容易出的 bug 就是表头藏了、正文没藏（或反过来）
    for (const [name, tid] of [['逐条隐患', '#tHz'], ['漏检复核', '#tNone'], ['按时间汇总', '#tMonth'], ['分歧隐患', '#tSpread']]) {
      const th = await a.locator(tid + ' thead tr').first().locator('th').count();
      const td = await a.locator(tid + ' tbody tr').first().locator('td').count().catch(() => -1);
      console.log(`  ${name}表 列数：表头 ${th} / 数据 ${td}`, th === td ? '（对齐）' : '（不一致！）');
    }

    // 按时间汇总：按月 / 按周同卡片内切换
    await a.locator('#cardMonth').scrollIntoViewIfNeeded();
    await a.waitForTimeout(300);
    const monthHead = async () => (await a.locator('#tMonth thead').innerText()).replace(/\s+/g, ' ');
    await a.locator('#cardMonth').screenshot({ path: path.join(OUT, 'admin-month-by-month.png') });
    console.log('  按月表头：', await monthHead(), '| 行数', await a.locator('#tMonth tbody tr').count());
    await a.click('#mByWeek');
    await a.waitForTimeout(400);
    await a.locator('#cardMonth').screenshot({ path: path.join(OUT, 'admin-month-by-week.png') });
    console.log('  按周表头：', await monthHead(), '| 行数', await a.locator('#tMonth tbody tr').count());
    console.log('  按周说明：', (await a.locator('#monthCap').innerText()).replace(/\s+/g, ' '));
    await a.click('#mByMonth');
    await a.waitForTimeout(300);
    console.log('  切回按月表头：', await monthHead());

    // 依据对标诊断：需人工复核条目要分页（流式排下来会拖出一条几千像素的长表）
    await a.locator('#basisLow').scrollIntoViewIfNeeded();
    await a.waitForTimeout(400);
    await a.locator('#basisLow').screenshot({ path: path.join(OUT, 'admin-basis-pager.png') });
    const basisRows = () => a.locator('#basisLow table tbody tr').count();
    console.log('  依据诊断 说明：', (await a.locator('#basisLow .cap').first().innerText()).replace(/\s+/g, ' '));
    console.log('  依据诊断 第 1 页行数：', await basisRows());
    console.log('  依据诊断 分页控件：', (await a.locator('#basisPager').innerText()).replace(/\s+/g, ' '));
    const p2 = a.locator('#basisPager button[data-page="2"]');
    if (await p2.count()) {
      await p2.click();
      await a.waitForTimeout(400);
      await a.locator('#basisLow').screenshot({ path: path.join(OUT, 'admin-basis-pager2.png') });
      console.log('  依据诊断 第 2 页行数：', await basisRows());
      console.log('  依据诊断 第 2 页控件：', (await a.locator('#basisPager').innerText()).replace(/\s+/g, ' '));
    } else {
      console.log('  依据诊断 只有一页（数据不足 20 条），跳过翻页核验');
    }

    // 评价人一致性：多人时「各评审人综合分」竖向排列
    await a.locator('#tSpread').scrollIntoViewIfNeeded();
    await a.waitForTimeout(300);
    const spread = a.locator('#tSpread .spreadrev').first();
    if (await spread.count()) {
      await a.locator('#cardAgree').screenshot({ path: path.join(OUT, 'admin-agree-spread.png') });
      console.log('  各评审人综合分 flex-direction：',
        await spread.evaluate((el) => getComputedStyle(el).flexDirection),
        '| 每人一行：', await spread.locator('> div').count());
    } else {
      console.log('  当前数据没有 2 人以上评过的隐患，跳过竖向布局核验');
    }

    // 导出：拦下响应看是不是 200 + xlsx，顺便确认请求头带了令牌
    const dl = a.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    const [resp] = await Promise.all([
      a.waitForResponse((r) => r.url().includes('/api/export-dept.xlsx'), { timeout: 8000 }),
      a.click('#deptExport'),
    ]);
    console.log('  导出响应：', resp.status(), resp.headers()['content-type'] || '');
    const file = await dl;
    console.log('  下载文件名：', file ? file.suggestedFilename() : '（未触发下载事件）');
    await a.screenshot({ path: path.join(OUT, 'admin-dept-export-toast.png') });

    // 顶部「导出 Excel」：解锁后必须带令牌，拿到的应是含「部门汇总」的版本（比匿名版大）。
    // 之前是 <a href> 裸链接，带不了令牌 —— 管理员点下去还是匿名版。
    const fullDl = a.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    const [fresp] = await Promise.all([
      a.waitForResponse((r) => /\/api\/export\.xlsx/.test(r.url()), { timeout: 8000 }),
      a.click('#expXlsx'),
    ]);
    const fullFile = await fullDl;
    console.log('  全量导出响应：', fresp.status(), '文件名：', fullFile ? fullFile.suggestedFilename() : '（未触发）');
    console.log('  全量导出提示：', (await a.locator('#toast').innerText()).replace(/\s+/g, ' '));
    // 匿名 vs 管理员两份体积对比：管理员版多一张表 + 两列「所属部门」，必然更大
    const sizes = await a.evaluate(async () => {
      const tok = sessionStorage.getItem('hr_admin_token') || '';
      const anon = await (await fetch('/api/export.xlsx')).arrayBuffer();
      const adm = await (await fetch('/api/export.xlsx', { headers: { 'x-admin-token': tok } })).arrayBuffer();
      return { anon: anon.byteLength, adm: adm.byteLength, tok: !!tok };
    });
    console.log('  全量导出体积：匿名 ' + sizes.anon + ' B / 管理员 ' + sizes.adm + ' B',
      '| 带令牌 ' + sizes.tok, '| 管理员版更大 ' + (sizes.adm > sizes.anon));

    // 退出：整页立刻回到上锁（列、筛选器一起消失）
    await a.click('#adminBtn');
    await a.waitForTimeout(1200);
    console.log('  退出后 body.admin：', await a.evaluate(() => document.body.classList.contains('admin')));
    console.log('  退出后逐条隐患表「部门」列：', await colState('#tHz thead th.col-dept'));
    console.log('  退出后提示：', (await a.locator('#toast').innerText()).replace(/\s+/g, ' '));
    await a.screenshot({ path: path.join(OUT, 'admin-relocked-full.png') });
    await pc.close();

    console.log('  截图完成 → ' + OUT);
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
  }
})();
