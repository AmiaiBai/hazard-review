'use strict';
// 端到端验证：起服务 → 拉 /api/export.xlsx → 校验图片与表结构
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = 3199;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'export-test.xlsx');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✅ ' + m); } else { fail++; console.log('  ❌ ' + m); } };

function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ code: r.statusCode, buf: Buffer.concat(c) }));
    }).on('error', rej);
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

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

  // 等端口就绪
  for (let i = 0; i < 40; i++) {
    try { await get('/api/meta'); break; } catch (e) { await new Promise((r) => setTimeout(r, 150)); }
  }

  try {
    console.log('【1】导出接口');
    const t0 = Date.now();
    const r1 = await get('/api/export.xlsx');
    const ms1 = Date.now() - t0;
    ok(r1.code === 200, `HTTP 200（实得 ${r1.code}）`);
    ok(r1.buf.length > 100000, `文件体积 ${(r1.buf.length / 1024 / 1024).toFixed(2)} MB（含图片）`);
    console.log(`     ↳ 首次构建 ${ms1} ms`);

    const t1 = Date.now();
    const r2 = await get('/api/export.xlsx');
    const ms2 = Date.now() - t1;
    ok(r2.buf.length === r1.buf.length, '二次请求字节数一致（缓存）');
    console.log(`     ↳ 二次（缓存）${ms2} ms`);
    ok(ms2 < ms1 / 2, '缓存后明显更快');

    fs.writeFileSync(OUT, r1.buf);
    const z = unzip(r1.buf);
    const txt = (n) => (z.get(n) || Buffer.alloc(0)).toString('utf8');

    console.log('\n【2】工作表清单');
    const wb = txt('xl/workbook.xml');
    const names = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    console.log('     ' + names.join(' | '));
    // 匿名（全员可见）的全量导出不含「部门汇总」—— 那是管理员专属的聚合视图，
    // 挡在这里是必须的：否则下载个 Excel 就绕过了「按部门查看」的密码锁。
    ok(names.length === 11, `匿名导出 11 张工作表（实得 ${names.length}）`);
    ok(!names.includes('部门汇总'), '匿名导出不含「部门汇总」（管理员专属）');
    ok(names[0] === '评分明细', '第 1 张 = 评分明细');
    ok(names[1] === '现场图片', '第 2 张 = 现场图片');
    ok(names.includes('月度汇总'), '含月度汇总');
    ok(!names.includes('批次汇总'), '已无「批次汇总」（批次概念已移除）');
    ok(names.includes('处理意见'), '含处理意见（按 部门 / 时间范围 分档）');
    ok(names.includes('漏检复核'), '含漏检复核');
    ok(names.includes('重大隐患识别出错'), '含「重大隐患识别出错」（报出来但报错，与漏检并列）');
    ok(names.includes('重大隐患总览'), '含「重大隐患总览」');

    console.log('\n【2.5】不再有「批次」列、改为「识别时间」');
    ok(/识别时间/.test(txt('xl/worksheets/sheet1.xml')), '评分明细含「识别时间」列');
    ok(!/批次/.test(txt('xl/worksheets/sheet1.xml')), '评分明细无「批次」列');
    ok(!/批次/.test(txt('xl/worksheets/sheet2.xml')), '现场图片无「批次」列');
    ok(!/批次/.test(txt('xl/worksheets/sheet3.xml')), '隐患汇总无「批次」列');
    ok(/识别时间/.test(txt('xl/worksheets/sheet3.xml')), '隐患汇总含「识别时间」列');
    // 匿名导出：部门 / 检查人整列裁掉（管理员专属）。留一排空列会让人以为数据缺了，还占版面。
    ok(!/检查人/.test(txt('xl/worksheets/sheet3.xml')), '匿名导出不含「检查人」列（管理员专属）');
    ok(!/部门/.test(txt('xl/worksheets/sheet3.xml')), '匿名导出不含「部门」列（管理员专属）');
    ok(/人工认定严重度/.test(txt('xl/worksheets/sheet3.xml')), '隐患汇总含「人工认定严重度」列');
    ok(/识别结论/.test(txt('xl/worksheets/sheet3.xml')), '隐患汇总含「识别结论」列');
    ok(/月份/.test(txt(`xl/worksheets/sheet${names.indexOf('月度汇总') + 1}.xml`)), '月度汇总表头为「月份」');

    console.log('\n【3】图片部件');
    const media = [...z.keys()].filter((k) => k.startsWith('xl/media/'));
    ok(media.length > 0, `写入 ${media.length} 张图片（已按记录去重）`);
    const totalBytes = media.reduce((a, k) => a + z.get(k).length, 0);
    console.log(`     ↳ 图片合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    ok(media.every((k) => z.get(k)[0] === 0xff && z.get(k)[1] === 0xd8), '全部是合法 JPEG');
    ok(z.has('xl/drawings/drawing1.xml'), 'drawing1.xml 存在');
    ok(z.has('xl/drawings/_rels/drawing1.xml.rels'), 'drawing1 rels 存在');

    console.log('\n【4】现场图片表锚点');
    const d1 = txt('xl/drawings/drawing1.xml');
    const anchors = (d1.match(/<xdr:oneCellAnchor>/g) || []).length;
    console.log(`     ↳ 锚点数 ${anchors}`);
    ok(anchors >= 500, `锚点覆盖全部隐患行（${anchors} ≥ 507）`);
    // 「现场图片」表裁掉了「部门 / 检查人员」两列，图片列从第 7 列（0-based 6）挪到第 5 列（0-based 4）。
    // 图片锚必须跟着挪 —— 忘了挪图就挂到隔壁列去了（裁列时最容易漏的就是这里）。
    ok(d1.includes('<xdr:col>4</xdr:col>'), '匿名版图片锚跟着裁列挪到第 5 列（0-based 4）');
    ok(d1.includes('r:embed="rId'), '含图片引用');

    const s1 = txt('xl/worksheets/sheet2.xml');   // sheet2 = 现场图片
    ok(s1.includes('现场图片'), '现场图片表含表头');
    ok(s1.includes('<drawing r:id="rId1"/>'), '现场图片表引用了 drawing');

    console.log('\n【5】漏检复核表也带图');
    const s6idx = names.indexOf('漏检复核') + 1;
    const s6 = txt(`xl/worksheets/sheet${s6idx}.xml`);
    ok(s6.includes('现场图片'), '漏检复核表含「现场图片」列');
    const rel6 = txt(`xl/worksheets/_rels/sheet${s6idx}.xml.rels`);
    ok(rel6.includes('drawing'), '漏检复核表挂上了 drawing');

    console.log('\n【6】Content_Types 完整');
    const ct = txt('[Content_Types].xml');
    ok(ct.includes('<Default Extension="jpeg"'), '声明 jpeg');
    ok((ct.match(/drawing\d+\.xml/g) || []).length >= 2, '声明了 2 个以上 drawing');
    ok(!/Target="[^"]*undefined/.test(txt('xl/drawings/_rels/drawing1.xml.rels')), 'rels 无 undefined 路径');
  } catch (e) {
    console.error('异常：', e);
    fail++;
  } finally {
    child.kill();
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
