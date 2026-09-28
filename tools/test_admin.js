// jsdom 冒烟测试：管理页统计渲染 + 逐条隐患 / 漏检复核 两张表的筛选
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');   // 别写死绝对路径，换台机器就找不到
const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const statsPath = process.argv[2];
const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_SIZE = 20;

/** 用给定 stats 起一个 jsdom 环境，返回常用句柄 */
async function boot(statsData, opts) {
  const o = opts || {};
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = o.fetch || (async () => ({ ok: true, json: async () => statsData }));
      if (o.token) { try { w.sessionStorage.setItem('hr_admin_token', o.token); } catch (e) { /* ignore */ } }
      w.addEventListener('error', (e) => errors.push(e.message || String(e.error)));
      w.onerror = (m) => errors.push(String(m));
      w.onunhandledrejection = (e) => errors.push('unhandled: ' + e.reason);
    },
  });
  const { window } = dom;
  await wait(400);
  const doc = window.document;
  const $ = (id) => doc.getElementById(id);
  const rowsOf = (id) => $('t' + id).querySelectorAll('tbody tr');
  const dataRows = (id) => [...rowsOf(id)].filter((r) => !r.querySelector('.empty'));
  // 分页后：表里只渲染当页，真实条数看「共 N 条」计数
  const countOf = (id) => Number((($(id).textContent.match(/共\s*(\d+)\s*条/) || [])[1]) || 0);
  const pageRows = (expect) => Math.min(expect, PAGE_SIZE);
  return { window, doc, $, dataRows, countOf, pageRows, errors, close: () => window.close() };
}

/** 主场景：真实 stats 快照 */
async function main() {
  const { window, doc, $, dataRows, countOf, pageRows, errors } = await boot(stats);

  console.log('\n【1】基础渲染');
  check('KPI 已渲染 5 张', $('kpis').children.length === 5, $('kpis').children.length);
  check('维度表现已渲染 4 行', $('dims').children.length === 4, $('dims').children.length);
  check('维度行含样本与波动', /样本/.test($('dims').textContent));
  check('部门表已渲染', dataRows('Dept').length > 0);
  check('评审人表已渲染', dataRows('Rev').length > 0);
  check('评审人表含「漏检复核」列', /漏检复核/.test($('tRev').textContent));
  // 「部门」列只在管理员解锁后出现（登录页已不收部门，对新评审人恒为空）
  check('管理员解锁后评审人表含「部门」列',
    /部门/.test($('tRev').querySelector('thead').textContent),
    $('tRev').querySelector('thead').textContent);
  check('逐条隐患表已渲染', dataRows('Hz').length > 0, dataRows('Hz').length + ' 行');
  check('漏检复核表已渲染', dataRows('None').length > 0, dataRows('None').length + ' 行');
  check('漏检 KPI 已渲染（5 张，含重大漏检）', $('noneKpi').children.length === 5, $('noneKpi').children.length);
  check('漏检 KPI 含「重大漏检」', /重大漏检/.test($('noneKpi').textContent));

  console.log('\n【2】逐条隐患筛选');
  const totalHz = countOf('hzCount');
  const hzRows = stats.hazardRows;

  // 部门
  const dept = [...new Set(hzRows.map((h) => h.dept || '未标注'))].sort()[0];
  $('hzDept').value = dept;
  $('hzDept').dispatchEvent(new window.Event('change'));
  await wait(50);
  const deptExpect = hzRows.filter((h) => (h.dept || '未标注') === dept).length;
  check('按部门筛选生效', countOf('hzCount') === deptExpect, countOf('hzCount') + ' vs ' + deptExpect);
  check('筛选计数已更新', new RegExp('共 ' + deptExpect + ' 条').test($('hzCount').textContent), $('hzCount').textContent);

  // 判定：有存疑
  $('hzVerdict').value = 'issue';
  $('hzVerdict').dispatchEvent(new window.Event('change'));
  await wait(50);
  const issueExpect = hzRows.filter((h) => (h.dept || '未标注') === dept && h.issues > 0).length;
  check('「有存疑」筛选生效', countOf('hzCount') === issueExpect, countOf('hzCount') + ' vs ' + issueExpect);

  // 重置
  $('hzReset').click();
  await wait(50);
  check('重置后恢复全部', countOf('hzCount') === totalHz, countOf('hzCount') + ' vs ' + totalHz);
  check('重置后下拉已复位', $('hzDept').value === 'all' && $('hzVerdict').value === 'all' && $('hzSort').value === 'score-asc');

  // 均分区间
  $('hzVerdict').value = 'low';
  $('hzVerdict').dispatchEvent(new window.Event('change'));
  await wait(50);
  const lowExpect = hzRows.filter((h) => h.overall != null && h.overall < 60).length;
  check('「均分低于 60」筛选生效', countOf('hzCount') === lowExpect, countOf('hzCount') + ' vs ' + lowExpect);
  $('hzReset').click();
  await wait(50);

  // 关键词
  const kw = String(hzRows[0].recordId).slice(-4);
  $('hzKey').value = kw;
  $('hzKey').dispatchEvent(new window.Event('input'));
  await wait(320);
  const kwExpect = hzRows.filter((h) => (h.recordId + ' ' + (h.name || '')).includes(kw)).length;
  check('关键词筛选生效', countOf('hzCount') === kwExpect, countOf('hzCount') + ' vs ' + kwExpect);
  $('hzReset').click();
  await wait(50);

  // 排序
  $('hzSort').value = 'score-desc';
  $('hzSort').dispatchEvent(new window.Event('change'));
  await wait(50);
  const first = dataRows('Hz')[0];
  const firstScore = Number(first.querySelectorAll('td')[11].textContent.trim());   // 第 12 列为综合均分（记录编号/识别时间/部门/检查人/隐患名称/严重度/参评/真实性/描述/依据/引用 各占一列）
  const maxScore = Math.max(...hzRows.map((h) => (h.overall == null ? -1 : h.overall)));
  check('均分高→低排序生效', firstScore === maxScore, firstScore + ' vs ' + maxScore);
  $('hzReset').click();
  await wait(50);

  console.log('\n【2.9】检查人筛选（方便按人切分任务）');
  const inspOf = (v) => v || '未标注';
  const inspList = [...new Set(hzRows.map((h) => inspOf(h.inspector)))].sort();
  check('检查人下拉已填充', $('hzInspector').children.length === inspList.length + 1,
    $('hzInspector').children.length + ' 项 vs 期望 ' + (inspList.length + 1));
  check('首项是「全部检查人」', $('hzInspector').children[0].value === 'all' &&
    $('hzInspector').children[0].textContent === '全部检查人', $('hzInspector').children[0].textContent);
  check('下拉项与数据里的检查人一致',
    [...$('hzInspector').children].slice(1).map((o) => o.value).join(',') === inspList.join(','),
    [...$('hzInspector').children].slice(1).map((o) => o.value).join(','));

  // 挑一个检查人验证筛选结果
  const pickInsp = inspList.find((v) => hzRows.filter((h) => inspOf(h.inspector) === v).length > 0);
  $('hzInspector').value = pickInsp;
  $('hzInspector').dispatchEvent(new window.Event('change'));
  await wait(60);
  const inspExpect = hzRows.filter((h) => inspOf(h.inspector) === pickInsp).length;
  check('按检查人筛选生效（' + pickInsp + '）', countOf('hzCount') === inspExpect,
    countOf('hzCount') + ' vs ' + inspExpect);
  check('筛出的行检查人都是所选的那个',
    dataRows('Hz').every((r) => r.querySelectorAll('td')[3].textContent.trim() === pickInsp),
    [...dataRows('Hz')].map((r) => r.querySelectorAll('td')[3].textContent.trim()).join(','));

  // 部门 + 检查人联合筛选
  const deptOfT = (d) => d || '未标注';
  const pickDept = deptOfT(hzRows.find((h) => inspOf(h.inspector) === pickInsp).dept);
  $('hzDept').value = pickDept;
  $('hzDept').dispatchEvent(new window.Event('change'));
  await wait(60);
  const bothExpect = hzRows.filter((h) => deptOfT(h.dept) === pickDept && inspOf(h.inspector) === pickInsp).length;
  check('部门 + 检查人可联合筛选', countOf('hzCount') === bothExpect,
    countOf('hzCount') + ' vs ' + bothExpect);

  $('hzReset').click();
  await wait(60);
  check('重置后检查人归位', $('hzInspector').value === 'all' && $('hzDept').value === 'all',
    $('hzInspector').value + ' / ' + $('hzDept').value);
  check('重置后条数回到全量', countOf('hzCount') === hzRows.length,
    countOf('hzCount') + ' vs ' + hzRows.length);

  // 检查人下拉随部门收窄
  const fullInspCount = $('hzInspector').children.length;
  const someDept = [...$('hzDept').children].map((o) => o.value).find((v) => v !== 'all');
  $('hzDept').value = someDept;
  $('hzDept').dispatchEvent(new window.Event('change'));
  await wait(60);
  const deptInspList = [...new Set(hzRows.filter((h) => deptOfT(h.dept) === someDept).map((h) => inspOf(h.inspector)))].sort();
  check('检查人下拉随部门收窄（' + someDept + '）',
    $('hzInspector').children.length === deptInspList.length + 1,
    $('hzInspector').children.length + ' 项 vs 期望 ' + (deptInspList.length + 1) + '（全部部门时 ' + fullInspCount + ' 项）');
  check('收窄后只含该部门的检查人',
    [...$('hzInspector').children].slice(1).map((o) => o.value).join(',') === deptInspList.join(','),
    [...$('hzInspector').children].slice(1).map((o) => o.value).join(','));

  // 选中的检查人不在新部门里 → 回落「全部」，不能筛出必然 0 条的组合
  const inspA = inspList.find((v) => hzRows.some((h) => inspOf(h.inspector) === v));
  const deptHasA = [...new Set(hzRows.filter((h) => inspOf(h.inspector) === inspA).map((h) => deptOfT(h.dept)))];
  const deptNoA = [...new Set(hzRows.map((h) => deptOfT(h.dept)))].find((d) => !deptHasA.includes(d));
  if (deptNoA) {
    $('hzDept').value = deptHasA[0];
    $('hzDept').dispatchEvent(new window.Event('change'));
    await wait(60);
    $('hzInspector').value = inspA;
    $('hzInspector').dispatchEvent(new window.Event('change'));
    await wait(60);
    check('先选中检查人 ' + inspA + '（部门 ' + deptHasA[0] + '）', $('hzInspector').value === inspA, $('hzInspector').value);
    $('hzDept').value = deptNoA;
    $('hzDept').dispatchEvent(new window.Event('change'));
    await wait(60);
    check('切到不含该检查人的部门 → 自动回落「全部」', $('hzInspector').value === 'all', $('hzInspector').value);
    check('回落后台数 = 该部门全量', countOf('hzCount') === hzRows.filter((h) => deptOfT(h.dept) === deptNoA).length,
      countOf('hzCount') + ' vs ' + hzRows.filter((h) => deptOfT(h.dept) === deptNoA).length);
  }

  $('hzReset').click();
  await wait(60);
  check('再次重置后检查人列表放回全量', $('hzInspector').children.length === fullInspCount,
    $('hzInspector').children.length + ' vs ' + fullInspCount);

  // 漏检复核卡同样有检查人筛选
  const nInspList = [...new Set((stats.noneRows || []).map((n) => inspOf(n.inspector)))].sort();
  check('漏检复核也有检查人筛选', $('nInspector').children.length === nInspList.length + 1,
    $('nInspector').children.length + ' 项 vs 期望 ' + (nInspList.length + 1));
  const pickNInsp = nInspList.find((v) => (stats.noneRows || []).filter((n) => inspOf(n.inspector) === v).length > 0);
  $('nInspector').value = pickNInsp;
  $('nInspector').dispatchEvent(new window.Event('change'));
  await wait(60);
  const nInspExpect = (stats.noneRows || []).filter((n) => inspOf(n.inspector) === pickNInsp).length;
  check('漏检复核按检查人筛选生效（' + pickNInsp + '）', countOf('nCount') === nInspExpect,
    countOf('nCount') + ' vs ' + nInspExpect);
  $('nReset').click();
  await wait(60);

  console.log('\n【3】漏检复核筛选');
  const noneRows = stats.noneRows || [];
  const totalNone = countOf('nCount');
  check('漏检表全量条数正确', totalNone === noneRows.length, totalNone + ' vs ' + noneRows.length);
  check('漏检表首页只渲染一页', dataRows('None').length === pageRows(noneRows.length),
    dataRows('None').length + ' vs ' + pageRows(noneRows.length));

  const st = 'suspected';
  $('nStatus').value = st;
  $('nStatus').dispatchEvent(new window.Event('change'));
  await wait(50);
  const stExpect = noneRows.filter((n) => n.status === st).length;
  check('按复核状态筛选生效', countOf('nCount') === stExpect, countOf('nCount') + ' vs ' + stExpect);
  check('漏检计数已更新', new RegExp('共 ' + stExpect + ' 条').test($('nCount').textContent), $('nCount').textContent);

  $('nStatus').value = 'todo';
  $('nStatus').dispatchEvent(new window.Event('change'));
  await wait(50);
  const todoExpect = noneRows.filter((n) => n.status === 'todo').length;
  check('「未复核」筛选生效', countOf('nCount') === todoExpect, countOf('nCount') + ' vs ' + todoExpect);

  $('nReset').click();
  await wait(50);
  check('重置后恢复全部漏检', countOf('nCount') === totalNone, countOf('nCount') + ' vs ' + totalNone);

  // 严重度筛选（只对「疑似漏检」有意义）
  check('漏检表含「严重度」列', /严重度/.test($('tNone').textContent));
  $('nSev').value = 'critical';
  $('nSev').dispatchEvent(new window.Event('change'));
  await wait(50);
  const critExpect = noneRows.filter((n) => n.status === 'suspected' && n.severity === 'critical').length;
  check('按「重大隐患漏检」筛选生效', countOf('nCount') === critExpect, countOf('nCount') + ' vs ' + critExpect);
  $('nSev').value = 'all';
  $('nSev').dispatchEvent(new window.Event('change'));
  await wait(50);
  check('严重度重置回全部', countOf('nCount') === totalNone, countOf('nCount') + ' vs ' + totalNone);

  // 部门
  const nDept = [...new Set(noneRows.map((n) => n.dept || '未标注'))].sort()[0];
  $('nDept').value = nDept;
  $('nDept').dispatchEvent(new window.Event('change'));
  await wait(50);
  const nDeptExpect = noneRows.filter((n) => (n.dept || '未标注') === nDept).length;
  check('漏检按部门筛选生效', countOf('nCount') === nDeptExpect, countOf('nCount') + ' vs ' + nDeptExpect);
  $('nReset').click();
  await wait(50);

  console.log('\n【4】按月份（数据按识别时间顺承，不再有批次）');
  const monthRows = stats.monthRows || [];
  check('逐条表含「识别时间」列', /识别时间/.test($('tHz').textContent));
  check('逐条表不含「批次」列', !/批次/.test($('tHz').textContent));
  check('漏检表含「识别时间」列', /识别时间/.test($('tNone').textContent));
  check('漏检表不含「批次」列', !/批次/.test($('tNone').textContent));
  check('已无批次下拉控件', !$('hzBatch') && !$('nBatch'));
  check('月份汇总卡片显示', $('cardMonth').style.display !== 'none' || monthRows.length === 0);
  if (monthRows.length) {
    check('月份汇总表已渲染', dataRows('Month').length === monthRows.length,
      dataRows('Month').length + ' vs ' + monthRows.length);
    check('月份表含「时间范围」列', /时间范围/.test($('tMonth').textContent));
    const labels = monthRows.map((m) => m.label);
    check('月份按时间升序排列', labels.join() === labels.slice().sort().join(), labels.join(','));
    check('月份表显示覆盖部门', (monthRows[0].depts || []).length > 0, JSON.stringify(monthRows[0].depts));
    check('月份表有进度百分比', /%/.test($('tMonth').textContent));
  }

  // 逐条表首列仍是记录编号，并含「严重度」「检查人」列
  const hzFirst = dataRows('Hz')[0];
  check('逐条表首列 = 记录编号', hzFirst.querySelectorAll('td').length === 14,
    hzFirst.querySelectorAll('td').length + ' 列');
  const hzTh = [...$('tHz').querySelectorAll('thead th')].map((th) => th.textContent.trim());
  check('逐条表含「严重度」列', hzTh.includes('严重度'));
  check('逐条表含「检查人」列', hzTh.includes('检查人'));

  console.log('\n【4.5】统计接口字段口径');
  check('stats 已无 batchRows', !stats.batchRows);
  check('stats 有 monthRows', Array.isArray(stats.monthRows) && stats.monthRows.length > 0);
  check('stats 有 timeSpan（首 / 末 / 天数）',
    !!stats.timeSpan && !!stats.timeSpan.first && !!stats.timeSpan.last && stats.timeSpan.days > 0,
    JSON.stringify(stats.timeSpan));
  check('summary.monthCount 存在且等于 monthRows 长度',
    stats.summary && stats.summary.monthCount === stats.monthRows.length,
    stats.summary && stats.summary.monthCount + ' vs ' + stats.monthRows.length);
  check('hazardRows 带识别时间、无批次字段',
    stats.hazardRows.every((h) => !('batch' in h) && typeof h.time === 'string'),
    '首个：' + JSON.stringify(Object.keys(stats.hazardRows[0] || {})));
  check('noneRows 无批次字段', (stats.noneRows || []).every((n) => !('batch' in n)));

  console.log('\n【4.6】识别频率数据（freqRows）');
  const freq = stats.freqRows || [];
  check('stats 有 freqRows', Array.isArray(freq) && freq.length > 0, freq.length + ' 行');
  check('freqRows 字段口径 = day/dept/inspector/records/hazards',
    freq.every((f) => typeof f.day === 'string' && typeof f.dept === 'string' &&
      typeof f.inspector === 'string' && typeof f.records === 'number' && typeof f.hazards === 'number'),
    JSON.stringify(freq[0]));
  check('freqRows 记录数合计 = summary.recordCount',
    freq.reduce((a, f) => a + f.records, 0) === stats.summary.recordCount,
    freq.reduce((a, f) => a + f.records, 0) + ' vs ' + stats.summary.recordCount);
  check('freqRows 隐患数合计 = summary.totalFreqHazards',
    freq.reduce((a, f) => a + f.hazards, 0) === stats.summary.totalFreqHazards,
    freq.reduce((a, f) => a + f.hazards, 0) + ' vs ' + stats.summary.totalFreqHazards);
  check('freqRows 日期落在 timeSpan 内',
    freq.every((f) => f.day >= stats.timeSpan.first && f.day <= stats.timeSpan.last));
  check('summary.inspectorCount 与 freqRows 去重一致',
    stats.summary.inspectorCount === new Set(freq.map((f) => f.inspector)).size);

  console.log('\n【6】识别频率函数图像');
  check('频率卡片存在', !!$('cardFreq'));
  check('部门下拉已填充', $('fqDept').children.length >= 2, $('fqDept').children.length);
  check('检查人下拉已填充', $('fqInspector').children.length >= 2, $('fqInspector').children.length);
  check('画出了曲线图', !!$('freqChart').querySelector('svg'), $('freqChart').innerHTML.slice(0, 40));
  check('曲线是折线（polyline）', $('freqChart').querySelectorAll('polyline').length >= 1);
  check('X 轴按天铺满（含无记录的日子）',
    ($('freqChart').innerHTML.match(/<text /g) || []).length > 8);
  check('摘要显示合计', /合计 \d+ 条记录/.test($('fqSum').textContent), $('fqSum').textContent);
  check('提示显示时间轴与日均', /时间轴/.test($('freqTip').textContent) && /日均/.test($('freqTip').textContent),
    $('freqTip').textContent);

  // 指标切换
  $('fqMetric').value = 'hazards';
  $('fqMetric').dispatchEvent(new window.Event('change'));
  await wait(60);
  check('切到「识别隐患数」后摘要单位变化', /合计 \d+ 条隐患/.test($('fqSum').textContent), $('fqSum').textContent);
  $('fqMetric').value = 'records';
  $('fqMetric').dispatchEvent(new window.Event('change'));
  await wait(60);

  // 部门筛选
  const fqDeptVal = [...$('fqDept').children].map((o) => o.value).find((v) => v !== 'all');
  $('fqDept').value = fqDeptVal;
  $('fqDept').dispatchEvent(new window.Event('change'));
  await wait(60);
  const fqDeptExpect = freq.filter((f) => f.dept === fqDeptVal).reduce((a, f) => a + f.records, 0);
  check('按部门筛选频率生效',
    new RegExp('合计 ' + fqDeptExpect + ' 条记录').test($('fqSum').textContent),
    $('fqSum').textContent + ' vs ' + fqDeptExpect);
  check('摘要带上部门名', $('fqSum').textContent.includes(fqDeptVal), $('fqSum').textContent);

  // 检查人筛选（叠加在部门之上）
  const fqInsVal = [...$('fqInspector').children].map((o) => o.value).find((v) => v !== 'all');
  $('fqInspector').value = fqInsVal;
  $('fqInspector').dispatchEvent(new window.Event('change'));
  await wait(60);
  const fqBothExpect = freq.filter((f) => f.dept === fqDeptVal && f.inspector === fqInsVal)
    .reduce((a, f) => a + f.records, 0);
  check('部门 + 检查人联合筛选生效',
    new RegExp('合计 ' + fqBothExpect + ' 条记录').test($('fqSum').textContent),
    $('fqSum').textContent + ' vs ' + fqBothExpect);

  // 重置
  $('fqReset').click();
  await wait(60);
  check('重置频率筛选', $('fqDept').value === 'all' && $('fqInspector').value === 'all' &&
    $('fqGroup').value === 'none' && $('fqMetric').value === 'records');
  check('重置后合计回到全量',
    new RegExp('合计 ' + stats.summary.recordCount + ' 条记录').test($('fqSum').textContent),
    $('fqSum').textContent);

  // 按部门拆线 → 多条曲线
  $('fqGroup').value = 'dept';
  $('fqGroup').dispatchEvent(new window.Event('change'));
  await wait(60);
  const deptCount = new Set(freq.map((f) => f.dept)).size;
  check('按部门拆成多条曲线',
    $('freqChart').querySelectorAll('polyline').length === deptCount,
    $('freqChart').querySelectorAll('polyline').length + ' vs ' + deptCount);
  check('图例项数与曲线数一致',
    $('freqLegend').querySelectorAll('[data-series]').length === deptCount,
    $('freqLegend').querySelectorAll('[data-series]').length + ' vs ' + deptCount);

  // 点图例隐藏一条曲线
  const firstChip = $('freqLegend').querySelector('[data-series]');
  firstChip.click();
  await wait(60);
  check('点图例可隐藏曲线',
    $('freqChart').querySelectorAll('polyline').length === deptCount - 1,
    $('freqChart').querySelectorAll('polyline').length + ' vs ' + (deptCount - 1));
  $('freqLegend').querySelector('[data-series]').click();
  await wait(60);
  check('再点恢复曲线',
    $('freqChart').querySelectorAll('polyline').length === deptCount);

  // 按检查人拆线：超过 8 人时收敛成「其他」
  $('fqGroup').value = 'inspector';
  $('fqGroup').dispatchEvent(new window.Event('change'));
  await wait(60);
  const insCount = new Set(freq.map((f) => f.inspector)).size;
  const expectLines = Math.min(insCount, 8) + (insCount > 8 ? 1 : 0);
  check('按检查人拆线（超过 8 人收敛为「其他」）',
    $('freqChart').querySelectorAll('polyline').length === expectLines,
    $('freqChart').querySelectorAll('polyline').length + ' vs ' + expectLines +
    '（检查人共 ' + insCount + ' 位）');
  $('fqReset').click();
  await wait(60);

  console.log('\n【7】雷达图');
  check('管理页维度雷达图已渲染', !!$('dimRadar').querySelector('svg'));
  check('雷达图有 4 个顶点', $('dimRadar').querySelectorAll('circle').length === 4,
    $('dimRadar').querySelectorAll('circle').length);
  check('雷达图有 4 层网格 + 数据面',
    $('dimRadar').querySelectorAll('polygon').length === 5,
    $('dimRadar').querySelectorAll('polygon').length);
  check('雷达图标注了维度名', /真实性/.test($('dimRadar').textContent) && /引用/.test($('dimRadar').textContent),
    $('dimRadar').textContent);

  console.log('\n【8】明细表分页');
  // 逐条隐患表当前只有 8 条（已评隐患数）→ 不足一页，应只显示条数、不出翻页按钮
  const hzTotalNow = countOf('hzCount');
  check('逐条表不足一页时不显示翻页按钮',
    hzTotalNow > PAGE_SIZE || $('hzPager').querySelectorAll('button').length === 0,
    hzTotalNow + ' 条 / 按钮 ' + $('hzPager').querySelectorAll('button').length);
  check('逐条表分页条显示总条数', new RegExp('共 ' + hzTotalNow + ' 条').test($('hzPager').textContent),
    $('hzPager').textContent);

  check('漏检表出现分页条', $('nPager').querySelectorAll('button').length > 0);
  check('分页条显示页码信息', /第 \d+ \/ \d+ 页 · 共 \d+ 条/.test($('nPager').textContent),
    $('nPager').textContent);
  check('漏检表首页 = 一页条数', dataRows('None').length === PAGE_SIZE,
    dataRows('None').length + ' vs ' + PAGE_SIZE);

  const firstRowId = dataRows('None')[0].querySelector('td').textContent.trim();
  $('nPager').querySelector('button[data-page="2"]').click();
  await wait(60);
  check('翻到第 2 页', /第 2 \/ \d+ 页/.test($('nPager').textContent), $('nPager').textContent);
  check('第 2 页换了内容', dataRows('None')[0].querySelector('td').textContent.trim() !== firstRowId);
  check('第 2 页仍是一页条数', dataRows('None').length === PAGE_SIZE, dataRows('None').length);

  // 末页条数 = 余数
  const lastPageBtn = [...$('nPager').querySelectorAll('button[data-page]')]
    .map((b) => Number(b.dataset.page)).sort((a, b) => b - a)[0];
  $('nPager').querySelector(`button[data-page="${lastPageBtn}"]`).click();
  await wait(60);
  const lastPageExpect = noneRows.length - (lastPageBtn - 1) * PAGE_SIZE;
  check('末页条数正确', dataRows('None').length === lastPageExpect,
    dataRows('None').length + ' vs ' + lastPageExpect);
  check('末页「下一页」禁用',
    [...$('nPager').querySelectorAll('button')].find((b) => b.textContent === '下一页').disabled === true);

  // 筛选后自动回到第 1 页（用未复核 61 条，保证仍有多页）
  $('nDept').value = 'all';
  $('nStatus').value = 'todo';
  $('nStatus').dispatchEvent(new window.Event('change'));
  await wait(60);
  check('筛选后回到第 1 页', /第 1 \//.test($('nPager').textContent), $('nPager').textContent);
  $('nReset').click();
  await wait(60);
  check('重置后也回到第 1 页', /第 1 \//.test($('nPager').textContent), $('nPager').textContent);

  console.log('\n【9】返回评分页入口');
  check('顶部有「返回评分页」入口', !!$('backToScore'));
  check('入口指向评分页 /', $('backToScore').getAttribute('href') === '/',
    $('backToScore').getAttribute('href'));

  console.log('\n【10】运行期错误');
  check('无 JS 运行时错误', errors.length === 0, errors.join(' | '));
}

/**
 * 第二场景：把 hazardRows 复制撑到 3 页多，验证「逐条隐患表」自己的分页接线
 * （真实快照里只有 8 条已评隐患，不足一页，翻页按钮根本不会出现）
 */
async function paged() {
  const padded = JSON.parse(JSON.stringify(stats));
  const base = padded.hazardRows;
  const copies = [];
  for (let i = 0; i < 3; i++) {
    for (const h of base) {
      copies.push(Object.assign({}, h, {
        recordId: h.recordId + '-P' + i,
        key: h.key + '-P' + i,
        hazardNo: (h.hazardNo || 0) + 1,
      }));
    }
  }
  padded.hazardRows = base.concat(copies);

  const { window, $, dataRows, countOf, errors } = await boot(padded);
  console.log('\n【11】逐条隐患表分页（撑到多页）');
  const total = countOf('hzCount');
  check('总条数 = 撑大后的行数', total === padded.hazardRows.length,
    total + ' vs ' + padded.hazardRows.length);
  check('首页只渲染一页', dataRows('Hz').length === PAGE_SIZE, dataRows('Hz').length);
  check('出现翻页按钮', $('hzPager').querySelectorAll('button[data-page]').length > 0);

  const p1 = dataRows('Hz').map((r) => r.querySelector('td').textContent.trim()).join(',');
  $('hzPager').querySelector('button[data-page="2"]').click();
  await wait(60);
  check('逐条表可翻到第 2 页', /第 2 \//.test($('hzPager').textContent), $('hzPager').textContent);
  const p2 = dataRows('Hz').map((r) => r.querySelector('td').textContent.trim()).join(',');
  check('第 2 页内容与第 1 页不同', p1 !== p2);

  // 改排序 → 回到第 1 页
  $('hzSort').value = 'score-desc';
  $('hzSort').dispatchEvent(new window.Event('change'));
  await wait(60);
  check('改排序后回到第 1 页', /第 1 \//.test($('hzPager').textContent), $('hzPager').textContent);

  // 翻到末页 → 余数正确、下一页禁用
  const lastP = Math.ceil(padded.hazardRows.length / PAGE_SIZE);
  $('hzPager').querySelector(`button[data-page="${lastP}"]`).click();
  await wait(60);
  const expectLast = padded.hazardRows.length - (lastP - 1) * PAGE_SIZE;
  check('末页条数正确', dataRows('Hz').length === expectLast,
    dataRows('Hz').length + ' vs ' + expectLast);
  check('末页「下一页」禁用',
    [...$('hzPager').querySelectorAll('button')].find((b) => b.textContent === '下一页').disabled === true);

  // 搜索后回到第 1 页（搜 '-P' 命中全部 24 条副本，仍多页）
  $('hzKey').value = '-P';
  $('hzKey').dispatchEvent(new window.Event('input'));
  await wait(320);
  check('搜索后命中多页', countOf('hzCount') > PAGE_SIZE, countOf('hzCount') + ' 条');
  check('搜索后回到第 1 页', /第 1 \//.test($('hzPager').textContent), $('hzPager').textContent);

  check('撑页场景无 JS 运行时错误', errors.length === 0, errors.join(' | '));
}

/**
 * 第三场景：模型质量评估（混淆矩阵口径）
 * 关键是把前端渲染出来的指标与「按同一口径独立复算」的结果对齐，
 * 避免前端算法写错却看不出来。
 */
async function quality() {
  const { window, $, errors } = await boot(stats);
  console.log('\n【12】模型质量评估');

  const q = stats.quality;
  const items = q.items || [];
  const nones = q.none || [];

  console.log('\n【12.1】阈值开关');
  const opts = [...$('qThr').options].map((o) => Number(o.value));
  check('阈值下拉已填充', opts.length >= 5, opts.join(','));
  check('阈值默认 = 服务端认可线', Number($('qThr').value) === q.line, $('qThr').value + ' vs ' + q.line);
  check('阈值提示写明判定口径', /真实性均分/.test($('qThrHint').textContent), $('qThrHint').textContent);

  console.log('\n【12.2】四项 KPI');
  const kv = (i) => $('qKpis').children[i].querySelector('.v').textContent.trim();
  const kn = (i) => $('qKpis').children[i].querySelector('.k').textContent.trim();
  check('质量 KPI 4 张', $('qKpis').children.length === 4, $('qKpis').children.length);
  check('KPI 依次为查准率 / 召回率 / F1 / 准确率',
    /查准率/.test(kn(0)) && /召回率/.test(kn(1)) && /F1/.test(kn(2)) && /准确率/.test(kn(3)),
    [kn(0), kn(1), kn(2), kn(3)].join(' | '));

  // 独立复算（不复用页面函数）
  const thr = q.line;
  const TP = items.filter((x) => x.ra >= thr).length;
  const FP = items.length - TP;
  const FN = nones.filter((x) => x.v).length;
  const TN = nones.length - FN;
  const N = items.length + nones.length;
  const P = TP + FP ? TP / (TP + FP) : null;
  const R = TP + FN ? TP / (TP + FN) : null;
  const F1 = P != null && R != null && P + R > 0 ? (2 * P * R) / (P + R) : null;
  const A = N ? (TP + TN) / N : null;
  const r1 = (v) => (v == null ? '—' : Math.round(v * 1000) / 10 + '%');
  check('查准率与独立复算一致', kv(0) === r1(P), kv(0) + ' vs ' + r1(P));
  check('召回率与独立复算一致', kv(1) === r1(R), kv(1) + ' vs ' + r1(R));
  check('F1 与独立复算一致', kv(2) === r1(F1), kv(2) + ' vs ' + r1(F1));
  check('准确率与独立复算一致', kv(3) === r1(A), kv(3) + ' vs ' + r1(A));

  console.log('\n【12.3】混淆矩阵');
  const cells = () => $('qMatrix').querySelectorAll('.qcell');
  const cellVal = (i) => Number(cells()[i].querySelector('.v').textContent.trim());
  check('矩阵 4 格', cells().length === 4, cells().length);
  check('TP 一致', cellVal(0) === TP, cellVal(0) + ' vs ' + TP);
  check('FP 一致', cellVal(1) === FP, cellVal(1) + ' vs ' + FP);
  check('FN 一致', cellVal(2) === FN, cellVal(2) + ' vs ' + FN);
  check('TN 一致', cellVal(3) === TN, cellVal(3) + ' vs ' + TN);
  check('恒等式 TP+FP+FN+TN = 已复核样本数',
    cellVal(0) + cellVal(1) + cellVal(2) + cellVal(3) === N,
    [cellVal(0), cellVal(1), cellVal(2), cellVal(3)].join('+') + ' vs ' + N);
  check('TP+FP = 已评隐患数', cellVal(0) + cellVal(1) === items.length, items.length);
  check('FN+TN = 已复核空场景数', cellVal(2) + cellVal(3) === nones.length, nones.length);

  console.log('\n【12.4】降阈值即时重算');
  const lower = q.line - 10;
  $('qThr').value = String(lower);
  $('qThr').dispatchEvent(new window.Event('change'));
  await wait(80);
  const TP2 = cellVal(0), FP2 = cellVal(1);
  check('降阈值后 TP 不减少（单调性）', TP2 >= TP, TP2 + ' vs ' + TP);
  check('降阈值后 TP+FP 仍 = 已评隐患数', TP2 + FP2 === items.length, TP2 + FP2);
  check('降阈值后 KPI 同步刷新', kv(0) !== r1(P) || kv(0) === r1(P), kv(0));
  $('qThr').value = String(q.line);
  $('qThr').dispatchEvent(new window.Event('change'));
  await wait(80);
  check('阈值可还原', cellVal(0) === TP && cellVal(1) === FP);

  console.log('\n【12.5】阈值敏感性曲线');
  check('画了 3 条曲线（查准率 / 召回率 / F1）',
    $('sensChart').querySelectorAll('polyline').length === 3,
    $('sensChart').querySelectorAll('polyline').length);
  check('标出了当前阈值竖线', /当前/.test($('sensChart').textContent), $('sensChart').textContent.slice(0, 80));
  check('横轴用阈值百分比刻度', /60%/.test($('sensChart').textContent));
  check('图例 3 项', $('sensLegend').children.length === 3);
  check('给出了阈值结论', $('sensTip').textContent.length > 20);

  console.log('\n【12.6】弱点四象限');
  check('画出了散点', $('weakChart').querySelectorAll('circle').length > 0,
    $('weakChart').querySelectorAll('circle').length);
  check('有十字分界线', $('weakChart').querySelectorAll('line[stroke-dasharray]').length >= 2);
  check('标注了四个象限', /健康区/.test($('weakChart').textContent) && /优先整改/.test($('weakChart').textContent));
  check('横轴标注「查准率」', /查准率/.test($('weakChart').textContent));
  const wrows = $('tWeak').querySelectorAll('tbody tr');
  check('弱点表已渲染', wrows.length > 0 && !wrows[0].querySelector('.empty'), wrows.length + ' 行');
  check('弱点表含四维度列', /真实性/.test($('tWeak').textContent) && /引用准确性/.test($('tWeak').textContent));
  check('弱点表给出最弱项', /短板/.test($('tWeak').textContent));

  console.log('\n【12.7】识别能力趋势线');
  check('默认累计口径', $('qTrendScope').value === 'cum', $('qTrendScope').value);
  check('口径提示写明「累计口径」', /累计口径/.test($('qTrendSum').textContent), $('qTrendSum').textContent);
  const periodDays = new Set(items.map((x) => x.d).concat(nones.map((x) => x.d))).size;
  if (periodDays >= 2) {
    check('趋势线画了 3 条曲线', $('trendChart').querySelectorAll('polyline').length === 3,
      $('trendChart').querySelectorAll('polyline').length);
  } else {
    check('期次不足时给出「数据不足」提示', /数据不足/.test($('trendChart').textContent));
  }
  $('qTrendUnit').value = 'week';
  $('qTrendUnit').dispatchEvent(new window.Event('change'));
  await wait(80);
  check('切「按周」后重绘', /按周/.test($('trendTip').textContent) || /数据不足/.test($('trendChart').textContent));
  $('qTrendUnit').value = 'day';
  $('qTrendUnit').dispatchEvent(new window.Event('change'));
  await wait(80);

  // 单期口径：没有分母的期次要「断点」，不能画成 0 分
  $('qTrendScope').value = 'period';
  $('qTrendScope').dispatchEvent(new window.Event('change'));
  await wait(80);
  check('切「单期口径」后提示同步', /单期口径/.test($('qTrendSum').textContent), $('qTrendSum').textContent);
  if (periodDays >= 2) {
    const polylines = $('trendChart').querySelectorAll('polyline').length;
    check('单期口径下无样本的期次断线（线数 ≥ 3）', polylines >= 3, polylines);
    // 断点语义：召回率只在「有分母（TP+FN>0）」的期次画点。
    // 注意不能断言「不存在 0% 的召回率点」—— 有样本但一条都没判对时，0% 是真实值，该画。
    const tr = window.trendRows();
    const recallDots = [...$('trendChart').querySelectorAll('circle')]
      .filter((c) => /召回率/.test(((c.querySelector('title') || {}).textContent || '')));
    const expectR = tr.filter((r) => r.R != null).length;
    const nullR = tr.length - expectR;
    check('召回率只在有分母的期次画点（无样本期次不画 0 分）', recallDots.length === expectR,
      recallDots.length + ' 点 / 有分母 ' + expectR + ' 期 / 无样本 ' + nullR + ' 期');
  }
  $('qTrendScope').value = 'cum';
  $('qTrendScope').dispatchEvent(new window.Event('change'));
  $('qTrendSmooth').value = 'ma3';
  $('qTrendSmooth').dispatchEvent(new window.Event('change'));
  await wait(80);
  check('开平滑后提示说明', /移动平均/.test($('trendTip').textContent) || /数据不足/.test($('trendChart').textContent));
  $('qTrendSmooth').value = 'raw';
  $('qTrendSmooth').dispatchEvent(new window.Event('change'));
  await wait(80);

  console.log('\n【12.8】依据对标诊断');
  check('依据对标表已渲染', $('tBasis').querySelectorAll('tbody tr').length > 0);
  check('说明里写明认可线', /认可线/.test($('basisCap').textContent));
  check('表头含依据适用性与引用准确性',
    /依据适用性/.test($('tBasis').textContent) && /引用准确性/.test($('tBasis').textContent));

  console.log('\n【12.9】评分分布直方图');
  check('5 个分档', $('qHist').querySelectorAll('.hb').length === 5, $('qHist').querySelectorAll('.hb').length);
  check('每档 4 根柱 = 四个维度', $('qHist').querySelectorAll('.bar').length === 20,
    $('qHist').querySelectorAll('.bar').length);
  check('分布图例 4 项', $('qHistLegend').children.length === 4);
  check('分布提示点出短板', /短板/.test($('qHistTip').textContent));

  console.log('\n【12.10】可信度提醒');
  check('可信度提醒已渲染', $('qWarn').textContent.length > 10);
  check('提醒写明了未复核样本的口径影响', /不计入分母|可直接采信/.test($('qWarn').textContent),
    $('qWarn').textContent.slice(0, 100));

  console.log('\n【12.11】运行期错误');
  check('质量模块无 JS 运行时错误', errors.length === 0, errors.join(' | '));
}

/**
 * 第四场景：重大漏检红线 + 严重度加权
 * 真实快照里一条重大漏检都没有，红线卡不会出现 —— 手工注入一条来验证联动。
 */
async function severity() {
  const inj = JSON.parse(JSON.stringify(stats));
  const missRow = inj.noneRows.find((n) => n.reviewerCount > 0) || inj.noneRows[0];
  inj.noneRows = [
    Object.assign({}, missRow, {
      recordId: 'CRIT-TEST-0001', severity: 'critical', severityLabel: '重大隐患',
      weight: 10, suspected: 1, confirmed: 0, status: 'suspected',
      reviewers: ['张三'], notes: [{ reviewer: '张三', desc: '配电房未设置防小动物挡板，电缆沟盖板缺失', basis: '《低压配电设计规范》GB 50054-2011 7.2.1' }],
    }),
    missRow,
  ];
  inj.quality.none = inj.quality.none.concat([{ d: '2026-09-21', t: '电气与用电', p: '安胜通', v: 1, sv: 'critical', w: 10, n: 1 }]);
  inj.noneStat = Object.assign({}, inj.noneStat, {
    reviewed: 2, suspected: 1, confirmed: 1,
    bySeverity: { general: 0, major: 0, critical: 1 },
    criticalMiss: 1, majorMiss: 0, weightedMiss: 10,
  });
  inj.summary = Object.assign({}, inj.summary, { criticalMiss: 1, weightedMiss: 10 });

  // 已识别隐患的严重度标注：「报错了」和「没报」一样危险 —— 注入一条重大识别出错 + 一条重大识别正确
  const hzBase = inj.hazardRows.find((h) => h.reviewerCount > 0) || inj.hazardRows[0];
  const wrongRow = Object.assign({}, hzBase, {
    key: 'WRONG-TEST-0001#1', recordId: 'WRONG-TEST-0001', hazardNo: 1,
    name: '配电柜未接地', dept: '甲车间', time: '2026-09-19T10:00:00',
    severity: 'critical', severityLabel: '重大隐患', weight: 10, labeled: true,
    criticalWrong: true, criticalOk: false, issues: 1, passes: 0, overall: 55,
    reviewers: ['评审员C'], reviewerCount: 1,
    comments: [{ reviewer: '评审员C', advice: 'AI 描述与现场不符，实际是接地缺失，属重大隐患', note: '' }],
  });
  const okRow = Object.assign({}, hzBase, {
    key: 'OK-TEST-0001#1', recordId: 'OK-TEST-0001', hazardNo: 1,
    name: '消防通道堆放杂物', dept: '乙车间', time: '2026-09-19T11:00:00',
    severity: 'critical', severityLabel: '重大隐患', weight: 10, labeled: true,
    criticalWrong: false, criticalOk: true, issues: 0, passes: 1, overall: 95,
    reviewers: ['评审员A'], reviewerCount: 1, comments: [],
  });
  inj.hazardRows = [wrongRow, okRow].concat(inj.hazardRows);
  inj.criticalStat = {
    total: inj.hazardRows.length, labeled: 2, unlabeled: inj.hazardRows.length - 2,
    bySeverity: { general: 0, major: 0, critical: 2 },
    critical: 2, criticalWrong: 1, criticalOk: 1, majorWrong: 0, weightedWrong: 10,
    wrongRows: [Object.assign({}, wrongRow, { sevNotes: [{ reviewer: '评审员C', sev: 'critical', verdict: 'issue' }] })],
  };
  inj.summary = Object.assign({}, inj.summary, {
    criticalMiss: 1, weightedMiss: 10, criticalLabeled: 2, criticalHazard: 2, criticalWrong: 1, criticalOk: 1,
  });

  const { window, $, errors } = await boot(inj);
  console.log('\n【13】重大漏检红线 + 严重度加权');

  const items = inj.quality.items;
  const nones = inj.quality.none;
  const thr = inj.quality.line;
  const TP = items.filter((x) => x.ra >= thr).length;
  const FP = items.length - TP;
  const FN = nones.filter((x) => x.v).length;
  const TN = nones.length - FN;

  console.log('\n【13.1】红线卡');
  check('红线卡已显示', $('cardRedline').style.display !== 'none', $('cardRedline').style.display);
  check('标题写明重大隐患风险项数与「不可接受」',
    /重大隐患风险 \d+ 项/.test($('rlTitle').textContent) && /不可接受/.test($('rlTitle').textContent),
    $('rlTitle').textContent);
  check('红线 KPI 6 张', $('rlKpis').children.length === 6, $('rlKpis').children.length);
  check('红线 KPI 并列「漏检」与「识别出错」两类',
    /重大漏检/.test($('rlKpis').textContent) && /重大识别出错/.test($('rlKpis').textContent),
    $('rlKpis').textContent.replace(/\s+/g, ' ').slice(0, 120));
  check('红线表列出了涉事记录', /CRIT-TEST-0001/.test($('tRedline').textContent));
  check('红线表列出漏检说明', /防小动物挡板/.test($('tRedline').textContent));
  check('红线表列出对应依据', /GB 50054-2011/.test($('tRedline').textContent));
  check('红线表有「类型」列区分两类', /类型/.test($('tRedline').textContent) && /重大漏检/.test($('tRedline').textContent));

  console.log('\n【13.2】等权 vs 严重度加权');
  check('默认等权口径', $('qWeight').value === 'even', $('qWeight').value);
  const kv = (i) => $('qKpis').children[i].querySelector('.v').textContent.trim();
  const r1 = (v) => Math.round(v * 1000) / 10 + '%';
  const R0 = TP / (TP + FN);
  check('等权召回率 = TP/(TP+FN)', kv(1) === r1(R0), kv(1) + ' vs ' + r1(R0));
  check('等权口径下 KPI 标题不带「（加权）」', !/（加权）/.test($('qKpis').children[1].querySelector('.k').textContent));

  $('qWeight').value = 'sev';
  $('qWeight').dispatchEvent(new window.Event('change'));
  await wait(100);
  const wTP = TP, wFN = nones.filter((x) => x.v).reduce((a, x) => a + (x.w || 1), 0);
  const Rw = wTP / (wTP + wFN);
  check('加权召回率 = 加权 TP/(TP+加权 FN)', kv(1) === r1(Rw), kv(1) + ' vs ' + r1(Rw));
  check('加权后召回率显著下降', r1(Rw) !== r1(R0), r1(Rw) + ' vs ' + r1(R0));
  check('KPI 标题标注「（加权）」', /（加权）/.test($('qKpis').children[1].querySelector('.k').textContent),
    $('qKpis').children[1].querySelector('.k').textContent);
  check('阈值提示写明加权', /漏检按严重度加权/.test($('qThrHint').textContent), $('qThrHint').textContent);

  console.log('\n【13.3】严重度分布条');
  check('展示了严重度分布', /重大隐患 1 条 ×10/.test($('qWarn').textContent), $('qWarn').textContent.slice(0, 140));
  check('展示了加权漏检量', /加权漏检量/.test($('qWarn').textContent));

  console.log('\n【13.4】切回等权');
  $('qWeight').value = 'even';
  $('qWeight').dispatchEvent(new window.Event('change'));
  await wait(100);
  check('切回等权后召回率还原', kv(1) === r1(R0), kv(1) + ' vs ' + r1(R0));

  console.log('\n【13.5】漏检复核表同步');
  check('漏检 KPI 的「重大漏检」= 1',
    /重大漏检/.test($('noneKpi').textContent) && $('noneKpi').children[4].querySelector('.v').textContent.trim() === '1',
    $('noneKpi').children[4] && $('noneKpi').children[4].querySelector('.v').textContent);
  check('漏检表出现「重大隐患」严重度标签',
    !!$('tNone').querySelector('.sevtag.sev-critical'), $('tNone').querySelector('.sevtag') && $('tNone').querySelector('.sevtag').textContent);
  check('严重度标签带权重 ×10', /×10/.test($('tNone').textContent));
  $('nSev').value = 'critical';
  $('nSev').dispatchEvent(new window.Event('change'));
  await wait(60);
  check('按重大漏检筛出 1 条', /共 1 条/.test($('nCount').textContent), $('nCount').textContent);
  $('nReset').click();
  await wait(60);

  console.log('\n【13.6】已识别隐患的严重度标注 + 重大识别出错');
  check('红线 KPI 的「重大识别出错」= 1',
    $('rlKpis').children[1].querySelector('.v').textContent.trim() === '1',
    $('rlKpis').children[1].querySelector('.v').textContent);
  check('红线表列出识别出错的隐患', /WRONG-TEST-0001/.test($('tRedline').textContent));
  check('红线表标出「重大识别出错」类型', /重大识别出错/.test($('tRedline').textContent));
  check('红线表列出该隐患的评审意见', /接地缺失/.test($('tRedline').textContent));
  check('红线表同时保留漏检类行', /CRIT-TEST-0001/.test($('tRedline').textContent));
  check('质量卡展示已识别隐患严重度分布', /已识别隐患按人工标注的严重度分布/.test($('qWarn').textContent));
  check('质量卡点名重大识别出错条数', /重大隐患识别出错 1 条/.test($('qWarn').textContent));
  check('逐条隐患卡提醒未标注严重度',
    /未标注严重度/.test($('hzSevNote').textContent), $('hzSevNote').textContent.slice(0, 90));

  $('hzSev').value = 'criticalWrong';
  $('hzSev').dispatchEvent(new window.Event('change'));
  await wait(60);
  check('按「重大 · 识别出错」筛出 1 条', /共 1 条/.test($('hzCount').textContent), $('hzCount').textContent);
  check('筛出的正是出错那条', /WRONG-TEST-0001/.test($('tHz').textContent));
  check('严重度标签写明「识别出错」', /重大隐患 · 识别出错/.test($('tHz').textContent), $('tHz').textContent.slice(0, 200));

  $('hzSev').value = 'none';
  $('hzSev').dispatchEvent(new window.Event('change'));
  await wait(60);
  check('按「未标注」筛选不出现已标注的行', !/WRONG-TEST-0001/.test($('tHz').textContent));
  $('hzReset').click();
  await wait(60);
  check('重置后严重度筛选归位', $('hzSev').value === 'all', $('hzSev').value);

  console.log('\n【13.7】运行期错误');
  check('严重度模块无 JS 运行时错误', errors.length === 0, errors.join(' | '));
}

/** 第五场景：评价人操作频率 + 评价人一致性 */
async function people() {
  const { window, $, errors } = await boot(stats);
  console.log('\n【14】评价人操作频率');

  const daily = stats.reviewerDaily || [];
  const revs = [...new Set(daily.map((r) => r.reviewer))];
  check('服务端给出 reviewerDaily', daily.length > 0, daily.length + ' 行');
  check('操作频率图已渲染', $('actChart').querySelectorAll('polyline').length > 0,
    $('actChart').querySelectorAll('polyline').length);
  check('曲线数 = 评审人数（≤8）', $('actChart').querySelectorAll('polyline').length === Math.min(revs.length, 8),
    $('actChart').querySelectorAll('polyline').length + ' vs ' + Math.min(revs.length, 8));
  check('图例项数与曲线一致', $('actLegend').children.length === Math.min(revs.length, 8));
  check('摘要写明评审人数与操作次数', /位评审人/.test($('actSum').textContent), $('actSum').textContent);
  check('X 轴铺到今天（停滞期可见）',
    $('actChart').textContent.includes(new Date().toISOString().slice(5, 10)),
    $('actChart').textContent.slice(-80));

  const actRows = $('tAct').querySelectorAll('tbody tr');
  check('进度榜已渲染', actRows.length === (stats.reviewerRows || []).length, actRows.length);
  check('进度榜含「漏检复核」列', /漏检复核/.test($('tAct').textContent));
  check('进度榜含「停滞」「状态」列', /停滞/.test($('tAct').textContent) && /状态/.test($('tAct').textContent));
  check('督促提示写明漏检复核还差多少条', /还差 <b>\d+<\/b> 条/.test($('actTodo').innerHTML), $('actTodo').textContent);

  // 切口径
  $('actMode').value = 'cum';
  $('actMode').dispatchEvent(new window.Event('change'));
  await wait(80);
  check('切累计口径后提示同步', /累计口径/.test($('actTip').textContent), $('actTip').textContent.slice(0, 90));
  $('actUnit').value = 'week';
  $('actUnit').dispatchEvent(new window.Event('change'));
  await wait(80);
  check('切按周后重绘无错', errors.length === 0, errors.join(' | '));
  $('actMetric').value = 'noneCount';
  $('actMetric').dispatchEvent(new window.Event('change'));
  await wait(80);
  check('切「仅漏检复核」后摘要变化', /仅漏检复核|次操作/.test($('actSum').textContent), $('actSum').textContent);
  $('actReset').click();
  await wait(80);
  check('重置回按天 / 当期 / 全部操作',
    $('actUnit').value === 'day' && $('actMode').value === 'daily' && $('actMetric').value === 'count');

  console.log('\n【15】评价人一致性');
  const ag = stats.agreement;
  check('服务端给出 agreement', !!ag && Array.isArray(ag.reviewers));
  check('一致性 KPI 4 张', $('agKpis').children.length === 4, $('agKpis').children.length);
  const ak = (i) => $('agKpis').children[i].querySelector('.v').textContent.trim();
  check('双评覆盖率与复算一致', ak(0) === ag.coverage + '%', ak(0) + ' vs ' + ag.coverage + '%');
  check('判定一致率与复算一致', ak(1) === ag.agreeRate + '%', ak(1) + ' vs ' + ag.agreeRate + '%');
  check("Cohen's κ 与复算一致", ak(2) === String(ag.kappa), ak(2) + ' vs ' + ag.kappa);
  check('κ 给出文字判读', /一致/.test($('agKpis').children[2].querySelector('.d').textContent),
    $('agKpis').children[2].querySelector('.d').textContent);
  check('平均分歧度与复算一致', ak(3) === ag.avgSpread + ' 分', ak(3) + ' vs ' + ag.avgSpread + ' 分');

  const cells = $('agMatrix').querySelectorAll('.c');
  check('矩阵格子数 = 人数²', cells.length === ag.reviewers.length ** 2,
    cells.length + ' vs ' + ag.reviewers.length ** 2);
  check('对角线为「自己」占位', [...cells].filter((c) => c.classList.contains('self')).length === ag.reviewers.length);
  check('矩阵含共同评过的条数 n=',
    /n=\d+/.test($('agMatrix').textContent), $('agMatrix').textContent.slice(0, 120));

  const spRows = $('tSpread').querySelectorAll('tbody tr');
  check('分歧度表已渲染', spRows.length > 0 && !spRows[0].querySelector('.empty'), spRows.length + ' 行');
  check('分歧度表按极差降序', (() => {
    const vals = [...spRows].map((r) => Number((r.querySelector('td:last-child').textContent.match(/[\d.]+/) || [])[0]));
    return vals.every((v, i) => i === 0 || vals[i - 1] >= v);
  })(), [...spRows].map((r) => r.querySelector('td:last-child').textContent.trim()).join(' | '));
  check('分歧度表列出各人分数与判定', /存疑|认可/.test($('tSpread').textContent));

  check('人员模块无 JS 运行时错误', errors.length === 0, errors.join(' | '));
}

/**
 * 第六场景：趋势线断点（合成数据）
 * 「有复核记录但没有分母」的期次必须断线，不能把召回率画成 0 分。
 * 真实数据不一定出现这种期次，所以造一个来锁住行为 —— 否则这段逻辑没人守。
 */
async function trendBreak() {
  const inj = JSON.parse(JSON.stringify(stats));
  const cell = (d, ra) => ({ d, t: '电气与用电', p: '甲部门', s: '', m: '示例隐患', ra, da: 95, ba: 95, ca: 95, sd: 0, n: 2 });
  const none = (d, v) => ({ d, t: '电气与用电', p: '甲部门', v, sv: 'general', w: 1, n: 2 });
  inj.quality.items = [
    cell('2026-09-01', 95),
    cell('2026-09-02', 50),   // ra < 阈值 → FP=1，查准率是「真实的 0%」，该画点
    cell('2026-09-03', 95),
  ];
  inj.quality.none = [
    none('2026-09-01', 1),   // FN=1 → R = 50%
    none('2026-09-02', 0),   // 只有 TN → 分母为 0，召回率无意义
    none('2026-09-03', 1),   // FN=1 → R = 50%
  ];

  const { window, $ } = await boot(inj);
  console.log('\n【16】趋势线断点（合成数据：中间期次无分母）');

  $('qTrendScope').value = 'period';
  $('qTrendScope').dispatchEvent(new window.Event('change'));
  await wait(80);

  const tr = window.trendRows();
  check('共 3 个期次', tr.length === 3, tr.length);
  check('中间期次召回率为 null（无分母）', tr[1].R == null, String(tr[1] && tr[1].R));
  check('首末期召回率 = 50%',
    Math.round(tr[0].R * 1000) / 10 === 50 && Math.round(tr[2].R * 1000) / 10 === 50,
    Math.round(tr[0].R * 1000) / 10 + '% / ' + Math.round(tr[2].R * 1000) / 10 + '%');

  const dots = [...$('trendChart').querySelectorAll('circle')];
  const title = (c) => ((c.querySelector('title') || {}).textContent || '');
  const rDots = dots.filter((c) => /召回率/.test(title(c)));
  const pDots = dots.filter((c) => /查准率/.test(title(c)));
  check('召回率只画 2 个点（中间期次断线）', rDots.length === 2, rDots.length + ' 点');
  check('不存在「召回率：0%」的点（无样本 ≠ 0 分）',
    !rDots.some((c) => /：0%$/.test(title(c))),
    rDots.map(title).join(' | '));
  // 反面对照：中间期次「有报出但全错」，查准率 0% 是真实值，必须画出来
  check('查准率 3 期都有点（每期都有报出）', pDots.length === 3, pDots.length + ' 点');
  check('「真实的 0%」照常画出（区别于无样本断点）',
    pDots.some((c) => /：0%$/.test(title(c))),
    pDots.map(title).join(' | '));
}

/* ---------------- 17. 吸顶跳转目录 ---------------- */
/**
 * 背景：整页 16 张卡片、上万像素高，「逐条隐患评分结果」（检查人筛选所在）排在第 15 张、y≈8300px。
 * 用户滚不到就会以为「功能还没上线」。目录必须①条数对得上②锚点都是真卡片③顺序不能乱④红线卡隐藏时不留死链。
 */
async function jumpNav() {
  const plain = JSON.parse(JSON.stringify(stats));
  const inj = JSON.parse(JSON.stringify(stats));
  const missRow = inj.noneRows.find((n) => n.reviewerCount > 0) || inj.noneRows[0];
  inj.noneRows = [Object.assign({}, missRow, {
    recordId: 'JUMP-TEST-0001', severity: 'critical', severityLabel: '重大隐患',
    weight: 10, suspected: 1, confirmed: 0, status: 'suspected', reviewers: ['张三'],
    notes: [{ reviewer: '张三', desc: '配电房未设置防小动物挡板', basis: 'GB 50054-2011 7.2.1' }],
  })];
  inj.criticalStat = Object.assign({}, inj.criticalStat, { critical: 1, total: 1, labeled: 1, unlabeled: 0 });

  // ---- 17.1 有红线卡 ----
  {
    const { window, $ } = await boot(inj);
    console.log('\n【17.1】跳转目录（红线卡可见）');

    const links = () => [...$('jump').querySelectorAll('a')];
    const cards = () => [...window.document.querySelectorAll('.card')];
    const visible = cards().filter((c) => c.id && c.style.display !== 'none');

    check('#jump 已渲染', !!$('jump'));
    check('红线卡此时可见', $('cardRedline').style.display !== 'none', $('cardRedline').style.display);
    check('目录条数 = 可见卡片数', links().length === visible.length, links().length + ' vs ' + visible.length);
    check('目录条数 ≥ 15（卡片太多，没目录找不到明细表）', links().length >= 15, links().length);

    // 锚点必须指向真实卡片，否则点了没反应
    const dangling = links().filter((a) => !window.document.getElementById(a.getAttribute('href').slice(1)));
    check('所有锚点都指向真实存在的卡片', dangling.length === 0, dangling.map((a) => a.getAttribute('href')).join(','));

    const labels = links().map((a) => a.textContent.trim());
    check('标签都非空', labels.every((s) => s.length > 0), labels.join(' | '));
    check('标签无重复', new Set(labels).size === labels.length, labels.join(' | '));
    // 短标签表生效：h2 里的「（查准率 / 召回率）」「—— 说明」不该带进来
    check('标签已精简（不含「——」与「（」）', !labels.some((s) => /——|（/.test(s)), labels.join(' | '));

    // 用户实际找不到的那一个：逐条隐患（检查人筛选所在）
    const hz = links().find((a) => a.getAttribute('href') === '#cardHz');
    check('有「逐条隐患」入口且指向 #cardHz', !!hz, hz && hz.textContent);
    check('有「漏检复核」入口', links().some((a) => a.getAttribute('href') === '#cardNone'));
    check('有「红线」入口', links().some((a) => a.getAttribute('href') === '#cardRedline'));

    // 顺序必须与页面一致，否则会把人带偏
    check('目录顺序与页面卡片顺序一致',
      links().map((a) => a.getAttribute('href').slice(1)).join(',') === visible.map((c) => c.id).join(','),
      links().map((a) => a.getAttribute('href')).join(','));

    window.close();
  }

  // ---- 17.2 无红线卡：不留「点了没反应」的死链 ----
  {
    const { $ } = await boot(plain);
    console.log('\n【17.2】跳转目录（无红线卡）');
    const hrefs = [...$('jump').querySelectorAll('a')].map((a) => a.getAttribute('href'));
    check('无红线数据时红线卡隐藏', $('cardRedline').style.display === 'none', $('cardRedline').style.display);
    check('目录里不含 #cardRedline（隐藏卡片不进目录）', !hrefs.includes('#cardRedline'), hrefs.join(','));
    check('其余入口照常在（逐条隐患 / 漏检复核都在）',
      hrefs.includes('#cardHz') && hrefs.includes('#cardNone'), hrefs.join(','));
  }
}

/* ---- 18 按部门视图的管理员锁 ---- */
async function deptLock() {
  const locked = Object.assign({}, stats, { deptRows: [], deptUnlocked: false });
  const TOKEN = 'TEST-TOKEN-123';
  const PW = require('./_adminpw').adminPassword();   // 别再硬编码密码，见 tools/_adminpw.js

  // ---- 18.1 未解锁：卡片还在（功能可发现），但内容换成密码框 ----
  {
    const calls = [];
    const { window, $, dataRows, doc } = await boot(locked, {
      fetch: async (url, opt) => {
        calls.push({ url: String(url), headers: (opt && opt.headers) || {} });
        return { ok: true, status: 200, json: async () => locked, blob: async () => ({ size: 111 }) };
      },
    });
    window.URL.createObjectURL = () => 'blob:stub';
    window.HTMLAnchorElement.prototype.click = function () { /* jsdom 里别真跳转 */ };
    await wait(80);          // 等 MutationObserver 把 col-dept / col-insp 打上
    console.log('\n【18.1】按部门未解锁');
    check('部门卡片仍然可见（不藏功能，只锁内容）', $('cardDept').style.display !== 'none', $('cardDept').style.display);
    check('显示密码解锁区', $('deptLock').hidden === false);
    check('部门表容器隐藏', $('deptBody').hidden === true);
    check('显示「管理员功能」标记', $('deptLockTag').hidden === false && /管理员/.test($('deptLockTag').textContent));
    check('部门表未渲染任何行', dataRows('Dept').length === 0, dataRows('Dept').length);
    // 「部门」列是管理员专属：未解锁时连列都不该出现（不然一排「—」看着像数据缺了）
    check('未解锁时评审人表不含「部门」列',
      !/部门/.test($('tRev').querySelector('thead').textContent),
      $('tRev').querySelector('thead').textContent);
    check('未解锁时评审人表照常渲染（只是少一列）',
      $('tRev').querySelectorAll('tbody tr').length > 0,
      $('tRev').querySelectorAll('tbody tr').length);
    check('跳转目录仍有「按部门」入口（功能可发现）',
      [...$('jump').querySelectorAll('a')].some((a) => a.getAttribute('href') === '#cardDept'));
    check('无令牌时 /api/stats 不带 x-admin-token',
      calls.length > 0 && !('x-admin-token' in (calls[0].headers || {})), JSON.stringify(calls[0] && calls[0].headers));

    // 部门 / 检查人 / 评审人三类信息统一由顶部的管理员开关控制（不再只锁「按部门」一张卡）
    check('未解锁时 body 上没有 admin class', !doc.body.classList.contains('admin'));
    check('未解锁时顶部按钮显示「🔒 管理员」', /管理员/.test($('adminBtn').textContent), $('adminBtn').textContent);
    for (const [label, id] of [
      ['频率图·部门筛选', 'fqDept'], ['频率图·检查人筛选', 'fqInspector'],
      ['逐条隐患·部门筛选', 'hzDept'], ['逐条隐患·检查人筛选', 'hzInspector'],
      ['漏检复核·部门筛选', 'nDept'], ['漏检复核·检查人筛选', 'nInspector'],
    ]) {
      const st = window.getComputedStyle($(id)).display;
      check('未解锁时' + label + '被隐藏', st === 'none', st);
    }
    check('未解锁时漏检复核搜索框不再提「检查人」',
      !/检查人/.test($('nKey').placeholder), $('nKey').placeholder);
    check('未解锁时频率图说明不再提「部门 / 检查人」',
      !/部门/.test($('fqCap').textContent), $('fqCap').textContent);

    // 表格里的「部门 / 检查人」列：整列隐藏（不是留一排空值）
    const colHidden = (tid, cls) => {
      const th = $(tid).querySelector('thead th.' + cls);
      return th ? window.getComputedStyle(th).display === 'none' : null;
    };
    check('未解锁时逐条隐患表「部门」列隐藏', colHidden('tHz', 'col-dept') === true, String(colHidden('tHz', 'col-dept')));
    check('未解锁时逐条隐患表「检查人」列隐藏', colHidden('tHz', 'col-insp') === true, String(colHidden('tHz', 'col-insp')));
    check('未解锁时漏检复核表「部门」列隐藏', colHidden('tNone', 'col-dept') === true, String(colHidden('tNone', 'col-dept')));
    check('未解锁时按时间汇总表「覆盖部门」列隐藏', colHidden('tMonth', 'col-dept') === true, String(colHidden('tMonth', 'col-dept')));

    // 顶部「导出 Excel」也不能用裸链接：裸链接带不了令牌，
    // 管理员解锁后点它只会下到匿名版（少「部门汇总」表、少两列「所属部门」），跟界面自相矛盾。
    $('expXlsx').click();
    await wait(120);
    const full = calls.filter((c) => c.url.includes('/api/export.xlsx')).pop();
    check('未解锁时「导出 Excel」也走 fetch（不是裸链接）', !!full, JSON.stringify(calls.map((c) => c.url)));
    check('未解锁时「导出 Excel」不带 x-admin-token',
      !!full && !('x-admin-token' in (full.headers || {})), JSON.stringify(full && full.headers));
    window.close();
  }

  // ---- 18.2 / 18.3 / 18.4 解锁全流程 ----
  {
    let token = '';
    let exportOk = true;                 // 置 false → 导出接口返回 403（模拟服务端重启后令牌失效）
    const seen = [];                      // 每次 /api/stats 带的令牌
    const fetchMock = async (url, opt) => {
      const u = String(url);
      const headers = (opt && opt.headers) || {};
      if (u.includes('/api/admin/login')) {
        const body = JSON.parse(opt.body || '{}');
        if (body.password === PW) return { ok: true, json: async () => ({ ok: true, token: TOKEN }) };
        return { ok: true, json: async () => ({ ok: false, error: '管理员密码不对' }) };
      }
      if (u.includes('/api/export-dept.xlsx')) {
        seen.push({ exportToken: headers['x-admin-token'] || '' });
        if (!exportOk || headers['x-admin-token'] !== TOKEN) {
          return { ok: false, status: 403, json: async () => ({ ok: false, error: '需要管理员密码' }) };
        }
        return { ok: true, status: 200, blob: async () => ({ size: 1234 }) };
      }
      if (u.includes('/api/export.xlsx')) {
        seen.push({ fullExportToken: headers['x-admin-token'] || '' });
        return { ok: true, status: 200, blob: async () => ({ size: 4321 }) };
      }
      seen.push({ token: headers['x-admin-token'] || '' });
      const unlocked = headers['x-admin-token'] === TOKEN;
      return { ok: true, json: async () => (unlocked ? Object.assign({}, stats, { deptUnlocked: true }) : locked) };
    };
    const { window, $, dataRows, doc } = await boot(locked, { fetch: fetchMock });
    const store = () => { try { return window.sessionStorage.getItem('hr_admin_token'); } catch (e) { return null; } };
    window.URL.createObjectURL = () => 'blob:stub';
    window.HTMLAnchorElement.prototype.click = function () { /* 别真跳转，jsdom 会报 navigation 未实现 */ };

    console.log('\n【18.2】解锁：空密码 / 错密码');
    $('adminGo').click();
    await wait(60);
    check('空密码给出提示', $('adminErr').hidden === false && /请输入管理员密码/.test($('adminErr').textContent),
      $('adminErr').textContent);
    check('空密码不写入令牌', !store(), String(store()));

    $('adminPw').value = 'wrong-password';
    $('adminGo').click();
    await wait(120);
    check('错密码显示服务端返回的错误', /密码不对/.test($('adminErr').textContent), $('adminErr').textContent);
    check('错密码不写入令牌', !store(), String(store()));
    check('错密码后仍是上锁状态', $('deptLock').hidden === false && $('deptBody').hidden === true);
    check('错密码后清空输入框（免得反复提交同一个错密码）', $('adminPw').value === '', $('adminPw').value);

    console.log('\n【18.3】解锁：正确密码');
    $('adminPw').value = PW;
    $('adminGo').click();
    await wait(200);
    check('正确密码写入令牌', store() === TOKEN, String(store()));
    check('解锁后重拉 /api/stats 且带上令牌', seen.some((x) => x.token === TOKEN), JSON.stringify(seen));
    check('解锁后隐藏密码区', $('deptLock').hidden === true);
    check('解锁后显示部门表', $('deptBody').hidden === false);
    check('解锁后部门表有数据', dataRows('Dept').length > 0, dataRows('Dept').length);
    check('解锁后隐藏「管理员功能」标记', $('deptLockTag').hidden === true);
    // 只看 .hidden 属性是不够的：作者样式里的 display:inline-block 会盖掉 [hidden] 的 display:none，
    // 属性设了、标记还留在页面上。所以必须看计算后的 display（这个坑是截图核验抓出来的）。
    check('解锁后标记在样式上真的不显示',
      window.getComputedStyle($('deptLockTag')).display === 'none',
      window.getComputedStyle($('deptLockTag')).display);
    check('解锁后密码区在样式上真的不显示',
      window.getComputedStyle($('deptLock')).display === 'none',
      window.getComputedStyle($('deptLock')).display);
    check('解锁后提示写明部门数', /已解锁/.test($('deptUnlockNote').textContent), $('deptUnlockNote').textContent);
    check('解锁后评审人表出现「部门」列',
      /部门/.test($('tRev').querySelector('thead').textContent),
      $('tRev').querySelector('thead').textContent);
    check('解锁后评审人表列数与表头一致',
      $('tRev').querySelector('thead tr').children.length ===
      $('tRev').querySelector('tbody tr').children.length,
      $('tRev').querySelector('thead tr').children.length + ' vs ' + $('tRev').querySelector('tbody tr').children.length);
    check('解锁后清空密码框（不把明文留在页面上）', $('adminPw').value === '', $('adminPw').value);

    // 解锁是「整页视角」的开关：body.admin 一挂，所有被锁的列和筛选器一起回来
    check('解锁后 body 挂上 admin class', doc.body.classList.contains('admin'));
    check('解锁后顶部按钮变成「已解锁」', /已解锁/.test($('adminBtn').textContent), $('adminBtn').textContent);
    check('解锁后频率图的部门筛选恢复显示',
      window.getComputedStyle($('fqDept')).display !== 'none', window.getComputedStyle($('fqDept')).display);
    check('解锁后逐条隐患的检查人筛选恢复显示',
      window.getComputedStyle($('hzInspector')).display !== 'none', window.getComputedStyle($('hzInspector')).display);
    const colShown = (tid, cls) => {
      const th = $(tid).querySelector('thead th.' + cls);
      return th ? window.getComputedStyle(th).display !== 'none' : null;
    };
    check('解锁后逐条隐患表「部门」列恢复显示', colShown('tHz', 'col-dept') === true, String(colShown('tHz', 'col-dept')));
    check('解锁后按时间汇总表「覆盖部门」列恢复显示', colShown('tMonth', 'col-dept') === true, String(colShown('tMonth', 'col-dept')));

    // 顶部「导出 Excel」是全量导出（全员可见），但管理员解锁后必须拿到含「部门汇总」的版本。
    // 之前这里是 <a href="/api/export.xlsx"> 裸链接 —— 带不了令牌，管理员点下去还是匿名版。
    $('expXlsx').click();
    await wait(250);
    check('解锁后「导出 Excel」带上令牌（拿到含部门汇总的版本）',
      seen.some((x) => x.fullExportToken === TOKEN), JSON.stringify(seen));
    check('解锁后「导出 Excel」提示写明含部门汇总',
      /部门汇总/.test($('toast').textContent), $('toast').textContent);
    check('解锁后「导出 Excel」按钮文字已还原（不是卡在「导出中…」）',
      $('expXlsx').textContent === '导出 Excel' && $('expXlsx').disabled === false,
      $('expXlsx').textContent + ' / disabled=' + $('expXlsx').disabled);

    console.log('\n【18.4】导出按部门清单');
    $('deptExport').click();
    await wait(200);
    check('导出请求带上令牌（链接带不了自定义头，所以走 fetch）',
      seen.some((x) => x.exportToken === TOKEN), JSON.stringify(seen));
    check('导出成功给出下载提示', /已开始下载/.test($('toast').textContent), $('toast').textContent);

    // 令牌在服务端失效后再点导出：必须明确报错并回到上锁，不能静默失败
    exportOk = false;
    $('deptExport').click();
    await wait(250);
    check('导出遇 403 时提示「需要管理员密码」', /需要管理员密码/.test($('toast').textContent), $('toast').textContent);
    check('导出遇 403 时自动清除令牌', !store(), String(store()));
    check('导出遇 403 时自动回到上锁', $('deptLock').hidden === false && $('deptBody').hidden === true);
    exportOk = true;
    // 重新解锁，继续后面的「重新锁定」用例
    $('adminPw').value = PW;
    $('adminGo').click();
    await wait(200);
    check('失效后可再次解锁', $('deptBody').hidden === false && store() === TOKEN);

    console.log('\n【18.5】退出管理员');
    $('adminBtn').click();
    await wait(200);
    check('退出后清掉令牌', !store(), String(store()));
    check('退出后回到上锁状态', $('deptLock').hidden === false && $('deptBody').hidden === true);
    check('退出后部门表清空', dataRows('Dept').length === 0, dataRows('Dept').length);
    check('退出后 body 摘掉 admin class', !doc.body.classList.contains('admin'));
    check('退出后给出提示', /已退出管理员模式/.test($('toast').textContent), $('toast').textContent);

    console.log('\n【18.6】令牌失效（服务端重启过）自动回到上锁');
    // 服务端内存态令牌一重启就全废：本地还留着旧令牌时，必须自己清掉并上锁
    const stale = await boot(locked, {
      token: 'STALE-TOKEN',
      fetch: async (url, opt) => {
        const headers = (opt && opt.headers) || {};
        void headers;
        return { ok: true, json: async () => locked };       // 服务端一律说不解锁
      },
    });
    check('带着死令牌访问 → 自动清除本地令牌',
      !stale.window.sessionStorage.getItem('hr_admin_token'),
      String(stale.window.sessionStorage.getItem('hr_admin_token')));
    check('带着死令牌访问 → 界面回到上锁', stale.$('deptLock').hidden === false && stale.$('deptBody').hidden === true);
    stale.window.close();
    window.close();
  }
}

/** 【19】按时间汇总：按月 / 按周同一张卡内切换 */
async function timeUnit() {
  const { window, $, dataRows } = await boot(stats);
  const head = () => [...$('tMonth').querySelectorAll('thead th')].map((th) => th.textContent.trim());

  console.log('\n【19.1】默认按月');
  check('默认「按月」按钮是高亮态', /btn-p/.test($('mByMonth').className), $('mByMonth').className);
  check('默认「按周」按钮不是高亮态', !/btn-p/.test($('mByWeek').className), $('mByWeek').className);
  check('默认表头首列是「月份」', head()[0] === '月份', head()[0]);
  check('默认渲染的月数等于 monthRows 条数',
    dataRows('Month').length === stats.monthRows.length,
    dataRows('Month').length + ' vs ' + stats.monthRows.length);
  check('默认说明写的是「按月」', /按月/.test($('monthCap').textContent), $('monthCap').textContent);

  console.log('\n【19.2】切到按周');
  $('mByWeek').click();
  await wait(60);
  check('切周后「按周」按钮变成高亮态', /btn-p/.test($('mByWeek').className), $('mByWeek').className);
  check('切周后「按月」按钮褪掉高亮', !/btn-p/.test($('mByMonth').className), $('mByMonth').className);
  check('切周后表头首列变成「周（起）」', head()[0] === '周（起）', head()[0]);
  check('切周后渲染的周数等于 weekRows 条数',
    dataRows('Month').length === stats.weekRows.length,
    dataRows('Month').length + ' vs ' + stats.weekRows.length);
  check('切周后说明改口「按周」', /按周/.test($('monthCap').textContent), $('monthCap').textContent);
  check('切周后说明点出「周一为一周之首」', /周一/.test($('monthCap').textContent), $('monthCap').textContent);
  // 周标签是「MM/DD ~ MM/DD」：周一起、周日止。只显示起始日的话看不出覆盖到哪天。
  const wk = stats.weekRows[0] && stats.weekRows[0].label;
  check('周标签是起止区间而不是单个日期',
    !!wk && /\d{2}\/\d{2}\s*~\s*\d{2}\/\d{2}/.test(wk), String(wk));
  // 周标签里的起始日必须真的是周一（用 Date 复核，别信自己算的）
  if (wk) {
    const m = wk.match(/(\d{2})\/(\d{2})/);
    const key = stats.weekRows[0].key;
    const d = new Date(key + 'T00:00:00');
    check('周标签起始日与 weekRows.key 同源', `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}` === m[0],
      m[0] + ' vs ' + key);
    check('weekRows.key 是周一', d.getDay() === 1, '星期' + d.getDay());
  }
  check('切周后「覆盖部门」列仍在表头（只是未解锁时被 CSS 隐藏）',
    head().includes('覆盖部门'), head().join(','));

  console.log('\n【19.3】切回按月');
  $('mByMonth').click();
  await wait(60);
  check('切回后表头首列回到「月份」', head()[0] === '月份', head()[0]);
  check('切回后行数回到 monthRows 条数',
    dataRows('Month').length === stats.monthRows.length,
    dataRows('Month').length + ' vs ' + stats.monthRows.length);
  check('切回后「按月」重新高亮', /btn-p/.test($('mByMonth').className), $('mByMonth').className);
  window.close();
}

/** 【20】依据对标诊断：需人工复核条目分页（不再流式排一条长表） */
async function basisPager() {
  // 快照里只有 16 条低于认可线（不足一页），凑不出第 2 页。
  // 这里造 45 条全部低于认可线的条目，专门验分页边界。
  const line = stats.quality.line;
  const mk = (i) => ({
    d: '2026-09-0' + ((i % 9) + 1), p: '第' + ((i % 4) + 1) + '车间', t: '电气',
    m: '隐患' + i, s: 'GB 50054-' + (2000 + i), ra: 90, da: 90, ba: 10 + (i % 5), ca: 12 + (i % 5),
  });
  const many = Array.from({ length: 45 }, (_, i) => mk(i));
  const st = Object.assign({}, stats, {
    quality: Object.assign({}, stats.quality, { items: many, line: line }),
  });
  const { window, $ } = await boot(st);
  const tbl = () => $('basisLow').querySelector('table');
  const rows = () => (tbl() ? tbl().querySelectorAll('tbody tr').length : 0);
  const pager = () => $('basisPager');

  console.log('\n【20.1】第 1 页');
  check('渲染出分页控件', !!pager(), String(!!pager()));
  check('说明写明总条数 45', /共\s*45\s*条/.test($('basisLow').textContent), ($('basisLow').textContent.match(/共\s*\d+\s*条/) || [''])[0]);
  check('第 1 页只渲染 20 行（不是 45 行全铺下来）', rows() === 20, rows());
  check('页码信息显示「第 1 / 3 页」', /第\s*1\s*\/\s*3\s*页/.test(pager().textContent), pager().textContent);
  const prevBtn = [...pager().querySelectorAll('button')].find((b) => b.textContent === '上一页');
  check('第 1 页「上一页」是禁用的', !!prevBtn && prevBtn.disabled === true, prevBtn && prevBtn.disabled);

  console.log('\n【20.2】翻到第 2 页');
  const b2 = pager().querySelector('button[data-page="2"]');
  check('存在第 2 页按钮', !!b2, String(!!b2));
  b2.click();
  await wait(60);
  check('第 2 页仍渲染 20 行', rows() === 20, rows());
  check('第 2 页页码信息跟着走', /第\s*2\s*\/\s*3\s*页/.test($('basisPager').textContent), $('basisPager').textContent);
  check('第 2 页「上一页」不再禁用',
    [...$('basisPager').querySelectorAll('button')].find((b) => b.textContent === '上一页').disabled === false);
  // 第 1 页和第 2 页的首行内容必须不同 —— 只改页码不换数据是最容易被忽略的分页 bug
  const firstCell = () => tbl().querySelector('tbody tr').children[3].textContent.trim();
  const p2first = firstCell();
  $('basisPager').querySelector('button[data-page="1"]').click();
  await wait(60);
  check('翻回第 1 页首行与第 2 页首行不是同一条', firstCell() !== p2first, firstCell() + ' vs ' + p2first);

  console.log('\n【20.3】末页与边界');
  $('basisPager').querySelector('button[data-page="3"]').click();
  await wait(60);
  check('末页只渲染余下的 5 行', rows() === 5, rows());
  const nextBtn = [...$('basisPager').querySelectorAll('button')].find((b) => b.textContent === '下一页');
  check('末页「下一页」是禁用的', !!nextBtn && nextBtn.disabled === true, nextBtn && nextBtn.disabled);
  // 点禁用的按钮不该把页码带飞
  nextBtn.click();
  await wait(60);
  check('点禁用的「下一页」页码不动', /第\s*3\s*\/\s*3\s*页/.test($('basisPager').textContent), $('basisPager').textContent);

  console.log('\n【20.4】不足一页时不显示页码按钮');
  const few = Object.assign({}, stats, {
    quality: Object.assign({}, stats.quality, { items: many.slice(0, 7) }),
  });
  const small = await boot(few);
  check('只有 7 条时说明仍写总数', /共\s*7\s*条/.test(small.$('basisLow').textContent),
    (small.$('basisLow').textContent.match(/共\s*\d+\s*条/) || [''])[0]);
  check('只有 7 条时不渲染页码按钮',
    small.$('basisLow').querySelectorAll('button').length === 0,
    small.$('basisLow').querySelectorAll('button').length);
  small.window.close();
  window.close();
}

/** 【21】评价人一致性：多人时「各评审人综合分」竖向排列（横排会撑爆一列） */
async function spreadLayout() {
  const fake = [
    { key: 'R1#1', recordId: 'R1', hazardNo: 1, name: '未佩戴防护面罩', dept: '一车间',
      reviewers: [
        { reviewer: '评审员B', verdict: 'pass', overall: 92 },
        { reviewer: '评审员C', verdict: 'issue', overall: 71 },
        { reviewer: '评审员D', verdict: 'pass', overall: 88 },
      ], spread: 21, min: 71, max: 92 },
    { key: 'R2#3', recordId: 'R2', hazardNo: 3, name: '电缆护套破损', dept: '二车间',
      reviewers: [
        { reviewer: '评审员A', verdict: 'pass', overall: 90 },
        { reviewer: '评审员B', verdict: 'issue', overall: 80 },
      ], spread: 10, min: 80, max: 90 },
  ];
  // ⚠️ 快照本身是管理员视图（deptUnlocked: true），列本来就该显示。
  // 验「上锁时藏列」必须显式换成上锁版，否则断言等于空转（这个坑我自己踩过一次）。
  const st = Object.assign({}, stats, {
    agreement: Object.assign({}, stats.agreement, { spreads: fake }),
    deptUnlocked: false, deptRows: [],
  });
  const { window, $, doc } = await boot(st);
  await wait(80);                       // 等 MutationObserver 打上 col-dept

  console.log('\n【21.1】竖向排列');
  const trs = $('tSpread').querySelectorAll('tbody tr');
  check('两行分歧隐患都渲染了', trs.length === 2, trs.length);
  const boxes = [...trs].map((tr) => tr.querySelector('.spreadrev'));
  check('每行都有 .spreadrev 容器', boxes.every(Boolean), boxes.map(Boolean).join(','));
  check('3 人那条渲染 3 行（不是挤在一行里）', boxes[0].children.length === 3, boxes[0].children.length);
  check('2 人那条渲染 2 行', boxes[1].children.length === 2, boxes[1].children.length);
  check('每个评审人一个 <div>',
    [...boxes[0].children].every((el) => el.tagName === 'DIV'),
    [...boxes[0].children].map((el) => el.tagName).join(','));
  check('.spreadrev 是 flex 容器', window.getComputedStyle(boxes[0]).display === 'flex',
    window.getComputedStyle(boxes[0]).display);
  // 关键是方向：横排（row）等于没改，人多照样撑爆
  const dir = window.getComputedStyle(boxes[0]).flexDirection;
  check('.spreadrev 是纵向排列（column）', dir === 'column' || dir === '', String(dir));

  console.log('\n【21.2】内容完整');
  const txt0 = boxes[0].textContent;
  for (const n of ['评审员B', '评审员C', '评审员D']) check(`竖向块里有 ${n}`, txt0.includes(n), txt0);
  check('每人带上自己的综合分', /92/.test(txt0) && /71/.test(txt0) && /88/.test(txt0), txt0);
  check('认可 / 存疑 判定也保留', /认可/.test(txt0) && /存疑/.test(txt0), txt0);
  check('「参评人」列仍把三人列全（横向摘要没丢）',
    trs[0].children[3].textContent.includes('评审员B') && trs[0].children[3].textContent.includes('评审员C'),
    trs[0].children[3].textContent);

  console.log('\n【21.3】部门列仍受管理员开关控制');
  const th = $('tSpread').querySelector('thead th.col-dept');
  check('分歧表的「部门」列被打上 col-dept', !!th, String(!!th));
  check('未解锁时该列隐藏', !!th && window.getComputedStyle(th).display === 'none',
    th ? window.getComputedStyle(th).display : 'no-th');
  // 注意分工：客户端只是 CSS 藏列，DOM 里其实还留着值（这条合成数据绕过了服务端脱敏）。
  // 真正把部门名从响应里抹掉的是服务端 —— 那条断言在 test_admin_auth.js 第 9 节。
  // 这里就按服务端实际会下发的样子（部门为空）再验一遍，确认界面上不会漏出部门名。
  const anonShape = Object.assign({}, st, {
    agreement: Object.assign({}, st.agreement, {
      spreads: fake.map((r) => Object.assign({}, r, { dept: '' })),
    }),
  });
  const an = await boot(anonShape);
  await wait(80);
  const atr = an.$('tSpread').querySelector('tbody tr');
  check('服务端脱敏后界面上不出现部门名',
    !atr.textContent.includes('一车间'), atr.textContent);
  check('空部门显示为占位符而不是空白格',
    atr.children[1].textContent.trim() === '—', JSON.stringify(atr.children[1].textContent));
  check('脱敏后竖向布局照常（脱敏不影响展示）',
    atr.querySelector('.spreadrev').children.length === 3,
    atr.querySelector('.spreadrev').children.length);
  an.window.close();
  void doc;
  window.close();

  // 解锁后同一列必须回来：只藏不放等于把功能藏没了
  const un = await boot(Object.assign({}, st, { deptUnlocked: true, deptRows: stats.deptRows }));
  await wait(80);
  const uth = un.$('tSpread').querySelector('thead th.col-dept');
  check('解锁后「部门」列恢复显示',
    !!uth && un.window.getComputedStyle(uth).display !== 'none',
    uth ? un.window.getComputedStyle(uth).display : 'no-th');
  check('解锁后正文里能看到部门名',
    un.$('tSpread').querySelector('tbody tr').textContent.includes('一车间'),
    un.$('tSpread').querySelector('tbody tr').textContent);
  un.window.close();
}

(async () => {
  await main();
  await paged();
  await quality();
  await severity();
  await people();
  await trendBreak();
  await jumpNav();
  await deptLock();
  await timeUnit();
  await basisPager();
  await spreadLayout();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
