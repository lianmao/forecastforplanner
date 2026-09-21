/**
 * stats.js —— 传统统计预测：拆解/合成、移动平均、阻尼三次指数平滑 (纯函数，无 DOM 依赖)
 *
 * ★ 一处必须说清的诚实边界（别在文档里吹成精确）：
 *   本文件的 Holt-Winters 用「固定初始状态 + 用户给定 α/β/γ/φ」递推。
 *   statsmodels 的 ExponentialSmoothing 会**联合最优化初始状态与平滑参数**，
 *   因此本实现不可能逐位复现 statsmodels 的拟合值。可复现的只有：
 *     - 用户显式给定参数时的递推公式本身（逐位精确，测试会断言）；
 *     - 与 statsmodels 同参数下的量级一致（RMSE 同阶）。
 *   任何「与 Python 完全一致」的说法对这个模块都不成立。
 */

import { q } from './quantize.js';

/** 95% 正态双侧分位点（Φ⁻¹(0.975)），用于置信区间。 */
export const Z95 = 1.959963984540054;

/* ────────────────────────── 移动平均 ────────────────────────── */

/**
 * 简单移动平均 SMA：窗口内 k 期等权。前 k−1 期为 null（无足够历史）。
 * 注意这是「单侧」移动平均（只用过去），不是居中移动平均 ——
 * 用于预测时只能用过去，这也是它产生滞后的根源。
 */
export function sma(values, k) {
  assertSeries(values, 'sma');
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`sma: 窗口 k 需为 >=1 的整数，收到 ${k}`);
  if (k > values.length) throw new RangeError(`sma: 窗口 k=${k} 大于序列长度 ${values.length}`);
  const out = new Array(values.length).fill(null);
  for (let i = k - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - k + 1; j <= i; j++) s += values[j];
    out[i] = s / k;
  }
  return out;
}

/**
 * 线性加权移动平均 WMA：权重 1..k，最近一期权重最大（w = k / (k(k+1)/2)）。
 * k=1 时退化为原始序列。
 */
export function wma(values, k) {
  assertSeries(values, 'wma');
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`wma: 窗口 k 需为 >=1 的整数，收到 ${k}`);
  if (k > values.length) throw new RangeError(`wma: 窗口 k=${k} 大于序列长度 ${values.length}`);
  const wsum = (k * (k + 1)) / 2;
  const out = new Array(values.length).fill(null);
  for (let i = k - 1; i < values.length; i++) {
    // 先累加加权分子、最后一次除以权重和 —— 逐个除以 wsum 会多一次舍入，
    // [1,2,3] 上就会算成 2.333333333333333 而不是精确的 14/6 = 2.3333333333333335。
    let s = 0;
    for (let j = 0; j < k; j++) {
      // j=0 是最早的一期，权重最低
      s += (j + 1) * values[i - k + 1 + j];
    }
    out[i] = s / wsum;
  }
  return out;
}

export const MOVING_AVERAGE_METHODS = ['sma', 'wma'];
export function movingAverage(values, { method = 'sma', k = 3 } = {}) {
  if (method === 'sma') return sma(values, k);
  if (method === 'wma') return wma(values, k);
  throw new RangeError(`movingAverage: 未知方法 ${method}（可选 ${MOVING_AVERAGE_METHODS.join('/')}）`);
}

/* ────────────────────────── 拐点与滞后 ────────────────────────── */

/** 局部峰值位置：严格高于左邻且不低于右邻（右平顶取第一次出现的点，避免重复计峰）。 */
export function findPeaks(values) {
  assertSeries(values, 'findPeaks');
  const peaks = [];
  for (let i = 1; i < values.length - 1; i++) {
    if (values[i] > values[i - 1] && values[i] >= values[i + 1]) peaks.push(i);
  }
  return peaks;
}

/** 局部谷值位置（用于把“拐点”讲全）。 */
export function findTroughs(values) {
  assertSeries(values, 'findTroughs');
  const troughs = [];
  for (let i = 1; i < values.length - 1; i++) {
    if (values[i] < values[i - 1] && values[i] <= values[i + 1]) troughs.push(i);
  }
  return troughs;
}

/**
 * 平滑线相对实际线的滞后。
 * 对每个实际峰值，向右寻找「实际峰之后第一个平滑峰值」，差值即滞后（期）。
 * 平滑线的前 k−1 期为 null，需跳过。
 * @returns {{pairs: Array<{actualIndex:number, smoothedIndex:number, lag:number}>, meanLag:number|null}}
 */
export function peakLag(actual, smoothed) {
  assertSeries(actual, 'peakLag');
  if (!Array.isArray(smoothed) || smoothed.length !== actual.length) {
    throw new RangeError('peakLag: 平滑序列长度需与实际一致');
  }
  const ap = findPeaks(actual);
  // 平滑序列头部 k−1 期为 null（窗口不足）。峰值扫描必须**跳过非有限值**，
  // 不能把它替换成 -Infinity 之类的哨兵值再交给 findPeaks —— 那会被
  // assertSeries 直接拒绝（这个 bug 就是被测试抓出来的）。
  const sp = [];
  for (let i = 1; i < smoothed.length - 1; i++) {
    const c = smoothed[i];
    const l = smoothed[i - 1];
    const r = smoothed[i + 1];
    if (!Number.isFinite(c) || !Number.isFinite(l) || !Number.isFinite(r)) continue;
    if (c > l && c >= r) sp.push(i);
  }
  const pairs = [];
  for (const a of ap) {
    const s = sp.find((x) => x >= a);
    if (s !== undefined) pairs.push({ actualIndex: a, smoothedIndex: s, lag: s - a });
  }
  return {
    pairs,
    meanLag: pairs.length ? pairs.reduce((s, p) => s + p.lag, 0) / pairs.length : null,
  };
}

/* ────────────────────────── 时序拆解 / 合成 ────────────────────────── */

/** 居中移动平均（偶周期用 2×m 加权，首尾各缺 m 期 → null）。 */
export function centeredMA(values, period) {
  assertSeries(values, 'centeredMA');
  if (!Number.isInteger(period) || period < 2) throw new RangeError(`centeredMA: period 需 >=2，收到 ${period}`);
  const n = values.length;
  const out = new Array(n).fill(null);
  const m = Math.floor(period / 2);
  if (period % 2 === 1) {
    for (let t = m; t < n - m; t++) {
      let s = 0;
      for (let j = -m; j <= m; j++) s += values[t + j];
      out[t] = s / period;
    }
  } else {
    for (let t = m; t < n - m; t++) {
      let s = 0.5 * values[t - m] + 0.5 * values[t + m];
      for (let j = -m + 1; j <= m - 1; j++) s += values[t + j];
      out[t] = s / period;
    }
  }
  return out;
}

/**
 * 经典时序拆解。
 *   加法：Y = T + S + R   → 去趋势用减法，季节指数归一到均值 0
 *   乘法：Y = T × S × R   → 去趋势用除法，季节指数归一到均值 1
 * @returns {{trend:(number|null)[], seasonal:number[], residual:(number|null)[], seasonalSeries:(number|null)[],
 *            mode:string, period:number, trendSlope:number|null, seasonalAmp:number, noiseStd:number}}
 */
export function decompose(values, { mode = 'additive', period = 12 } = {}) {
  assertSeries(values, 'decompose');
  if (mode !== 'additive' && mode !== 'multiplicative') {
    throw new RangeError(`decompose: mode 只能是 additive / multiplicative，收到 ${mode}`);
  }
  if (values.length < 2 * period) {
    throw new RangeError(`decompose: 至少需要 ${2 * period} 期（2 个完整周期）才能识别季节，当前 ${values.length} 期`);
  }
  if (mode === 'multiplicative' && values.some((v) => v <= 0)) {
    throw new RangeError('decompose: 乘法模型要求全部为正数（存在 0 或负值，常见于缺货归零，请先清洗）');
  }
  const n = values.length;
  const trend = centeredMA(values, period);

  // 去趋势 → 按周期位置求平均 → 归一
  const buckets = Array.from({ length: period }, () => []);
  for (let t = 0; t < n; t++) {
    if (trend[t] === null) continue;
    const detrended = mode === 'additive' ? values[t] - trend[t] : values[t] / trend[t];
    buckets[t % period].push(detrended);
  }
  let seasonal = buckets.map((b) => (b.length ? b.reduce((a, c) => a + c, 0) / b.length : 0));
  const mean = seasonal.reduce((a, c) => a + c, 0) / period;
  if (mode === 'additive') seasonal = seasonal.map((s) => s - mean);
  else seasonal = seasonal.map((s) => (mean === 0 ? 1 : s / mean));

  const seasonalSeries = new Array(n).fill(null);
  const residual = new Array(n).fill(null);
  for (let t = 0; t < n; t++) {
    seasonalSeries[t] = seasonal[t % period];
    if (trend[t] === null) continue;
    residual[t] = mode === 'additive'
      ? values[t] - trend[t] - seasonalSeries[t]
      : values[t] / (trend[t] * seasonalSeries[t]);
  }
  const res = residual.filter((r) => r !== null);
  const resMean = res.reduce((a, c) => a + c, 0) / res.length;
  const noiseStd = res.length > 1
    ? Math.sqrt(res.reduce((a, c) => a + (c - resMean) ** 2, 0) / (res.length - 1))
    : 0;

  return {
    trend,
    seasonal,
    residual,
    seasonalSeries,
    mode,
    period,
    trendSlope: trendSlope(trend),
    seasonalAmp: Math.max(...seasonal) - Math.min(...seasonal),
    noiseStd,
  };
}

/**
 * 从已估的趋势线读斜率（件/月）。
 * 用最小二乘拟合非 null 点 —— 不能用「首尾差分」，那会被端点噪音放大。
 */
export function trendSlope(trend) {
  const pts = [];
  trend.forEach((v, t) => { if (v !== null) pts.push([t, v]); });
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den === 0 ? null : num / den;
}

/**
 * 即时合成（模块 1 的滑杆驱动方向）：由三个分量参数生成序列。
 * 与 generator.synthSeries 是两条独立实现 —— 测试会对照两者在加法下的一致性。
 */
export function compose({ base = 1000, trend = 2, seasonality = 20, noise = 5, n = 72, mode = 'additive', seedSeries = null }) {
  if (!Number.isInteger(n) || n < 3) throw new RangeError(`compose: n 需 >=3，收到 ${n}`);
  const noiseArr = seedSeries || new Array(n).fill(0);
  const out = [];
  for (let t = 0; t < n; t++) {
    const tr = base + t * trend;
    const sn = q(seasonality * Math.sin((2 * Math.PI * t) / 12));
    if (mode === 'additive') out.push(tr + sn + noiseArr[t]);
    else out.push(tr * (1 + sn / base) * (1 + noiseArr[t] / base));
  }
  return out;
}

/* ────────────────────────── 阻尼 Holt-Winters ────────────────────────── */

/**
 * 三次指数平滑（Holt-Winters），带阻尼趋势 φ。
 *
 * 递推（加法季节）：
 *   L_t = α(Y_t − S_{t−m}) + (1−α)(L_{t−1} + φT_{t−1})
 *   T_t = β(L_t − L_{t−1}) + (1−β)φT_{t−1}
 *   S_t = γ(Y_t − L_{t−1} − φT_{t−1}) + (1−γ)S_{t−m}
 * 一步预测： Ŷ_t = L_{t−1} + φT_{t−1} + S_{t−m}
 *
 * 初始状态：用前两个完整季节估水平/趋势/季节指数（标准做法，非最优但可解释）。
 *
 * @param {number[]} values
 * @param {object} o
 * @param {number} o.alpha 水平平滑系数 (0,1)
 * @param {number} o.beta  趋势平滑系数 [0,1]
 * @param {number} o.gamma 季节平滑系数 [0,1]，纯趋势场景可传 0
 * @param {number} o.phi   阻尼系数 (0,1]
 * @param {number} o.period 季节周期
 * @param {boolean} o.seasonal 是否启用季节项
 */
export function holtWintersFit(values, {
  alpha = 0.3, beta = 0.1, gamma = 0.2, phi = 0.98, period = 12, seasonal = true,
} = {}) {
  assertSeries(values, 'holtWintersFit');
  for (const [nm, v] of [['alpha', alpha], ['beta', beta], ['gamma', gamma]]) {
    if (!(v >= 0 && v <= 1)) throw new RangeError(`holtWintersFit: ${nm} 需在 [0,1]，收到 ${v}`);
  }
  if (!(phi > 0 && phi <= 1)) throw new RangeError(`holtWintersFit: phi 需在 (0,1]，收到 ${phi}`);
  if (seasonal) {
    if (!Number.isInteger(period) || period < 2) throw new RangeError(`holtWintersFit: period 需 >=2，收到 ${period}`);
    if (values.length < 2 * period) {
      throw new RangeError(`holtWintersFit: 启用季节项时至少需要 ${2 * period} 期，当前 ${values.length} 期`);
    }
  }
  const n = values.length;
  const m = period;

  // ── 初始状态 ──
  let level;
  let trend;
  const seas = new Array(m).fill(0);
  if (seasonal) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < m; i++) { s1 += values[i]; s2 += values[i + m]; }
    const mean1 = s1 / m;
    const mean2 = s2 / m;
    level = mean1;
    trend = (mean2 - mean1) / m;
    for (let i = 0; i < m; i++) seas[i] = values[i] - mean1;
  } else {
    level = values[0];
    trend = n > 1 ? values[1] - values[0] : 0;
  }

  const fitted = new Array(n).fill(null);
  const L = new Array(n).fill(null);
  const T = new Array(n).fill(null);
  let S = seas.slice();

  for (let t = 0; t < n; t++) {
    const sIdx = seasonal ? (t % m) : 0;
    const sea = seasonal ? S[sIdx] : 0;
    // 一步预测（用 t−1 时刻的状态），t=0 无历史 → null
    if (t > 0) fitted[t] = L[t - 1] + phi * T[t - 1] + (seasonal ? S[sIdx] : 0);

    const prevL = level;
    const newL = alpha * (values[t] - sea) + (1 - alpha) * (level + phi * trend);
    const newT = beta * (newL - prevL) + (1 - beta) * phi * trend;
    if (seasonal) S[sIdx] = gamma * (values[t] - newL) + (1 - gamma) * sea;
    level = newL;
    trend = newT;
    L[t] = level;
    T[t] = trend;
  }

  const residuals = fitted.map((f, i) => (f === null ? null : values[i] - f));
  const res = residuals.filter((r) => r !== null);
  const rMean = res.reduce((a, c) => a + c, 0) / res.length;
  const sigma = res.length > 1
    ? Math.sqrt(res.reduce((a, c) => a + (c - rMean) ** 2, 0) / (res.length - 1))
    : 0;

  return {
    fitted,
    level: L,
    trend: T,
    seasonalIdx: S.slice(),
    residuals,
    sigma,
    params: { alpha, beta, gamma, phi, period, seasonal },
    state: { level, trend, seasonal: S.slice() },
  };
}

/**
 * 未来 h 期外推（含阻尼）。
 *   Ŷ_{t+h} = L_t + (φ + φ² + … + φ^h)·T_t + S_{t+h−m}
 * 置信区间：σ_h = σ·√h。
 * ⚠️ 这是教学用简化式（误差按 √h 扩散），不是 statsmodels 的精确预测方差公式。
 */
export function holtWintersForecast(fit, h = 12, { z = Z95 } = {}) {
  if (!Number.isInteger(h) || h < 1) throw new RangeError(`holtWintersForecast: h 需 >=1，收到 ${h}`);
  const { state, sigma, params } = fit;
  const m = params.period;
  const n = fit.fitted.length;
  const mean = [];
  const lower = [];
  const upper = [];
  let cumPhi = 0;
  let phiPow = 1;
  for (let k = 1; k <= h; k++) {
    phiPow *= params.phi;
    cumPhi += phiPow;
    const sea = params.seasonal ? state.seasonal[(n + k - 1) % m] : 0;
    const yhat = state.level + cumPhi * state.trend + sea;
    const sig = sigma * Math.sqrt(k);
    mean.push(yhat);
    lower.push(yhat - z * sig);
    upper.push(yhat + z * sig);
  }
  return { mean, lower, upper, sigma, z };
}

/** 便捷入口：拟合 + 外推一次返回，UI 直接消费。 */
export function holtWinters(values, params = {}, h = 12) {
  const fit = holtWintersFit(values, params);
  const fc = holtWintersForecast(fit, h);
  return { fit, forecast: fc };
}

/**
 * 模型风格标签（模块 3 的“风格仪表卡”）。
 * 依据 α/β 组合给出业务化的人话描述 —— 这是教学工具的价值点，别删。
 */
export function styleLabel({ alpha, beta, phi }) {
  const a = alpha > 0.6 ? 'high' : alpha < 0.15 ? 'low' : 'mid';
  const b = beta > 0.4 ? 'high' : 'low';
  const damped = phi < 0.92;
  if (a === 'high' && b === 'high') {
    return { tag: '敏捷激进型', desc: '紧跟最新波动、快速改判趋势 —— 对市场拐点敏感，但容易把偶发订单当成大势，预测曲线“追涨杀跌”。' };
  }
  if (a === 'high') {
    return { tag: '灵敏稳健型', desc: '水平跟得快、趋势改得慢 —— 适合“整体水平在变但长期方向未变”的产品。' };
  }
  if (a === 'low' && b === 'high') {
    return { tag: '迟钝赶追型', desc: '水平动得慢、趋势却敢改 —— 组合最不推荐，容易出现“拐点后还要飘一段”的反向错误。' };
  }
  if (a === 'low') {
    return { tag: '沉稳抗噪型', desc: '大惯性、抗偶发干扰 —— 适合成熟稳定期 SKU，代价是对真实拐点反应迟滞。' };
  }
  return { tag: '均衡型', desc: '水平与趋势的中庸权重，多数成熟 SKU 的安全起点。' };
}

function assertSeries(values, fn) {
  if (!Array.isArray(values) || values.length === 0) throw new RangeError(`${fn}: 序列为空`);
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new RangeError(`${fn}: 第 ${i} 期非有限数值 (${values[i]})`);
  }
}
