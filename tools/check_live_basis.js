'use strict';
// 用真实浏览器核验「法规依据」的按需补全（本地或线上）：
//   A 缓存命中 → 首帧就是全文（不再出现半句）
//   B 缓存未命中 → 首帧是「加载中」，随后补全为全文
//   C 请求失败 → 显示「重试」而不是截断版；点击重试后能补全
//
// 用法：node tools/check_live_basis.js [--url https://xxx]
//
// ⚠️ 手机端要先「输入姓名 → 开始评分」才能进主流程，而这一步会在服务端登记评审人。
//    所以核验线上时必须用探针名 + 结束后自动 /api/delete 清掉，否则线上名单里会多出假人。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { chromium } = require('playwright-core');

const PROBE = '__probe_basis__';        // 探针名：核验结束会从线上删掉
const PORT = 3204;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '..', 'outputs', 'hazard-review-shots');
const CHROME = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { const a = []; r.on('data', (d) => a.push(d)); r.on('end', () => res(Buffer.concat(a))); }).on('error', rej);
});

/** 对任意 base（http/https）发请求 —— 收尾清理探针用 */
function apiCall(base, method, p, body) {
  return new Promise((res, rej) => {
    const u = new URL(base + p);
    const mod = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const r = mod.request({
      host: u.host, path: u.pathname + u.search, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (x) => { let d = ''; x.setEncoding('utf8'); x.on('data', (c) => d += c); x.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error('非 JSON: ' + d.slice(0, 80))); } }); });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}
const getJson = (base, p) => apiCall(base, 'GET', p);
const postJson = (base, p, body) => apiCall(base, 'POST', p, body);

const RID = 'JL-20260917-0002', NO = 1, K = RID + '#' + NO;
// 传 --url <base> 则直接核验线上（不起本地服务）
const urlIdx = process.argv.indexOf('--url');
const LIVE = urlIdx >= 0 ? process.argv[urlIdx + 1] : null;

(async () => {
  const hazards = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'hazards.json'), 'utf8'));
  const FULL = hazards.records.find((r) => r.id === RID).hazards.find((h) => h.no === NO).basis;
  console.log(LIVE ? ('线上：' + LIVE) : '本地');

  const child = LIVE ? { kill() {} } : spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }), cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  });
  const BASE = LIVE || ('http://127.0.0.1:' + PORT);
  let browser;
  const ok = [], bad = [];
  const T = (n, c, e) => (c ? ok : bad).push(n + (e ? ' → ' + e : ''));

  try {
    if (!LIVE) {
      let up = false;
      for (let i = 0; i < 40 && !up; i++) { try { await get('/api/meta'); up = true; } catch (e) { await new Promise((r) => setTimeout(r, 150)); } }
      if (!up) throw new Error('服务没起来');
    }

    browser = await chromium.launch(fs.existsSync(CHROME) ? { executablePath: CHROME } : {});
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => bad.push('JS 错误：' + e.message));

    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(500);
    await p.fill('#gName', PROBE);
    await p.waitForTimeout(150);
    await p.click('#gGo');
    await p.waitForTimeout(1000);

    console.log('全文长度 = ' + FULL.length);

    // ---- B 缓存未命中：清空缓存后打开抽屉 ----
    const cold = await p.evaluate(async (k) => {
      S.basisCache.clear();
      window.openSheet(k);
      const el = document.getElementById('basisTxt');
      const first = { text: el.textContent, cls: el.className };
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (document.getElementById('basisTxt').textContent.includes('联锁的活动式防护装置进行防护。应根据')) break;
      }
      const el2 = document.getElementById('basisTxt');
      return { first, final: el2.textContent, finalCls: el2.className };
    }, K);
    console.log('\n【B 冷缓存】首帧「' + cold.first.text + '」class=' + cold.first.cls);
    T('冷缓存首帧是明确的「加载中」占位（不是半句法规）', cold.first.text === '依据全文加载中…', cold.first.text);
    T('冷缓存首帧为「加载中」', /加载中/.test(cold.first.text), cold.first.text);
    T('冷缓存最终补全为全文', cold.final === FULL, '长度 ' + cold.final.length);
    T('补全后去掉 loading 样式', cold.finalCls === '', 'class=' + cold.finalCls);

    // ---- A 缓存命中：预热后打开，首帧即全文 ----
    const warm = await p.evaluate(async (k) => {
      S.basisCache.clear();
      await fetchBasis([k]);
      window.closeSheet();
      window.openSheet(k);
      const el = document.getElementById('basisTxt');
      return { text: el.textContent, cls: el.className };
    }, K);
    T('热缓存首帧就是全文', warm.text === FULL, '长度 ' + warm.text.length + ' class=' + warm.cls);
    T('热缓存首帧无 loading 样式', warm.cls === '', warm.cls);

    // ---- 列表卡片与抽屉同源 ----
    const same = await p.evaluate(async (k) => {
      S.idx = S.filtered.findIndex((x) => x.rid + '#' + x.no === k);   // ⚠️ 索引的是 S.filtered，不是 S.items
      window.paintDeck && window.paintDeck();
      await new Promise((r) => setTimeout(r, 700));
      const cardEl = document.querySelector('#card [data-basis-text]');
      window.openSheet(k);
      await new Promise((r) => setTimeout(r, 500));
      const sheetEl = document.getElementById('basisTxt');
      return { card: cardEl ? cardEl.textContent : '', sheet: sheetEl ? sheetEl.textContent : '' };
    }, K);
    T('列表卡片与抽屉文本一致', same.card === same.sheet && same.card === FULL, '卡片 ' + same.card.length + ' / 抽屉 ' + same.sheet.length);

    // ---- C 请求失败：显示「重试」，点击后恢复 ----
    const fail = await p.evaluate(async (k) => {
      S.basisCache.clear();
      // 拦掉 /api/basis，模拟工地断网
      const orig = window.fetch;
      let blocked = true;
      window.fetch = (u, o) => (blocked && String(u).includes('/api/basis')) ? Promise.reject(new Error('offline')) : orig(u, o);
      window.closeSheet();
      window.openSheet(k);
      await new Promise((r) => setTimeout(r, 900));
      const el = document.getElementById('basisTxt');
      const failedText = el.textContent, failedCls = el.className;
      blocked = false;                     // 网络恢复
      el.click();                          // 点「重试」
      await new Promise((r) => setTimeout(r, 900));
      const after = document.getElementById('basisTxt');
      window.fetch = orig;
      return { failedText, failedCls, afterText: after.textContent, afterCls: after.className };
    }, K);
    console.log('\n【C 断网】显示「' + fail.failedText + '」class=' + fail.failedCls);
    T('断网时不显示截断版', !fail.failedText.includes('…'), fail.failedText);
    T('断网时提示加载失败并给出重试', /失败/.test(fail.failedText) && fail.failedCls === 'basisretry', fail.failedText + ' / ' + fail.failedCls);
    T('点重试后补全为全文', fail.afterText === FULL, '长度 ' + fail.afterText.length);

    // ---- 预热覆盖前后各 8 张 ----
    const warmRange = await p.evaluate(async () => {
      S.basisCache.clear();
      S.idx = 20;
      window.paintDeck && window.paintDeck();
      await new Promise((r) => setTimeout(r, 1200));
      const keys = [...S.basisCache.keys()];
      const want = [];
      for (let i = Math.max(0, S.idx - 8); i < Math.min(S.idx + 9, S.filtered.length); i++) {
        const x = S.filtered[i];
        if (x.hz && x.hz.more) want.push(x.rid + '#' + x.no);
      }
      return { cached: keys.length, want: want.length, covered: want.filter((k) => S.basisCache.has(k)).length };
    });
    T('预热覆盖前后各 8 张', warmRange.covered === warmRange.want, JSON.stringify(warmRange));

    await p.evaluate(() => { const el = document.getElementById('basisTxt'); if (el) el.scrollIntoView({ block: 'center' }); });
    await p.waitForTimeout(300);
    await p.screenshot({ path: path.join(OUT, 'fix-basis-sheet.png') });

    console.log('\n结果：');
    ok.forEach((s) => console.log('  ✓ ' + s));
    bad.forEach((s) => console.log('  ✗ ' + s));
    console.log(`\n通过 ${ok.length} / 失败 ${bad.length}`);
    process.exitCode = bad.length ? 1 : 0;
  } finally {
    if (browser) await browser.close();
    child.kill();
    // 收尾：把探针从线上名单里删掉（先确认它名下没有评分，避免误删真人数据）
    try {
      const mine = await getJson(BASE, '/api/my?reviewer=' + encodeURIComponent(PROBE));
      if ((mine.items || []).length === 0) {
        const r = await postJson(BASE, '/api/delete', { reviewer: PROBE, all: true });
        console.log(`\n探针「${PROBE}」已清理 → ${r.removed} 条评分被删`);
      } else {
        console.log(`\n⚠ 探针「${PROBE}」名下有 ${mine.items.length} 条评分，未自动删除`);
      }
    } catch (e) { console.log('\n⚠ 探针清理失败：' + e.message); }
  }
})();
