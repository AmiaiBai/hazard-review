'use strict';
/**
 * 线上链接打不开时的分层诊断 —— 区分「服务挂了」和「网络拦截」。
 *
 * 为什么需要它：用户报「网站打不开了」，最容易被误判成「服务停了、沙箱被回收了」，
 * 然后白折腾一通重新发布。实际很多时候是**本地网络对域名的阻断**，
 * 服务好好的，重新发布也解决不了。
 *
 * 关键手法：
 *   ① 多 DNS 对比 —— 本地/公共/DoH 各查一遍。**结果不一致 = DNS 污染**。
 *   ② 直连真实 IP —— 绕开 DNS，看是不是服务本身的问题。
 *   ③ 有/无 SNI 对比 —— 这是决定性判据：
 *        带目标域名 SNI 被 RST，去掉 SNI 却能握手成功  → **SNI 阻断，服务是活的**
 *        两种情况都失败                              → 服务可能真的挂了
 *   ④ 读证书 —— 确认后端到底是不是目标服务（腾讯云发布的域名证书会写 O=Tencent）。
 *
 * 用法：node tools/diagnose_live.js [--url https://xxx]
 */
const tls = require('tls');
const https = require('https');
const dns = require('dns');

const li = process.argv.indexOf('--url');
const URL_ = li >= 0 ? process.argv[li + 1] : 'https://da782378ef0146348f92b5c66301a892.sg.agentos-app.run';
const HOST = new URL(URL_).hostname;

const ok = (s) => '  ✅ ' + s;
const bad = (s) => '  ❌ ' + s;
const info = (s) => '  ·  ' + s;

/** 无 SNI 的 TLS 握手；返回证书信息或错误 */
function handshake(servername, ip, timeout = 12000) {
  return new Promise((res) => {
    const t0 = Date.now();
    const opt = { host: ip, port: 443, timeout, rejectUnauthorized: false };
    if (servername) opt.servername = servername;
    const s = tls.connect(opt, () => {
      const c = s.getPeerCertificate() || {};
      res({ ok: true, ms: Date.now() - t0, subject: c.subject, issuer: c.issuer, san: c.subjectaltname, validTo: c.valid_to });
      s.destroy();
    });
    s.on('timeout', () => { s.destroy(); res({ ok: false, err: '超时 ' + timeout + 'ms' }); });
    s.on('error', (e) => res({ ok: false, err: e.code || e.message, ms: Date.now() - t0 }));
  });
}

/** 带 Host 头发 HTTP 请求（可指定是否发 SNI），用于在握手成功后继续验证应用层 */
function httpGet(ip, path, servername, timeout = 15000) {
  return new Promise((res) => {
    const t0 = Date.now();
    const opt = {
      host: ip, port: 443, path, method: 'GET', rejectUnauthorized: false, timeout,
      headers: { Host: HOST, 'User-Agent': 'diagnose_live' },
    };
    opt.servername = servername === undefined ? false : servername;
    const r = https.request(opt, (x) => {
      let a = ''; x.on('data', (d) => a += d);
      x.on('end', () => res({ ok: true, code: x.statusCode, ms: Date.now() - t0, ct: x.headers['content-type'], body: a.slice(0, 200) }));
    });
    r.on('timeout', () => { r.destroy(); res({ ok: false, err: '超时' }); });
    r.on('error', (e) => res({ ok: false, err: e.code || e.message }));
    r.end();
  });
}

/** 本机系统解析器（跟浏览器/nslookup 走的是同一条路，带 hosts 与本地缓存） */
const resolveLocal = async () => {
  try {
    const r = await dns.promises.lookup(HOST, { all: true });
    return r.map((x) => x.address).join(',');
  } catch (e) { return 'ERR ' + (e.code || e.message); }
};

const doh = (endpoint) => new Promise((res) => {
  const r = https.get(endpoint + encodeURIComponent(HOST) + '&type=A', { timeout: 15000 }, (x) => {
    let a = ''; x.on('data', (d) => a += d);
    x.on('end', () => { try { const j = JSON.parse(a); res((j.Answer || []).map((y) => y.data).join(',') || '无记录'); } catch (e) { res('解析失败'); } });
  });
  r.on('timeout', () => { r.destroy(); res('超时'); });
  r.on('error', (e) => res('ERR ' + (e.code || e.message)));
});

(async () => {
  console.log('诊断目标：' + URL_);
  console.log('主机名：  ' + HOST + '\n');

  // ---------- ① DNS ----------
  console.log('【① DNS 解析】');
  const local = await resolveLocal();
  console.log(info('本机 DNS      → ' + local));
  const ali = await doh('https://223.5.5.5/resolve?name=');
  console.log(info('阿里 DoH      → ' + ali));
  const tx = await doh('https://doh.pub/dns-query?name=');
  console.log(info('腾讯 DoH      → ' + tx));

  const ips = new Set([].concat(local, ali, tx).join(',').split(',').filter((x) => /^\d/.test(x)));
  const dnsPolluted = ips.size > 1;
  console.log(dnsPolluted
    ? bad('各 DNS 结果不一致（' + [...ips].join(' / ') + '）→ 存在 DNS 污染/劫持')
    : ok('各 DNS 结果一致 → DNS 正常'));
  console.log('');

  // 挑一个「最像真的」IP 做后续测试：优先用腾讯 DoH（腾讯自家域名，可信度高）
  const candidates = [].concat(String(tx).split(','), String(ali).split(','), local).filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
  const targetIp = candidates[0];
  console.log(info('后续测试用 IP：' + targetIp + '（取腾讯 DoH 结果）\n'));

  // ---------- ② 带 SNI 握手（正常访问路径） ----------
  console.log('【② 正常路径：TLS 带目标域名 SNI】');
  const withSni = await handshake(HOST, targetIp);
  console.log(withSni.ok ? ok('握手成功 ' + withSni.ms + 'ms') : bad('握手失败：' + withSni.err));
  console.log('');

  // ---------- ③ 无 SNI 握手（决定性判据） ----------
  console.log('【③ 对照：TLS 不带 SNI（裸 IP）】');
  const noSni = await handshake(null, targetIp);
  if (noSni.ok) {
    console.log(ok('握手成功 ' + noSni.ms + 'ms'));
    console.log(info('证书 subject：' + JSON.stringify(noSni.subject)));
    console.log(info('证书 issuer ：' + JSON.stringify(noSni.issuer)));
    console.log(info('证书 SAN    ：' + String(noSni.san).slice(0, 160)));
    console.log(info('有效期至    ：' + noSni.validTo));
    const covers = String(noSni.san || '').includes(HOST.split('.').slice(-2).join('.'));
    console.log(covers
      ? ok('证书覆盖目标域名 → 后端就是该服务，服务本身是活的')
      : bad('证书不覆盖目标域名 → 后端可能不是该服务'));
  } else {
    console.log(bad('握手也失败：' + noSni.err));
  }
  console.log('');

  // ---------- ④ 结论 ----------
  console.log('【④ 判定】');
  if (!withSni.ok && noSni.ok) {
    console.log(bad('带目标 SNI 被阻断、去掉 SNI 能握手 → 【SNI 阻断】'));
    console.log(info('服务是活的，是网络层按域名掐断了 TLS。重新发布解决不了这个问题。'));
  } else if (!withSni.ok && !noSni.ok) {
    console.log(bad('两种方式都连不上 → 服务可能真的停了，或网络整体不可达'));
    console.log(info('先换一个网络（如手机热点）复测；仍不通再考虑重新发布。'));
  } else if (withSni.ok) {
    const app = await httpGet(targetIp, '/api/meta', HOST);
    if (app.ok && app.code === 200) {
      console.log(ok('TLS 与应用层都正常 → 服务健康，当前网络可以访问'));
      console.log(info('HTTP ' + app.code + ' | ' + app.ms + 'ms | ' + (app.ct || '')));
    } else {
      console.log(bad('TLS 通了但应用层异常：' + (app.err || 'HTTP ' + app.code)));
    }
  }
  if (dnsPolluted) console.log(info('另注：DNS 结果不一致，说明该域名在当前网络被污染，即使服务正常也可能解析到错误 IP。'));
})();
