'use strict';
/**
 * 「仓库不含 data/，克隆下来还能跑吗」—— 这个契约的回归测试。
 *
 * 为什么单独一个文件：别的测试都跑在**有数据**的本地目录上，永远覆盖不到
 * 「data/ 不存在」这条路径。而这条路径真的崩过 —— loadHazards() 在启动时被调用且没有
 * try/catch，全新克隆 `node server.js` 直接 ENOENT 退出，连错误页都看不到。
 * 仓库既然承诺「只含代码、克隆后自己准备 data/」，就得把这条钉住。
 *
 * 做法：把服务真正需要的文件复制到一个空目录（不复制 data/、tools/），
 * 当它是刚 clone 下来的，然后清掉 HR_ADMIN_PW 启动它。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(path.resolve(ROOT, '..'), 'outputs', '_fresh_clone');
const PORT = 3224;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

/** 递归复制目录（只用于「模拟克隆」，不处理软链/特殊文件） */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function req(method, p, payload) {
  return new Promise((res, rej) => {
    const body = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : null;
    const h = body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {};
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, (x) => {
      const c = []; x.on('data', (d) => c.push(d));
      x.on('end', () => res({ code: x.statusCode, buf: Buffer.concat(c) }));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- 搭一个「刚 clone 下来」的目录：只有服务真正需要的文件，没有 data/ ----
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  for (const f of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f));
  for (const d of ['lib', 'public']) copyDir(path.join(ROOT, d), path.join(TMP, d));

  console.log('\n【1】克隆目录本身');
  check('临时目录里没有 data/', !fs.existsSync(path.join(TMP, 'data')));
  check('也没有 hazards.json', !fs.existsSync(path.join(TMP, 'data', 'hazards.json')));

  const env = Object.assign({}, process.env, { PORT: String(PORT) });
  delete env.HR_ADMIN_PW;                       // 走「随机生成密码」那条路
  const child = spawn(process.execPath, [path.join(TMP, 'server.js')], {
    env, cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { await req('GET', '/api/health'); up = true; } catch (e) { await wait(200); }
    }

    console.log('\n【2】启动不崩（这条就是当初的 bug）');
    check('服务能起来', up, out.trim().split('\n').slice(0, 3).join(' | '));
    check('启动输出里没有 ENOENT', !/ENOENT/.test(out), out.trim().split('\n')[0]);
    check('data/ 被自动创建', fs.existsSync(path.join(TMP, 'data')));

    console.log('\n【3】首次运行就生成密码，且打印出来');
    const af = path.join(TMP, 'data', 'admin.json');
    check('admin.json 已生成', fs.existsSync(af));
    let pw = '';
    if (fs.existsSync(af)) pw = JSON.parse(fs.readFileSync(af, 'utf8')).password || '';
    check('密码是 16 位', pw.length === 16, pw.length);
    check('不是硬编码的旧默认值', pw !== 'asd2026', pw);
    // 这条最要紧：用户在启动日志里看不到密码就进不去管理端
    check('启动日志里打印了同一个密码', pw !== '' && out.includes(pw));

    console.log('\n【4】用这个密码能进管理端');
    if (pw) {
      const ok = await req('POST', '/api/admin/login', { password: pw });
      check('新密码登录 200', ok.code === 200, ok.code);
      const bad = await req('POST', '/api/admin/login', { password: 'asd2026' });
      check('旧默认密码被拒 401', bad.code === 401, bad.code);
    }

    console.log('\n【5】没有数据时各页面不 5xx');
    for (const p of ['/api/health', '/api/meta', '/api/hazards', '/api/stats', '/', '/admin']) {
      const r = await req('GET', p);
      check(`${p} 不是 5xx`, r.code < 500, r.code);
    }
    const meta = JSON.parse((await req('GET', '/api/meta')).buf.toString('utf8'));
    check('/api/meta 结构完整（不是 undefined）', meta && typeof meta === 'object' && !!meta.meta, JSON.stringify(meta).slice(0, 80));
    const list = JSON.parse((await req('GET', '/api/hazards')).buf.toString('utf8'));
    check('/api/hazards 返回空列表而不是报错', Array.isArray(list.records) && list.records.length === 0, JSON.stringify(list).slice(0, 80));
    check('启动日志给了「数据放哪」的提示', /暂无识别记录|data/i.test(out));
  } catch (e) {
    fail++; console.log('  ✗ 异常：' + e.message);
  } finally {
    child.kill();
    await wait(300);
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
