// jsdom 冒烟测试（单卡片牌堆版）：引导页 / 单卡渲染 / 竖向滚动不误触 / 左右滑 / 上一条下一条 / 筛选 / 空场景复核 / 评完面板
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = 'D:\\Project\\AI眼镜\\hazard-review';
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const hzData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'hazards.json'), 'utf8'));

const DIMS = [
  { key: 'real', label: '隐患真实性', hint: '画面中是否确实存在这条隐患', low: '不存在', high: '确实存在' },
  { key: 'desc', label: '隐患描述符合性', hint: '描述内容是否与画面事实一致', low: '完全不符', high: '完全符合' },
  { key: 'basis', label: '法规依据适用性', hint: '引用条款是否适用于该隐患', low: '不适用', high: '完全适用' },
  { key: 'cite', label: '依据引用准确性', hint: '引用条款是否适用于该区域、行业', low: '不适用', high: '完全适用' },
];

const submitted = [];
const withHz = hzData.records.filter((r) => r.hazards.length).slice(0, 6);
const noHz = hzData.records.filter((r) => !r.hazards.length).slice(0, 2);
// 再放两条更早的记录：用于验证「默认只看最近一周」会把它们排除在外
const older = hzData.records.filter((r) => r.hazards.length && String(r.time).slice(0, 10) < '2026-09-01').slice(0, 2);

// 模拟服务端的「列表精简版」：法规依据只带开头 + more 标记
function slim(r) {
  const out = { id: r.id, dept: r.dept, inspector: r.inspector, device: r.device, time: r.time, image: r.image };
  if (!r.hazards.length) out.summary = r.summary;
  out.hazards = r.hazards.map((h) => ({
    no: h.no, name: h.name, desc: h.desc, advice: h.advice, std: h.std,
    basis: h.basis.length > 56 ? h.basis.slice(0, 56) + '…' : h.basis,
    more: h.basis.length > 56,
  }));
  return out;
}
const recentRecords = withHz.concat(noHz).map(slim);      // 最新的一批（09-16 / 09-17）
const oldRecords = older.map(slim);                        // 更早的一批（08 月）
const sampleRecords = recentRecords.concat(oldRecords);
// 首屏第一张卡 = 第一条记录的第一个隐患，用于校验依据全文自动补齐
const FIRST_FULL_BASIS = withHz[0].hazards[0].basis;

// 条数口径：有隐患的记录按隐患数算，空场景按 1 条算
const itemsOf = (recs) => recs.reduce((a, r) => a + (r.hazards.length || 1), 0);
const dayOfR = (r) => String(r.time || '').slice(0, 10);
const inR = (r, a, b) => { const d = dayOfR(r); return d >= a && d <= b; };

// 时间跨度与「默认最近一周」都由 mock 数据推导，避免写死日期
const SPAN_DAYS = sampleRecords.map(dayOfR).filter(Boolean).sort();
const SPAN_FIRST = SPAN_DAYS[0];                                      // 最早识别日期
const SPAN_LAST = SPAN_DAYS[SPAN_DAYS.length - 1];                    // 最新识别日期
function shiftDayT(day, delta) {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
const WEEK_FROM = shiftDayT(SPAN_LAST, -6);                           // 显式区间用（部门 + 时间联合筛选）
const TODAY = (() => {                                                // 浏览器本地「今天」
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
})();
// 默认区间 = 记录首日 ~ 今日（= 全部时间）；快捷档都以今日为终点，起点不早于数据首日
const DEFAULT_FROM = SPAN_FIRST;
const DEFAULT_TO = TODAY;
const clampFrom = (d) => (d < SPAN_FIRST ? SPAN_FIRST : d);
const QUICK_WEEK_FROM = clampFrom(shiftDayT(TODAY, -6));
const QUICK_MONTH_FROM = clampFrom(shiftDayT(TODAY, -29));
const HZ_IN = (a, b) => sampleRecords.filter((r) => inR(r, a, b)).reduce((s, r) => s + r.hazards.length, 0);
const ITEMS_IN = (a, b) => itemsOf(sampleRecords.filter((r) => inR(r, a, b)));
const RECS_IN = (a, b) => sampleRecords.filter((r) => inR(r, a, b)).length;
// 筛选标签里的短区间文本：同年只显示 MM-DD~MM-DD
const shortR = (a, b) => (a.slice(0, 4) === b.slice(0, 4) ? a.slice(5) + '~' + b.slice(5) : a + '~' + b);
const NONE_RECS = sampleRecords.filter((r) => !r.hazards.length).length;   // AI 未识别到隐患的记录数

const RECENT_HZ = withHz.reduce((a, r) => a + r.hazards.length, 0);   // 默认区间内的隐患条数（空场景开关关着）
const RECENT_ITEMS = itemsOf(recentRecords);                          // 默认区间内全部条数（含空场景）
const OLD_ITEMS = itemsOf(oldRecords);
const ALL_ITEMS = RECENT_ITEMS + OLD_ITEMS;
const ALL_HZ = RECENT_HZ + oldRecords.reduce((a, r) => a + r.hazards.length, 0);
const OLD_LAST = oldRecords.map(dayOfR).filter(Boolean).sort().pop();  // 更早那批里最新的日期
const REC_COUNT_ALL = sampleRecords.length;                           // 不限时间时的记录条数
const REC_COUNT_WEEK = sampleRecords.filter((r) => inR(r, WEEK_FROM, SPAN_LAST)).length;
// 关键词搜索的期望值：口径必须和页面 matchKeyword() 一致 ——
// 记录编号 + 隐患名称 + 隐患描述 + 法规依据（列表里的 basis 是截断版，所以期望值也从截断版算）
const KW = '电气';                     // 用户原话里举的例子，且新旧两段数据里都命中
const kwHit = (r, h, kw) => (r.id + ' ' + h.name + ' ' + h.desc + ' ' + h.basis).toLowerCase().includes(kw.toLowerCase());
/** 命中关键词的「隐患卡片」条数（不含 AI 未识别到隐患的记录，因为搜索态下开关默认关着） */
const kwHz = (recs, kw) => recs.reduce((a, r) => a + r.hazards.filter((h) => kwHit(r, h, kw)).length, 0);
/** 命中关键词的「记录」条数 —— 用于核对搜索面板提示里的「来自 N 条记录」 */
const kwRecs = (recs, kw) => recs.filter((r) => r.hazards.some((h) => kwHit(r, h, kw))).length;
const KW_ALL = kwHz(sampleRecords, KW);
const KW_WEEK = kwHz(sampleRecords.filter((r) => inR(r, WEEK_FROM, SPAN_LAST)), KW);
const KW_RECS_ALL = kwRecs(sampleRecords, KW);
const KW_NOWORD = '不存在的关键词ZZZ';

function makeFetch() {
  return async (url, opt) => {
    const u = String(url);
    let body = {};
    if (u.includes('/api/meta')) body = { meta: hzData.meta, dimensions: DIMS, initScore: 90, inspectors: ['检查员A', '检查员B'], reviewers: [] };
    else if (u.includes('/api/hazards')) body = { meta: hzData.meta, records: sampleRecords };
    else if (u.includes('/api/basis')) {
      const keys = decodeURIComponent((u.split('keys=')[1] || '')).split(',').filter(Boolean);
      const out = {};
      for (const k of keys) {
        const [rid, no] = k.split('#');
        const rec = hzData.records.find((r) => r.id === rid);
        const h = rec && rec.hazards.find((x) => String(x.no) === String(no));
        if (h) out[k] = h.basis;
      }
      body = out;
    }
    else if (u.includes('/api/my')) body = { items: [], general: '', generals: {} };
    else if (u.includes('/api/delete')) body = { ok: true, removed: 1 };
    else if (u.includes('/api/submit')) { const p = JSON.parse(opt.body); submitted.push(p); body = { ok: true, saved: (p.items || []).length }; }
    return { ok: true, json: async () => body };
  };
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function swipe(win, el, from, to) {
  el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, clientX: from[0], clientY: from[1] }));
  win.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: to[0], clientY: to[1] }));
  win.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, clientX: to[0], clientY: to[1] }));
}
function tap(win, el, at) {
  el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, clientX: at[0], clientY: at[1] }));
  win.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, clientX: at[0], clientY: at[1] }));
}

(async () => {
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = makeFetch();
      w.addEventListener('error', (e) => errors.push(e.message || String(e.error)));
      w.onerror = (m) => errors.push(String(m));
      w.onunhandledrejection = (e) => errors.push('unhandled: ' + e.reason);
    },
  });
  const { window } = dom;
  await wait(400);
  const doc = window.document;
  const $ = (id) => doc.getElementById(id);
  const card = () => $('card');
  const cardText = () => $('card').textContent;

  // 跳到下一个「AI 未识别到隐患」的卡片；返回是否找到
  function navToNone() {
    for (let i = 0; i < 500; i++) {
      if (!$('panel').hidden) return false;
      if (/AI 未识别到隐患/.test(cardText())) return true;
      $('btnNext').click();
    }
    return false;
  }

  console.log('\n【1】引导页');
  check('引导页显示', $('gate').style.display === 'flex');
  check('引导页已去掉部门选择', !$('gDeps'), 'gDeps 仍在');
  check('姓名补全已注入', $('nameList').children.length === 2);

  $('gName').value = '测试工程师';
  await $('gGo').onclick();
  await wait(200);

  console.log('\n【2】单卡片渲染与信息完整度');
  check('引导页关闭', $('gate').style.display === 'none');
  check('只有一个卡片容器', doc.querySelectorAll('.swipe').length === 1);
  check('卡片已渲染', $('swipe').hidden === false);
  check('操作条已显示', $('ops').hidden === false);
  check('默认覆盖全部时间：总数 = 全量隐患条数', Number($('pAll').textContent) === ALL_HZ,
    $('pAll').textContent + ' vs ' + ALL_HZ + '（全量含漏检 ' + ALL_ITEMS + '）');
  check('当前定位第 1 条', Number($('pIdx').textContent) === 1, $('pIdx').textContent);
  check('卡片含「隐患描述」段', /隐患描述/.test(cardText()));
  check('卡片含「整改建议」段', /整改建议/.test(cardText()));
  check('卡片含「法规依据」段', /法规依据/.test(cardText()));
  check('整改建议有实际内容', card().querySelector('.csec.advice p').textContent.trim().length > 5,
    card().querySelector('.csec.advice p').textContent.slice(0, 30));
  check('卡片显示记录编号/检查人', /检查人/.test(cardText()) && !!card().querySelector('.recid'));

  console.log('\n【2.5】法规依据直接全文展示（单卡片下不再折叠）');
  const basisBox = card().querySelector('[data-basis]');
  check('依据区无折叠类', !basisBox.classList.contains('clamp'));
  check('依据区无「展开全文」按钮', !card().querySelector('[data-more]'));
  await wait(300);                       // 等 ensureBasis 把全文补齐
  const basisLen = basisBox.querySelector('[data-basis-text]').textContent.length;
  check('依据已自动补齐为全文', basisLen > 60, basisLen + ' 字');
  check('依据全文与数据一致', basisBox.querySelector('[data-basis-text]').textContent === FIRST_FULL_BASIS,
    '期望 ' + FIRST_FULL_BASIS.length + ' 字，实得 ' + basisLen);

  console.log('\n【3】竖向滚动不应误入评分页（核心修复）');
  swipe(window, card(), [200, 500], [200, 260]);
  await wait(80);
  check('纯垂直上滑未打开评分面板', !$('sheet').classList.contains('show'));
  swipe(window, card(), [180, 600], [186, 300]);
  await wait(80);
  check('斜向但以纵向为主也未打开', !$('sheet').classList.contains('show'));

  console.log('\n【4】轻点打开评分抽屉');
  tap(window, card(), [150, 400]);
  await wait(80);
  check('轻点打开评分面板', $('sheet').classList.contains('show'));
  check('四个评分滑块已渲染', doc.querySelectorAll('.slider').length === 4);
  check('滑块默认值 90', [...doc.querySelectorAll('.slider input')].every((i) => Number(i.value) === 90));
  check('现场图片已插入', !!$('pic'));
  check('底部按钮为「保存并下一条」', /保存并下一条/.test($('shFoot').textContent));
  $('shClose').click();
  await wait(80);

  console.log('\n【5】右滑打开评分抽屉');
  swipe(window, card(), [80, 400], [230, 404]);
  await wait(120);
  check('右滑打开评分面板', $('sheet').classList.contains('show'));
  check('右滑后卡片已回弹', !card().style.transform);
  $('shClose').click();
  await wait(100);

  console.log('\n【6】左滑 = 认可并翻到下一条');
  const before = submitted.length;
  const key0 = $('swipe').dataset.k;
  swipe(window, card(), [320, 420], [200, 422]);   // 左滑 120px
  await wait(340);
  const p2 = submitted[submitted.length - 1];
  check('产生认可提交', submitted.length === before + 1);
  check('判定为认可', p2 && p2.items[0].verdict === 'pass', p2 && p2.items[0].verdict);
  check('四项均为初始分', p2 && Object.values(p2.items[0].scores).every((v) => v === 90));
  check('未打开评分面板', !$('sheet').classList.contains('show'));
  check('提示带撤销按钮', /撤销/.test($('toast').textContent));
  check('已自动翻到下一条', $('swipe').dataset.k !== key0, key0 + ' → ' + $('swipe').dataset.k);
  check('进度已更新', Number($('pDone').textContent) === 1, $('pDone').textContent);
  check('序号已前进到 2', Number($('pIdx').textContent) === 2, $('pIdx').textContent);

  console.log('\n【7】左滑幅度不足则回弹');
  const n3 = submitted.length;
  swipe(window, card(), [300, 430], [255, 432]);   // 只滑 45px
  await wait(120);
  check('未产生提交', submitted.length === n3);
  check('卡片回弹无位移', !card().style.transform);
  check('未打开评分面板', !$('sheet').classList.contains('show'));

  console.log('\n【8】上一条 / 下一条按钮');
  const idxNow = Number($('pIdx').textContent);
  $('btnNext').click();
  check('下一条：序号 +1', Number($('pIdx').textContent) === idxNow + 1, $('pIdx').textContent);
  $('btnPrev').click();
  check('上一条：序号 -1', Number($('pIdx').textContent) === idxNow, $('pIdx').textContent);
  $('btnPrev').click(); $('btnPrev').click();
  check('已在第一条时不会越界', Number($('pIdx').textContent) >= 1, $('pIdx').textContent);

  console.log('\n【9】筛选面板（时间区间默认全部 + 空场景开关）');
  $('btnFilter').click();
  await wait(60);
  check('筛选面板已打开', $('filters').classList.contains('show'));
  check('起止日期默认「记录首日 ~ 今日」',
    $('fFrom').value === DEFAULT_FROM && $('fTo').value === DEFAULT_TO,
    $('fFrom').value + ' ~ ' + $('fTo').value);
  check('未点「应用」前不改变列表', Number($('pAll').textContent) === ALL_HZ, $('pAll').textContent);
  $('swNone').click();
  check('空场景开关已打开', $('swNone').classList.contains('on'));
  $('fApply').click();
  await wait(120);
  check('应用后含入空场景记录', Number($('pAll').textContent) === ALL_ITEMS, $('pAll').textContent);
  check('应用后面板关闭', !$('filters').classList.contains('show'));

  console.log('\n【10】空场景：左滑确认无隐患');
  check('可导航到空场景卡片', navToNone() === true);
  check('空场景卡片说明可标记漏检', /疑似漏检|标记漏检/.test(cardText()));
  const n4 = submitted.length;
  swipe(window, card(), [320, 600], [190, 602]);
  await wait(340);
  const pn = submitted[submitted.length - 1];
  check('空场景左滑产生提交', submitted.length === n4 + 1);
  check('判定为确认无隐患', pn && pn.items[0].verdict === 'pass' && pn.items[0].hazardNo === 0);
  check('空场景不写评分', pn && Object.keys(pn.items[0].scores || {}).length === 0);

  console.log('\n【11】空场景：标记疑似漏检');
  const found = navToNone();
  check('还有第二个空场景卡片', found === true);
  if (found) {
    tap(window, card(), [150, 500]);
    await wait(120);
    check('漏检复核面板打开', $('sheet').classList.contains('show'));
    check('出现「确认无隐患 / 疑似漏检」选项', !!$('pick') && $('pick').children.length === 2);
    $('pick').querySelector('[data-v="issue"]').click();
    await wait(50);
    check('选择疑似漏检后出现说明输入框', $('missBlk').style.display !== 'none');
    $('adviceBox').value = '画面右侧配电箱箱门敞开';
    $('noteBox').value = '《建筑电气工程施工质量验收规范》GB 50303-2015';
    $('doSave').click();
    await wait(300);
    const pm = submitted[submitted.length - 1];
    check('漏检复核已提交', pm && pm.items[0].hazardNo === 0);
    check('判定为疑似漏检', pm && pm.items[0].verdict === 'issue');
    check('漏检描述已带上', pm && pm.items[0].advice === '画面右侧配电箱箱门敞开');
    check('依据已带上', pm && /GB 50303/.test(pm.items[0].note));
  }

  console.log('\n【11.5】「疑似漏检」= 所有 AI 未识别到隐患的记录（召回率口径）');
  $('btnFilter').click();
  await wait(60);
  $('fStatus').querySelector('[data-v="miss"]').click();
  $('fApply').click();
  await wait(120);
  check('「疑似漏检」筛出全部 AI 未识别到隐患的记录（不管评没评过）',
    Number($('pAll').textContent) === NONE_RECS, $('pAll').textContent + ' vs ' + NONE_RECS);
  check('筛选标签显示「疑似漏检」', $('filterLabel').textContent.indexOf('疑似漏检') >= 0,
    $('filterLabel').textContent);
  check('筛出来的卡片都是漏检复核卡', /漏检复核|未识别到隐患/.test(cardText()), cardText().slice(0, 60));

  $('btnOverview').click();
  await wait(80);
  check('总览给出漏检复核（召回）进度', /漏检复核（召回）/.test($('panel').textContent));
  check('总览漏检复核条数与数据一致',
    new RegExp('共 <b>' + NONE_RECS + '</b> 条').test($('panel').innerHTML),
    $('panel').textContent.replace(/\s+/g, ' ').slice(0, 140));
  $('panel').querySelector('[data-act="back"]').click();
  await wait(80);

  $('btnFilter').click();
  await wait(60);
  $('fStatus').querySelector('[data-v="all"]').click();
  $('fApply').click();
  await wait(120);
  check('复位到全部状态', Number($('pAll').textContent) === ALL_ITEMS, $('pAll').textContent);

  console.log('\n【12】走到末尾出现「时段总览」');
  for (let i = 0; i < 500 && $('panel').hidden; i++) $('btnNext').click();
  check('末尾出现总览面板', !$('panel').hidden);
  check('总览标题正确', /本次筛选进度总览|本次筛选已评完/.test($('panel').textContent));
  check('总览时隐藏操作条', $('ops').hidden === true);
  check('总览显示已评 / 待评条数', /已评条数/.test($('panel').textContent) && /待评条数/.test($('panel').textContent));
  check('总览显示各维度表现', /各维度表现/.test($('panel').textContent));
  check('总览显示综合均分', /综合均分/.test($('panel').textContent));
  check('总览有「填写本时段处理意见」', /填写本次筛选处理意见|修改本次筛选处理意见/.test($('panel').textContent));

  const dots = $('panel').querySelectorAll('.dot');
  const totalNow = Number($('pAll').textContent);
  check('圆点阵列数量 = 当前范围条数', dots.length === totalNow, dots.length + ' vs ' + totalNow);
  check('圆点有已评状态', $('panel').querySelectorAll('.dot.d-pass, .dot.d-issue, .dot.d-miss').length > 0);
  check('圆点有未评状态', $('panel').querySelectorAll('.dot:not(.d-pass):not(.d-issue):not(.d-miss)').length > 0);
  check('有未评遗漏提示', /还有 .* 条未评/.test($('panel').textContent));
  check('遗漏提示带「回到第一条未评」', !!$('panel').querySelector('.ovmiss [data-jump]'));

  // 时段总览里的维度雷达图
  check('总览含维度雷达图', !!$('panel').querySelector('.ovradar svg'));
  check('雷达图 4 个顶点', $('panel').querySelectorAll('.ovradar circle').length === 4,
    $('panel').querySelectorAll('.ovradar circle').length);
  check('雷达图有 4 层网格 + 数据面', $('panel').querySelectorAll('.ovradar polygon').length === 5,
    $('panel').querySelectorAll('.ovradar polygon').length);
  check('雷达图标注维度名',
    /真实性/.test($('panel').querySelector('.ovradar').textContent) &&
    /引用/.test($('panel').querySelector('.ovradar').textContent),
    $('panel').querySelector('.ovradar').textContent);

  const todoIdx = Number($('panel').querySelector('.ovmiss [data-jump]').dataset.jump);
  check('第一条未评的下标有效', todoIdx >= 0 && todoIdx < totalNow, String(todoIdx));
  $('panel').querySelector('.ovmiss [data-jump]').click();
  await wait(60);
  check('点击跳转到未评卡片', $('panel').hidden === true && Number($('pIdx').textContent) === todoIdx + 1,
    $('pIdx').textContent + ' vs ' + (todoIdx + 1));

  console.log('\n【12.5】进度：已评 / 待评 / 跳过回看');
  check('头部显示待评条数', $('pTodo') && $('pTodo').textContent !== '', $('pTodo') && $('pTodo').textContent);
  check('已评 + 待评 = 总数', Number($('pDone').textContent) + Number($('pTodo').textContent) === totalNow,
    $('pDone').textContent + ' + ' + $('pTodo').textContent + ' vs ' + totalNow);
  // 跳到末尾 → 前面应有跳过
  for (let i = 0; i < 500 && $('panel').hidden; i++) $('btnNext').click();
  check('跳过提示已出现', $('pSkip').hidden === false);
  const skipTxt = $('pSkip').textContent;
  const skipN = Number((skipTxt.match(/跳过\s*(\d+)/) || [])[1]);
  check('跳过条数 > 0 且合理', skipN > 0 && skipN <= totalNow, skipTxt);
  $('pSkip').click();
  await wait(60);
  check('点跳过提示可回看', $('panel').hidden === true && Number($('pIdx').textContent) <= totalNow, $('pIdx').textContent);
  check('回看的是未评卡片', /待评/.test(cardText()));

  console.log('\n【13】筛选：只看未评');
  $('btnFilter').click();
  $('fStatus').querySelector('[data-v="todo"]').click();
  $('fApply').click();
  await wait(120);
  const todoAll = Number($('pAll').textContent);
  const todoDone = Number($('pDone').textContent);
  check('未评筛选生效', todoAll > 0 && todoDone === 0, '未评 ' + todoAll + ' 条 / 已评 ' + todoDone);
  $('btnFilter').click();
  $('fStatus').querySelector('[data-v="all"]').click();
  $('fApply').click();
  await wait(120);
  check('恢复全部筛选', Number($('pAll').textContent) === ALL_ITEMS, $('pAll').textContent);

  console.log('\n【14】时间范围：默认全部 / 快捷档（最近一周、最近一月）/ 可自行调整');
  check('默认覆盖全量 → 顶部不显示「仅看…」提示', $('pRange').hidden === true, $('pRange').textContent);
  $('btnFilter').click();
  await wait(60);
  check('默认区间 = 记录首日 ~ 今日',
    $('fFrom').value === DEFAULT_FROM && $('fTo').value === DEFAULT_TO,
    $('fFrom').value + ' ~ ' + $('fTo').value);
  check('面板提示写明「记录数 + 可评条目数」',
    /该范围共 <b>\d+<\/b> 条记录，可评 <b>\d+<\/b> 条/.test($('fRangeHint').innerHTML),
    $('fRangeHint').textContent);
  check('面板提示拆分「隐患卡片 / 漏检复核」两个口径',
    $('fRangeHint').innerHTML.indexOf('漏检复核 <b>' + NONE_RECS + '</b> 条') >= 0,
    $('fRangeHint').textContent);
  check('提示里带全部数据时间跨度',
    $('fRangeHint').textContent.indexOf(SPAN_FIRST) >= 0 && $('fRangeHint').textContent.indexOf(SPAN_LAST) >= 0,
    $('fRangeHint').textContent);
  check('「不限时间」按钮已删除', !$('fRangeAll'));
  check('快捷区间按钮 = 全部时间 / 最近一周 / 最近一月',
    [...$('fQuick').children].map((b) => b.textContent).join(',') === '全部时间,最近一周,最近一月',
    [...$('fQuick').children].map((b) => b.textContent).join(','));
  check('默认命中「全部时间」快捷档', $('fQuick').querySelector('[data-r="all"]').classList.contains('on'));

  // 日期可选范围：最早 = 数据首日，最晚 = 今天
  check('起始日期 min = 数据首日', $('fFrom').min === SPAN_FIRST, $('fFrom').min + ' vs ' + SPAN_FIRST);
  check('起始日期 max = 今天', $('fFrom').max === TODAY, $('fFrom').max + ' vs ' + TODAY);
  check('截止日期 min = 数据首日', $('fTo').min === SPAN_FIRST, $('fTo').min + ' vs ' + SPAN_FIRST);
  check('截止日期 max = 今天', $('fTo').max === TODAY, $('fTo').max + ' vs ' + TODAY);
  check('面板提示写明可选日期范围',
    $('fRangeHint').textContent.includes(SPAN_FIRST) && $('fRangeHint').textContent.includes(TODAY),
    $('fRangeHint').textContent);

  // 手动填一个早于数据首日的日期 → 应被夹回首日
  $('fFrom').value = '2020-01-01';
  $('fFrom').oninput({ target: $('fFrom') });
  await wait(60);
  check('早于数据首日的日期被夹回', $('fFrom').value === SPAN_FIRST, $('fFrom').value);
  // 手动填一个未来的日期 → 应被夹回今天
  $('fTo').value = '2099-12-31';
  $('fTo').oninput({ target: $('fTo') });
  await wait(60);
  check('晚于今天的日期被夹回今天', $('fTo').value === TODAY, $('fTo').value);
  check('夹回后区间仍是合法顺序（起点 ≤ 终点）', $('fFrom').value <= $('fTo').value,
    $('fFrom').value + ' ~ ' + $('fTo').value);

  // 快捷档：最近一周 → 应排除更早的记录
  $('fQuick').querySelector('[data-r="week"]').click();
  await wait(60);
  check('点「最近一周」→ 区间 = 今日-6 ~ 今日（不早于数据首日）',
    $('fFrom').value === QUICK_WEEK_FROM && $('fTo').value === DEFAULT_TO,
    $('fFrom').value + ' ~ ' + $('fTo').value);
  check('「最近一周」按钮高亮', $('fQuick').querySelector('[data-r="week"]').classList.contains('on'));
  check('提示条数 = 该区间记录数',
    $('fRangeHint').innerHTML.indexOf('该范围共 <b>' + RECS_IN(QUICK_WEEK_FROM, DEFAULT_TO) + '</b> 条记录') >= 0,
    $('fRangeHint').textContent);
  $('fApply').click();
  await wait(120);
  check('应用「最近一周」→ 更早的记录被排除',
    Number($('pAll').textContent) === ITEMS_IN(QUICK_WEEK_FROM, DEFAULT_TO),
    $('pAll').textContent + ' vs ' + ITEMS_IN(QUICK_WEEK_FROM, DEFAULT_TO) + '（全量 ' + ALL_ITEMS + '）');
  check('收窄后出现「仅看…」范围提示',
    $('pRange').hidden === false && /仅看/.test($('pRange').textContent), $('pRange').textContent);
  check('范围提示带当前条数 / 全量条数',
    $('pRange').textContent.indexOf(String(ITEMS_IN(QUICK_WEEK_FROM, DEFAULT_TO))) >= 0 &&
    $('pRange').textContent.indexOf(String(ALL_ITEMS)) >= 0, $('pRange').textContent);
  check('收窄后筛选标签不再是「全部」', $('filterLabel').textContent !== '全部', $('filterLabel').textContent);

  // 快捷档：最近一月
  $('btnFilter').click();
  await wait(60);
  $('fQuick').querySelector('[data-r="month"]').click();
  await wait(60);
  check('点「最近一月」→ 区间 = 今日-29 ~ 今日（不早于数据首日）',
    $('fFrom').value === QUICK_MONTH_FROM && $('fTo').value === DEFAULT_TO,
    $('fFrom').value + ' ~ ' + $('fTo').value);
  check('「最近一月」按钮高亮', $('fQuick').querySelector('[data-r="month"]').classList.contains('on'));

  // 手改日期 → 快捷档取消高亮
  $('fFrom').value = shiftDayT(DEFAULT_FROM, 2);
  $('fFrom').oninput({ target: $('fFrom') });
  await wait(60);
  check('手改日期后快捷档取消高亮',
    [...$('fQuick').children].every((b) => !b.classList.contains('on')));

  // 快捷档：全部时间 → 回到全量
  $('fQuick').querySelector('[data-r="all"]').click();
  await wait(60);
  check('点「全部时间」→ 区间 = 记录首日 ~ 今日',
    $('fFrom').value === DEFAULT_FROM && $('fTo').value === DEFAULT_TO,
    $('fFrom').value + ' ~ ' + $('fTo').value);
  $('fApply').click();
  await wait(120);
  check('回到全量后顶部范围提示隐藏', $('pRange').hidden === true, $('pRange').textContent);
  check('回到全量后筛选标签回到「全部」', $('filterLabel').textContent === '全部', $('filterLabel').textContent);
  check('回到全量 = 全量条数', Number($('pAll').textContent) === ALL_ITEMS, $('pAll').textContent);

  // 起止日期填反 → 自动纠偏
  $('btnFilter').click();
  await wait(60);
  $('fTo').value = SPAN_FIRST;
  $('fTo').oninput({ target: $('fTo') });
  await wait(60);
  $('fFrom').value = SPAN_LAST;                      // 起点晚于终点 → 应互换
  $('fFrom').oninput({ target: $('fFrom') });
  await wait(60);
  check('起点晚于终点时自动互换',
    $('fFrom').value === SPAN_FIRST && $('fTo').value === SPAN_LAST,
    $('fFrom').value + ' ~ ' + $('fTo').value);
  $('fClose').click();
  await wait(60);

  console.log('\n【14.5】关键词 + 时间范围联合筛选（筛选面板入口）');
  const typeKw = (v) => { $('fKey').value = v; $('fKey').oninput({ target: $('fKey') }); };
  $('btnFilter').click();
  await wait(60);
  check('筛选面板已无部门栏', !$('fDept'), 'fDept 仍在');
  check('筛选面板已无「部门」字样', !/部门/.test($('filters').textContent), '筛选面板里还能看到「部门」');
  $('fQuick').querySelector('[data-r="all"]').click();
  await wait(60);
  typeKw(KW);
  await wait(60);
  check('输入关键词后提示条数实时联动', $('fRangeHint').textContent.indexOf(String(KW_ALL)) >= 0,
    $('fRangeHint').textContent.replace(/\s+/g, ' '));
  check('提示显示已叠加关键词', /已叠加关键词/.test($('fRangeHint').textContent), $('fRangeHint').textContent);
  $('fApply').click();
  await wait(120);
  check('关键词 + 全部时间 联合生效', Number($('pAll').textContent) === KW_ALL,
    $('pAll').textContent + ' vs ' + KW_ALL + '（关键词 ' + KW + '）');
  check('筛选标签显示关键词', $('filterLabel').textContent.indexOf(KW) >= 0, $('filterLabel').textContent);

  // 收窄到最近一周 → 更早的命中记录应被排除
  $('btnFilter').click();
  await wait(60);
  $('fFrom').value = WEEK_FROM;
  $('fFrom').oninput({ target: $('fFrom') });
  $('fTo').value = SPAN_LAST;
  $('fTo').oninput({ target: $('fTo') });
  $('fApply').click();
  await wait(120);
  check('关键词 + 近一周 联合生效（更早的命中被排除）', Number($('pAll').textContent) === KW_WEEK,
    $('pAll').textContent + ' vs ' + KW_WEEK);
  check('筛选标签同时显示关键词 + 时间区间',
    $('filterLabel').textContent === '「' + KW + '」 · ' + shortR(WEEK_FROM, SPAN_LAST),
    $('filterLabel').textContent);
  check('近一周 + 关键词 比 不限时间 + 关键词 更少', KW_WEEK < KW_ALL, KW_WEEK + ' < ' + KW_ALL);

  // 关键词 + 时间 + 未评 三条件叠加
  const mineKeys = new Set();
  for (const p of submitted) for (const it of (p.items || [])) mineKeys.add(it.recordId + '#' + it.hazardNo);
  const expectTodo = sampleRecords
    .filter((r) => inR(r, WEEK_FROM, SPAN_LAST))
    .reduce((a, r) => a + r.hazards.filter((h) => kwHit(r, h, KW) && !mineKeys.has(r.id + '#' + h.no)).length, 0);
  $('btnFilter').click();
  $('fStatus').querySelector('[data-v="todo"]').click();
  $('fApply').click();
  await wait(120);
  check('关键词 + 时间 + 未评 三条件叠加生效',
    Number($('pDone').textContent) === 0 && Number($('pAll').textContent) === expectTodo,
    $('pAll').textContent + ' vs ' + expectTodo + '（已评 ' + $('pDone').textContent + '）');

  // 恢复：清空关键词 + 不限时间 + 全部状态
  $('btnFilter').click();
  typeKw('');
  $('fQuick').querySelector('[data-r="all"]').click();
  $('fStatus').querySelector('[data-v="all"]').click();
  $('fApply').click();
  await wait(120);
  check('清空关键词 / 不限时间后恢复全量', Number($('pAll').textContent) === ALL_ITEMS, $('pAll').textContent);

  console.log('\n【14.6】隐患搜索入口（顶部「搜索隐患」）');
  check('顶部有搜索入口', !!$('btnSearch'));
  check('搜索面板默认关闭', !$('searchbox').classList.contains('show'));
  $('btnSearch').click();
  await wait(80);
  check('点入口后搜索面板打开', $('searchbox').classList.contains('show'));
  check('热门关键词已生成', $('sHot').children.length >= 4, $('sHot').children.length);
  check('搜索面板提示写明「自动切到全部时间」', /全部时间/.test($('sHint').textContent), $('sHint').textContent);

  // 热门词点一下应填进输入框并实时预告条数
  const hotEl = [...$('sHot').children].find((b) => b.dataset.w === KW);
  check('热门词里有测试用的关键词', !!hotEl, KW);
  if (hotEl) {
    hotEl.click();
    await wait(60);
    check('点热门词填入输入框', $('sKey').value === KW, $('sKey').value);
    check('搜索前先预告命中条数',
      $('sHint').textContent.indexOf(String(KW_ALL)) >= 0 && $('sHint').textContent.indexOf(String(KW_RECS_ALL)) >= 0,
      $('sHint').textContent.replace(/\s+/g, ' '));
  }

  // 先故意把时间收窄，验证「搜索会自动放开到全部时间」
  $('sClose').click();
  await wait(60);
  $('btnFilter').click();
  await wait(60);
  $('fFrom').value = WEEK_FROM;
  $('fFrom').oninput({ target: $('fFrom') });
  $('fTo').value = SPAN_LAST;
  $('fTo').oninput({ target: $('fTo') });
  $('fApply').click();
  await wait(120);

  $('btnSearch').click();
  await wait(60);
  $('sKey').value = KW;
  $('sKey').oninput({ target: $('sKey') });
  $('sGo').click();
  await wait(150);
  check('搜索后时间范围自动放开到全部', Number($('pAll').textContent) === KW_ALL,
    $('pAll').textContent + ' vs ' + KW_ALL);
  check('搜索后「仅看…」时间提示消失', $('pRange').hidden === true, $('pRange').textContent);
  check('顶部显示搜索批次提示', $('pSearch').hidden === false && $('pSearch').textContent.indexOf(KW) >= 0,
    $('pSearch').textContent);
  check('搜索批次提示写明已评条数', /已评 \d+/.test($('pSearch').textContent), $('pSearch').textContent);
  check('筛选标签显示当前搜索词', $('filterLabel').textContent.indexOf(KW) >= 0, $('filterLabel').textContent);
  check('搜索面板已关闭', !$('searchbox').classList.contains('show'));

  // 搜到的一批可以直接评分
  const searchFirstKey = $('swipe').dataset.k;
  $('btnPass').click();
  await wait(120);
  check('搜索批次里可以直接认可评分', submitted[submitted.length - 1].items.length === 1,
    JSON.stringify(submitted[submitted.length - 1]).slice(0, 120));
  check('搜索批次评分记录正确', submitted[submitted.length - 1].items[0].recordId + '#' + submitted[submitted.length - 1].items[0].hazardNo === searchFirstKey,
    searchFirstKey);

  // 总览应标注「含「电气」」，统一处理意见按关键词分档
  $('btnOverview').click();
  await wait(80);
  check('总览标注搜索范围 = 含「电气」',
    $('panel').querySelector('.ovscope').textContent === '含「' + KW + '」',
    $('panel').querySelector('.ovscope').textContent);
  $('panel').querySelector('[data-act="general"]').click();
  await wait(80);
  check('搜索批次的处理意见抽屉范围标注 = 含「电气」',
    $('gScopeLabel').textContent === '含「' + KW + '」', $('gScopeLabel').textContent);
  $('generalBox').value = '电气类隐患集中在配电箱与线路敷设，建议统一整改';
  $('gSave').click();
  await wait(180);
  check('搜索批次的处理意见 scope = 关键词:电气',
    submitted[submitted.length - 1].scope === '关键词:' + KW, submitted[submitted.length - 1].scope);

  // 换一个搜索词：意见不能串档
  $('btnSearch').click();
  await wait(60);
  $('sKey').value = KW_NOWORD;
  $('sKey').oninput({ target: $('sKey') });
  check('搜不到时搜索面板给出提示', /没有找到/.test($('sHint').textContent), $('sHint').textContent);
  $('sGo').click();
  await wait(150);
  check('搜不到时牌堆给出空态说明', !$('panel').hidden && /没搜到/.test($('panel').textContent),
    $('panel').textContent.slice(0, 80));
  check('空态下提供「清除搜索」', !!$('panel').querySelector('[data-act="clearSearch"]'));
  $('panel').querySelector('[data-act="clearSearch"]').click();
  await wait(150);
  check('清除搜索后恢复全量', Number($('pAll').textContent) === ALL_ITEMS, $('pAll').textContent);
  check('清除搜索后顶部提示消失', $('pSearch').hidden === true, $('pSearch').textContent);
  check('清除搜索后筛选标签回到「全部」', $('filterLabel').textContent === '全部', $('filterLabel').textContent);

  console.log('\n【15】时段处理意见（按 关键词 / 时间范围 分档）');
  check('提示条不再常驻「总体意见」按钮', !$('btnGeneral'));
  check('提示条改为「时段总览」入口', !!$('btnOverview'));

  // 先铺满全量再逐端收窄，避免「起点 > 终点」的中间态触发自动纠偏
  const setRange = (a, b) => {
    $('fQuick').querySelector('[data-r="all"]').click();
    $('fFrom').value = a; $('fFrom').oninput({ target: $('fFrom') });
    $('fTo').value = b; $('fTo').oninput({ target: $('fTo') });
  };

  $('btnOverview').click();
  await wait(60);
  check('总览可由按钮打开', !$('panel').hidden);
  check('总览标注当前范围', !!$('panel').querySelector('.ovscope') && $('panel').querySelector('.ovscope').textContent.length > 0);

  $('panel').querySelector('[data-act="general"]').click();
  await wait(60);
  check('时段意见抽屉打开', $('sheet2').classList.contains('show'));
  check('抽屉标题为时段处理意见', /筛选处理意见/.test($('sh2Title').textContent));
  check('不限时间 + 无关键词 → 范围标注为「全部数据」', $('gScopeLabel').textContent === '全部数据', $('gScopeLabel').textContent);
  check('抽屉显示已评 / 待评条数', /已评 \d+ 条/.test($('gScopeDesc').textContent), $('gScopeDesc').textContent);

  $('generalBox').value = '整体识别准确，建议加强依据引用校验';
  $('gSave').click();
  await wait(150);
  const subAll = submitted[submitted.length - 1];
  check('时段意见已提交', /整体识别准确/.test(JSON.stringify(subAll)));
  check('提交带上意见归属 scope', !!subAll.scope, String(subAll.scope));
  check('全部范围下 scope = 全部', subAll.scope === '全部', subAll.scope);
  check('保存后抽屉关闭', !$('sheet2').classList.contains('show'));

  // 切到「关键词 + 最近一周」这一档，意见应分档保存
  const scopeLabel2 = '含「' + KW + '」 · ' + WEEK_FROM + ' ~ ' + SPAN_LAST;
  const scopeKey2 = '关键词:' + KW + '|时间:' + WEEK_FROM + '~' + SPAN_LAST;
  $('btnFilter').click();
  await wait(60);
  setRange(WEEK_FROM, SPAN_LAST);
  typeKw(KW);
  $('fApply').click();
  await wait(120);
  $('btnOverview').click();
  await wait(60);
  check('总览标注当前范围 = 关键词 · 时间区间',
    $('panel').querySelector('.ovscope').textContent === scopeLabel2,
    $('panel').querySelector('.ovscope').textContent);
  $('panel').querySelector('[data-act="general"]').click();
  await wait(60);
  check('切范围后意见归属跟随', $('gScopeLabel').textContent === scopeLabel2, $('gScopeLabel').textContent);
  $('generalBox').value = '这一周的隐患集中在法规依据引用';
  $('gSave').click();
  await wait(150);
  check('分档意见归属 = 关键词:XX|时间:YYYY-MM-DD~YYYY-MM-DD',
    submitted[submitted.length - 1].scope === scopeKey2, submitted[submitted.length - 1].scope);

  // 换一个从没填过的范围（只留更早那段）→ 输入框应为空
  $('btnFilter').click();
  await wait(60);
  typeKw('');
  setRange(SPAN_FIRST, OLD_LAST);
  $('fApply').click();
  await wait(120);
  $('btnOverview').click();
  await wait(60);
  $('panel').querySelector('[data-act="general"]').click();
  await wait(60);
  check('未填写过的范围输入框为空', $('generalBox').value === '', JSON.stringify($('generalBox').value));
  $('sh2Close').click();
  await wait(60);

  // 回到「关键词 + 最近一周」：应回显已保存的意见
  $('btnFilter').click();
  await wait(60);
  setRange(WEEK_FROM, SPAN_LAST);
  typeKw(KW);
  $('fApply').click();
  await wait(120);
  $('btnOverview').click();
  await wait(60);
  check('总览回显已填写的处理意见', /这一周的隐患集中在法规依据引用/.test($('panel').textContent));
  $('panel').querySelector('[data-act="general"]').click();
  await wait(60);
  check('同一档意见可回显', /这一周的隐患集中在法规依据引用/.test($('generalBox').value), $('generalBox').value);
  $('sh2Close').click();
  await wait(60);

  // 恢复
  $('btnFilter').click();
  await wait(60);
  typeKw('');
  $('fQuick').querySelector('[data-r="all"]').click();
  $('fApply').click();
  await wait(120);
  check('恢复不限时间（收尾）', Number($('pAll').textContent) === ALL_ITEMS, $('pAll').textContent);

  check('无 JS 运行时错误', errors.length === 0, errors.join(' | '));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
