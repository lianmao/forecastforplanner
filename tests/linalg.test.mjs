/**
 * linalg.test.mjs —— 最小二乘求解器。
 *
 * 重点验证三件事，它们对应真实项目里踩过的三个坑：
 *   ① 系数正确（含内部标准化后的雅可比还原）；
 *   ② 标准误正确（原尺度，不是标准化尺度）；
 *   ③ 秩亏/常量列必须拒绝，而不是给出一个看起来像分数的伪解。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ols, standardizedImportance } from '../src/core/linalg.js';

test('精确线性数据：y = 5 + 3x 必须精确还原（容差 1e-12，不是逐位相等）', () => {
  const X = [[1], [2], [3], [4]];
  const y = X.map(([x]) => 5 + 3 * x);
  const fit = ols(X, y);
  // 为什么不是 assert.equal：求解走「标准化 → 解正规方程 → 雅可比换算回原尺度」，
  // 这条路径必然引入几次舍入（实测 β0 = 5.000000000000001，1 ULP 量级）。
  // 换来的是对量纲跨 10 个数量级的特征依然稳定，这个交换是值得的。
  assert.ok(Math.abs(fit.beta[0] - 5) < 1e-12, `β0 = ${fit.beta[0]}`);
  assert.ok(Math.abs(fit.beta[1] - 3) < 1e-12, `β1 = ${fit.beta[1]}`);
  assert.ok(fit.r2 > 1 - 1e-15, `R² = ${fit.r2}`);
  assert.ok(fit.sigma < 1e-13, `残差 σ = ${fit.sigma}`);
  assert.ok(fit.residuals.every((r) => Math.abs(r) < 1e-12));
  assert.ok(Math.abs(fit.fitted[0] - 8) < 1e-12);
  assert.ok(Math.abs(fit.fitted[3] - 17) < 1e-12);
});

test('标准误与教科书闭式解一致（原尺度，不是标准化尺度）', () => {
  const X = [[1], [2], [3], [4], [5], [6]];
  const y = [2.3, 3.6, 5.9, 8.2, 9.8, 12.4];
  const fit = ols(X, y);
  const n = X.length;
  const xs = X.map(([v]) => v);
  const xbar = xs.reduce((a, b) => a + b, 0) / n;
  const Sxx = xs.reduce((a, b) => a + (b - xbar) ** 2, 0);
  const seB1Expected = fit.sigma / Math.sqrt(Sxx);
  const seB0Expected = fit.sigma * Math.sqrt(1 / n + xbar ** 2 / Sxx);
  assert.ok(Math.abs(fit.se[1] - seB1Expected) < 1e-12, `se(b1)=${fit.se[1]} 期望 ${seB1Expected}`);
  assert.ok(Math.abs(fit.se[0] - seB0Expected) < 1e-12, `se(b0)=${fit.se[0]} 期望 ${seB0Expected}`);
  // t 值 = 系数 / 标准误
  assert.ok(Math.abs(fit.tStat[1] - fit.beta[1] / fit.se[1]) < 1e-12);
  // 自由度 = n − 参数个数(含截距)
  assert.equal(fit.dof, n - 2);
});

test('内部标准化的雅可比还原：对特征做平移+缩放，系数必须可逆换算', () => {
  const X = [[1], [2], [3], [4], [5], [6]];
  const y = [4.1, 5.2, 7.1, 8.3, 10.2, 11.1];
  const a = ols(X, y);
  // x' = 1000x + 50000 → β1' = β1/1000，β0' = β0 − 50·β1
  const X2 = X.map(([x]) => [1000 * x + 50000]);
  const b = ols(X2, y);
  assert.ok(Math.abs(b.beta[1] - a.beta[1] / 1000) < 1e-12, `β1' = ${b.beta[1]}`);
  assert.ok(Math.abs(b.beta[0] - (a.beta[0] - 50 * a.beta[1])) < 1e-9, `β0' = ${b.beta[0]}`);
  assert.ok(Math.abs(b.se[1] - a.se[1] / 1000) < 1e-12, '标准误也必须跟着换算');
  assert.equal(b.r2.toFixed(12), a.r2.toFixed(12), 'R² 不该受特征尺度影响');
});

test('两特征精确还原（样本量充裕）', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 12; i++) {
    const x1 = i;
    const x2 = (i * i) % 5;
    X.push([x1, x2]);
    y.push(10 + 2 * x1 - 3 * x2);
  }
  const fit = ols(X, y);
  assert.ok(Math.abs(fit.beta[0] - 10) < 1e-9);
  assert.ok(Math.abs(fit.beta[1] - 2) < 1e-9);
  assert.ok(Math.abs(fit.beta[2] + 3) < 1e-9);
  assert.ok(fit.r2 > 0.999999);
});

test('带截距的回归：残差之和必须为 0（OLS 正规方程的必然结果）', () => {
  const X = [[1], [2], [3], [4], [5], [7], [9]];
  const y = [3, 5, 4, 9, 8, 12, 13];
  const fit = ols(X, y);
  const sum = fit.residuals.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum) < 1e-9, `残差和 ${sum}`);
  assert.ok(fit.adjR2 <= fit.r2 + 1e-12, '调整 R² 不可能大于 R²');
});

test('秩亏（样本量不足）必须拒绝，而不是给出最小范数伪解', () => {
  // 5 行 4 参数 → 需要 2×5=10 行
  const X = [[1, 2, 3], [2, 3, 4], [3, 4, 6], [4, 6, 8], [5, 7, 9]];
  const y = [1, 2, 3, 4, 5];
  assert.throws(() => ols(X, y), /不足以稳定拟合/);
  // minRowsPerParam=1 时门槛降低，才允许求解（换一个条件数良好的设计矩阵）
  const X2 = [[1, 0, 0], [2, 1, 0], [3, 0, 1], [4, 1, 1], [5, 2, 3], [6, 3, 1]];
  assert.doesNotThrow(() => ols(X2, [1, 2, 3, 4, 5, 6], { minRowsPerParam: 1 }));
});

test('完全共线的特征必须拒绝（不能给伪解）', () => {
  const X = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8]];
  const y = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.throws(() => ols(X, y), /奇异|秩亏|共线/);
});

test('常量列必须点名报错并给出列号（否则用户无从排查）', () => {
  const X = [
    [1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5],
  ];
  assert.throws(() => ols(X, [1, 2, 3, 4, 5, 6]), /第 1 列（0 起算）在全样本上恒定/);
});

test('输入形状与数值校验', () => {
  assert.throws(() => ols([[1], [2]], [1]), /行数 .* 与 y 长度/);
  assert.throws(() => ols([], []), /输入为空/);
  assert.throws(() => ols([[1], [2, 3]], [1, 2]), /列数不一致/);
  assert.throws(() => ols([[1], [NaN]], [1, 2]), /非有限数值/);
});

test('standardizedImportance 归一化到合计 100，且强度大的特征权重更高', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 30; i++) {
    const strong = i;
    const weak = i % 3;
    X.push([strong, weak]);
    y.push(5 * strong + 0.1 * weak);
  }
  const fit = ols(X, y);
  const imp = standardizedImportance(fit);
  const total = imp.reduce((a, c) => a + c.weightPct, 0);
  assert.ok(Math.abs(total - 100) < 1e-9, `合计 ${total}`);
  assert.ok(imp[0].weightPct > imp[1].weightPct, '强特征权重应更大');
});
