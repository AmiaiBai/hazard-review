'use strict';
// 用真实 Chromium 截管理页 / 手机端总览，肉眼核验图表与分页渲染
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const PORT = 3194;
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

    // 管理页（宽屏）
    const pc = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
    const p1 = await pc.newPage();
    p1.on('pageerror', (e) => console.log('  [admin pageerror] ' + e.message));
    await p1.goto(base + '/admin', { waitUntil: 'networkidle' });
    await p1.waitForTimeout(600);
    await p1.screenshot({ path: path.join(OUT, 'admin-full.png'), fullPage: true });
    // 吸顶跳转目录：整页上万像素高，没有它用户滚不到「逐条隐患」（检查人筛选所在）就会以为功能没上线
    await p1.locator('#jump').screenshot({ path: path.join(OUT, 'admin-jumpnav.png') });
    await p1.locator('#cardFreq').screenshot({ path: path.join(OUT, 'admin-freq.png') });
    await p1.locator('#dimRadar').locator('xpath=ancestor::div[contains(@class,"card")][1]')
      .screenshot({ path: path.join(OUT, 'admin-radar.png') });
    // 模型质量评估各卡片
    for (const [id, name] of [['cardQuality', 'admin-quality'], ['cardSens', 'admin-sens'],
      ['cardWeak', 'admin-weak'], ['cardTrend', 'admin-trend'],
      ['cardBasis', 'admin-basis'], ['cardHist', 'admin-hist'],
      ['cardAct', 'admin-act'], ['cardAgree', 'admin-agree']]) {
      await p1.locator('#' + id).scrollIntoViewIfNeeded();
      await p1.waitForTimeout(150);
      await p1.locator('#' + id).screenshot({ path: path.join(OUT, name + '.png') });
    }
    // 漏检权重切到「严重度加权」
    await p1.selectOption('#qWeight', 'sev');
    await p1.waitForTimeout(350);
    await p1.locator('#cardQuality').screenshot({ path: path.join(OUT, 'admin-quality-weighted.png') });
    await p1.selectOption('#qWeight', 'even');
    await p1.waitForTimeout(250);
    // 阈值调低后重算（验证联动）
    await p1.selectOption('#qThr', '75');
    await p1.waitForTimeout(350);
    await p1.locator('#cardQuality').screenshot({ path: path.join(OUT, 'admin-quality-thr75.png') });
    await p1.selectOption('#qThr', '90');
    await p1.waitForTimeout(250);
    await p1.locator('#nPager').scrollIntoViewIfNeeded();
    await p1.waitForTimeout(200);
    await p1.screenshot({ path: path.join(OUT, 'admin-pager.png') });

    // 检查人筛选：按人切分任务（检查人下拉随部门收窄）
    const inspOpts = await p1.$$eval('#hzInspector option', (os) => os.map((o) => o.value));
    const pickInsp = inspOpts.find((v) => v !== 'all');
    if (pickInsp) {
      await p1.selectOption('#hzInspector', pickInsp);
      await p1.waitForTimeout(450);
      await p1.locator('#hzInspector').locator('xpath=ancestor::div[contains(@class,"card")][1]')
        .screenshot({ path: path.join(OUT, 'admin-hz-inspector.png') });
      await p1.selectOption('#hzInspector', 'all');
      await p1.waitForTimeout(250);
    }
    // 部门 → 检查人联动：选了部门后检查人下拉只剩该部门的人（挑检查人最多的部门，效果最明显）
    const pickDept = await p1.evaluate(() => {
      // ⚠️ S 是顶层 let，不在 window 上，必须当裸标识符用
      const rows = (typeof S !== 'undefined' && S && S.hazardRows) ? S.hazardRows : [];
      const m = new Map();
      for (const h of rows) {
        const d = h.dept || '未标注';
        if (!m.has(d)) m.set(d, new Set());
        m.get(d).add(h.inspector || '未标注');
      }
      let best = null, n = 0;   // 真实数据里一个部门常常只有 1 个检查人，别卡阈值
      for (const [d, s] of m) if (s.size > n) { n = s.size; best = d; }
      return best;
    });
    if (pickDept) {
      await p1.selectOption('#hzDept', pickDept);
      await p1.waitForTimeout(450);
      await p1.locator('#hzDept').locator('xpath=ancestor::div[contains(@class,"card")][1]')
        .screenshot({ path: path.join(OUT, 'admin-hz-inspector-cascade.png') });
      await p1.selectOption('#hzDept', 'all');
      await p1.waitForTimeout(250);
    }
    // 点目录里的「逐条隐患」→ 吸顶条仍在视野里 + 当前项高亮（证明目录真能把人带到明细表）
    await p1.evaluate(() => {
      const a = [...document.querySelectorAll('#jump a')].find((x) => x.getAttribute('href') === '#cardHz');
      if (a) a.click();
    });
    await p1.waitForTimeout(500);
    await p1.screenshot({ path: path.join(OUT, 'admin-jumpnav-active.png') });

    // 重大漏检红线：临时注入一条（只改这一页的响应，绝不碰真实数据）
    await p1.route('**/api/stats', async (route) => {
      const resp = await route.fetch();
      const j = await resp.json();
      const base = (j.noneRows || [])[0] || {};
      j.noneRows = [Object.assign({}, base, {
        recordId: 'DEMO-CRIT-0001', dept: base.dept || '示例部门', inspector: base.inspector || '示例检查人',
        time: base.time || '2026-09-21 09:30:00', severity: 'critical', severityLabel: '重大隐患', weight: 10,
        suspected: 1, confirmed: 0, status: 'suspected', reviewers: ['示例复核人'],
        notes: [{ reviewer: '示例复核人', desc: '配电房电缆沟盖板缺失、未设防小动物挡板，存在触电与短路风险', basis: '《低压配电设计规范》GB 50054-2011 7.2.1' }],
      })].concat(j.noneRows || []);
      j.quality.none = (j.quality.none || []).concat([{ d: '2026-09-21', t: '电气与用电', p: base.dept || '示例部门', v: 1, sv: 'critical', w: 10, n: 1 }]);
      j.noneStat = Object.assign({}, j.noneStat, {
        reviewed: 2, suspected: 1, confirmed: 1,
        bySeverity: { general: 0, major: 0, critical: 1 }, criticalMiss: 1, majorMiss: 0, weightedMiss: 10,
      });
      j.summary = Object.assign({}, j.summary, { criticalMiss: 1, weightedMiss: 10 });

      // 已识别隐患的「重大识别出错」—— 和漏检并列的另一类红线
      const hb = (j.hazardRows || [])[0] || {};
      const wrongHz = Object.assign({}, hb, {
        key: 'DEMO-WRONG-0001#1', recordId: 'DEMO-WRONG-0001', hazardNo: 1,
        name: '配电柜未做保护接地', dept: hb.dept || '示例部门', time: hb.time || '2026-09-20 10:15:00',
        severity: 'critical', severityLabel: '重大隐患', weight: 10, labeled: true,
        criticalWrong: true, criticalOk: false, overall: 58, issues: 1, passes: 0,
        reviewers: ['示例评审人'],
        comments: [{ reviewer: '示例评审人', advice: 'AI 描述与现场不符，实际是保护接地缺失，属重大隐患', note: '' }],
      });
      j.hazardRows = [wrongHz].concat(j.hazardRows || []);
      j.criticalStat = {
        total: j.hazardRows.length, labeled: 1, unlabeled: j.hazardRows.length - 1,
        bySeverity: { general: 0, major: 0, critical: 1 },
        critical: 1, criticalWrong: 1, criticalOk: 0, majorWrong: 0, weightedWrong: 10,
        wrongRows: [Object.assign({}, wrongHz, { sevNotes: [{ reviewer: '示例评审人', sev: 'critical', verdict: 'issue' }] })],
      };
      j.summary = Object.assign({}, j.summary, {
        criticalMiss: 1, weightedMiss: 10, criticalLabeled: 1, criticalHazard: 1, criticalWrong: 1, criticalOk: 0,
      });
      await route.fulfill({ json: j });
    });
    await p1.reload({ waitUntil: 'networkidle' });
    await p1.waitForTimeout(600);
    await p1.locator('#cardRedline').screenshot({ path: path.join(OUT, 'admin-redline.png') });
    await p1.selectOption('#hzSev', 'criticalWrong');
    await p1.waitForTimeout(400);
    await p1.locator('#tHz').locator('xpath=ancestor::div[contains(@class,"card")][1]')
      .screenshot({ path: path.join(OUT, 'admin-hz-sev.png') });
    await p1.selectOption('#hzSev', 'all');
    await p1.waitForTimeout(200);
    await p1.selectOption('#qWeight', 'sev');
    await p1.waitForTimeout(400);
    await p1.locator('#cardQuality').screenshot({ path: path.join(OUT, 'admin-quality-weighted.png') });
    await p1.selectOption('#nSev', 'critical');
    await p1.waitForTimeout(300);
    await p1.locator('#nPager').locator('xpath=ancestor::div[contains(@class,"card")][1]')
      .screenshot({ path: path.join(OUT, 'admin-none-sev.png') });
    await p1.unroute('**/api/stats');
    console.log('  管理页截图完成');
    await pc.close();

    // 手机端：进引导页 → 走完一轮 → 打开时段总览
    const mob = await browser.newContext({ viewport: { width: 414, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p2 = await mob.newPage();
    p2.on('pageerror', (e) => console.log('  [mobile pageerror] ' + e.message));
    await p2.goto(base + '/', { waitUntil: 'networkidle' });
    await p2.waitForTimeout(400);
    await p2.fill('#gName', '截图测试');
    await p2.click('#gGo');
    await p2.waitForTimeout(600);
    await p2.screenshot({ path: path.join(OUT, 'mobile-card.png') });

    // 已识别隐患的严重度标注：选「重大」+ 拖低维度 → 「识别出错」红线提示
    await p2.click('#btnScore');
    await p2.waitForTimeout(400);
    await p2.locator('#hazSevPick').scrollIntoViewIfNeeded();
    await p2.waitForTimeout(200);
    await p2.screenshot({ path: path.join(OUT, 'mobile-haz-sev.png') });
    await p2.click('#hazSevPick [data-v="critical"]');
    await p2.waitForTimeout(250);
    await p2.screenshot({ path: path.join(OUT, 'mobile-haz-sev-ok.png') });
    // 拖低「隐患真实性」→ 判定转为存疑 → 升级为「识别出错」
    await p2.locator('.slider[data-dim="real"] input').evaluate((el) => {
      el.value = '40';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await p2.waitForTimeout(300);
    await p2.screenshot({ path: path.join(OUT, 'mobile-haz-sev-wrong.png') });
    await p2.click('#shClose');
    await p2.waitForTimeout(300);

    // 筛选面板（默认「全部时间」+ 快捷档按钮 + 两口径提示）
    await p2.click('#btnFilter');
    await p2.waitForTimeout(300);
    await p2.screenshot({ path: path.join(OUT, 'mobile-filter.png') });
    await p2.click('#fQuick [data-r="week"]');
    await p2.waitForTimeout(250);
    await p2.screenshot({ path: path.join(OUT, 'mobile-filter-week.png') });
    await p2.click('#fQuick [data-r="all"]');
    await p2.waitForTimeout(250);
    // 「疑似漏检」= 所有 AI 未识别到隐患的记录（召回率口径）
    await p2.click('#fStatus [data-v="miss"]');
    await p2.click('#fApply');
    await p2.waitForTimeout(400);
    await p2.screenshot({ path: path.join(OUT, 'mobile-miss.png') });

    // 漏检严重度面板：疑似漏检 → 重大隐患（红线警示）
    await p2.click('#btnScore');
    await p2.waitForTimeout(400);
    await p2.click('#pick [data-v="issue"]');
    await p2.waitForTimeout(250);
    await p2.screenshot({ path: path.join(OUT, 'mobile-severity.png') });
    await p2.click('#sevPick [data-v="critical"]');
    await p2.waitForTimeout(250);
    await p2.screenshot({ path: path.join(OUT, 'mobile-severity-critical.png') });
    await p2.click('#shClose');
    await p2.waitForTimeout(300);

    await p2.click('#btnFilter');
    await p2.waitForTimeout(250);
    await p2.click('#fStatus [data-v="all"]');
    await p2.click('#fApply');
    await p2.waitForTimeout(300);

    // 时段总览（含雷达图）—— 面板内部滚动，滚到底再截一张
    await p2.click('#btnOverview');
    await p2.waitForTimeout(400);
    await p2.screenshot({ path: path.join(OUT, 'mobile-overview.png') });
    await p2.locator('#panel').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await p2.waitForTimeout(300);
    await p2.screenshot({ path: path.join(OUT, 'mobile-overview-bottom.png') });
    console.log('  手机端截图完成');
    await mob.close();
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
  console.log('截图目录：' + OUT);
})();
