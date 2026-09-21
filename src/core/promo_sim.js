/**
 * promo_sim.js —— 促销/折扣特征工程与响应模型 (纯函数，无 DOM 依赖)
 *
 * 这一层刻意做成「真拟合」而不是画一条好看的假曲线：
 *   ① 生成侧（applyPromo）：用已知参数 κ、λ 造出带促销拉升与透支低谷的数据；
 *   ② 学习侧（fitPromoModel）：用最小二乘从数据里**把 κ 学回来**；
 *   ③ UI 把「学回的折扣系数」和「真实 κ」并排显示 —— 计划员能直接看到
 *      「模型有没有学到东西」，而不是看一个不可证伪的重要性条形图。
 *
 * ★ 特征工程的关键设计（这是模块 4 真正的教学点）：
 *   促销拉增量是「折扣深度 × 当前量级」的**交互项**，不是加性特征。
 *   ΔY ≈ κ·(1−d)·Y_base  →  特征应取 (1−d)×Lag1，而不是把 (1−d) 当独立一列。
 *   用加性特征去拟合乘性效应，模型会把促销效应错误地摊到 lag1 上。
 */

import { ols } from './linalg.js';
import { q } from './quantize.js';

/** 促销拉升系数：Lift = 1 + κ·(1−d)^η。d=0.8 表示八折（让利 20%）。 */
export function liftFactor({ discount, kappa = 2.5, eta = 1 }) {
  if (!(discount > 0 && discount <= 1)) throw new RangeError(`liftFactor: 折扣需在 (0,1]，收到 ${discount}`);
  if (!(kappa >= 0)) throw new RangeError(`liftFactor: κ 需 >=0，收到 ${kappa}`);
  if (!(eta > 0)) throw new RangeError(`liftFactor: η 需 >0，收到 ${eta}`);
  return 1 + kappa * Math.pow(1 - discount, eta);
}

/**
 * 促销全效应：当期拉升 + 后续两期透支。
 *   ΔY_lift(i) = (Lift − 1)·Y_natural(i)
 *   ΔY_dip(i+1) = −λ·ΔY_lift ,  ΔY_dip(i+2) = −λ/2·ΔY_lift
 * 透支的存在是「促销期过后必须下调备货」这句话的数学依据。
 */
export function promoEffect({ base, discount, kappa = 2.5, eta = 1, lambda = 0.45 }) {
  const lf = liftFactor({ discount, kappa, eta });
  const liftQty = (lf - 1) * base;
  return {
    liftFactor: lf,
    liftQty,
    dips: [-lambda * liftQty, -(lambda / 2) * liftQty],
    lambda,
  };
}

/**
 * 把多个促销事件施加到自然需求序列上。
 * @param {number[]} natural 自然需求（无促销）
 * @param {object} o
 * @param {Array<{index:number, discount:number}>} o.promos 促销事件
 * @returns {{values:number[], lift:Array, dip:Array, natural:number[]}}
 */
export function applyPromo(natural, {
  promos = [], kappa = 2.5, eta = 1, lambda = 0.45,
} = {}) {
  if (!Array.isArray(natural) || natural.length === 0) throw new RangeError('applyPromo: natural 序列为空');
  const n = natural.length;
  const values = natural.slice();
  const lift = [];
  const dip = [];
  for (const { index, discount } of promos) {
    if (!Number.isInteger(index) || index < 0 || index >= n) {
      throw new RangeError(`applyPromo: 促销位置越界 ${index}（序列长度 ${n}）`);
    }
    const eff = promoEffect({ base: natural[index], discount, kappa, eta, lambda });
    values[index] += eff.liftQty;
    lift.push({ index, discount, factor: eff.liftFactor, delta: eff.liftQty });
    for (let k = 1; k <= 2; k++) {
      const idx = index + k;
      if (idx >= n) continue;
      const d = eff.dips[k - 1];
      values[idx] += d;
      dip.push({ index: idx, delta: d, from: index });
    }
  }
  return { values, lift, dip, natural: natural.slice() };
}

/**
 * 默认促销安排：8 次、折扣力度横跨 5 折~95 折。
 *
 * ★ 这是**实测标定**出来的设计，不是随手编的：
 *   折扣弹性 κ 只有在「折扣力度有足够变化」时才可识别。强度交互项
 *   (1−d)×Lag1 与 Lag1 本身高度共线，促销次数少或折扣雷同时，
 *   最小二乘会把效应任意摊到 Lag1 上 —— 实测（8 个种子）：
 *     4 次促销、折扣雷同 → κ 还原相对误差平均 20.5%，最差 41.0%
 *     6 次促销、区间翻倍 → 28.5%（更差：6 个参数抢 6 个点）
 *     8 次促销、折扣 5 折~95 折 → 6.7%，最差 16.2%   ← 采用
 *    10 次促销          → 9.5%（促销太密，透支期与下一次促销互相污染）
 *   结论：真实项目里想估促销弹性，历史里至少要有**若干次力度不同的**促销，
 *   否则不是模型不行，是数据里根本没这个信息。
 */
export const DEFAULT_PROMOS = [
  { index: 4, discount: 0.95 },
  { index: 8, discount: 0.6 },
  { index: 13, discount: 0.85 },
  { index: 17, discount: 0.5 },
  { index: 21, discount: 0.75 },
  { index: 26, discount: 0.55 },
  { index: 30, discount: 0.9 },
  { index: 34, discount: 0.7 },
];

export const PROMO_FEATURE_NAMES = [
  'Lag1 上期实际',
  'Lag2 上上期实际',
  'Promo 促销标志',
  'Promo×Lag1 折扣强度交互',
  'Month_sin 年度正弦',
  'Month_cos 年度余弦',
  'Holiday 节假日标志',
];

/** 交互项在特征表里的名字（用名字找位置，别硬编码下标）。 */
export const INTERACTION_NAME = 'Promo×Lag1 折扣强度交互';

/** 单行特征构造（训练与预测必须走同一条路径，否则就是经典的静默不一致 bug）。 */
export function featureVector({ lag1, lag2, discount, monthIdx, hol = 0, period = 12 }) {
  return [
    lag1,
    lag2,
    discount === null ? 0 : 1,
    discount === null ? 0 : (1 - discount) * lag1,
    q(Math.sin((2 * Math.PI * monthIdx) / period)),
    q(Math.cos((2 * Math.PI * monthIdx) / period)),
    hol,
  ];
}

/**
 * 构造监督学习特征矩阵（时序 → 监督学习的关键一步）。
 * 每行对应一个「被预测期」i（从 i=2 起，因为需要 lag1/lag2）。
 *
 * ★ 全样本恒定的列会被**自动剔除**并记入 dropped，而不是直接抛错：
 *   例：历史里一次促销都没有时，Promo 标志与折扣交互列恒为 0，
 *   模型确实无法估计促销效应 —— 这是事实，应当如实回报（recoveredKappa = null），
 *   而不是让整个模块崩掉。底层 ols() 对常量列仍然是硬拒绝（见 linalg.js）。
 *
 * @param {number[]} values 历史实际（含促销）
 * @param {object} o
 * @param {number} o.startMonth 首期月份（1-12），用于年度周期项
 * @param {number} o.period 月度周期，默认 12
 * @param {Array<{index:number,discount:number}>} o.promos 促销事件
 * @param {(monthIdx:number)=>number} o.holidayOf 月份 → 节假日标志（0/1）
 */
export function buildFeatureMatrix(values, {
  startMonth = 1, period = 12, promos = [], holidayOf = null,
} = {}) {
  if (!Array.isArray(values) || values.length < 3) throw new RangeError('buildFeatureMatrix: 至少需要 3 期数据');
  const promoMap = new Map(promos.map((p) => [p.index, p.discount]));
  const full = [];
  const y = [];
  const rows = [];
  const extras = [];
  for (let i = 2; i < values.length; i++) {
    const lag1 = values[i - 1];
    const lag2 = values[i - 2];
    const discount = promoMap.get(i) ?? null;
    const monthIdx = ((startMonth - 1) + i) % period;
    const hol = holidayOf ? holidayOf(monthIdx) : 0;
    full.push(featureVector({ lag1, lag2, discount, monthIdx, hol, period }));
    y.push(values[i]);
    rows.push(i);
    extras.push({ monthIdx, discount, promoFlag: discount === null ? 0 : 1 });
  }
  const allNames = PROMO_FEATURE_NAMES.slice();
  const kept = [];
  const dropped = [];
  for (let j = 0; j < allNames.length; j++) {
    let mean = 0;
    for (const r of full) mean += r[j];
    mean /= full.length;
    let ss = 0;
    for (const r of full) ss += (r[j] - mean) ** 2;
    if (ss === 0) dropped.push(allNames[j]);
    else kept.push(j);
  }
  const X = full.map((r) => kept.map((j) => r[j]));
  return {
    X, y, rows, extras, kept, dropped, period, startMonth,
    names: kept.map((j) => allNames[j]),
    allNames,
  };
}

/**
 * 拟合促销特征模型，并给出「学到的折扣系数 vs 真实 κ」的对照。
 * @returns {{fit:object, names:string[], dropped:string[], rows:number[], importance:Array,
 *            recoveredKappa:number|null, identifiable:boolean, truth:object}}
 */
export function fitPromoModel(values, {
  startMonth = 1, promos = [], holidayOf = null, kappa = null,
} = {}) {
  const { X, y, rows, names, dropped } = buildFeatureMatrix(values, { startMonth, promos, holidayOf });
  const fit = ols(X, y);
  const raw = [];
  for (let j = 0; j < fit.p; j++) raw.push(Math.abs(fit.beta[j + 1]) * fit.columnScales[j]);
  const total = raw.reduce((a, c) => a + c, 0);
  const importance = names.map((nm, j) => ({
    name: nm,
    effect: raw[j],
    weightPct: total === 0 ? 0 : (raw[j] / total) * 100,
    coef: fit.beta[j + 1],
    se: fit.se[j + 1],
    t: fit.tStat[j + 1],
  }));
  const intIdx = names.indexOf(INTERACTION_NAME);
  return {
    fit,
    names,
    dropped,
    rows,
    importance,
    recoveredKappa: intIdx >= 0 ? fit.beta[intIdx + 1] : null,
    identifiable: intIdx >= 0,
    truth: { kappa },
  };
}

/**
 * 情景预测：同样的历史，促销开 / 关两种情形下的下一期预测。
 * 这是「传统平滑模型看不出促销」的对照点 —— 平滑模型只会按惯性延伸。
 */
export function forecastScenario(values, {
  discount = null, kappa = 2.5, eta = 1, lambda = 0.45,
  startMonth = 1, promos = [], holidayOf = null,
} = {}) {
  const { X, y, kept, period } = buildFeatureMatrix(values, { startMonth, promos, holidayOf });
  const fit = ols(X, y);
  const last = values[values.length - 1];
  const prev = values[values.length - 2];
  const monthIdx = ((startMonth - 1) + values.length) % period;
  const hol = holidayOf ? holidayOf(monthIdx) : 0;
  const pick = (row) => kept.map((j) => row[j]);
  const predict = (d) => {
    const row = pick(featureVector({ lag1: last, lag2: prev, discount: d, monthIdx, hol, period }));
    return row.reduce((s, v, j) => s + fit.beta[j + 1] * v, fit.beta[0]);
  };
  const withoutPromo = predict(null);
  const withPromo = predict(discount);
  return {
    withoutPromo,
    withPromo,
    lift: withPromo - withoutPromo,
    liftPct: withoutPromo === 0 ? NaN : ((withPromo - withoutPromo) / withoutPromo) * 100,
    fit,
  };
}
