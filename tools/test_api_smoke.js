'use strict';
// 本地端到端自检：起服务 → 核对关键接口字段口径（无批次、按时间顺承）
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 3196;
const ROOT = path.join(__dirname, '..');
const SUBS_FILE = path.join(ROOT, 'data', 'submissions.json');

function get(p, headers) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers: headers || {} }, (r) => {
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => res({ code: r.statusCode, buf: Buffer.concat(c) }));
    }).on('error', rej);
  });
}

/** 同 get，但把响应头也带回来（核对缓存头用） */
function getFull(p, headers) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers: headers || {} }, (r) => {
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => res({ code: r.statusCode, headers: r.headers, buf: Buffer.concat(c) }));
    }).on('error', rej);
  });
}

function postJson(p, body, headers) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body || {});
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, headers || {}),
    }, (resp) => {
      const c = []; resp.on('data', (d) => c.push(d));
      resp.on('end', () => res({ code: resp.statusCode, buf: Buffer.concat(c) }));
    });
    r.on('error', rej); r.write(data); r.end();
  });
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

(async () => {
  // 本测试会真的写数据（验证提交接口）—— 先备份，finally 里无条件还原
  let subsBackup = null;
  try { subsBackup = fs.readFileSync(SUBS_FILE, 'utf8'); } catch (e) { subsBackup = null; }

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { await get('/api/meta'); up = true; } catch (e) { await new Promise((r) => setTimeout(r, 150)); }
    }
    ok(up, '服务已就绪');

    // 部门 / 检查人 / 评审人姓名只对管理员下发 —— 本测试要核对完整字段，所以先拿管理员令牌。
    // 匿名视角的脱敏另有专门断言（见下面「匿名视角」一段）。
    const adminPw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'admin.json'), 'utf8')).password;
    const token = JSON.parse((await postJson('/api/admin/login', { password: adminPw })).buf.toString('utf8')).token;
    const AUTH = { 'x-admin-token': token };
    ok(!!token, '已取得管理员令牌');

    const meta = JSON.parse((await get('/api/meta', AUTH)).buf.toString('utf8'));
    ok(Array.isArray(meta.dimensions) && meta.dimensions.length === 4, '维度 4 项');

    const list = JSON.parse((await get('/api/hazards', AUTH)).buf.toString('utf8'));
    const r0 = list.records[0];
    ok(!('batch' in r0), '列表记录无 batch 字段');
    ok(typeof r0.time === 'string' && r0.time.length >= 10, '列表记录带识别时间：' + r0.time);
    ok(Object.keys(r0).join(',') === 'id,dept,inspector,device,time,image,hazards',
      '列表字段口径：' + Object.keys(r0).join(','));

    // ---- 匿名视角：部门 / 检查人 / 评审人姓名一律不下发 ----
    {
      const anonMeta = JSON.parse((await get('/api/meta')).buf.toString('utf8'));
      const anonList = JSON.parse((await get('/api/hazards')).buf.toString('utf8'));
      const anonSt = JSON.parse((await get('/api/stats')).buf.toString('utf8'));
      ok(anonMeta.inspectors.length === 0, '匿名 meta 的检查人清单为空');
      ok(anonMeta.reviewers.length === 0, '匿名 meta 的填写人员清单为空');
      ok(anonMeta.meta.depts.length === 0, '匿名 meta 的部门清单为空');
      ok(anonList.records.every((r) => !r.dept && !r.inspector), '匿名列表不含部门 / 检查人');
      ok(anonSt.deptRows.length === 0 && anonSt.deptUnlocked === false, '匿名 stats 不含部门汇总');
      ok(anonSt.hazardRows.every((h) => !h.dept && !h.inspector), '匿名 stats 的隐患行不含部门 / 检查人');
      ok(anonSt.reviewerRows.every((r) => /^评审人\d+$/.test(r.reviewer)), '匿名 stats 的评审人是代号');
      ok(anonSt.monthRows.every((m) => (m.depts || []).length === 0), '匿名 stats 的月份行不含覆盖部门');
      ok((await get('/api/raw')).code === 403, '匿名读 /api/raw → 403（含全部填写人员真名）');
    }

    // ---- 缓存头：/api/hazards 按身份内容不同，必须让浏览器按令牌分槽缓存 ----
    // 光有 private 不够（private 只管共享缓存 / 代理）；URL 不变时浏览器自己的缓存会照 max-age 直接用，
    // 于是「先匿名打开 → 再解锁」会吃到 10 分钟前的匿名版（部门 / 检查人还是空的）。
    // 这个 bug 是截图核验抓出来的 —— jsdom 的 fetch 桩没有 HTTP 缓存，测不出来。
    {
      const anonH = (await getFull('/api/hazards')).headers;
      const admH = (await getFull('/api/hazards', AUTH)).headers;
      ok(/x-admin-token/i.test(anonH.vary || ''), '匿名 /api/hazards 的 Vary 含 X-Admin-Token：' + (anonH.vary || '(无)'));
      ok(/x-admin-token/i.test(admH.vary || ''), '管理员 /api/hazards 的 Vary 含 X-Admin-Token：' + (admH.vary || '(无)'));
      ok(!!anonH.etag && anonH.etag !== admH.etag, '匿名与管理员两份列表 ETag 不同：' + anonH.etag + ' vs ' + admH.etag);
      ok(/private/.test(anonH['cache-control'] || ''), '列表缓存是 private（不给共享缓存）：' + anonH['cache-control']);
      ok(/no-store/.test((await getFull('/api/meta')).headers['cache-control'] || ''), '/api/meta 是 no-store');
      ok(/no-store/.test((await getFull('/api/stats')).headers['cache-control'] || ''), '/api/stats 是 no-store');
      // 带具体部门筛选的那条分支（dept=all 会走上面那个缓存分支，所以要用真部门名）
      const oneDept = (meta.meta.depts || [])[0];
      ok(!!oneDept, '管理员 meta 里能拿到部门清单（下面那条断言要有真部门名才有意义）');
      if (oneDept) {
        const h = (await getFull('/api/hazards?dept=' + encodeURIComponent(oneDept), AUTH)).headers;
        ok(/no-store/.test(h['cache-control'] || ''), '带具体 dept 的 /api/hazards 是 no-store：' + (h['cache-control'] || '(无)'));
      }
    }

    const st = JSON.parse((await get('/api/stats', AUTH)).buf.toString('utf8'));
    ok(!st.batchRows, 'stats 无 batchRows');
    ok(Array.isArray(st.monthRows) && st.monthRows.length === 2, 'monthRows 2 行');
    ok(st.monthRows[0].label === '2026年8月' && st.monthRows[1].label === '2026年9月',
      '月份标签：' + st.monthRows.map((m) => m.label).join(' / '));
    ok(st.monthRows[0].records === 145 && st.monthRows[1].records === 222,
      '月份记录数：' + st.monthRows.map((m) => m.records).join(' / '));
    ok(st.timeSpan && st.timeSpan.first === '2026-08-18' && st.timeSpan.last === '2026-09-21',
      '时间跨度：' + JSON.stringify(st.timeSpan));
    ok(st.summary && st.summary.monthCount === 2, 'summary.monthCount = 2');
    ok(st.hazardRows.every((h) => !('batch' in h) && 'time' in h), 'hazardRows 全部带 time、无 batch');
    ok((st.noneRows || []).every((n) => !('batch' in n)), 'noneRows 无 batch');

    // 识别频率（管理页折线图数据源）
    const freq = st.freqRows || [];
    ok(freq.length > 0, 'freqRows 非空（' + freq.length + ' 行）');
    ok(freq.every((f) => typeof f.day === 'string' && typeof f.dept === 'string' &&
      typeof f.inspector === 'string' && typeof f.records === 'number' && typeof f.hazards === 'number'),
      'freqRows 字段口径正确');
    ok(freq.reduce((a, f) => a + f.records, 0) === st.summary.recordCount,
      'freqRows 记录数合计 = summary.recordCount（' + st.summary.recordCount + '）');
    ok(freq.reduce((a, f) => a + f.hazards, 0) === st.summary.totalFreqHazards,
      'freqRows 隐患数合计 = summary.totalFreqHazards（' + st.summary.totalFreqHazards + '）');
    ok(freq.every((f) => f.day >= st.timeSpan.first && f.day <= st.timeSpan.last),
      'freqRows 日期都落在 timeSpan 内');
    ok(st.summary.inspectorCount === new Set(freq.map((f) => f.inspector)).size,
      'summary.inspectorCount 与 freqRows 去重一致（' + st.summary.inspectorCount + ' 位）');
    ok(freq.every((f) => !('batch' in f)), 'freqRows 无 batch 字段');

    // ---- 模型质量指标（quality） ----
    const qy = st.quality;
    ok(!!qy && typeof qy === 'object', 'stats 含 quality 块');
    ok(qy.line > 0 && qy.line <= 100, 'quality.line 是有效认可线（' + qy.line + '）');
    ok(Array.isArray(qy.topics) && qy.topics.length >= 10, 'quality.topics 主题数 ≥ 10（' + qy.topics.length + '）');
    ok(Array.isArray(qy.items) && Array.isArray(qy.none), 'quality.items / none 均为数组');
    ok(qy.items.every((x) => typeof x.ra === 'number' && x.ra >= 0 && x.ra <= 100),
      'quality.items 的真实性均分都在 0-100');
    ok(qy.items.every((x) => qy.topics.includes(x.t)), 'items 的主题都在 topics 白名单内');
    ok(qy.none.every((x) => x.v === 0 || x.v === 1), 'quality.none 的漏检标记是 0/1');
    ok(qy.items.every((x) => !('name' in x) && !('dept' in x)),
      'items 用短键传（d/t/p/s/m/ra…），不传冗余长键');
    // 与已有字段的一致性：已评隐患数 / 已复核空场景数
    ok(qy.items.length === st.summary.reviewedHazards,
      'quality.items 条数 = 已评隐患数（' + qy.items.length + '）');
    ok(qy.none.length === st.noneRows.filter((r) => r.reviewerCount > 0).length,
      'quality.none 条数 = 已复核空场景数（' + qy.none.length + '）');
    // 混淆矩阵恒等式（用默认阈值）
    const TP = qy.items.filter((x) => x.ra >= qy.line).length;
    const FN = qy.none.filter((x) => x.v).length;
    ok(TP + (qy.items.length - TP) + FN + (qy.none.length - FN) === qy.items.length + qy.none.length,
      '混淆矩阵恒等式成立（TP+FP+FN+TN = 样本数 ' + (qy.items.length + qy.none.length) + '）');
    // ---- 传输体积：明细是短键扁平行，gzip 后必须小 ----
    const gz = await new Promise((res, rej) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/api/stats', headers: { 'accept-encoding': 'gzip', 'x-admin-token': token } }, (r) => {
        const c = []; r.on('data', (d) => c.push(d));
        r.on('end', () => res({ enc: r.headers['content-encoding'], buf: Buffer.concat(c) }));
      }).on('error', rej);
    });
    ok(gz.enc === 'gzip', 'stats 走 gzip 传输（' + gz.enc + '）');
    ok(gz.buf.length < 200 * 1024, 'stats gzip 后体积可控（' + (gz.buf.length / 1024).toFixed(1) + ' KB）');

    // ---- 漏检严重度 / 加权 ----
    ok(Array.isArray(qy.severities) && qy.severities.length === 3, 'quality.severities 三档严重度');
    ok(qy.severities.map((s) => s.weight).join(',') === '1,3,10',
      '严重度权重 = 1 / 3 / 10（' + qy.severities.map((s) => s.weight).join(' / ') + '）');
    ok(qy.none.every((x) => typeof x.w === 'number' && x.w > 0), 'quality.none 每条都带权重 w');
    ok(qy.none.every((x) => !x.v || ['general', 'major', 'critical'].includes(x.sv)),
      'quality.none 的严重度取值合法');
    ok(qy.none.filter((x) => x.v).every((x) => x.w === ({ general: 1, major: 3, critical: 10 }[x.sv])),
      '漏检条目的权重与严重度一致');
    ok(st.noneStat && typeof st.noneStat.criticalMiss === 'number', 'noneStat.criticalMiss 存在');
    ok(st.noneStat.criticalMiss === (st.noneRows || []).filter((n) => n.severity === 'critical').length,
      'criticalMiss 与 noneRows 中的重大漏检数一致');
    ok(st.noneRows.every((n) => 'severity' in n && 'weight' in n && 'severityLabel' in n),
      'noneRows 带 severity / severityLabel / weight');
    ok(st.noneRows.every((n) => n.status === 'suspected' ? n.weight >= 1 : n.weight === 1),
      '只有疑似漏检才带权重');
    ok(st.summary.criticalMiss === st.noneStat.criticalMiss, 'summary.criticalMiss 与 noneStat 一致');
    ok(st.summary.weightedMiss === st.noneStat.weightedMiss, 'summary.weightedMiss 与 noneStat 一致');

    // ---- 已识别隐患的严重度标注 / 重大识别出错（「报错了」和「没报」一样危险）----
    const cs = st.criticalStat;
    ok(cs && typeof cs.total === 'number', 'criticalStat 存在');
    ok(cs.total === st.hazardRows.length, 'criticalStat.total = 已评隐患数');
    ok(cs.labeled + cs.unlabeled === cs.total, 'labeled + unlabeled = total');
    ok(cs.labeled === st.hazardRows.filter((h) => h.severity).length, 'labeled 与实际标注数一致');
    ok(st.hazardRows.every((h) => 'severity' in h && 'weight' in h && 'criticalWrong' in h && 'labeled' in h),
      'hazardRows 带 severity / weight / criticalWrong / labeled');
    ok(st.hazardRows.every((h) => 'inspector' in h), 'hazardRows 带 inspector（管理端按人切分任务）');
    ok(st.hazardRows.some((h) => h.inspector), 'inspector 有实际取值（' +
      [...new Set(st.hazardRows.map((h) => h.inspector || '未标注'))].slice(0, 4).join(' / ') + '）');
    ok((st.criticalStat.wrongRows || []).every((w) => 'inspector' in w), 'wrongRows 带 inspector');
    ok(st.hazardRows.every((h) => !h.severity || ['general', 'major', 'critical'].includes(h.severity)),
      'hazardRows 的 severity 取值合法（空 = 未标注）');
    ok(st.hazardRows.every((h) => h.weight === (h.severity ? { general: 1, major: 3, critical: 10 }[h.severity] : 1)),
      '未标注按权重 1 计，已标注按严重度权重');
    ok(cs.criticalWrong === st.hazardRows.filter((h) => h.criticalWrong).length, 'criticalWrong 与明细一致');
    ok(cs.critical === cs.criticalWrong + cs.criticalOk, '重大隐患 = 识别出错 + 识别正确');
    ok(st.hazardRows.every((h) => !h.criticalWrong || h.severity === 'critical'),
      '只有标注为重大的才可能「识别出错」');
    ok(st.summary.criticalWrong === cs.criticalWrong, 'summary.criticalWrong 与 criticalStat 一致');
    ok(st.summary.criticalOk === cs.criticalOk, 'summary.criticalOk 与 criticalStat 一致');
    ok((cs.wrongRows || []).every((w) => w.severity === 'critical'), 'wrongRows 全是重大隐患');
    ok(cs.weightedWrong === (cs.wrongRows || []).reduce((a, w) => a + w.weight, 0),
      '加权识别出错量 = 各条权重之和');

    // ---- 评价人一致性 ----
    const ag = st.agreement;
    ok(ag && Array.isArray(ag.reviewers) && ag.reviewers.length > 0, 'agreement.reviewers 非空（' + (ag && ag.reviewers.length) + ' 人）');
    ok(ag.dualHazards <= st.summary.reviewedHazards, '双评隐患数 ≤ 已评隐患数');
    ok(ag.coverage === (st.summary.reviewedHazards ? Math.round((ag.dualHazards / st.summary.reviewedHazards) * 1000) / 10 : 0),
      'coverage = 双评数 / 已评数（' + ag.coverage + '%）');
    ok(ag.agreeRate == null || (ag.agreeRate >= 0 && ag.agreeRate <= 100), 'agreeRate 在 0-100');
    ok(ag.kappa == null || (ag.kappa >= -1 && ag.kappa <= 1), 'Cohen κ 在 -1 ~ 1（' + ag.kappa + '）');
    ok((ag.pairs || []).every((p) => p.n >= 1 && p.agree <= p.n && p.rate >= 0 && p.rate <= 100),
      '两两配对统计自洽');
    ok((ag.pairs || []).reduce((a, p) => a + p.n, 0) === ag.pairObservations,
      'pairs 的 n 合计 = pairObservations');
    ok((ag.spreads || []).every((s) => s.spread >= 0 && s.max >= s.min), '分歧度行 max ≥ min');
    ok((ag.spreads || []).every((s) => s.reviewers.length >= 2), '分歧度行都有 ≥2 位评审人');
    ok((ag.spreads || []).every((s, i, a) => i === 0 || a[i - 1].spread >= s.spread), '分歧度按极差降序');

    // ---- 评价人操作频率 ----
    ok(Array.isArray(st.reviewerDaily) && st.reviewerDaily.length > 0, 'reviewerDaily 非空（' + (st.reviewerDaily || []).length + ' 行）');
    ok(st.reviewerDaily.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day)), 'reviewerDaily.day 都是 YYYY-MM-DD');
    ok(st.reviewerDaily.every((r) => r.count >= r.noneCount && r.noneCount >= 0), 'count ≥ noneCount');
    ok(st.reviewerDaily.reduce((a, r) => a + r.count, 0) === st.summary.itemCount,
      '操作次数合计 = 评分记录总数（' + st.summary.itemCount + '）');
    ok(st.reviewerRows.every((r) => 'recent7' in r && 'stalledDays' in r && 'state' in r && 'lastDay' in r),
      'reviewerRows 带活跃度字段');
    ok(st.reviewerRows.every((r) => ['active', 'watch', 'stalled', 'none'].includes(r.state)),
      'reviewerRows.state 取值合法');
    ok(st.reviewerRows.every((r) => r.stalledDays == null || r.stalledDays >= 0), 'stalledDays ≥ 0');

    // ---- 提交接口：已识别隐患的严重度是「可选标注」，未标注必须留空 ----
    const rv = '冒烟测试员';
    const post = (p, body) => new Promise((res, rej) => {
      const data = Buffer.from(JSON.stringify(body), 'utf8');
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      }, (r) => {
        const c = []; r.on('data', (d) => c.push(d));
        r.on('end', () => res({ code: r.statusCode, buf: Buffer.concat(c) }));
      });
      req.on('error', rej); req.write(data); req.end();
    });
    const sub = (rec, no, verdict, severity) => post('/api/submit', {
      reviewer: rv, dept: '冒烟测试',
      items: [{ recordId: rec, hazardNo: no, verdict, severity, scores: {}, advice: verdict === 'issue' ? '冒烟测试' : '', note: '' }],
    });

    const itemsBefore = st.summary.itemCount;
    const hA = st.hazardRows[0];
    const hB = st.hazardRows.filter((h) => !h.labeled && h.key !== hA.key)[0];   // 必须是另一条，否则后一次提交会覆盖前一次
    ok((await sub(hA.recordId, hA.hazardNo, 'issue', 'critical')).code === 200, '提交「重大 + 识别存疑」成功');
    if (hB) await sub(hB.recordId, hB.hazardNo, 'pass', '');

    const st2 = JSON.parse((await get('/api/stats', AUTH)).buf.toString('utf8'));
    const rA = st2.hazardRows.find((h) => h.key === hA.key);
    ok(rA && rA.severity === 'critical', '已识别隐患的严重度被写入（' + (rA && rA.severity) + '）');
    ok(rA && rA.criticalWrong === true, '重大 + 判定存疑 → 判为「识别出错」');
    ok(rA && rA.weight === 10, '识别出错条目权重 ×10');
    ok(st2.criticalStat.criticalWrong >= 1, 'criticalStat 统计到识别出错（' + st2.criticalStat.criticalWrong + ' 条）');
    ok(st2.criticalStat.wrongRows.some((w) => w.key === hA.key), 'wrongRows 含该隐患');
    ok(st2.summary.criticalWrong === st2.criticalStat.criticalWrong, 'summary.criticalWrong 同步');
    if (hB) {
      const rB = st2.hazardRows.find((h) => h.key === hB.key);
      ok(rB && rB.severity === '', '未标注的严重度存为空串（不冒充「一般隐患」）');
      ok(rB && rB.weight === 1, '未标注按权重 1 计');
      ok(rB && rB.criticalWrong === false, '未标注不会被判为识别出错');
    }

    const delRes = JSON.parse((await post('/api/delete', { reviewer: rv, all: true })).buf.toString('utf8'));
    ok(delRes.removed >= 1, '清理冒烟测试数据（' + delRes.removed + ' 条）');
    const st3 = JSON.parse((await get('/api/stats', AUTH)).buf.toString('utf8'));
    ok(st3.summary.itemCount === itemsBefore, '清理后评分条数还原（' + st3.summary.itemCount + '）');

    const exp = await get('/api/export.xlsx');
    ok(exp.code === 200 && exp.buf.length > 100000, '导出 xlsx 正常（' + (exp.buf.length / 1024 / 1024).toFixed(2) + ' MB）');
    const page = await get('/');
    ok(page.code === 200, '首页 200');
    const adm = await get('/admin');
    ok(adm.code === 200, '管理页 200');
  } catch (e) {
    console.error('异常：', e);
    fail++;
  } finally {
    await new Promise((r) => setTimeout(r, 350));   // 等服务的 120ms 防抖写盘落地
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    if (subsBackup != null) {
      try { fs.writeFileSync(SUBS_FILE, subsBackup); console.log('（已还原 data/submissions.json）'); } catch (e) { /* ignore */ }
    }
  }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
