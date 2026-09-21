/**
 * daily_prophet.test.mjs —— 日粒度日期工具 + Prophet 式 GAM 组件拆解。
 *
 * 关键断言：GAM 必须能把生成侧的分段斜率与节假日窗口效应**学回来**。
 * 容差来自实测（scripts/measure-recovery.mjs）：
 *   趋势序列最大误差 ≤ 8.2 件（0.7%）；单个斜率误差 ≤ 0.03；
 *   春节前窗口 2.2%、春节假期 0.5%、国庆前 15.6%、双11 假期 8.3%。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  epochDay, isoFromDay, dailyLabels, dayOfWeek, dayOfYearISO,
  holidayIndicators, makeDailyDataset, CN_HOLIDAYS, DAY_MS,
} from '../src/core/daily.js';
import { fitGam, forecastGam, futureLabels, buildGamDesign, prophetNarrative, DEFAULT_GAM_OPTIONS } from '../src/core/prophet_sim.js';

test('日期用 UTC 整数天运算：epochDay / isoFromDay 互为逆，且不涉及时区', () => {
  assert.equal(epochDay('1970-01-01'), 0);
  assert.equal(isoFromDay(0), '1970-01-01');
  assert.equal(epochDay('2023-01-01') - epochDay('2022-12-31'), 1);
  assert.equal(epochDay('2024-03-01') - epochDay('2024-02-29'), 1, '2024 是闰年，2 月有 29 天');
  assert.equal(isoFromDay(epochDay('2025-12-31')), '2025-12-31');
  assert.equal(DAY_MS, 86400000);
  assert.throws(() => epochDay('2023/01/01'), /格式应为 'YYYY-MM-DD'/);
});

test('dayOfWeek：1970-01-01 是周四，1970-01-04 是周日', () => {
  assert.equal(dayOfWeek(epochDay('1970-01-01')), 4);
  assert.equal(dayOfWeek(epochDay('1970-01-04')), 0);
  assert.equal(dayOfWeek(epochDay('2023-01-01')), 0, '2023-01-01 是周日');
  assert.equal(dayOfWeek(epochDay('2023-01-02')), 1);
});

test('dayOfYearISO 处理闰年', () => {
  assert.equal(dayOfYearISO('2023-01-01'), 0);
  assert.equal(dayOfYearISO('2023-12-31'), 364);
  assert.equal(dayOfYearISO('2024-12-31'), 365);
});

test('dailyLabels 连续无缺口', () => {
  const l = dailyLabels('2023-01-30', 4);
  assert.deepEqual(l, ['2023-01-30', '2023-01-31', '2023-02-01', '2023-02-02']);
  for (let i = 1; i < l.length; i++) {
    assert.equal(epochDay(l[i]) - epochDay(l[i - 1]), 1);
  }
});

test('holidayIndicators 的窗口长度与节假日配置一致，且范围外日期被跳过', () => {
  const labels = dailyLabels('2022-12-01', 120);
  const { names, columns, windows } = holidayIndicators(labels, CN_HOLIDAYS);
  assert.equal(names.length, 6, '3 个节假日 × 2 个窗口');
  const cnyPre = columns[names.indexOf('春节·节前14天')];
  assert.equal(cnyPre.reduce((a, b) => a + b, 0), 14);
  const cnyDuring = columns[names.indexOf('春节·假期8天')];
  assert.equal(cnyDuring.reduce((a, b) => a + b, 0), 8);
  assert.equal(windows.cny.ranges.length, 1, '该区间内只有 2023 年春节');
  // 春节 2023-01-22 的节前窗口应到 01-08 为止
  assert.equal(cnyPre[labels.indexOf('2023-01-08')], 1);
  assert.equal(cnyPre[labels.indexOf('2023-01-07')], 0);
  assert.equal(cnyPre[labels.indexOf('2023-01-22')], 0, '春节当天属于假期窗口，不属于节前窗口');
  assert.equal(cnyDuring[labels.indexOf('2023-01-22')], 1);
  assert.equal(cnyDuring[labels.indexOf('2023-01-29')], 1);
  assert.equal(cnyDuring[labels.indexOf('2023-01-30')], 0);
});

test('makeDailyDataset：分量求和必须逐位等于合成值（可诊断性依赖这条）', () => {
  const d = makeDailyDataset({ n: 200, seed: 5 });
  assert.equal(d.values.length, 200);
  assert.equal(d.labels.length, 200);
  for (let t = 0; t < 200; t++) {
    const sum = d.components.trend[t] + d.components.weekly[t] + d.components.yearly[t]
      + d.components.holiday[t] + d.components.noise[t];
    assert.equal(d.values[t], sum, `第 ${t} 期分量求和不等于合成值`);
  }
  // 确定性
  assert.deepEqual(makeDailyDataset({ n: 200, seed: 5 }).values, d.values);
  assert.notDeepEqual(makeDailyDataset({ n: 200, seed: 6 }).values, d.values);
  assert.throws(() => makeDailyDataset({ slopes: [1, 2] }), /slopes 长度应为/);
});

test('makeDailyDataset 的趋势是精确的分段线性（GAM 能精确表示它）', () => {
  const d = makeDailyDataset({ n: 800, changepoints: [100, 400], slopes: [1, -0.5, 2], base: 1000 });
  assert.equal(d.components.trend[0], 1000);
  assert.equal(d.components.trend[1], 1001);
  assert.equal(d.components.trend[100], 1000 + 1 * 100, '变点当天斜率尚未改变');
  assert.equal(d.components.trend[101], 1000 + 1 * 100 - 0.5);
  assert.equal(d.components.trend[400], 1000 + 100 - 0.5 * 300);
  assert.equal(d.components.trend[401], 1000 + 100 - 0.5 * 300 + 2);
});

test('★ 核心断言：GAM 把分段斜率与变点学回来', () => {
  const d = makeDailyDataset({ n: 1095, seed: 2023 });
  const g = fitGam(d.labels, d.values);
  // 单个斜率误差（实测 ≤ 0.030）
  g.summary.slopes.forEach((s, i) => {
    assert.ok(Math.abs(s - d.truth.slopes[i]) < 0.05,
      `第 ${i + 1} 段斜率学回 ${s.toFixed(4)}，真值 ${d.truth.slopes[i]}`);
  });
  // 更重要的：重建出的趋势**序列**误差（实测 ≤ 8.2 件）
  let maxErr = 0;
  for (let i = 0; i < d.values.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(g.components.trend[i] - d.components.trend[i]));
  }
  assert.ok(maxErr < 15, `趋势序列最大误差 ${maxErr.toFixed(1)} 件（真值水平 ${d.truth.base}）`);
  assert.equal(g.summary.changepoints.length, 2);
  assert.ok(g.summary.adjR2 > 0.9, `调整 R² = ${g.summary.adjR2}`);
});

test('★ 核心断言：GAM 把节假日窗口效应学回来（容差按实测标定）', () => {
  const d = makeDailyDataset({ n: 1095, seed: 2023 });
  const g = fitGam(d.labels, d.values);
  const base = d.truth.base;
  const find = (prefix) => {
    const hit = g.summary.holidayEffects.find((h) => h.name.startsWith(prefix));
    assert.ok(hit, `未找到 ${prefix} 的效应项`);
    return hit;
  };
  const cases = [
    ['春节·节前', 0.35, 0.08],
    ['春节·假期', -0.55, 0.05],
    ['国庆·节前', 0.12, 0.20],
    ['国庆·假期', -0.3, 0.05],
    ['双 11·节前', 0.25, 0.08],
    ['双 11·假期', -0.15, 0.12],
  ];
  for (const [prefix, ratio, tol] of cases) {
    const h = find(prefix);
    const truth = ratio * base;
    const relErr = Math.abs(h.coef - truth) / Math.abs(truth);
    assert.ok(relErr < tol, `${prefix} 学回 ${h.coef.toFixed(1)}，真值 ${truth.toFixed(1)}，相对误差 ${(relErr * 100).toFixed(1)}%`);
    assert.ok(Number.isFinite(h.se) && h.se > 0);
  }
});

test('★ 负向对照：变点位置给错时，斜率必须学不回来（证明上一条断言有区分度）', () => {
  const d = makeDailyDataset({ n: 1095, seed: 2023 });
  const wrong = fitGam(d.labels, d.values, { changepoints: [100, 900] });
  const errs = wrong.summary.slopes.map((s, i) => Math.abs(s - d.truth.slopes[i]));
  assert.ok(Math.max(...errs) > 0.3,
    `变点给错时最大斜率误差仅 ${Math.max(...errs).toFixed(4)}，断言缺乏区分度`);
});

test('回归测试：样本短于变点位置时，必须丢弃超范围变点而不是整个崩掉', () => {
  // 曾经的 bug：n=400 而变点设在 [365, 730] → 第二列 max(0,t−730) 恒为 0
  // → 与截距共线 → ols 抛「第 2 列在全样本上恒定」，整个模块不可用。
  const d = makeDailyDataset({ n: 400, seed: 9 });
  let g;
  assert.doesNotThrow(() => { g = fitGam(d.labels, d.values); });
  assert.deepEqual(g.summary.changepoints, [365], '730 应被丢弃');
  assert.deepEqual(g.summary.droppedChangepoints, [730]);
  assert.equal(g.summary.slopes.length, 2, '斜率段数 = 可用变点数 + 1');
  assert.ok(g.summary.slopes.every(Number.isFinite));
  // 样本完全短于全部变点时应全部丢弃，退化为纯线性趋势（仍可用，不报错）
  const short = makeDailyDataset({ n: 200, seed: 9 }); // 只覆盖到 2023-07-19
  const g2 = fitGam(short.labels, short.values);
  assert.deepEqual(g2.summary.changepoints, []);
  assert.equal(g2.summary.slopes.length, 1);
  assert.ok(Number.isFinite(g2.summary.slopes[0]));
  // 同一道护栏也必须罩住「样本没覆盖到的节假日」：国庆/双 11 在 7 月前不存在，
  // 其窗口列会恒为 0，必须被剔除并回报（否则整个模块崩掉）
  assert.ok(g2.summary.droppedColumns.some((nm) => nm.startsWith('国庆')), '国庆窗口列应被剔除');
  assert.ok(g2.summary.droppedColumns.some((nm) => nm.startsWith('双 11')), '双 11 窗口列应被剔除');
  assert.ok(g2.summary.holidayEffects.every((h) => h.name.startsWith('春节')));
  assert.ok(g2.summary.holidayEffects.every((h) => Number.isFinite(h.coef)));
});

test('GAM 内部一致性：fitted + residual 必须逐位等于原始序列', () => {
  const d = makeDailyDataset({ n: 400, seed: 9 });
  const g = fitGam(d.labels, d.values);
  for (let i = 0; i < d.values.length; i++) {
    assert.equal(g.components.fitted[i] + g.components.residual[i], d.values[i]);
  }
  // 残差应接近真实噪音（估计质量）
  let maxDev = 0;
  for (let i = 0; i < d.values.length; i++) {
    maxDev = Math.max(maxDev, Math.abs(g.components.residual[i] - d.components.noise[i]));
  }
  assert.ok(maxDev < 0.5 * d.truth.base * 0.1, `残差与真实噪音最大偏差 ${maxDev.toFixed(1)}`);
});

test('GAM 的周内效应剖面：周末高于周中，且最好/最差日可读', () => {
  const d = makeDailyDataset({ n: 1095, seed: 2023 });
  const g = fitGam(d.labels, d.values);
  const { dowMean, bestDow, worstDow } = g.summary;
  assert.equal(dowMean.length, 7);
  assert.ok(dowMean[bestDow] === Math.max(...dowMean));
  assert.ok(dowMean[worstDow] === Math.min(...dowMean));
  // 生成侧是「周末高、周中低」（周日/周六为正，周四最低）
  assert.ok(dowMean[0] > 0 && dowMean[6] > 0, '周日/周六应为正效应');
  assert.ok(dowMean[4] < 0, '周四应为负效应');
});

test('buildGamDesign 的基函数分组与命名一致', () => {
  // 用 400 天（2023-01-01 ~ 2024-02-03）：覆盖到春节/国庆/双 11 各至少一次，
  // 保证节假日窗口列都不是恒定的（否则会被护栏剔除，索引会整体前移）。
  const labels = dailyLabels('2023-01-01', 400);
  const { X, names, groups, droppedColumns } = buildGamDesign(labels, { changepoints: [10, 20], weeklyOrder: 2, yearlyOrder: 1 });
  assert.equal(X.length, 400);
  assert.equal(X[0].length, names.length);
  assert.deepEqual(droppedColumns, [], '这段时间范围内不应有列被剔除');
  // 趋势组：t + 2 个变点列
  assert.equal(groups.trend.length, 3);
  assert.equal(names[0], '趋势 t');
  assert.equal(X[0][0], 0);
  assert.equal(X[5][0], 5);
  // 变点列在变点前恒为 0，之后线性增长
  assert.equal(X[10][1], 0);
  assert.equal(X[15][1], 5);
  assert.equal(X[25][2], 5);
  // 周度 2 阶 + 年度 1 阶 = 4 + 2 列
  assert.equal(groups.weekly.length, 4);
  assert.equal(groups.yearly.length, 2);
  assert.equal(groups.holiday.length, 6);
  // 分组索引必须覆盖所有列且不重复（列被剔除后要重映射，很容易漏）
  const all = [...groups.trend, ...groups.weekly, ...groups.yearly, ...groups.holiday].sort((a, b) => a - b);
  assert.deepEqual(all, Array.from({ length: names.length }, (_, i) => i));
});

test('forecastGam 外推：标签连续、区间随步长变宽、周度项仍起作用', () => {
  const d = makeDailyDataset({ n: 400, seed: 3 });
  const g = fitGam(d.labels, d.values);
  const fut = futureLabels(d.labels, 30);
  assert.equal(fut.length, 30);
  assert.equal(epochDay(fut[0]) - epochDay(d.labels[d.labels.length - 1]), 1);
  const fc = forecastGam(g, fut);
  assert.equal(fc.length, 30);
  assert.equal(fc[0].label, fut[0]);
  for (const p of fc) {
    assert.ok(Number.isFinite(p.mean));
    assert.ok(p.lower < p.mean && p.upper > p.mean);
  }
  // 区间宽度随步长单调不减（σ√h 扩散）
  const w = fc.map((p) => p.upper - p.lower);
  for (let i = 1; i < w.length; i++) assert.ok(w[i] >= w[i - 1]);
  // 未来值不应出现负数（销量不能为负）
  assert.ok(fc.every((p) => p.mean > 0));
});

test('prophetNarrative 输出计划员可读的业务结论', () => {
  const d = makeDailyDataset({ n: 1095, seed: 2023 });
  const g = fitGam(d.labels, d.values);
  const lines = prophetNarrative(g.summary, d.truth.base);
  assert.ok(lines.length >= 3);
  assert.ok(lines.some((l) => l.includes('趋势段斜率')));
  assert.ok(lines.some((l) => l.includes('春节')));
  assert.ok(lines.some((l) => l.includes('调整 R²')));
  assert.ok(lines.every((l) => typeof l === 'string' && l.length > 5));
});

test('DEFAULT_GAM_OPTIONS 的参数预算不会触发秩亏护栏', () => {
  const nParam = 1 + 1 + DEFAULT_GAM_OPTIONS.changepoints.length
    + 2 * DEFAULT_GAM_OPTIONS.weeklyOrder + 2 * DEFAULT_GAM_OPTIONS.yearlyOrder
    + 6;
  const rows = 1095;
  assert.ok(rows >= 2 * nParam, `1095 行不足以稳定拟合 ${nParam} 个参数`);
});
