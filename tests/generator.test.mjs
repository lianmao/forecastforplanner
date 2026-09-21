/**
 * generator.test.mjs —— 数据生成器的确定性与可复现性。
 * 生成器是所有教学图表的起点：它不确定，后面每个模块的“对照”都不成立。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRng, standardNormal, periodLabels, synthSeries, makeTurningPointSeries,
  injectDirty, makeCleaningDataset, makePromoDataset, holidayCalendar, makeHolidayDataset, q,
} from '../src/core/generator.js';
import { DEFAULT_PROMOS } from '../src/core/promo_sim.js';

test('makeRng 同种子必然同序列，不同种子不同序列', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  const c = makeRng(43);
  const sa = Array.from({ length: 20 }, () => a());
  const sb = Array.from({ length: 20 }, () => b());
  const sc = Array.from({ length: 20 }, () => c());
  assert.deepEqual(sa, sb);
  assert.notDeepEqual(sa, sc);
  // 必须落在 [0,1)
  for (const v of sa) assert.ok(v >= 0 && v < 1, `${v} 越界`);
  // 不能被常量或简单周期糊弄过去
  assert.ok(new Set(sa).size > 15, '随机性不足');
});

test('standardNormal 近似 N(0,1)：均值≈0、方差≈1，且逐位可复现', () => {
  const rng = makeRng(7);
  const xs = Array.from({ length: 20000 }, () => standardNormal(rng));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const varr = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  assert.ok(Math.abs(mean) < 0.05, `均值 ${mean}`);
  assert.ok(Math.abs(varr - 1) < 0.06, `方差 ${varr}`);
  // Irwin–Hall 有界，Box–Muller 无界 —— 有界是它跨引擎逐位一致的代价
  assert.ok(Math.max(...xs) <= 6 && Math.min(...xs) >= -6);
  // 同种子同序列（逐位可复现）
  const rngA = makeRng(7);
  const xs1 = Array.from({ length: 50 }, () => standardNormal(rngA));
  const rngB = makeRng(7);
  const xs2 = Array.from({ length: 50 }, () => standardNormal(rngB));
  assert.deepEqual(xs1, xs2);
});

test('periodLabels 跨年进位正确', () => {
  assert.deepEqual(periodLabels('2020-11', 4), ['2020-11', '2020-12', '2021-01', '2021-02']);
  assert.equal(periodLabels('2020-01', 72).length, 72);
  assert.equal(periodLabels('2020-01', 72)[71], '2025-12');
  assert.throws(() => periodLabels('2020/01', 3), /格式应为 'YYYY-MM'/);
  assert.throws(() => periodLabels('2020-13', 3), /月份越界/);
});

test('synthSeries 加法模式：三分量之和必须逐位等于合成值', () => {
  const s = synthSeries({ n: 40, base: 1000, trend: 3, seasonality: 25, noise: 7, seed: 11 });
  assert.equal(s.values.length, 40);
  for (let t = 0; t < 40; t++) {
    assert.equal(s.values[t], 1000 + t * 3 + s.components.seasonal[t] + s.components.noise[t],
      `第 ${t} 期分量求和不等于合成值`);
  }
  // 季节分量是 1e-12 的整数倍（跨引擎一致性的前提）
  for (const v of s.components.seasonal) {
    assert.ok(Math.abs(v * 1e12 - Math.round(v * 1e12)) < 1e-6);
  }
});

test('synthSeries 确定性：同参数两次调用完全一致', () => {
  const a = synthSeries({ n: 30, seed: 5 });
  const b = synthSeries({ n: 30, seed: 5 });
  assert.deepEqual(a.values, b.values);
  assert.notDeepEqual(a.values, synthSeries({ n: 30, seed: 6 }).values);
});

test('synthSeries 参数校验与乘法模式', () => {
  assert.throws(() => synthSeries({ n: 2 }), /n 需为 >=3 的整数/);
  assert.throws(() => synthSeries({ mode: 'mixed' }), /mode 只能是/);
  const m = synthSeries({ n: 30, base: 1000, trend: 3, seasonality: 25, noise: 5, mode: 'multiplicative' });
  assert.ok(m.values.every((v) => v > 0), '乘法模式的销量必须为正');
});

test('injectDirty 精确注入爆单与缺货，且不污染传入的干净序列', () => {
  const clean = Array.from({ length: 20 }, (_, i) => 100 + i);
  const snapshot = clean.slice();
  const r = injectDirty({ cleanValues: clean, spikeIndices: [3], spikeFactor: 3, stockoutRuns: [[10, 12]] });
  assert.equal(r.values[3], 103 * 3);
  assert.equal(r.values[10], 0);
  assert.equal(r.values[12], 0);
  assert.deepEqual(clean, snapshot, 'injectDirty 不能改动调用方传入的数组');
  assert.deepEqual(r.truth.cleanValues, snapshot);
  assert.deepEqual(r.truth.zeroed, [10, 11, 12]);
  assert.throws(() => injectDirty({ cleanValues: clean, spikeIndices: [99] }), /爆单位置越界/);
  assert.throws(() => injectDirty({ cleanValues: clean, stockoutRuns: [[5, 99]] }), /缺货区间非法/);
});

test('makeCleaningDataset 默认含 2 处爆单 + 2 段缺货，且真值可对照', () => {
  const d = makeCleaningDataset();
  assert.equal(d.truth.spikeIndices.length, 2);
  assert.equal(d.truth.stockoutRuns.length, 2);
  assert.equal(d.values.length, d.truth.cleanValues.length);
  for (const i of d.truth.spikeIndices) {
    assert.ok(d.values[i] > d.truth.cleanValues[i] * 3, `位置 ${i} 未被爆单放大`);
  }
  for (const [s, e] of d.truth.stockoutRuns) {
    for (let i = s; i <= e; i++) assert.equal(d.values[i], 0);
  }
});

test('makeTurningPointSeries 的拐点位置固定，测试可断言', () => {
  const d = makeTurningPointSeries({ n: 36, noise: 0, breakUp: 12, breakDown: 24 });
  assert.deepEqual(d.turningPoints, [12, 24]);
  assert.equal(d.values.length, 36);
  // 无噪音时三段方向必须明确
  assert.ok(d.values[11] > d.values[0], '上行段应递增');
  assert.ok(d.values[23] < d.values[12], '下行段应递减');
  assert.ok(d.values[35] > d.values[24], '反弹段应递增');
});

test('holidayCalendar 每月只有一个主节假日，避免效应叠加不可归因', () => {
  const c = holidayCalendar();
  for (let m = 0; m < 12; m++) {
    const hits = Object.values(c).filter((arr) => arr[m] === 1).length;
    assert.ok(hits <= 1, `第 ${m + 1} 月有 ${hits} 个节假日标志`);
  }
  assert.equal(c.cnyPre.reduce((a, b) => a + b, 0), 1);
  assert.equal(c.double11.reduce((a, b) => a + b, 0), 1);
});

test('makeHolidayDataset 的节假日月份确实被抬高/压低', () => {
  const d = makeHolidayDataset({ n: 72, noise: 0, seed: 1 });
  assert.equal(d.components.holiday.length, 72);
  // 1 月（春节前，索引 0,12,24…）效应为正
  assert.ok(d.components.holiday[0] > 0);
  // 2 月（节后回落）效应为负
  assert.ok(d.components.holiday[1] < 0);
  // 无噪音时 holiday 分量只在有标志的月份非零
  const nonZero = d.components.holiday.map((v, i) => (v !== 0 ? i % 12 : -1)).filter((x) => x >= 0);
  assert.deepEqual([...new Set(nonZero)].sort((a, b) => a - b), [0, 1, 8, 9, 10]);
});

test('makePromoDataset 的促销期被拉升、后续两期被透支，且自然需求可对照', () => {
  const d = makePromoDataset({ n: 40, kappa: 2.5, eta: 1, lambda: 0.45 });
  assert.equal(d.lift.length, DEFAULT_PROMOS.length);
  assert.equal(d.values.length, 40);
  const first = d.lift[0];
  assert.equal(first.factor, 1 + 2.5 * (1 - first.discount));
  assert.equal(d.values[first.index], d.natural[first.index] + first.delta);
  // 透支必须让促销后一期低于自然需求
  const dip = d.dip.find((x) => x.from === first.index);
  assert.ok(dip.delta < 0);
  assert.equal(d.values[dip.index], d.natural[dip.index] + dip.delta);
  // 折扣必须各异 —— 否则折扣弹性不可识别（只有一次促销是学不出效应的）
  assert.ok(new Set(d.lift.map((l) => l.discount)).size > 1);
  // 促销数学与学习侧共用一份实现（生成侧/拟合侧不得各写一遍）
  assert.deepEqual(d.promos, DEFAULT_PROMOS);
});

test('q() 量化语义：把 1e-12 以下的差异抹平', () => {
  assert.equal(q(1.0000000000001), 1);
  assert.equal(q(1.0000000000006), 1.000000000001);
  assert.equal(q(0), 0);
});
