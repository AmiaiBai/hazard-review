'use strict';
/**
 * 并发压测：验证「多少人可以同时评分」
 *
 * 用法：node tools/loadtest.js [并发人数...]
 *   例：node tools/loadtest.js            → 默认测 14 / 30 / 60 / 120 / 240
 *       node tools/loadtest.js 14 30      → 只测这两个档位
 *
 * 安全设计：**先把项目复制到一个隔离的临时目录**（只带 data/*.json，不带 images/thumbs），
 * 压测产生的几千条假评分只落在临时目录里，跑完自动删除，绝不碰真实 data/。
 * 因此不会污染线上评分数据，也不需要手工备份还原。
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'hr-loadtest-' + Date.now());
const PORT = 3199;
const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const t0 = process.hrtime.bigint();
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method, agent,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const pad = (s, n) => String(s).padEnd(n);

/** 手写递归拷贝 —— 不要用 fs.cpSync：本机沙箱的 fs shim 会直接中断进程（退出码 127，无报错） */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/** 把项目复制到临时目录（只带 data/*.json 与 thumbs，不带原图，省 13MB 拷贝） */
function makeSandbox() {
  fs.mkdirSync(path.join(TMP, 'data', 'images'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(TMP, 'server.js'));
  for (const d of ['lib', 'public']) copyDir(path.join(ROOT, d), path.join(TMP, d));
  for (const f of ['hazards.json', 'submissions.json', 'sources.json']) {
    const src = path.join(ROOT, 'data', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TMP, 'data', f));
  }
  // thumbs 是导出内嵌图片用的，带上它「导出 Excel」的耗时才贴近真实
  const thumbs = path.join(ROOT, 'data', 'thumbs');
  if (fs.existsSync(thumbs)) copyDir(thumbs, path.join(TMP, 'data', 'thumbs'));
  else fs.mkdirSync(path.join(TMP, 'data', 'thumbs'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'data', 'submissions.json'), JSON.stringify({ reviewers: {}, items: [] }));
}

async function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: TMP, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { await req('GET', '/api/meta'); return child; } catch (e) { await wait(200); }
  }
  child.kill();
  throw new Error('服务起不来（端口 ' + PORT + ' 被占用？）');
}

(async () => {
  const levels = process.argv.slice(2).map(Number).filter((n) => n > 0);
  const CASES = levels.length ? levels : [14, 30, 60, 120, 240];

  makeSandbox();
  console.log(`隔离环境：${TMP}\n`);

  const hz = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'hazards.json'), 'utf8'));
  const keys = [];
  for (const r of (hz.records || [])) {
    r.hazards.forEach((h, i) => keys.push([r.id, i + 1]));
    keys.push([r.id, 0]);   // 漏检复核也算可评分条目
  }
  console.log(`可评分条目 ${keys.length} 条（${(hz.records || []).length} 条记录）`);
  console.log(`每个虚拟用户每 300ms 提交一批（每批 3 条，模拟连续左滑认可），每档跑 6 秒\n`);

  const child = await startServer();
  console.log(pad('并发人数', 12) + pad('提交批次', 11) + pad('失败', 8) + pad('p50', 10) + pad('p95', 10) + pad('max', 10) + '吞吐(条/秒)');
  console.log('-'.repeat(74));

  let cursor = 0;
  for (const N of CASES) {
    const ms = [];
    let ok = 0, bad = 0;
    const t0 = Date.now();
    const stop = t0 + 6000;

    async function worker(u) {
      while (Date.now() < stop) {
        const items = [];
        for (let i = 0; i < 3; i++) {
          const [rid, no] = keys[(cursor++) % keys.length];
          items.push({ recordId: rid, hazardNo: no, verdict: 'pass', scores: { real: 90, desc: 90, basis: 90, cite: 90 }, advice: '', note: '' });
        }
        try {
          const r = await req('POST', '/api/submit', { reviewer: 'u' + u, dept: '压测', items });
          ms.push(r.ms);
          if (r.status === 200) ok++; else bad++;
        } catch (e) { bad++; }
        await wait(300);
      }
    }
    await Promise.all(Array.from({ length: N }, (_, u) => worker(u)));
    const dur = (Date.now() - t0) / 1000;
    console.log(
      pad(N, 13) + pad(ok, 12) + pad(bad, 9) +
      pad(pct(ms, .5).toFixed(0) + 'ms', 11) + pad(pct(ms, .95).toFixed(0) + 'ms', 11) +
      pad(Math.max(...ms).toFixed(0) + 'ms', 11) + (ok * 3 / dur).toFixed(0)
    );
  }

  // 混合负载：模拟「有人评分 + 有人刷统计页 + 有人导出」
  console.log('\n混合负载（14 人评分 + 3 人刷统计 + 1 人导出，持续 8 秒）');
  const subMs = [], stMs = [], exMs = [];
  const t0 = Date.now(); const stop = t0 + 8000;
  async function scorer(u) {
    while (Date.now() < stop) {
      const items = [];
      for (let i = 0; i < 3; i++) { const [rid, no] = keys[(cursor++) % keys.length]; items.push({ recordId: rid, hazardNo: no, verdict: 'pass', scores: { real: 90, desc: 90, basis: 90, cite: 90 }, advice: '', note: '' }); }
      try { const r = await req('POST', '/api/submit', { reviewer: 'u' + u, dept: '压测', items }); subMs.push(r.ms); } catch (e) {}
      await wait(400);
    }
  }
  async function poller() { while (Date.now() < stop) { const r = await req('GET', '/api/stats'); stMs.push(r.ms); await wait(800); } }
  async function exporter() { while (Date.now() < stop) { const r = await req('GET', '/api/export.xlsx'); exMs.push(r.ms); await wait(3000); } }
  await Promise.all([...Array.from({ length: 14 }, (_, u) => scorer(u)), ...Array.from({ length: 3 }, () => poller()), exporter()]);
  const avg = (a) => a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(0) + 'ms' : '(无)';
  console.log(`  提交 ${subMs.length} 次 · avg ${avg(subMs)} · p95 ${pct(subMs, .95).toFixed(0)}ms`);
  console.log(`  统计 ${stMs.length} 次 · avg ${avg(stMs)} · p95 ${pct(stMs, .95).toFixed(0)}ms`);
  console.log(`  导出 ${exMs.length} 次 · avg ${avg(exMs)} · p95 ${pct(exMs, .95).toFixed(0)}ms`);

  await wait(600);
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'submissions.json'), 'utf8'));
  console.log(`\n落盘 ${onDisk.items.length} 条（去重后）· 登记人 ${Object.keys(onDisk.reviewers || {}).length} 人`);

  child.kill();
  await wait(300);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('临时环境已清理，真实 data/ 未受影响。');
  process.exit(0);
})().catch((e) => {
  console.error('压测出错：', e.message);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});
