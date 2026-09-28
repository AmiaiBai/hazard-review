'use strict';
/**
 * 极简 xlsx 生成器（零依赖）：只用到 Node 内置 zlib。
 * 支持：多工作表、表头样式、自动列宽、冻结首行、长文本自动换行、单元格内嵌图片。
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const EMU_PER_PX = 9525;   // 1 px @96dpi
const PX_PER_WIDTH_UNIT = 7;   // Excel 列宽单位 ≈ 7px

// 图片扩展名 -> Content-Type
const IMAGE_CT = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
};

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- 最小 ZIP 打包 ----------
function zipFiles(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    // 图片本身已压缩，再高压缩率地 deflate 纯属浪费 CPU
    const deflated = zlib.deflateRawSync(raw, { level: f.level == null ? 9 : f.level });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0x0800, 6);  // UTF-8 flag
    local.writeUInt16LE(8, 8);       // deflate
    local.writeUInt16LE(0, 10);      // time
    local.writeUInt16LE(0x21, 12);   // date (1996-01-01 合法值)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + deflated.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ---------- XML 工具 ----------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// 中文字符按 2 个宽度估算，用于自动列宽
function displayWidth(v) {
  const s = String(v == null ? '' : v);
  let w = 0;
  for (const ch of s) w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return w;
}

/** 从 JPEG 字节流里读出宽高（扫 SOF 段），失败返回 null */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** 从 PNG 字节流里读出宽高 */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** 图片实际像素尺寸（用于保持宽高比）；读不出来就退回 4:3 */
function imageSize(buf, ext) {
  const s = ext === 'png' ? pngSize(buf) : jpegSize(buf);
  return s && s.w > 0 && s.h > 0 ? s : { w: 320, h: 240 };
}

/**
 * @param {Array<{name:string, rows:Array<Array<any>>, widths?:number[], wrap?:number[],
 *                images?:Array<{col:number,row:number,path:string,width?:number}>}>} sheets
 *        images 的 col/row 为 0 基单元格坐标，锚在该格左上角；width 为显示宽度（px，默认 180）
 * @returns {Buffer}
 */
function buildXlsx(sheets) {
  const sheetXmls = [];
  const sheetNames = [];
  const mediaFiles = [];        // { name, buf } 去重后的图片
  const mediaIndex = new Map(); // 绝对路径 -> media 序号
  const drawingSheets = [];     // 需要 drawing 的工作表：{ sheetIdx, drawingIdx, images }
  const contentExts = new Set();

  sheets.forEach((sheet, si) => {
    const rows = sheet.rows || [];
    const nCols = rows.reduce((m, r) => Math.max(m, r.length), 1);
    const wrapSet = new Set(sheet.wrap || []);

    // 自动列宽
    const widths = [];
    for (let c = 0; c < nCols; c++) {
      let w = sheet.widths && sheet.widths[c] ? sheet.widths[c] : 8;
      if (!sheet.widths) {
        for (let r = 0; r < Math.min(rows.length, 400); r++) {
          const v = rows[r] && rows[r][c];
          if (v != null && v !== '') w = Math.max(w, displayWidth(v) + 2);
        }
        w = Math.min(w, 60);
      }
      widths.push(w);
    }

    // ---- 图片：读尺寸、按行分组、撑开列宽与行高 ----
    const rawImages = sheet.images || [];
    const rowH = new Map();          // 行号(0基) -> 需要的最小行高(px)
    const imgPlan = [];              // { col,row,mediaIdx,ext,cxPx,cyPx }
    let imgCol = -1;
    let imgMaxW = 0;

    for (const im of rawImages) {
      let buf;
      try { buf = fs.readFileSync(im.path); } catch (e) { continue; }
      const ext = (path.extname(im.path).replace('.', '') || 'jpeg').toLowerCase();
      const normExt = ext === 'jpg' ? 'jpeg' : ext;
      contentExts.add(normExt);

      let idx = mediaIndex.get(im.path);
      if (idx === undefined) {
        idx = mediaFiles.length;
        mediaFiles.push({ name: `xl/media/image${idx + 1}.${normExt}`, buf, level: 0 });
        mediaIndex.set(im.path, idx);
      }

      const px = imageSize(buf, normExt);
      const dispW = im.width || 180;
      const dispH = Math.max(24, Math.round(dispW * px.h / px.w));
      imgPlan.push({ col: im.col, row: im.row, mediaIdx: idx, ext: normExt, cxPx: dispW, cyPx: dispH });
      imgCol = im.col;
      imgMaxW = Math.max(imgMaxW, dispW);
      rowH.set(im.row, Math.max(rowH.get(im.row) || 0, dispH + 6));
    }
    if (imgCol >= 0) widths[imgCol] = Math.max(widths[imgCol] || 8, Math.ceil(imgMaxW / PX_PER_WIDTH_UNIT) + 1);

    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' +
      '<sheetData>';

    rows.forEach((row, ri) => {
      const cells = (row || []).map((v, ci) => {
        const ref = colName(ci) + (ri + 1);
        if (v === null || v === undefined || v === '') {
          return `<c r="${ref}"${ri === 0 ? ' s="1"' : ''}/>`;
        }
        if (typeof v === 'number' && isFinite(v)) {
          return `<c r="${ref}"${ri === 0 ? ' s="1"' : ''}><v>${v}</v></c>`;
        }
        const style = ri === 0 ? 1 : (wrapSet.has(ci) ? 2 : 0);
        return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }).join('');
      const h = rowH.get(ri);
      xml += h ? `<row r="${ri + 1}" ht="${(h * 0.75).toFixed(1)}" customHeight="1">${cells}</row>`
               : `<row r="${ri + 1}">${cells}</row>`;
    });

    xml += '</sheetData><autoFilter ref="A1:' + colName(nCols - 1) + Math.max(rows.length, 1) + '"/>';

    if (imgPlan.length) {
      drawingSheets.push({ sheetIdx: si, drawingIdx: drawingSheets.length + 1, images: imgPlan });
      xml += '<drawing r:id="rId1"/>';
    }
    xml += '</worksheet>';
    sheetXmls.push(xml);
    sheetNames.push(sheet.name || `Sheet${si + 1}`);
  });

  const files = [];

  files.push({
    name: '[Content_Types].xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      [...contentExts].map((e) => `<Default Extension="${e}" ContentType="${IMAGE_CT[e] || 'image/' + e}"/>`).join('') +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheetNames.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      drawingSheets.map((ds) => `<Override PartName="/xl/drawings/drawing${ds.drawingIdx}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`).join('') +
      '</Types>',
  });

  files.push({
    name: '_rels/.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  });

  files.push({
    name: 'xl/workbook.xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + sheetNames.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets>' +
      '</workbook>',
  });

  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheetNames.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheetNames.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
  });

  files.push({
    name: 'xl/styles.xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="等线"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FF1F3864"/><name val="等线"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
      '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
  });

  sheetXmls.forEach((xml, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml });
  });

  // ---- 图片二进制（原样存储，不再二次压缩）----
  for (const m of mediaFiles) files.push({ name: m.name, data: m.buf, level: m.level });

  // ---- 每个带图工作表：drawingN.xml + 两层 rels ----
  for (const ds of drawingSheets) {
    const anchors = ds.images.map((im, k) => {
      const cx = Math.round(im.cxPx * EMU_PER_PX);
      const cy = Math.round(im.cyPx * EMU_PER_PX);
      // oneCellAnchor：锚在单元格左上角，尺寸固定，不随行列拉伸
      return '<xdr:oneCellAnchor>' +
        `<xdr:from><xdr:col>${im.col}</xdr:col><xdr:colOff>0</xdr:colOff>` +
        `<xdr:row>${im.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${cx}" cy="${cy}"/>` +
        '<xdr:pic>' +
        `<xdr:nvPicPr><xdr:cNvPr id="${k + 1}" name="Picture ${k + 1}"/>` +
        '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
        '<xdr:blipFill>' +
        '<a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
        ` r:embed="rId${k + 1}"/><a:stretch><a:fillRect/></a:stretch>` +
        '</xdr:blipFill>' +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>' +
        '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
    }).join('');

    files.push({
      name: `xl/drawings/drawing${ds.drawingIdx}.xml`,
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"' +
        ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        anchors + '</xdr:wsDr>',
    });

    files.push({
      name: `xl/drawings/_rels/drawing${ds.drawingIdx}.xml.rels`,
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        ds.images.map((im, k) =>
          `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"` +
          ` Target="../media/image${im.mediaIdx + 1}.${im.ext}"/>`).join('') +
        '</Relationships>',
    });

    files.push({
      name: `xl/worksheets/_rels/sheet${ds.sheetIdx + 1}.xml.rels`,
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing"' +
        ` Target="../drawings/drawing${ds.drawingIdx}.xml"/>` +
        '</Relationships>',
    });
  }

  return zipFiles(files);
}

module.exports = { buildXlsx };
