/**
 * cleaning.test.mjs —— 分位数 / IQR / 盖帽 / 缺货修复的精确验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quantile, iqrBounds, winsorize, medianReplace, dropInterpolate,
  detectStockoutRuns, repairStockouts, describe, cleanSeries, linearFill,
} from '../src/core/cleaning.js';
import { makeCleaningDataset } from '../src/core/generator.js';

const TEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test('quantile 与 numpy 默认 linear 插值一致（含 p=0 / p=1 端点）', () => {
  assert.equal(quantile(TEN, 0), 1);
  assert.equal(quantile(TEN, 1), 10);
  assert.equal(quantile(TEN, 0.5), 5.5);   // pos=4.5 → 5+0.5×1
  assert.equal(quantile(TEN, 0.25), 3.25); // pos=2.25 → 3+0.25×1
  assert.equal(quantile(TEN, 0.75), 7.75); // pos=6.75 → 7+0.75×1
  // 未排序输入应自动排序
  assert.equal(quantile([10, 1, 5, 3], 0.5), 4);
  assert.throws(() => quantile(TEN, 1.5), /需在 \[0,1\]/);
  assert.throws(() => quantile([], 0.5), /输入为空/);
});

test('iqrBounds：Q1=3.25 Q3=7.75 IQR=4.5 → k=1.5 时区间 [−3.5, 14.5]', () => {
  const b = iqrBounds(TEN, 1.5);
  assert.equal(b.q1, 3.25);
  assert.equal(b.q3, 7.75);
  assert.equal(b.iqr, 4.5);
  assert.equal(b.lower, -3.5);
  assert.equal(b.upper, 14.5);
});

test('winsorize 把爆单截断到上界（并记录被截断位置）', () => {
  const dirty = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 100];
  const r = winsorize(dirty, 1.5);
  // n=12 → q1 pos=2.75 → 12.75；q3 pos=8.25 → 18.25；IQR=5.5；上界=18.25+8.25=26.5
  assert.equal(r.bounds.upper, 26.5);
  assert.equal(r.values[11], 26.5);
  assert.equal(r.clipped.length, 1);
  assert.deepEqual(r.clipped[0], { index: 11, from: 100, to: 26.5, side: 'high' });
  // 长度与时间轴必须保持不变
  assert.equal(r.values.length, dirty.length);
});

test('负向对照：把爆单去掉后不应再有任何截断（证明上一条断言不是空转）', () => {
  const clean = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const r = winsorize(clean, 1.5);
  assert.equal(r.clipped.length, 0);
});

test('medianReplace 用全序列中位数替换异常点', () => {
  const dirty = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 100];
  const r = medianReplace(dirty, 1.5);
  assert.equal(r.replaced.length, 1);
  assert.equal(r.values[11], r.median);
  assert.ok(r.median > 10 && r.median < 20, `中位数应落在正常区间，实际 ${r.median}`);
});

test('dropInterpolate 剔除异常点后用线性插值补齐（长度不变、无空洞）', () => {
  const dirty = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 100];
  const r = dropInterpolate(dirty, 1.5);
  assert.equal(r.removed.length, 1);
  assert.equal(r.values.length, dirty.length);
  assert.ok(Number.isFinite(r.values[11]));
  // 末点无右邻，只能向左外延 → 等于最后一个已知值 20
  assert.equal(r.values[11], 20);
});

test('linearFill 两端缺数据时向最近已知值外延（诚实降级，不编造趋势）', () => {
  assert.deepEqual(linearFill([null, null, 5, 7, null]), [5, 5, 5, 7, 7]);
  assert.deepEqual(linearFill([0, null, 10]), [0, 5, 10]);
  assert.throws(() => linearFill([null, null]), /没有任何已知点/);
});

test('detectStockoutRuns：连续 0 的区间，minLen 控制“连续”的判定', () => {
  const v = [1, 0, 0, 5, 0, 3];
  assert.deepEqual(detectStockoutRuns(v, { minLen: 2 }), [[1, 2]]);
  assert.deepEqual(detectStockoutRuns(v, { minLen: 1 }), [[1, 2], [4, 4]]);
  // 尾部连续 0 也要被抓到
  assert.deepEqual(detectStockoutRuns([1, 2, 0, 0, 0], { minLen: 2 }), [[2, 4]]);
  assert.deepEqual(detectStockoutRuns([1, 2, 3], { minLen: 2 }), []);
});

test('repairStockouts 线性插值：区间 [1,2] 落在 10 与 40 之间 → 20 / 30', () => {
  const r = repairStockouts([10, 0, 0, 40], [[1, 2]], { method: 'linear' });
  assert.equal(r.values[1], 20);
  assert.equal(r.values[2], 30);
  assert.equal(r.values[0], 10);
  assert.equal(r.values[3], 40);
  assert.equal(r.filled.length, 2);
  assert.ok(r.filled.every((f) => f.how === 'linear'));
});

test('repairStockouts yoy：用去年同期值，并在无同比数据时退回插值', () => {
  const v = new Array(24).fill(0);
  for (let i = 0; i < 24; i++) v[i] = 100 + i;
  v[13] = 0; v[14] = 0;
  const r = repairStockouts(v, [[13, 14]], { method: 'yoy', period: 12 });
  assert.equal(r.values[13], 101); // i−12 = 1 → 101
  assert.equal(r.values[14], 102);
  assert.ok(r.filled.every((f) => f.how === 'yoy'));
  // 第 0 期附近无同比 → 不允许 NaN 漏出
  const v2 = [0, 0, 105, 106];
  const r2 = repairStockouts(v2, [[0, 1]], { method: 'yoy', period: 12 });
  assert.ok(r2.values.every(Number.isFinite));
  assert.ok(r2.filled.some((f) => f.how.startsWith('extrapolate')));
});

test('describe 的均值 / 样本标准差 / CV 手算核对', () => {
  const d = describe([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(d.n, 8);
  assert.equal(d.mean, 5);
  // 样本标准差 = sqrt(32/7)
  assert.equal(d.std.toFixed(10), Math.sqrt(32 / 7).toFixed(10));
  assert.equal(d.cv.toFixed(6), ((Math.sqrt(32 / 7) / 5) * 100).toFixed(6));
  assert.equal(d.median, 4.5);
  assert.equal(d.min, 2);
  assert.equal(d.max, 9);
});

test('cleanSeries 顺序：先补缺货再判异常（零值不该被当成低异常点）', () => {
  //                    0  1  2  3  4   5  6   7  8   9   10 11 12
  const dirty = [20, 22, 21, 23, 20, 0, 0, 22, 24, 150, 23, 21, 20];
  const r = cleanSeries(dirty, { outlierMethod: 'keep', stockoutMethod: 'linear' });
  assert.equal(r.meta.stockoutRuns.length, 1);
  assert.deepEqual(r.meta.stockoutRuns[0], [5, 6]);
  assert.equal(r.meta.filled.length, 2);
  // 线性插值：锚点 20(idx4) 与 22(idx7) → 20+2/3, 20+4/3
  assert.equal(r.values[5].toFixed(6), (20 + 2 / 3).toFixed(6));
  assert.equal(r.values[6].toFixed(6), (20 + 4 / 3).toFixed(6));
  assert.equal(r.values[9], 150, 'outlierMethod=keep 时爆单应原样保留');
});

test('cleanSeries：缺货策略为 keep 时零值豁免，不被盖帽抬起来', () => {
  const dirty = [20, 22, 21, 23, 20, 0, 0, 22, 24, 150, 23, 21, 20];
  const r = cleanSeries(dirty, { outlierMethod: 'winsorize', k: 1.5, stockoutMethod: 'keep' });
  assert.equal(r.meta.exemptZeroCount, 2);
  assert.equal(r.values[5], 0, '已知缺货的 0 不应被改写成插值/上界值');
  assert.equal(r.values[6], 0);
  assert.ok(r.values[9] < 150, '爆单应被截断');
  assert.equal(r.meta.clipped.length, 1);
  assert.equal(r.meta.clipped[0].index, 9);
});

test('★ 可用性断言：k 滑杆在 1.0~3.0 全程都必须有可观察的反馈（截断数单调不增且确有变化）', () => {
  // 这条断言来自一个真实缺陷：早期数据集只有 3.2 倍的极端爆单，远超任何 k 的上界，
  // 于是 k 从 1.5 到 3.0 不作任何改变 —— 计划员拖动滑杆毫无反馈，会以为工具坏了。
  // 数据侧补了 4 处中等幅度异常（落在判定边界之间）之后才成立。
  const d = makeCleaningDataset();
  const exempt = new Set();
  for (const [s, e] of d.truth.stockoutRuns) for (let i = s; i <= e; i++) exempt.add(i);
  const pool = d.values.filter((_, i) => !exempt.has(i));

  const counts = [];
  for (const k of [1.0, 1.5, 2.0, 2.5, 3.0]) {
    const b = iqrBounds(pool, k);
    counts.push(d.values.filter((v, i) => !exempt.has(i) && (v > b.upper || v < b.lower)).length);
  }
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] <= counts[i - 1], `k 增大时截断数必须单调不增：${counts.join(' → ')}`);
  }
  assert.ok(counts[0] > counts[counts.length - 1],
    `k 从 1.0 到 3.0 必须真的改变判定结果，实际 ${counts.join(' → ')}`);
  // 而且在这条路径上，清洗确实改变了序列（不是"判定了但没改"）
  const c1 = cleanSeries(d.values, { outlierMethod: 'winsorize', k: 1.5, stockoutMethod: 'keep' });
  const c2 = cleanSeries(d.values, { outlierMethod: 'winsorize', k: 2.5, stockoutMethod: 'keep' });
  assert.notDeepEqual(c1.values, c2.values, '不同 k 下清洗结果必须不同');
});

test('cleanSeries 清洗后 CV 应下降（否则说明清洗没起作用）', () => {
  const dirty = [20, 22, 21, 23, 20, 0, 0, 22, 24, 150, 23, 21, 20];
  const before = cleanSeries(dirty, {});
  const after = cleanSeries(dirty, { outlierMethod: 'winsorize', k: 1.5, stockoutMethod: 'linear' });
  assert.ok(after.after.cv < before.before.cv, `CV 应下降：${before.before.cv} → ${after.after.cv}`);
});

test('未知策略名必须抛错（防止 UI 传错字符串时静默不清洗）', () => {
  assert.throws(() => cleanSeries([1, 2, 3], { outlierMethod: 'nope' }), /未知异常处理策略/);
  assert.throws(() => cleanSeries([1, 2, 3], { stockoutMethod: 'nope' }), /未知缺货处理策略/);
});
