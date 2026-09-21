/**
 * stats.test.mjs —— 拆解/合成、移动平均、拐点滞后、阻尼 Holt-Winters。
 *
 * 这里刻意用手工可推导的极小样本，让每个期望值都能在纸上核对：
 * 序列 [11,11,15,15,19,19,23,23] = 线性趋势 10+2t 叠加季节 [1,−1,1,−1]（周期 4）。
 * 经典 2×4 居中移动平均能精确剥离周期 4 的季节，因此趋势/季节/残差都应被精确还原。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sma, wma, movingAverage, findPeaks, findTroughs, peakLag, centeredMA,
  decompose, compose, holtWintersFit, holtWintersForecast, holtWinters,
  trendSlope, styleLabel, Z95,
} from '../src/core/stats.js';
import { synthSeries, q } from '../src/core/generator.js';

test('SMA 手算：[1,2,3,4,5] k=3 → [null,null,2,3,4]', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  // 前 k−1 期必须是 null 而不是 0（0 会被图表和图线当成真实预测值）
  assert.equal(sma([1, 2, 3, 4, 5], 3)[1], null);
  assert.throws(() => sma([1, 2, 3], 4), /大于序列长度/);
  assert.throws(() => sma([1, 2, 3], 0), /需为 >=1 的整数/);
});

test('WMA 线性加权手算：[1,2,3] k=3 → (1·1+2·2+3·3)/6 = 14/6', () => {
  assert.equal(wma([1, 2, 3], 3)[2], 14 / 6);
  // 近期权重更高 → 在上涨序列上 WMA 必须 > SMA（这就是它“更灵敏”的量化证据）
  const up = [1, 2, 3, 4, 5, 6];
  assert.ok(wma(up, 3)[5] > sma(up, 3)[5]);
  assert.equal(wma([5, 5, 5], 2)[1], 5, '常数序列上 WMA 应等于该常数');
});

test('movingAverage 分派与未知方法报错', () => {
  assert.deepEqual(movingAverage([1, 2, 3], { method: 'sma', k: 2 }), sma([1, 2, 3], 2));
  assert.deepEqual(movingAverage([1, 2, 3], { method: 'wma', k: 2 }), wma([1, 2, 3], 2));
  assert.throws(() => movingAverage([1, 2, 3], { method: 'ema' }), /未知方法/);
});

test('findPeaks / findTroughs 手算', () => {
  const v = [1, 3, 2, 5, 4, 1, 2, 6, 2];
  assert.deepEqual(findPeaks(v), [1, 3, 7]);
  assert.deepEqual(findTroughs(v), [2, 5]);
});

test('peakLag 量化平滑线的滞后：右移 2 期的序列必须报滞后 2 期', () => {
  const actual = [1, 2, 3, 2, 1, 2, 3, 4, 5, 4, 3, 2];
  const smoothed = [null, null, ...actual.slice(0, 10)]; // 右移 2 期
  const r = peakLag(actual, smoothed);
  assert.equal(r.pairs.length, 2);
  assert.ok(r.pairs.every((p) => p.lag === 2), `每对滞后都应为 2，实际 ${JSON.stringify(r.pairs)}`);
  assert.equal(r.meanLag, 2);
  // 负向对照：不平移时滞后必须为 0，否则说明 peakLag 恒返回某个非零值
  assert.equal(peakLag(actual, actual).meanLag, 0);
});

test('centeredMA：奇周期简单居中平均 / 偶周期 2×m 加权', () => {
  const odd = centeredMA([1, 2, 4, 5, 8], 3);
  assert.deepEqual(odd, [null, 7 / 3, 11 / 3, 17 / 3, null]);
  // 偶周期 2×4：t=2 → (0.5·11 + 11 + 15 + 15 + 0.5·19)/4
  const even = centeredMA([11, 11, 15, 15, 19, 19, 23, 23], 4);
  assert.equal(even[2], (0.5 * 11 + 11 + 15 + 15 + 0.5 * 19) / 4);
  assert.equal(even[2], 14);
  assert.equal(even[5], 20);
  assert.equal(even[0], null, '首尾缺窗必须是 null');
});

test('decompose 加法：线性趋势 + 周期 4 季节应被精确还原，残差为 0', () => {
  const values = [11, 11, 15, 15, 19, 19, 23, 23]; // = 10+2t + [1,−1,1,−1]
  const d = decompose(values, { mode: 'additive', period: 4 });
  assert.deepEqual(d.trend, [null, null, 14, 16, 18, 20, null, null]);
  assert.deepEqual(d.seasonal.map((s) => Number(s.toFixed(12))), [1, -1, 1, -1]);
  assert.ok(d.seasonal.reduce((a, b) => a + b, 0) === 0 || Math.abs(d.seasonal.reduce((a, b) => a + b, 0)) < 1e-12,
    '加法模型的季节指数必须归一到和 = 0');
  const inner = d.residual.slice(2, 6);
  assert.ok(inner.every((r) => Math.abs(r) < 1e-12), `内点残差应全为 0，实际 ${inner}`);
  assert.equal(d.trendSlope, 2);
  assert.equal(d.seasonalAmp, 2);
  assert.ok(d.noiseStd < 1e-12);
});

test('decompose 的季节项归一：和 = 0（加法）/ 均值 = 1（乘法）', () => {
  const add = decompose(compose({ base: 1000, trend: 5, seasonality: 40, n: 48 }), { mode: 'additive' });
  assert.ok(Math.abs(add.seasonal.reduce((a, b) => a + b, 0)) < 1e-9);
  const val = [1010, 990, 1010, 990, 1050, 1030, 1050, 1030, 1090, 1070, 1090, 1070,
    1130, 1110, 1130, 1110, 1170, 1150, 1170, 1150, 1210, 1190, 1210, 1190];
  const mul = decompose(val, { mode: 'multiplicative', period: 4 });
  const mean = mul.seasonal.reduce((a, b) => a + b, 0) / 4;
  assert.ok(Math.abs(mean - 1) < 1e-9, `乘法季节指数均值应为 1，实际 ${mean}`);
});

test('decompose 拒绝数据不足与含零的乘法场景（而不是给出垃圾结果）', () => {
  assert.throws(() => decompose([1, 2, 3, 4], { period: 4 }), /至少需要 8 期/);
  assert.throws(() => decompose([0, 1, 2, 3, 4, 5, 6, 7], { mode: 'multiplicative', period: 4 }), /全部为正数/);
});

test('trendSlope 用最小二乘读斜率（不是首尾差分，且忽略 null）', () => {
  assert.equal(trendSlope([null, 1, 2, 3, 4, 5, null]), 1);
  assert.equal(trendSlope([5, 5, 5]), 0);
  // null 必须被跳过：(0,1)(1,2)(3,4)(4,5) → 斜率 1
  assert.equal(trendSlope([1, 2, null, 4, 5]), 1);
  // 与「首尾差分」明确区分：末点爆冲让差分 = 1.8，而最小二乘斜率是 22.5/17.5
  const spike = [1, 1, 1, 1, 1, 10];
  assert.equal(trendSlope(spike).toFixed(12), (22.5 / 17.5).toFixed(12));
  assert.notEqual(trendSlope(spike).toFixed(6), (9 / 5).toFixed(6));
});

test('compose 与 synthSeries 两条独立实现在加法模式下必须逐位一致', () => {
  const s = synthSeries({ n: 36, base: 1000, trend: 3, seasonality: 25, noise: 7, seed: 99 });
  const c = compose({ n: 36, base: 1000, trend: 3, seasonality: 25, noise: 7, seedSeries: s.components.noise });
  for (let i = 0; i < 36; i++) {
    assert.equal(c[i], s.values[i], `第 ${i} 期不一致：compose=${c[i]} synthSeries=${s.values[i]}`);
  }
});

test('季节项输出量化到 1e-12（跨引擎一致性），而未量化的值不满足该性质', () => {
  const c = compose({ n: 12, base: 1000, trend: 0, seasonality: 20, noise: 0 });
  for (const v of c) {
    const scaled = v * 1e12;
    assert.ok(Math.abs(scaled - Math.round(scaled)) < 1e-6, `${v} 不是 1e-12 的整数倍`);
  }
  // 负向对照：未量化的 Math.sin 结果通常不满足（否则上面的断言无意义）
  const raw = 20 * Math.sin((2 * Math.PI * 1) / 12);
  const rawScaled = raw * 1e12;
  assert.ok(Math.abs(rawScaled - Math.round(rawScaled)) > 1e-6, '未量化值竟然也是 1e-12 整数倍，量化断言失去意义');
  assert.equal(q(raw) * 1e12, Math.round(q(raw) * 1e12));
});

test('holtWinters 常数序列：水平保持不变、外推也保持不变', () => {
  const fit = holtWintersFit([5, 5, 5, 5], { alpha: 0.5, beta: 0, gamma: 0, seasonal: false });
  assert.deepEqual(fit.fitted, [null, 5, 5, 5]);
  assert.equal(fit.state.level, 5);
  assert.equal(fit.state.trend, 0);
  assert.equal(fit.sigma, 0);
  const fc = holtWintersForecast(fit, 3);
  assert.deepEqual(fc.mean, [5, 5, 5]);
  assert.deepEqual(fc.lower, [5, 5, 5], 'σ=0 时区间应退化为点预测');
});

test('holtWinters 手算极小样本（α=1, β=1, φ=0.5）验证阻尼外推公式', () => {
  const fit = holtWintersFit([10, 20], { alpha: 1, beta: 1, gamma: 0, phi: 0.5, seasonal: false });
  assert.deepEqual(fit.fitted, [null, 10]);
  assert.equal(fit.state.level, 20);
  assert.equal(fit.state.trend, 10);
  const fc = holtWintersForecast(fit, 2);
  // cumPhi: 0.5 → 0.75
  assert.equal(fc.mean[0], 25);
  assert.equal(fc.mean[1], 27.5);
  // 阻尼必须让外推收敛：φ<1 时步长递减
  assert.ok(fc.mean[1] - fc.mean[0] < fc.mean[0] - 20, 'φ<1 的外推增量应递减');
});

test('holtWinters 在上升趋势上外推上行；φ=1 与 φ<1 的差别可量化', () => {
  const up = Array.from({ length: 30 }, (_, t) => 500 + 12 * t);
  const a = holtWinters(up, { alpha: 0.6, beta: 0.4, gamma: 0, phi: 1, seasonal: false }, 6);
  const b = holtWinters(up, { alpha: 0.6, beta: 0.4, gamma: 0, phi: 0.7, seasonal: false }, 6);
  assert.ok(a.forecast.mean[5] > up[29], 'φ=1 时应继续线性外推');
  assert.ok(b.forecast.mean[5] < a.forecast.mean[5], 'φ<1 的阻尼必须比 φ=1 更保守');
  assert.ok(a.forecast.lower[5] < a.forecast.mean[5] && a.forecast.upper[5] > a.forecast.mean[5]);
  // 区间随步长变宽（σ·√h）
  assert.ok((a.forecast.upper[5] - a.forecast.lower[5]) > (a.forecast.upper[0] - a.forecast.lower[0]));
  assert.equal(a.forecast.z, Z95);
});

test('holtWinters 参数越界与季节数据不足必须抛错', () => {
  const v = Array.from({ length: 30 }, (_, t) => 100 + t);
  assert.throws(() => holtWintersFit(v, { alpha: 1.5 }), /alpha 需在 \[0,1\]/);
  assert.throws(() => holtWintersFit(v, { phi: 0 }), /phi 需在 \(0,1\]/);
  assert.throws(() => holtWintersFit(v.slice(0, 10), { period: 12 }), /至少需要 24 期/);
});

test('holtWinters 确定性：同参数同输入必须逐位一致（可复现是教学工具的前提）', () => {
  const v = synthSeries({ n: 48, base: 1000, trend: 4, seasonality: 60, noise: 30, seed: 3 }).values;
  const a = holtWinters(v, { alpha: 0.3, beta: 0.1, gamma: 0.2, phi: 0.98 }, 12);
  const b = holtWinters(v, { alpha: 0.3, beta: 0.1, gamma: 0.2, phi: 0.98 }, 12);
  assert.deepEqual(a.forecast.mean, b.forecast.mean);
  assert.deepEqual(a.fit.fitted, b.fit.fitted);
});

test('styleLabel 覆盖全部四种风格，且描述非空', () => {
  assert.equal(styleLabel({ alpha: 0.9, beta: 0.5, phi: 0.98 }).tag, '敏捷激进型');
  assert.equal(styleLabel({ alpha: 0.9, beta: 0.05, phi: 0.98 }).tag, '灵敏稳健型');
  assert.equal(styleLabel({ alpha: 0.05, beta: 0.5, phi: 0.98 }).tag, '迟钝赶追型');
  assert.equal(styleLabel({ alpha: 0.05, beta: 0.05, phi: 0.98 }).tag, '沉稳抗噪型');
  assert.equal(styleLabel({ alpha: 0.3, beta: 0.1, phi: 0.98 }).tag, '均衡型');
  for (const a of [0.05, 0.3, 0.9]) {
    for (const b of [0.05, 0.5]) {
      assert.ok(styleLabel({ alpha: a, beta: b, phi: 0.9 }).desc.length > 10);
    }
  }
});
