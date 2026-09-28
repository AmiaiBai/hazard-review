'use strict';
/**
 * 量「保存并下一条」这条路径的耗时，并验证「翻页不等网络」。
 *
 * 为什么要有这个工具：用户报过「电脑端点击保存并下一条很慢」——
 * 手机端左滑是「画面立刻滑走 + 后台保存」，桌面端却是「等服务端返回才翻页」。
 * 这种「体感问题」单元测试测不出来（JSDOM 里网络是瞬时的），必须在真浏览器里
 * 加上人为网络延迟才能复现和证明。
 *
 * 判据：加了 150ms 延迟后，
 *   「点击 → 下一张卡可见」应当仍是几十毫秒级，
 *   「点击 → /api/submit 响应完成」应当是 150ms+。
 *   两者解耦 = 修好了；两者接近 = 又变回等网络了。
 *
 * 用法：node tools/perf_save.js [--latency 150]
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright-core');

const PORT = 3206;
const ROOT = path.join(__dirname, '..');
const CHROME = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe');
const PROBE = '__perf_save__';            // 探针名统一带前缀，跑完自动清，别污染本地评审人名单
const li = process.argv.indexOf('--latency');
const LATENCY = li >= 0 ? Number(process.argv[li + 1]) : 150;

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { const a = []; r.on('data', (d) => a.push(d)); r.on('end', () => res(Buffer.concat(a))); }).on('error', rej);
});
const post = (p, body) => new Promise((res, rej) => {
  const data = JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
    (x) => { const a = []; x.on('data', (d) => a.push(d)); x.on('end', () => res(Buffer.concat(a).toString())); });
  r.on('error', rej); r.write(data); r.end();
});

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }), cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser;
  let failed = false;
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { try { await get('/api/meta'); up = true; } catch (e) { await new Promise((r) => setTimeout(r, 150)); } }
    if (!up) throw new Error('服务没起来');

    // ① 纯接口耗时（不经过浏览器）—— 服务端 120ms 写盘防抖会体现在这里
    const api = [];
    for (const no of [1, 2]) {
      const t0 = Date.now();
      await post('/api/submit', { reviewer: PROBE, dept: '甲车间', items: [{ recordId: 'JL-20260917-0002', hazardNo: no, verdict: 'pass', scores: { real: 90, desc: 90, basis: 90, cite: 90 } }] });
      api.push(Date.now() - t0);
    }
    console.log(`【纯接口】POST /api/submit：${api.join('ms / ')}ms（含服务端写盘防抖 120ms）\n`);

    browser = await chromium.launch(fs.existsSync(CHROME) ? { executablePath: CHROME } : {});

    for (const [label, vp] of [['手机 390', { width: 390, height: 844, isMobile: true, hasTouch: true }], ['电脑 1280', { width: 1280, height: 900 }]]) {
      const ctx = await browser.newContext(Object.assign({ deviceScaleFactor: 1 }, vp));
      // 人为加延迟 —— 本机 RTT 是 0，不加延迟根本复现不出「等网络」的卡顿
      await ctx.route('**/api/submit', async (route) => {
        await new Promise((r) => setTimeout(r, LATENCY));
        route.continue();
      });
      const p = await ctx.newPage();
      await p.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'networkidle' });
      await p.waitForTimeout(400);
      await p.fill('#gName', PROBE);
      await p.waitForTimeout(150);
      await p.click('#gGo');
      await p.waitForTimeout(900);

      // 在页面里记录「点击 → /api/submit 响应完成」的耗时，用于跟「翻页耗时」对比
      await p.evaluate(() => {
        window.__subMs = [];
        const of = window.fetch;
        window.fetch = function (...a) {
          const t0 = performance.now();
          const pr = of.apply(this, a);
          if (String(a[0]).includes('/api/submit')) {
            pr.then(() => window.__subMs.push(Math.round(performance.now() - t0))).catch(() => {});
          }
          return pr;
        };
      });

      const r = await p.evaluate(async () => {
        const card = document.getElementById('card');
        const before = card.querySelector('.recid').textContent;
        const idx0 = window.eval('S.idx');
        const total = window.eval('S.filtered.length');
        window.openSheet(window.eval('keyOf(S.filtered[S.idx].rid, S.filtered[S.idx].no)'));
        await new Promise((z) => setTimeout(z, 250));
        const sheetOpen = document.getElementById('sheet').classList.contains('show');
        const hasSave = !!document.getElementById('doSave');
        const t0 = performance.now();
        document.getElementById('doSave').click();
        for (let i = 0; i < 300; i++) {
          await new Promise((z) => setTimeout(z, 10));
          const now = document.getElementById('card').querySelector('.recid');
          if (now && now.textContent !== before) break;
        }
        return {
          toNext: Math.round(performance.now() - t0), before,
          after: document.getElementById('card').querySelector('.recid').textContent,
          idx0, idx1: window.eval('S.idx'), total, sheetOpen, hasSave,
        };
      });
      await p.waitForTimeout(500);
      const subMs = await p.evaluate(() => window.__subMs);

      const netMs = subMs.length ? subMs[0] : -1;
      const ok = r.toNext < 100 && netMs >= LATENCY;
      if (!ok) failed = true;
      console.log(`【${label}】点击 → 下一张卡可见：${r.toNext}ms   |   点击 → 服务端响应：${netMs}ms   ${ok ? '✓ 翻页不等网络' : '✗ 又在等网络了'}`);
      console.log(`           卡片 ${r.before} → ${r.after}   idx ${r.idx0}→${r.idx1} / 共 ${r.total} 条` +
        `   抽屉已开=${r.sheetOpen} 有保存键=${r.hasSave}`);
      await ctx.close();
    }

    // 清掉探针 —— 跑一次性能测试不该在评审人名单里留下假人。
    // 探针名是保留前缀 __ 开头的，它名下的评分一定是我们自己造的，直接删；
    // 数量异常大（说明名字撞上了真人）才停下来报警，不自动动手。
  } finally {
    // 清理放在 finally —— 中途任何一步抛异常都不能把假评审人留在名单里
    // （本项目出过这个事故：核验脚本往线上名单塞了两个假人，事后才发现）
    try {
      const mine = JSON.parse(await get('/api/my?reviewer=' + encodeURIComponent(PROBE)));
      const n = (mine.items || []).length;
      if (n > 20) {
        console.log(`\n⚠ 探针「${PROBE}」名下竟有 ${n} 条评分，疑似撞名真人，未自动删除，请人工确认`);
        failed = true;
      } else {
        const res = JSON.parse(await post('/api/delete', { reviewer: PROBE, all: true }));
        console.log(`\n（已清理探针「${PROBE}」→ 删掉 ${res.removed} 条评分记录）`);
      }
    } catch (e) {
      console.log(`\n⚠ 探针「${PROBE}」清理失败：${e.message}，请手工确认名单里有没有它`);
      failed = true;
    }
    if (browser) await browser.close();
    child.kill();
  }
  process.exit(failed ? 1 : 0);
})();
