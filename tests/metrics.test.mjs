/**
 * metrics.test.mjs —— 误差指标的精确值验证。
 * 期望值全部手算，不用“跑一下就抄下来”的方式固化错误。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mae, rmse, mape, wape, bias, residualStd, summarize, biasRisk,
} from '../src/core/metrics.js';

// 固定输入：actual [10,20,30] vs forecast [12,18,33]
// 误差 e = A−F = [−2, 2, −3]，|e| 合计 7，ΣA = 60
const A = [10, 20, 30];
const F = [12, 18, 33];

test('mae = Σ|A−F| / n = 7/3', () => {
  assert.equal(mae(A, F), 7 / 3);
  assert.equal(mae(A, F).toFixed(6), '2.333333');
});

test('rmse = sqrt(17/3)（对大偏差惩罚更重）', () => {
  assert.equal(rmse(A, F), Math.sqrt(17 / 3));
  assert.ok(rmse(A, F) > mae(A, F), 'RMSE 必须 >= MAE（Jensen 不等式）');
});

test('mape = 平均(|e|/A) × 100 = (0.2+0.1+0.1)/3 × 100', () => {
  const m = mape(A, F);
  assert.equal(m.value, (0.4 / 3) * 100);
  assert.equal(m.value.toFixed(4), '13.3333');
  assert.equal(m.excluded, 0);
  assert.deepEqual(m.zeroPeriods, []);
});

test('wape = Σ|e| / Σ|A| × 100 = 7/60 × 100', () => {
  assert.equal(wape(A, F), (7 / 60) * 100);
});

test('bias = Σ(F−A)/ΣA × 100 = 3/60 × 100 = +5%', () => {
  assert.equal(bias(A, F), 5);
  // 把角色对调（actual=F, forecast=A）：Σ(A−F) = −3，Σ(F) = 63 → −3/63×100
  assert.equal(bias(F, A).toFixed(4), '-4.7619');
});

test('residualStd 用样本标准差(n−1)：残差 [−2,2,−3] → sqrt(14/2)', () => {
  assert.equal(residualStd(A, F), Math.sqrt(7));
  assert.equal(residualStd(A, F).toFixed(10), '2.6457513111');
});

test('MAPE 遇实际值 0 必须剔除并报告，而不是产生 Infinity 冒充结果', () => {
  const m = mape([0, 100, 200], [10, 50, 200]);
  assert.equal(m.excluded, 1);
  assert.deepEqual(m.zeroPeriods, [0]);
  // 只用后两期：|100−50|/100 = 0.5，|200−200|/200 = 0 → (0.5+0)/2 = 25%
  assert.equal(m.value, 25);
});

test('全部实际值为 0 时 MAPE/WAPE/Bias 返回 NaN（不可定义），而不是 0', () => {
  const zeros = [0, 0, 0];
  const f = [1, 2, 3];
  assert.ok(Number.isNaN(mape(zeros, f).value));
  assert.ok(Number.isNaN(wape(zeros, f)));
  assert.ok(Number.isNaN(bias(zeros, f)));
  assert.equal(biasRisk(NaN).level, 'unknown');
});

test('长度不一致 / 非有限数值必须抛错（静默错配是这类代码最常见的 bug）', () => {
  assert.throws(() => mae([1, 2], [1]), /长度不一致/);
  assert.throws(() => mae([], []), /输入为空/);
  assert.throws(() => mae([1, NaN], [1, 2]), /非有限数值/);
  assert.throws(() => rmse('x', [1]), /必须是数组/);
});

test('summarize 各字段与单独调用一致', () => {
  const s = summarize(A, F);
  assert.equal(s.mae, mae(A, F));
  assert.equal(s.rmse, rmse(A, F));
  assert.equal(s.mape, mape(A, F).value);
  assert.equal(s.wape, wape(A, F));
  assert.equal(s.bias, bias(A, F));
  assert.equal(s.residualStd, residualStd(A, F));
  assert.equal(s.n, 3);
});

test('负向对照：这些断言确实有区分度（把方向搞反会被抓住）', () => {
  // 若有人把 bias 写成 Σ(A−F)，本测试必须失败
  assert.notEqual(bias(A, F), -5);
  // 若有人把 MAPE 写成不乘 100，本测试必须失败
  assert.notEqual(mape(A, F).value, 0.4 / 3);
  // 若有人用总体标准差(n)而非样本标准差(n−1)，residualStd 会是 sqrt(14/3)
  assert.notEqual(residualStd(A, F), Math.sqrt(14 / 3));
});

test('biasRisk 分级：阈值 ±5% / ±10% 与方向', () => {
  assert.equal(biasRisk(0).level, 'ok');
  assert.equal(biasRisk(4.9).level, 'ok');
  assert.equal(biasRisk(5.1).level, 'warn-high');
  assert.equal(biasRisk(10.1).level, 'danger-high');
  assert.equal(biasRisk(-4.9).level, 'ok');
  assert.equal(biasRisk(-5.1).level, 'warn-low');
  assert.equal(biasRisk(-10.1).level, 'danger-low');
  // 高估 = 库存积压风险，低估 = 缺货风险，方向不能反
  assert.match(biasRisk(20).label, /积压/);
  assert.match(biasRisk(-20).label, /缺料|断货/);
});
