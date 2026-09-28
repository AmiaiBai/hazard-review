'use strict';
/**
 * 端到端验证「按 部门 / 时间范围 分档的处理意见」：
 *   备份 submissions.json → 起服务 → POST 分档意见 → /api/my 回读 → 导出表核对 → 还原数据
 * 说明：会短暂改动 data/submissions.json，结束时必定还原（含异常路径）。
 * 同时验证旧的「批次:XX」格式仍能解析（向后兼容）。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = 3197;
const ROOT = path.join(__dirname, '..');
const SUBS = path.join(ROOT, 'data', 'submissions.json');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

function req(method, p, payload) {
  return new Promise((res, rej) => {
    const body = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {} }, (x) => {
      const c = []; x.on('data', (d) => c.push(d)); x.on('end', () => res({ code: x.statusCode, buf: Buffer.concat(c) }));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}

function unzip(buffer) {
  const out = new Map();
  let p = buffer.length - 22;
  while (p >= 0 && buffer.readUInt32LE(p) !== 0x06054b50) p--;
  const count = buffer.readUInt16LE(p + 10);
  let off = buffer.readUInt32LE(p + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = buffer.readUInt16LE(off + 28);
    const extraLen = buffer.readUInt16LE(off + 30);
    const cmtLen = buffer.readUInt16LE(off + 32);
    const lho = buffer.readUInt32LE(off + 42);
    const name = buffer.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const method = buffer.readUInt16LE(off + 10);
    const csize = buffer.readUInt32LE(off + 20);
    const start = lho + 30 + buffer.readUInt16LE(lho + 26) + buffer.readUInt16LE(lho + 28);
    const raw = buffer.slice(start, start + csize);
    out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const NAME = '__scope测试员__';

(async () => {
  const backup = fs.readFileSync(SUBS);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  });

  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { await req('GET', '/api/meta'); up = true; } catch (e) { await new Promise((r) => setTimeout(r, 150)); }
    }
    ok(up, '服务已就绪');

    console.log('\n【1】写入分档意见');
    const SCOPE_DEPT_WEEK = '部门:甲车间|时间:2026-09-11~2026-09-17';
    const SCOPE_TIME = '时间:2026-08-01~2026-08-31';
    const SCOPE_DEPT = '部门:乙车间';
    const SCOPE_LEGACY = '批次:第1批';
    const r1 = await req('POST', '/api/submit', { reviewer: NAME, dept: '甲车间', scope: SCOPE_DEPT_WEEK, general: '甲车间近一周：依据引用需复核' });
    ok(r1.code === 200 && JSON.parse(r1.buf).ok, '提交「部门 + 时间范围」成功');
    const r2 = await req('POST', '/api/submit', { reviewer: NAME, dept: '甲车间', scope: SCOPE_TIME, general: '8月：整体识别准确' });
    ok(r2.code === 200 && JSON.parse(r2.buf).ok, '提交「时间范围」成功');
    const r3 = await req('POST', '/api/submit', { reviewer: NAME, dept: '甲车间', scope: SCOPE_DEPT, general: '乙车间：建议增加漏检复核' });
    ok(r3.code === 200 && JSON.parse(r3.buf).ok, '提交「部门」成功');
    const r4 = await req('POST', '/api/submit', { reviewer: NAME, dept: '甲车间', scope: '全部', general: '总体：口径统一' });
    ok(r4.code === 200 && JSON.parse(r4.buf).ok, '提交「全部」成功');
    const r5 = await req('POST', '/api/submit', { reviewer: NAME, dept: '甲车间', scope: SCOPE_LEGACY, general: '旧格式批次意见' });
    ok(r5.code === 200 && JSON.parse(r5.buf).ok, '提交旧格式「批次:第1批」成功（向后兼容）');

    console.log('\n【2】回读 /api/my');
    const my = JSON.parse((await req('GET', '/api/my?reviewer=' + encodeURIComponent(NAME))).buf.toString('utf8'));
    ok(my.generals && Object.keys(my.generals).length === 5, `generals 有 5 档（实得 ${Object.keys(my.generals || {}).length}）`);
    ok(my.generals[SCOPE_DEPT_WEEK] === '甲车间近一周：依据引用需复核', '部门 + 时间范围档内容正确');
    ok(my.generals[SCOPE_TIME] === '8月：整体识别准确', '时间范围档内容正确');
    ok(my.generals[SCOPE_DEPT] === '乙车间：建议增加漏检复核', '部门档内容正确');
    ok(my.generals[SCOPE_LEGACY] === '旧格式批次意见', '旧格式批次档内容正确');
    ok(my.general === '旧格式批次意见', 'general 保留为最近一次（兼容旧逻辑）');

    console.log('\n【3】导出表「处理意见」');
    const xl = (await req('GET', '/api/export.xlsx')).buf;
    const z = unzip(xl);
    const wb = z.get('xl/workbook.xml').toString('utf8');
    const names = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    const idx = names.indexOf('处理意见') + 1;
    ok(idx > 0, '存在「处理意见」工作表');
    const sheet = z.get(`xl/worksheets/sheet${idx}.xml`).toString('utf8');
    ok(sheet.includes('意见归属') && sheet.includes('归属类型'), '表头正确');
    ok(sheet.includes('甲车间 · 2026-09-11 ~ 2026-09-17') && sheet.includes('部门+时间段'), '含「部门 + 时间范围」档行');
    ok(sheet.includes('2026-08-01 ~ 2026-08-31') && sheet.includes('时间段'), '含「时间范围」档行');
    ok(sheet.includes('乙车间') && sheet.includes('部门'), '含「部门」档行');
    ok(sheet.includes('全部数据') && sheet.includes('全部'), '含「全部」档行');
    ok(sheet.includes('第1批') && sheet.includes('批次'), '旧格式「批次」档仍能解析');
    ok(/评审人\d/.test(sheet), '匿名导出的评审人已换成代号');
    ok(!sheet.includes(NAME), '匿名导出不含评审人真名');

    console.log('\n【4】旧数据未被破坏');
    const subs = JSON.parse(fs.readFileSync(SUBS, 'utf8'));
    const before = JSON.parse(backup.toString('utf8'));
    ok(subs.items.length === before.items.length,
      `原有 ${before.items.length} 条评分保留（实得 ${subs.items.length}）`);
    ok(Object.keys(subs.reviewers).length === Object.keys(before.reviewers).length + 1,
      `原 ${Object.keys(before.reviewers).length} 人 + 测试员 = ${Object.keys(subs.reviewers).length}`);
    // 评审人姓名从「备份的原始数据」里取，不要写死 ——
    // 这个测试跑在真实数据上，写死等于把真实姓名抄进代码（仓库是要推出去的）。
    const beforeNames = Object.keys(before.reviewers);
    ok(beforeNames.every((n) => !!subs.reviewers[n]), `原有 ${beforeNames.length} 位评审人记录仍在`);
    ok(subs.items.every((it) => !!before.items.find((x) =>
      x.reviewer === it.reviewer && x.recordId === it.recordId && x.hazardNo === it.hazardNo)),
      '原有评分逐条都还在（无覆盖丢失）');
  } catch (e) {
    console.error('异常：', e);
    fail++;
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(SUBS, backup);
    console.log('\n（已还原 data/submissions.json）');
  }

  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
