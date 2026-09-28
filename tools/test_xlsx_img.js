'use strict';
// 验证 lib/xlsx.js 的单元格内嵌图片：生成 → 解包 → 校验部件齐全
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildXlsx } = require('../lib/xlsx.js');

const TH = path.join(__dirname, '..', 'data', 'thumbs');
const OUT = path.join(__dirname, '..', 'data', 'tmp-test-img.xlsx');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  ❌ ' + msg); } };

const names = fs.readdirSync(TH).filter((n) => n.endsWith('.jpg')).slice(0, 5);
console.log('样本图片：' + names.length + ' 张');

const rows = [['序号', '编号', '现场图片']];
const images = [];
names.forEach((n, i) => {
  rows.push([i + 1, n.replace(/\.jpg$/, ''), '']);
  images.push({ col: 2, row: i + 1, path: path.join(TH, n), width: 180 });
});

// 第二张表：不贴图，验证混合场景
const buf = buildXlsx([
  { name: '现场图片', rows, images },
  { name: '文字表', rows: [['a', 'b'], ['1', '2']] },
]);
fs.writeFileSync(OUT, buf);
console.log('输出：' + OUT + '  ' + (buf.length / 1024).toFixed(1) + ' KB\n');

// ---- 手工解 ZIP（只读中央目录）----
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
    const lNameLen = buffer.readUInt16LE(lho + 26);
    const lExtraLen = buffer.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buffer.slice(start, start + csize);
    out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const z = unzip(buf);
const has = (n) => z.has(n);
const txt = (n) => (z.get(n) || Buffer.alloc(0)).toString('utf8');

console.log('【1】ZIP 部件');
ok(has('xl/media/image1.jpeg'), 'xl/media/image1.jpeg 存在');
ok(has('xl/media/image5.jpeg'), 'xl/media/image5.jpeg 存在（5 张图都写入）');
ok(z.get('xl/media/image1.jpeg').length === fs.statSync(path.join(TH, names[0])).size, '图片字节与源文件一致（未被二次压缩破坏）');
ok(z.get('xl/media/image1.jpeg')[0] === 0xff && z.get('xl/media/image1.jpeg')[1] === 0xd8, 'JPEG 魔数正确');

console.log('\n【2】Content_Types');
const ct = txt('[Content_Types].xml');
ok(ct.includes('<Default Extension="jpeg" ContentType="image/jpeg"/>'), '声明 jpeg Default');
ok(ct.includes('/xl/drawings/drawing1.xml'), '声明 drawing1 Override');
ok(!ct.includes('drawing2.xml'), '只有 1 张表带图，不生成多余 drawing');

console.log('\n【3】drawing 与 rels');
ok(has('xl/drawings/drawing1.xml'), 'drawing1.xml 存在');
ok(has('xl/drawings/_rels/drawing1.xml.rels'), 'drawing1 rels 存在');
ok(has('xl/worksheets/_rels/sheet1.xml.rels'), 'sheet1 rels 存在');
ok(!has('xl/worksheets/_rels/sheet2.xml.rels'), '无图工作表不生成 rels');

const dw = txt('xl/drawings/drawing1.xml');
ok((dw.match(/<xdr:oneCellAnchor>/g) || []).length === 5, 'drawing1 有 5 个锚点');
ok(dw.includes('<xdr:col>2</xdr:col>'), '锚点列 = 2（0 基，第 3 列）');
ok(dw.includes('<xdr:row>1</xdr:row>'), '锚点行 = 1（0 基，第 2 行）');
ok(dw.includes('r:embed="rId5"'), '第 5 张图引用 rId5');
ok(/<xdr:ext cx="1714500" cy="\d+"\/>/.test(dw), '显示宽度 180px = 1714500 EMU');
ok(dw.includes('noChangeAspect="1"'), '锁定宽高比');

const dr = txt('xl/drawings/_rels/drawing1.xml.rels');
ok((dr.match(/Type="[^"]*\/image"/g) || []).length === 5, 'drawing rels 有 5 条 image 关系');
ok(dr.includes('Target="../media/image1.jpeg"'), 'rId1 -> ../media/image1.jpeg');
ok(dr.includes('Target="../media/image5.jpeg"'), 'rId5 -> ../media/image5.jpeg');

const sr = txt('xl/worksheets/_rels/sheet1.xml.rels');
ok(sr.includes('Target="../drawings/drawing1.xml"') && sr.includes('Id="rId1"'), 'sheet1 rId1 -> drawing1');

console.log('\n【4】worksheet 行高与 drawing 引用');
const s1 = txt('xl/worksheets/sheet1.xml');
ok(s1.includes('<drawing r:id="rId1"/>'), 'sheet1 内引用 drawing rId1');
ok(s1.includes('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'), 'worksheet 根节点声明 xmlns:r');
ok((s1.match(/customHeight="1"/g) || []).length === 5, '5 行都设了自定义行高');
ok(/<col min="3" max="3" width="2[6-9]/.test(s1) || /<col min="3" max="3" width="2[6-9]/.test(s1), '图片列宽被撑到 26+');
ok(s1.indexOf('<autoFilter') < s1.indexOf('<drawing'), 'drawing 在 autoFilter 之后（符合 schema 顺序）');

console.log('\n【5】无图工作表不受影响');
const s2 = txt('xl/worksheets/sheet2.xml');
ok(!s2.includes('<drawing'), 'sheet2 无 drawing 引用');
ok(!/customHeight/.test(s2), 'sheet2 无自定义行高');

console.log('\n【6】尺寸换算');
const st = fs.statSync(path.join(TH, names[0]));
ok(st.size > 1000, '缩略图非空（' + (st.size / 1024).toFixed(1) + ' KB）');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
try { fs.unlinkSync(OUT); } catch (e) {}
process.exit(fail ? 1 : 0);
