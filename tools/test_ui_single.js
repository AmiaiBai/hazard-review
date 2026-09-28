// 单时段场景冒烟：数据跨度不足一周时，默认区间应覆盖全量、不出现多余的筛选噪声
// 同时覆盖：日期快捷档（全部时间 / 最近一周 / 最近一月）、「疑似漏检」召回口径筛选
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = 'D:\\Project\\AI眼镜\\hazard-review';
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const hzData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'hazards.json'), 'utf8'));

const DIMS = [
  { key: 'real', label: '隐患真实性', hint: 'a', low: 'x', high: 'y' },
  { key: 'desc', label: '隐患描述符合性', hint: 'b', low: 'x', high: 'y' },
  { key: 'basis', label: '法规依据适用性', hint: 'c', low: 'x', high: 'y' },
  { key: 'cite', label: '依据引用准确性', hint: 'd', low: 'x', high: 'y' },
];

// 取最新那一天的 5 条有隐患记录 + 1 条空场景 → 全部落在默认「最近一周」内
const withHz = hzData.records.filter((r) => r.hazards.length).slice(0, 5);
const noHz = hzData.records.filter((r) => !r.hazards.length).slice(0, 1);
const slim = (r) => ({
  id: r.id, dept: r.dept, inspector: r.inspector,
  device: r.device, time: r.time, image: r.image,
  summary: r.hazards.length ? undefined : r.summary,
  hazards: r.hazards.map((h) => ({ no: h.no, name: h.name, desc: h.desc, advice: h.advice, std: h.std, basis: h.basis.slice(0, 56), more: h.basis.length > 56 })),
});
const sampleRecords = withHz.concat(noHz).map(slim);
// 法规依据全文索引 —— /api/basis 桩要返回真实全文，否则补全逻辑永远停在「加载中」
const FULL_BASIS = new Map();
for (const r of hzData.records) for (const h of r.hazards) FULL_BASIS.set(r.id + '#' + h.no, h.basis);
const HZ_TOTAL = withHz.reduce((a, r) => a + r.hazards.length, 0);       // 空场景开关关着
const ALL_ITEMS = HZ_TOTAL + noHz.length;                                // 空场景开关打开

const dayOfR = (r) => String(r.time || '').slice(0, 10);
const SPAN_DAYS = sampleRecords.map(dayOfR).filter(Boolean).sort();
const SPAN_FIRST = SPAN_DAYS[0];
const SPAN_LAST = SPAN_DAYS[SPAN_DAYS.length - 1];
function shiftDayT(day, delta) {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
const WEEK_FROM_RAW = shiftDayT(SPAN_LAST, -6);
const TODAY = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
})();
// 默认区间 = 记录首日 ~ 今日（= 全部时间）
const DEFAULT_FROM = SPAN_FIRST;
const DEFAULT_TO = TODAY;
// 快捷档位：都以今日为终点，起点不早于数据首日
const clampFrom = (d) => (d < SPAN_FIRST ? SPAN_FIRST : d);
const QUICK_WEEK_FROM = clampFrom(shiftDayT(TODAY, -6));
const QUICK_MONTH_FROM = clampFrom(shiftDayT(TODAY, -29));
const ALL_IN_WEEK = SPAN_FIRST >= WEEK_FROM_RAW;                        // 数据跨度不足一周（前提）

let pass = 0, fail = 0;
const check = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? '  → ' + e : '')); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const errors = [];
  const sent = [];                     // 捕获提交给 /api/submit 的请求体
  let basisOffline = false;            // 置真 → /api/basis 拒绝，用来测「断网显示重试」
  let submitDelay = 0;                 // >0 → /api/submit 延迟这么久才返回，用来证明「翻页不等网络」
  let submitFail = false;              // 置真 → /api/submit 返回 ok:false，用来测失败回滚
  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = async (url, opt) => {
        const u = String(url);
        let body = {};
        if (u.includes('/api/submit') && opt && opt.body) {
          try { sent.push(JSON.parse(opt.body)); } catch (e) { /* ignore */ }
          if (submitDelay) await wait(submitDelay);
          if (submitFail) return { ok: true, json: async () => ({ ok: false, error: 'boom' }) };
        }
        if (u.includes('/api/meta')) body = { meta: hzData.meta, dimensions: DIMS, initScore: 90, inspectors: ['张三'], reviewers: [] };
        else if (u.includes('/api/hazards')) body = { meta: hzData.meta, records: sampleRecords };
        else if (u.includes('/api/my')) body = { items: [], general: '', generals: {} };
        else if (u.includes('/api/basis')) {
          if (basisOffline) throw new Error('offline');   // 模拟工地断网
          // 返回真实全文（列表里只带了前 56 字的截断版）
          const keys = decodeURIComponent(u.split('keys=')[1] || '').split(',').filter(Boolean);
          body = {};
          for (const k of keys) { const f = FULL_BASIS.get(k); if (f) body[k] = f; }
        }
        else body = { ok: true };
        return { ok: true, json: async () => body };
      };
      w.addEventListener('error', (e) => errors.push(e.message || String(e.error)));
      w.onerror = (m) => errors.push(String(m));
      w.onunhandledrejection = (e) => errors.push('unhandled: ' + e.reason);
    },
  });
  const { window } = dom;
  await wait(400);
  const doc = window.document;
  const $ = (id) => doc.getElementById(id);

  console.log('\n【数据全在同一周内】');
  $('gName').value = '张三';
  await $('gGo').onclick();
  await wait(200);

  check('无 JS 错误', errors.length === 0, errors.join(' | '));
  check('卡片已渲染', $('swipe').hidden === false);
  check('总数正确（默认区间已覆盖全量）', Number($('pAll').textContent) === HZ_TOTAL,
    $('pAll').textContent + ' vs ' + HZ_TOTAL);
  check('卡片不显示批次标签', !doc.querySelector('#card .tag-b'));
  check('筛选标签默认「全部」', $('filterLabel').textContent === '全部', $('filterLabel').textContent);
  check('数据跨度不足一周（前提成立）', ALL_IN_WEEK === true, SPAN_FIRST + ' vs ' + WEEK_FROM_RAW);
  check('默认区间覆盖全量 → 不显示「仅看…」提示', $('pRange').hidden === true, $('pRange').textContent);

  $('btnFilter').click();
  await wait(60);
  check('起止日期默认「记录首日 ~ 今日」',
    $('fFrom').value === DEFAULT_FROM && $('fTo').value === DEFAULT_TO,
    $('fFrom').value + ' ~ ' + $('fTo').value);
  check('起始日期 min = 数据首日', $('fFrom').min === SPAN_FIRST, $('fFrom').min);
  check('截止日期 max = 今天', $('fTo').max === TODAY, $('fTo').max);
  check('无「数据批次」栏残留', !$('fBatchWrap') && !$('fBatch'));
  check('无「时间范围」标签快选残留', !$('fPeriodWrap') && !$('fPeriod'));
  check('筛选面板已无部门栏（部门视图改为管理员专属）', !$('fDept'), 'fDept 仍在');
  check('筛选面板已无「部门」字样', !/部门/.test($('filters').textContent), '筛选面板里还能看到「部门」');
  check('面板提示写明「记录数 + 可评条目数」',
    /该范围共 <b>\d+<\/b> 条记录，可评 <b>\d+<\/b> 条/.test($('fRangeHint').innerHTML),
    $('fRangeHint').textContent);
  check('面板提示拆分「隐患卡片 / 漏检复核」两个口径',
    /隐患卡片 <b>\d+<\/b> 条 · 漏检复核 <b>\d+<\/b> 条/.test($('fRangeHint').innerHTML),
    $('fRangeHint').textContent);
  check('「不限时间」按钮已删除', !$('fRangeAll'));
  check('快捷区间按钮 = 全部时间 / 最近一周 / 最近一月',
    [...$('fQuick').children].map((b) => b.textContent).join(',') === '全部时间,最近一周,最近一月',
    [...$('fQuick').children].map((b) => b.textContent).join(','));
  check('默认命中「全部时间」快捷档', $('fQuick').querySelector('[data-r="all"]').classList.contains('on'));

  $('fQuick').querySelector('[data-r="week"]').click();
  await wait(60);
  check('点「最近一周」→ 起点 = 今日-6（不早于数据首日）',
    $('fFrom').value === QUICK_WEEK_FROM && $('fTo').value === TODAY,
    $('fFrom').value + ' ~ ' + $('fTo').value);
  check('「最近一周」按钮高亮', $('fQuick').querySelector('[data-r="week"]').classList.contains('on'));

  $('fQuick').querySelector('[data-r="month"]').click();
  await wait(60);
  check('点「最近一月」→ 起点 = 今日-29（不早于数据首日）',
    $('fFrom').value === QUICK_MONTH_FROM && $('fTo').value === TODAY,
    $('fFrom').value + ' ~ ' + $('fTo').value);

  $('fQuick').querySelector('[data-r="all"]').click();
  await wait(60);
  check('点「全部时间」→ 回到记录首日 ~ 今日',
    $('fFrom').value === DEFAULT_FROM && $('fTo').value === DEFAULT_TO,
    $('fFrom').value + ' ~ ' + $('fTo').value);
  $('fClose').click();
  await wait(60);

  // 单一时段也能用时段总览 + 填写本时段意见
  $('btnOverview').click();
  await wait(80);
  check('可打开时段总览', !$('panel').hidden);
  check('总览圆点数 = 当前条数', $('panel').querySelectorAll('.dot').length === Number($('pAll').textContent),
    $('panel').querySelectorAll('.dot').length + ' vs ' + $('pAll').textContent);
  check('总览范围标注为「全部数据」', $('panel').querySelector('.ovscope').textContent === '全部数据',
    $('panel').querySelector('.ovscope').textContent);
  $('panel').querySelector('[data-act="general"]').click();
  await wait(60);
  check('可填时段处理意见', $('sheet2').classList.contains('show') && /筛选处理意见/.test($('sh2Title').textContent));
  $('sh2Close').click();
  await wait(60);
  $('panel').querySelector('[data-act="back"]').click();
  await wait(80);
  check('总览可返回卡片', $('panel').hidden === true);

  // 越界日期会被夹回可选范围（最早 = 数据首日，最晚 = 今天）
  $('fFrom').value = '2020-01-01';
  $('fFrom').oninput({ target: $('fFrom') });
  await wait(60);
  check('早于数据首日的日期被夹回', $('fFrom').value === SPAN_FIRST, $('fFrom').value);
  $('fTo').value = '2099-12-31';
  $('fTo').oninput({ target: $('fTo') });
  await wait(60);
  check('晚于今天的日期被夹回', $('fTo').value === TODAY, $('fTo').value);

  // 选一段「数据之后、今天之前」的日子 → 无数据，出现「仅看…」提示 + 空状态
  if (TODAY > SPAN_LAST) {
    $('fFrom').value = shiftDayT(SPAN_LAST, 1);
    $('fFrom').oninput({ target: $('fFrom') });
    $('fTo').value = TODAY;
    $('fTo').oninput({ target: $('fTo') });
    $('fApply').click();
    await wait(120);
    check('选到无数据区间 → 出现「仅看…」范围提示',
      $('pRange').hidden === false && /仅看/.test($('pRange').textContent), $('pRange').textContent);
    check('提示里带「当前 0 条 / 全量 N 条」',
      $('pRange').textContent.indexOf('当前 0 条') >= 0 &&
      $('pRange').textContent.indexOf(String(ALL_ITEMS)) >= 0, $('pRange').textContent);
    check('无数据时给出空状态提示', /当前筛选下没有隐患/.test($('panel').textContent),
      $('panel').textContent.replace(/\s+/g, ' ').slice(0, 60));
  } else {
    check('数据就在今天，跳过「无数据区间」用例', true);
  }

  // 空场景开关：打开后把漏检复核条目也纳入牌堆
  $('btnFilter').click();
  $('fQuick').querySelector('[data-r="all"]').click();
  await wait(60);
  const canOff = Number(($('fRangeHint').innerHTML.match(/可评 <b>(\d+)<\/b> 条/) || [])[1]);
  $('swNone').click();
  await wait(60);
  const canOn = Number(($('fRangeHint').innerHTML.match(/可评 <b>(\d+)<\/b> 条/) || [])[1]);
  check('切「含漏检复核」开关 → 可评条数实时变化',
    canOn === canOff + noHz.length, canOff + ' → ' + canOn + '（漏检复核 ' + noHz.length + ' 条）');
  $('fApply').click();
  await wait(120);
  check('空场景开关仍生效', Number($('pAll').textContent) === ALL_ITEMS, $('pAll').textContent);
  check('「全部时间」后范围提示隐藏', $('pRange').hidden === true);

  // 「疑似漏检」= 所有 AI 未识别到隐患的记录（召回率口径，不管评没评过都要能捞出来）
  $('btnFilter').click();
  $('fStatus').querySelector('[data-v="miss"]').click();
  $('fApply').click();
  await wait(120);
  check('「疑似漏检」筛出全部 AI 未识别到隐患的记录',
    Number($('pAll').textContent) === noHz.length, $('pAll').textContent + ' vs ' + noHz.length);
  check('筛选标签显示「疑似漏检」', $('filterLabel').textContent.indexOf('疑似漏检') >= 0,
    $('filterLabel').textContent);

  // 时段总览给出漏检复核（召回）进度
  $('btnOverview').click();
  await wait(80);
  check('时段总览显示漏检复核（召回）进度', /漏检复核（召回）/.test($('panel').textContent));
  check('漏检复核条数与数据一致',
    new RegExp('共 <b>' + noHz.length + '</b> 条').test($('panel').innerHTML),
    $('panel').textContent.replace(/\s+/g, ' ').slice(0, 120));
  $('panel').querySelector('[data-act="back"]').click();
  await wait(80);

  $('btnFilter').click();
  $('fStatus').querySelector('[data-v="done"]').click();
  $('fApply').click();
  await wait(120);
  check('状态筛选仍生效', Number($('pAll').textContent) === 0, $('pAll').textContent);

  // ---------------- 漏检严重度 + 「继续处理」按钮 ----------------
  console.log('\n【漏检严重度标记】');
  $('btnFilter').click();
  await wait(60);
  $('fStatus').querySelector('[data-v="miss"]').click();
  $('fApply').click();
  await wait(140);
  check('筛出全部空场景记录', Number($('pAll').textContent) === noHz.length, $('pAll').textContent);

  $('btnScore').click();
  await wait(80);
  check('漏检复核面板已打开', $('sheet').classList.contains('show'));
  check('面板含严重度选择', !!$('sevPick'));
  check('严重度三档 = 一般 / 较大 / 重大',
    [...$('sevPick').children].map((b) => b.dataset.v).join(',') === 'general,major,critical',
    [...$('sevPick').children].map((b) => b.dataset.v).join(','));
  check('严重度默认「一般隐患」',
    $('sevPick').querySelector('button.on').dataset.v === 'general',
    $('sevPick').querySelector('button.on').dataset.v);
  check('重大隐患警示默认隐藏', $('sevWarn').style.display === 'none');

  $('pick').querySelector('[data-v="issue"]').click();
  await wait(40);
  check('选「疑似漏检」后出现严重度区块', $('missBlk').style.display !== 'none');

  $('sevPick').querySelector('[data-v="critical"]').click();
  await wait(40);
  check('选「重大隐患」后红色警示出现', $('sevWarn').style.display !== 'none');
  check('警示写明 10 倍权重', /10 倍/.test($('sevWarn').textContent), $('sevWarn').textContent.slice(0, 60));

  const n0 = sent.length;
  $('doSave').click();
  await wait(220);
  const last = sent[sent.length - 1];
  check('提交了保存请求', sent.length > n0, sent.length + ' vs ' + n0);
  check('请求带 severity = critical',
    last && last.items[0].severity === 'critical', JSON.stringify(last && last.items[0]));
  check('请求 verdict = issue', last && last.items[0].verdict === 'issue');
  check('toast 提示「重大隐患漏检」', /重大隐患漏检/.test($('toast').textContent), $('toast').textContent);

  // 总览圆点应按严重度单独着色
  $('btnOverview').click();
  await wait(120);
  check('总览出现重大漏检圆点', !!$('ovDots').querySelector('.d-crit'), $('ovDots').innerHTML.slice(0, 160));
  check('总览列出重大漏检计数', /重大漏检/.test($('panel').textContent));
  check('总览提示 10 倍权重', /10 倍权重/.test($('panel').textContent));
  $('panel').querySelector('[data-jump="0"]').click();
  await wait(100);
  check('卡片徽标显示「重大漏检」', /重大漏检/.test($('card').innerHTML), $('card').querySelector('.badge') && $('card').querySelector('.badge').textContent);

  // 重新打开面板 → 严重度应回显为「重大隐患」
  $('btnScore').click();
  await wait(80);
  check('重新打开后严重度回显「重大隐患」',
    $('sevPick').querySelector('button.on').dataset.v === 'critical',
    $('sevPick').querySelector('button.on').dataset.v);

  // 改判「确认无隐患」→ 严重度应归零（不残留重大标记）
  $('pick').querySelector('[data-v="pass"]').click();
  await wait(40);
  $('allPass').click();
  await wait(220);
  const last2 = sent[sent.length - 1];
  check('改判确认无隐患后 severity 归零为 general',
    last2 && last2.items[0].verdict === 'pass' && last2.items[0].severity === 'general',
    JSON.stringify(last2 && last2.items[0]));

  console.log('\n【已识别隐患的严重度标注】');
  $('btnFilter').click();
  await wait(60);
  $('fStatus').querySelector('[data-v="all"]').click();
  if ($('swNone').classList.contains('on')) $('swNone').click();   // 关掉空场景，只留隐患卡片
  $('fApply').click();
  await wait(140);
  check('当前卡片是隐患卡片', !/AI 未识别到隐患/.test($('card').innerHTML));

  $('btnScore').click();
  await wait(90);
  check('隐患评分面板含严重度选择', !!$('hazSevPick'));
  check('严重度四档 = 未标注 / 一般 / 较大 / 重大',
    [...$('hazSevPick').children].map((b) => b.dataset.v).join(',') === ',general,major,critical',
    [...$('hazSevPick').children].map((b) => b.dataset.v).join(','));
  check('默认选中「未标注」', $('hazSevPick').querySelector('button.on').dataset.v === '',
    JSON.stringify($('hazSevPick').querySelector('button.on').dataset.v));
  check('未选重大时无提示', $('hazSevMsg').style.display === 'none');

  // 滑块默认 90 分 = 认可 → 选「重大」应提示「识别正确」
  $('hazSevPick').querySelector('[data-v="critical"]').click();
  await wait(50);
  check('认可 + 重大 → 提示「识别正确」',
    $('hazSevMsg').className === 'sevinfo' && /识别正确/.test($('hazSevMsg').textContent),
    $('hazSevMsg').className + ' / ' + $('hazSevMsg').textContent.slice(0, 36));

  // 拖低一个维度 → 判定变「存疑」→ 升级为「识别出错」红线
  const slInput = doc.querySelector('.slider[data-dim] input');
  slInput.value = '40';
  slInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await wait(60);
  check('拖低维度 + 重大 → 提示「识别出错」红线',
    $('hazSevMsg').className === 'sevwarn' && /识别出错/.test($('hazSevMsg').textContent),
    $('hazSevMsg').className + ' / ' + $('hazSevMsg').textContent.slice(0, 36));

  const h0 = sent.length;
  $('doSave').click();
  await wait(220);
  const hl = sent[sent.length - 1];
  check('隐患提交带 severity = critical', hl && hl.items[0].severity === 'critical',
    JSON.stringify(hl && hl.items[0]));
  check('隐患提交 verdict = issue', hl && hl.items[0].verdict === 'issue');
  check('提交了保存请求', sent.length > h0, sent.length + ' vs ' + h0);
  check('toast 提示「重大隐患识别出错」', /重大隐患识别出错/.test($('toast').textContent), $('toast').textContent);

  // 保存后会自动跳下一条，退回来才能看到刚评的那张
  $('btnPrev').click();
  await wait(140);
  check('卡片徽标显示「重大识别出错」', /重大识别出错/.test($('card').innerHTML),
    $('card').querySelector('.badge') && $('card').querySelector('.badge').textContent);

  // 重新打开 → 严重度与提示都应回显
  $('btnScore').click();
  await wait(90);
  check('重新打开后严重度回显「重大隐患」',
    $('hazSevPick').querySelector('button.on').dataset.v === 'critical',
    $('hazSevPick').querySelector('button.on').dataset.v);
  check('重新打开后仍提示「识别出错」', $('hazSevMsg').className === 'sevwarn');

  // 改回「未标注」→ 提示消失，且提交时 severity 为空串（不冒充「一般隐患」）
  $('hazSevPick').querySelector('[data-v=""]').click();
  await wait(40);
  check('改回未标注后提示消失', $('hazSevMsg').style.display === 'none');
  $('doSave').click();
  await wait(220);
  const hl2 = sent[sent.length - 1];
  check('未标注提交 severity = 空串', hl2 && hl2.items[0].severity === '',
    JSON.stringify(hl2 && hl2.items[0]));

  console.log('\n【法规依据全文：预览与评分抽屉同源】');
  // 列表里每条依据只带前 56 字，全文靠 /api/basis 按需补。
  // 曾经的 bug：列表卡片读 basisCache（预热过就是全文），评分抽屉却直接读 hz.basis（截断版），
  // 于是「预览是全文、点进去只剩半句」—— 用户报「法规依据不能显示全」。
  const fullItem = (() => {
    for (const r of sampleRecords) for (const h of r.hazards) {
      if (h.more) return { k: r.id + '#' + h.no, full: FULL_BASIS.get(r.id + '#' + h.no) };
    }
    return null;
  })();
  check('样本里存在需要补全文的条目（前提成立）', !!fullItem && fullItem.full.length > 56,
    fullItem && (fullItem.k + ' 全文 ' + fullItem.full.length + ' 字'));
  if (fullItem) {
    // S 是顶层 let，不挂 window；间接 eval 才能看到它
    const clearBasisCache = () => window.eval('S.basisCache.clear(); basisFailed.clear();');

    // ① 冷缓存：先明确「加载中」，补全后为全文 —— 全程不出现半句法规
    clearBasisCache();
    window.openSheet(fullItem.k);
    check('冷缓存首帧是「加载中」而非截断版', $('basisTxt').textContent === '依据全文加载中…',
      $('basisTxt').textContent);
    check('冷缓存首帧带 loading 样式', $('basisTxt').className === 'basisloading', $('basisTxt').className);
    await wait(140);
    check('补全后显示全文', $('basisTxt').textContent === fullItem.full,
      '长度 ' + $('basisTxt').textContent.length + ' / 期望 ' + fullItem.full.length);
    check('补全后清除 loading 样式', $('basisTxt').className === '', $('basisTxt').className);
    check('补全后的文本不含截断省略号', !/…$/.test($('basisTxt').textContent), $('basisTxt').textContent.slice(-14));

    // ② 热缓存：缓存到位后重开，首帧即全文（列表卡片走的就是这条路）
    window.closeSheet();
    window.openSheet(fullItem.k);
    check('热缓存首帧即全文（不再先给半句）', $('basisTxt').textContent === fullItem.full,
      '长度 ' + $('basisTxt').textContent.length);

    // ③ 同一条隐患：列表卡片与评分抽屉必须同源
    const curK = window.eval('(S.filtered[S.idx] && S.filtered[S.idx].hz) ? keyOf(S.filtered[S.idx].rid, S.filtered[S.idx].no) : ""');
    if (curK) {
      window.openSheet(curK);
      await wait(140);
      const cardEl = doc.querySelector('#card [data-basis-text]');
      check('列表卡片与评分抽屉文本一致',
        !!cardEl && cardEl.textContent === $('basisTxt').textContent,
        cardEl ? '卡片 ' + cardEl.textContent.length + ' / 抽屉 ' + $('basisTxt').textContent.length : '卡片未渲染');
    }

    // ④ 断网：必须显示「加载失败 + 重试」，不能退回截断版假装完整；点重试要能恢复
    clearBasisCache();
    basisOffline = true;
    window.openSheet(fullItem.k);
    await wait(220);                       // 内部重试一次后再判定
    check('断网时提示加载失败', /加载失败/.test($('basisTxt').textContent), $('basisTxt').textContent);
    check('断网时不显示截断版（无半句法规）', !$('basisTxt').textContent.includes('传动部件产生的危险'), $('basisTxt').textContent);
    check('失败态带可点击的重试样式', $('basisTxt').className === 'basisretry', $('basisTxt').className);
    basisOffline = false;                  // 网络恢复
    $('basisTxt').onclick();
    await wait(160);
    check('点重试后补全为全文', $('basisTxt').textContent === fullItem.full,
      '长度 ' + $('basisTxt').textContent.length + ' / 期望 ' + fullItem.full.length);

    window.closeSheet();
    await wait(40);
  }

  console.log('\n【乐观提交：点完立刻翻页，不等网络】');
  /**
   * 背景：手机端左滑（approveAndNext）是「画面立刻滑走 + 后台保存」，
   * 桌面端「保存并下一条」原来是「等服务端返回才翻页」—— 线上 RTT ~120ms
   * 再加服务端 120ms 写盘防抖，点一下要等 300-500ms 且全程没有任何反馈，
   * 用户报「电脑端点击保存并下一条很慢」。同一个动作，两端不该有两套体感。
   *
   * 但快不能靠丢数据换：保存失败必须退回该条、重开抽屉、还原本地状态，
   * 让人点一下就能重试 —— 一条评分就是一份评审证据。
   */
  // 准备：停在一张「已识别隐患」的卡片上（空场景分支是另一条路径，这里只测主路径）
  window.eval('S.idx = S.filtered.findIndex(function (x) { return x.kind !== "none"; }); paintDeck();');
  await wait(100);
  const kOpt = $('swipe').dataset.k;
  check('准备就绪：当前是隐患卡片', !!kOpt && window.eval('S.idx') < window.eval('S.filtered.length') - 1,
    kOpt + ' @ ' + window.eval('S.idx'));

  // ---- ① 服务端慢 400ms，点完必须立刻翻页 ----
  submitDelay = 400;
  {
    const idx0 = window.eval('S.idx');
    const rid0 = $('card').querySelector('.recid').textContent;
    const n0 = sent.length;
    $('btnScore').click();
    await wait(90);
    const t0 = Date.now();
    $('doSave').click();
    await wait(60);                       // 远小于 400ms 的响应延迟
    const elapsed = Date.now() - t0;

    check('点完立刻翻到下一张（不等网络）', window.eval('S.idx') === idx0 + 1,
      'idx ' + window.eval('S.idx') + ' / 期望 ' + (idx0 + 1) + '，耗时 ' + elapsed + 'ms');
    check('卡片内容真的换成了下一条', $('card').querySelector('.recid').textContent !== rid0,
      rid0 + ' → ' + $('card').querySelector('.recid').textContent);
    check('抽屉已关闭', !$('sheet').classList.contains('show'));
    check('提交请求已发出', sent.length === n0 + 1, sent.length + ' vs ' + (n0 + 1));
    check('此时服务端确实还没返回（前提成立）', elapsed < submitDelay, elapsed + 'ms < ' + submitDelay + 'ms');

    await wait(500);                      // 等那个慢响应回来
    check('响应回来后索引不回退', window.eval('S.idx') === idx0 + 1, 'idx ' + window.eval('S.idx'));
    check('响应回来后抽屉没被重新打开', !$('sheet').classList.contains('show'));
    submitDelay = 0;
  }

  // ---- ② 保存失败：乐观翻页 → 回滚到原条，本地状态也要还原 ----
  {
    const idx0 = window.eval('S.idx');
    const k0 = $('swipe').dataset.k;
    const hadBefore = window.eval('S.mine.has(' + JSON.stringify(k0) + ')');
    const prevBefore = window.eval('JSON.stringify(S.mine.get(' + JSON.stringify(k0) + ') || null)');
    // 失败也要「慢着失败」：瞬时失败全在微任务里跑完，根本看不到中间那一帧乐观翻页
    submitFail = true;
    submitDelay = 300;
    $('btnScore').click();
    await wait(90);
    $('doSave').click();
    await wait(60);
    check('失败前也先乐观翻页（这一帧用户已经看到下一张）', window.eval('S.idx') === idx0 + 1,
      'idx ' + window.eval('S.idx') + ' / 期望 ' + (idx0 + 1));

    await wait(400);
    check('保存失败后索引退回原条', window.eval('S.idx') === idx0, 'idx ' + window.eval('S.idx'));
    check('退回的正是那一条', $('swipe').dataset.k === k0, $('swipe').dataset.k + ' / ' + k0);
    check('保存失败后抽屉重新打开（分数还在，点一下就能重试）',
      $('sheet').classList.contains('show') && !!$('doSave'));
    check('提示写明「已退回该条」', /保存失败/.test($('toast').textContent) && /退回/.test($('toast').textContent),
      $('toast').textContent);
    check('S.mine 已还原（不留未落盘的假评分）',
      window.eval('S.mine.has(' + JSON.stringify(k0) + ')') === hadBefore,
      'has ' + window.eval('S.mine.has(' + JSON.stringify(k0) + ')') + ' / 期望 ' + hadBefore);
    check('S.mine 里的值也回到提交前',
      window.eval('JSON.stringify(S.mine.get(' + JSON.stringify(k0) + ') || null)') === prevBefore);

    // ---- ③ 重试：抽屉还开着，再点一次应当成功 ----
    submitFail = false;
    submitDelay = 0;
    const nR = sent.length;
    $('doSave').click();
    await wait(260);
    check('点一下重试即提交成功', sent.length === nR + 1, sent.length + ' vs ' + (nR + 1));
    check('重试成功后翻到下一张', window.eval('S.idx') === idx0 + 1, 'idx ' + window.eval('S.idx'));
    check('重试成功后抽屉关闭', !$('sheet').classList.contains('show'));
  }

  // ---- ④ 连点两下不能把同一条提交两遍 ----
  {
    const idx0 = window.eval('S.idx');
    const n0 = sent.length;
    $('btnScore').click();
    await wait(90);
    $('doSave').click();
    $('doSave').click();                  // 第一次点击已 closeSheet + 清空 curKey
    await wait(260);
    check('连点两下只提交一次', sent.length === n0 + 1, sent.length + ' vs ' + (n0 + 1));
    check('连点两下只前进一张', window.eval('S.idx') === idx0 + 1,
      'idx ' + window.eval('S.idx') + ' / 期望 ' + (idx0 + 1));
  }

  // ---- ⑤ 用户已经评到后面去了，前面那条才失败：不能把人拽回来 ----
  // 连点两下保存时，第一条慢、第二条快，第一条失败时用户已经在后面那张上了。
  // 这时回滚索引会关掉他正在填的抽屉、丢掉刚拖好的分数 —— 比「存不上」更糟。
  {
    submitFail = true;
    submitDelay = 300;
    const idx0 = window.eval('S.idx');
    const ridA = $('card').querySelector('.recid').textContent;
    $('btnScore').click();
    await wait(90);
    $('doSave').click();                  // 提交 A —— 会失败，但 300ms 后才失败
    await wait(50);
    check('A 已乐观前进（前提成立）', window.eval('S.idx') === idx0 + 1, 'idx ' + window.eval('S.idx'));

    $('btnNext').click();                 // 用户没等，继续往下
    await wait(60);
    $('btnScore').click();
    await wait(60);
    const idxNow = window.eval('S.idx');
    check('用户已走到下一条并打开抽屉（前提成立）',
      idxNow === idx0 + 2 && $('sheet').classList.contains('show'), 'idx ' + idxNow);

    await wait(400);                      // A 的失败响应到了
    check('不把用户拽回失败的那条', window.eval('S.idx') === idxNow, 'idx ' + window.eval('S.idx'));
    check('不关掉用户正在填的抽屉', $('sheet').classList.contains('show'));
    check('提示点名是哪条没存上', $('toast').textContent.includes(ridA), $('toast').textContent);
    check('提示让用户回看补评', /回看/.test($('toast').textContent), $('toast').textContent);

    window.closeSheet();
    await wait(40);
    submitFail = false;
    submitDelay = 0;
  }

  console.log('\n【继续处理按钮】');
  $('btnFilter').click();
  await wait(60);
  $('fStatus').querySelector('[data-v="all"]').click();
  $('fApply').click();
  await wait(140);
  $('btnOverview').click();
  await wait(120);
  const backBtn = $('panel').querySelector('[data-act="back"]');
  check('还有待办时按钮文案为「继续处理」', backBtn.textContent === '继续处理', backBtn.textContent);
  check('「继续处理」按钮为绿色（催办）', backBtn.classList.contains('g'), backBtn.className);
  $('panel').querySelector('[data-act="back"]').click();
  await wait(100);

  check('全程无 JS 错误', errors.length === 0, errors.join(' | '));
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
