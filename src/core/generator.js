/**
 * generator.js —— 场景数据集生成器 (纯函数，无 DOM 依赖)
 *
 * 设计约束（重要，别改）：
 * 1. 全部序列由「种子 + 参数」决定，同种子必然得到同一序列 —— 测试才能断言精确值。
 * 2. 全程避免 Math.sin/cos/log 直接参与数值构造，改用：
 *    - Irwin–Hall 近似正态（12 个均匀分布之和 − 6，方差恰为 1）替代 Box–Muller；
 *    - 季节/节假日波形输出的 sin 值经 q() 量化到 1e-12。
 *    原因：Math.sin 在 V8 不同版本间存在 1~2 ULP 差异（实测 Math.sin(4π/3) 在
 *    Chrome 152 与 Node V8 14.6 上相差 1 ULP）。若不断言精确值，node --test 的结果
 *    就没法代表浏览器里的结果。量化后两边完全一致。
 */

import { q } from './quantize.js';
import { applyPromo, DEFAULT_PROMOS } from './promo_sim.js';

export { q };

/** mulberry32 —— 32 位种子伪随机数发生器，纯整数运算，跨引擎完全一致。 */
export function makeRng(seed = 42) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Irwin–Hall 近似标准正态：12 个 U(0,1) 之和减 6。
 * 均值 0、方差恰为 1（12 × 1/12），取值范围 [-6, 6]，尾部比真实正态薄。
 * 用于教学演示数据足够，且只用加减法 → 跨引擎逐位一致。
 */
export function standardNormal(rng) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += rng();
  return s - 6;
}

/** 生成 n 期月度标签，如 ['2020-01','2020-02',...]。 */
export function periodLabels(start = '2020-01', n = 72) {
  const m = /^(\d{4})-(\d{2})$/.exec(start);
  if (!m) throw new RangeError(`periodLabels: 起始期格式应为 'YYYY-MM'，收到 ${start}`);
  let year = Number(m[1]);
  let month = Number(m[2]);
  if (month < 1 || month > 12) throw new RangeError(`periodLabels: 月份越界 ${month}`);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return out;
}

/**
 * 合成序列：Y = Trend + A·sin(2πt/12) + Noise  (加法)
 *            Y = Trend · (1 + A·sin/100) · (1 + Noise/100) (乘法)
 *
 * @param {object} o
 * @param {number} o.n          期数，默认 72
 * @param {string} o.start      起始期 'YYYY-MM'，默认 2020-01
 * @param {number} o.trend      趋势斜率（每月增量），默认 2
 * @param {number} o.seasonality 季节振幅 A，默认 20
 * @param {number} o.noise      噪音强度（正态标准差），默认 5
 * @param {number} o.base       基准水平，默认 1000
 * @param {number} o.phase      季节相位（月），默认 0
 * @param {number} o.seed       随机种子
 * @param {'additive'|'multiplicative'} o.mode
 */
export function synthSeries({
  n = 72, start = '2020-01', trend = 2, seasonality = 20, noise = 5,
  base = 1000, phase = 0, seed = 42, mode = 'additive',
} = {}) {
  if (!Number.isInteger(n) || n < 3) throw new RangeError(`synthSeries: n 需为 >=3 的整数，收到 ${n}`);
  if (mode !== 'additive' && mode !== 'multiplicative') {
    throw new RangeError(`synthSeries: mode 只能是 additive / multiplicative，收到 ${mode}`);
  }
  const rng = makeRng(seed);
  const labels = periodLabels(start, n);
  const trendArr = [];
  const seasonalArr = [];
  const noiseArr = [];
  const values = [];

  for (let t = 0; t < n; t++) {
    trendArr.push(t * trend);
    seasonalArr.push(q(seasonality * Math.sin((2 * Math.PI * (t + phase)) / 12)));
    noiseArr.push(standardNormal(rng) * noise);
    if (mode === 'additive') {
      values.push(base + t * trend + seasonalArr[t] + noiseArr[t]);
    } else {
      // 乘法的季节/噪音表达成比例，% 效果
      values.push(base * (1 + t * trend / base) * (1 + seasonalArr[t] / base) * (1 + noiseArr[t] / base));
    }
  }
  return { labels, values, components: { trend: trendArr, seasonal: seasonalArr, noise: noiseArr }, mode };
}

/**
 * 拐点显著的测试序列 —— 专供模块 2（移动平均滞后演示）。
 * 前段平稳上行，中段转跌（模拟产品进入衰退期），后段再度反弹。
 * 拐点位置由参数固定，测试可断言。
 */
export function makeTurningPointSeries({
  n = 36, base = 1000, riseSlope = 30, fallSlope = -45, reboundSlope = 25,
  breakUp = 12, breakDown = 24, noise = 8, seed = 7,
} = {}) {
  const rng = makeRng(seed);
  const labels = periodLabels('2022-01', n);
  const values = [];
  for (let t = 0; t < n; t++) {
    let level;
    if (t < breakUp) level = base + riseSlope * t;
    else if (t < breakDown) level = base + riseSlope * breakUp + fallSlope * (t - breakUp);
    else level = base + riseSlope * breakUp + fallSlope * (breakDown - breakUp) + reboundSlope * (t - breakDown);
    values.push(level + standardNormal(rng) * noise);
  }
  return { labels, values, turningPoints: [breakUp, breakDown] };
}

/**
 * 脏数据注入 —— 专供模块 0（清洗实验）。
 * 返回「干净真值」与「脏序列」两份，让 UI 能画对比图，测试能验证修复效果。
 *
 * ★ 刻意同时注入**两级**异常：
 *   极端爆单（3.2 倍，远超任何 k 的上界）与中等幅度异常（1.2~1.7 倍，正好落在
 *   k 的判定边界之间）。只放极端爆单的话，k 滑杆在 1.5~3.0 全范围内都不会改变
 *   任何判定 —— 计划员拖动滑杆看不到反馈，会以为工具坏了。
 *   真实脏数据本来就是这样：既有大客户一次性团购，也有中等幅度的偶发加单。
 *
 * @param {object} o
 * @param {number[]} o.cleanValues 干净序列
 * @param {number[]} o.spikeIndices 极端爆单位置（乘 spikeFactor 倍）
 * @param {number} o.spikeFactor 极端爆单倍数，默认 3.2
 * @param {Array<{index:number, factor:number}>} o.spikes 中等幅度异常（各自指定倍数）
 * @param {Array<[number,number]>} o.stockoutRuns 缺货断供区间 [起, 止]（闭区间），置 0
 */
export function injectDirty({
  cleanValues, spikeIndices = [], spikeFactor = 3.2, spikes = [], stockoutRuns = [],
} = {}) {
  if (!Array.isArray(cleanValues) || cleanValues.length === 0) {
    throw new RangeError('injectDirty: cleanValues 不能为空');
  }
  const n = cleanValues.length;
  const values = cleanValues.slice();
  for (const i of spikeIndices) {
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new RangeError(`injectDirty: 爆单位置越界 ${i}`);
    values[i] = cleanValues[i] * spikeFactor;
  }
  const moderate = [];
  for (const { index, factor } of spikes) {
    if (!Number.isInteger(index) || index < 0 || index >= n) {
      throw new RangeError(`injectDirty: 中等异常位置越界 ${index}`);
    }
    if (!(factor > 0)) throw new RangeError(`injectDirty: 中等异常倍数需 >0，收到 ${factor}`);
    values[index] = cleanValues[index] * factor;
    moderate.push(index);
  }
  const zeroed = [];
  for (const [s, e] of stockoutRuns) {
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e >= n || s > e) {
      throw new RangeError(`injectDirty: 缺货区间非法 [${s},${e}]（序列长度 ${n}）`);
    }
    for (let i = s; i <= e; i++) { values[i] = 0; zeroed.push(i); }
  }
  const allSpikes = [...new Set([...spikeIndices, ...moderate])].sort((a, b) => a - b);
  return {
    values,
    truth: {
      cleanValues: cleanValues.slice(),
      spikeIndices: allSpikes,
      extremeSpikeIndices: [...spikeIndices],
      moderateSpikeIndices: moderate,
      stockoutRuns: stockoutRuns.map((r) => [...r]),
      zeroed,
    },
  };
}

/**
 * 默认的教学用脏数据集（模块 0）。
 * 2 处极端爆单 + 4 处中等幅度异常 + 2 段缺货（其中一段 3 期连续），并保留干净真值。
 * 中等异常的目标值落在 k 滑杆的判定边界之间，保证 k 在 1.0~3.0 全程都有可观察的反馈。
 */
export function makeCleaningDataset({
  n = 48, base = 1200, trend = 6, seasonality = 180, noise = 90, seed = 2020,
  spikeIndices = [10, 31], stockoutRuns = [[19, 20], [37, 39]],
  moderateSpikes = [
    { index: 6, factor: 1.63 },
    { index: 14, factor: 1.19 },
    { index: 26, factor: 1.20 },
    { index: 40, factor: 1.36 },
  ],
} = {}) {
  const clean = synthSeries({ n, start: '2021-01', base, trend, seasonality, noise, seed });
  const dirty = injectDirty({
    cleanValues: clean.values, spikeIndices, spikeFactor: 3.2, spikes: moderateSpikes, stockoutRuns,
  });
  return { labels: clean.labels, ...dirty, components: clean.components };
}

/**
 * 促销场景序列（模块 4）：自然需求 + 促销脉冲拉升 + 促销后透支低谷。
 *
 * 促销数学**不在这里重复实现** —— 与学习侧（promo_sim.js）共用同一份，
 * 否则生成侧与拟合侧一旦漂移，「学回来对不对」的对照就失去意义。
 */
export function makePromoDataset({
  n = 40, base = 1000, trend = 6, seasonality = 120, noise = 50, seed = 21,
  promos = DEFAULT_PROMOS, kappa = 2.5, eta = 1, lambda = 0.45,
} = {}) {
  const s = synthSeries({ n, start: '2022-01', base, trend, seasonality, noise, seed });
  const r = applyPromo(s.values, { promos, kappa, eta, lambda });
  return {
    labels: s.labels,
    values: r.values,
    natural: r.natural,
    lift: r.lift,
    dip: r.dip,
    promos,
    startMonth: 1, // 数据集从 2022-01 开始 → 首期月份 = 1
    truth: { kappa, eta, lambda, promos },
  };
}

/**
 * 节假日日历（模块 5）：按月给出春节前/春节后/中秋/国庆/双11 的脉冲标记。
 * 由于农历日期每年变动，这里用固定表（真实项目中应接节假日字典）。
 * @returns {{cnyPre:number[], cnyPost:number[], midAutumn:number[], national:number[], double11:number[]}}
 */
export function holidayCalendar() {
  // 索引 = 月份 (0=1月 ... 11=12月)
  return {
    cnyPre: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],       // 1 月节前压货
    cnyPost: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],      // 2 月节后回落
    midAutumn: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],    // 9 月中秋
    national: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],     // 10 月国庆
    double11: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],     // 11 月双 11
  };
}

/**
 * 带节假日效应的年度序列（模块 5）：趋势 + 年度周期 + 节假日脉冲。
 * 用于演示 Prophet 的加性组件拆解。
 */
export function makeHolidayDataset({
  n = 72, start = '2020-01', base = 1000, trend = 5, noise = 60, seed = 5,
  holidayEffects = { cnyPre: 0.24, cnyPost: -0.1, midAutumn: 0.12, national: 0.08, double11: 0.09 },
} = {}) {
  const rng = makeRng(seed);
  const labels = periodLabels(start, n);
  const cal = holidayCalendar();
  const trendArr = [];
  const yearlyArr = [];
  const holidayArr = [];
  const values = [];
  for (let t = 0; t < n; t++) {
    const monthIdx = (Number(labels[t].slice(5, 7)) - 1);
    const tr = base + t * trend;
    // 年度周期：用 cos → 1 月最高、7 月最低（冬春旺、盛夏淡），符合快消常规
    const yearly = q(0.13 * base * Math.cos((2 * Math.PI * monthIdx) / 12));
    let hol = 0;
    for (const [key, eff] of Object.entries(holidayEffects)) {
      if (cal[key] && cal[key][monthIdx]) hol += eff * base;
    }
    const nz = standardNormal(rng) * noise;
    trendArr.push(tr); yearlyArr.push(yearly); holidayArr.push(hol);
    values.push(tr + yearly + hol + nz);
  }
  return { labels, values, holidayEffects, components: { trend: trendArr, yearly: yearlyArr, holiday: holidayArr } };
}
