/**
 * prophet_sim.js —— Prophet 式广义加性模型（GAM）组件拆解 (纯函数，无 DOM 依赖)
 *
 *   y(t) = g(t) 趋势（含自动变点） + s_week(t) 周度 + s_year(t) 年度 + h(t) 节假日 + ε
 *
 * 这里不是“画一条像 Prophet 的线”，而是真的用最小二乘把**每一项拆出来**：
 * 基函数 = {1, t, max(0,t−cp)} 分段线性 + 周度傅里叶 + 年度傅里叶 + 节假日指示向量，
 * 系数由 ols() 求解，因此每张组件小图都是可归因、可辩论的（这正是 Prophet 的商业价值）。
 *
 * ★ 为什么用「窗口指示向量」而不是原样喂节假日日期：
 *   Prophet 的做法就是把节假日展开成窗口回归量（本节前窗口 / 假期窗口各一列），
 *   这样才能回答“节前两周平均拉动多少”，而不只是“那天是不是节假日”。
 */

import { ols } from './linalg.js';
import { q } from './quantize.js';
import { dayOfWeek, dayOfYearISO, holidayIndicators, CN_HOLIDAYS, isoFromDay, epochDay } from './daily.js';

export const DEFAULT_GAM_OPTIONS = {
  changepoints: [365, 730],
  weeklyOrder: 2,
  yearlyOrder: 2,
  weeklyCycle: 7,
  yearlyCycle: 365.25,
  holidays: CN_HOLIDAYS,
};

/**
 * 构造 GAM 设计矩阵。
 *
 * ★ 变点必须**过滤到样本范围内**：若样本只有 400 天而变点设在 [365, 730]，
 *   第二列 max(0, t−730) 会恒为 0 → 与截距完全共线 → 底层 ols 直接拒绝，
 *   整个模块崩掉。用户只是把时间范围改短一点就会踩到，所以这里主动丢弃
 *   落在样本之外的变点并记入 droppedChangepoints（而不是让它传下去炸掉）。
 *
 * @returns {{X:number[][], names:string[], groups:object, changepoints:number[],
 *            droppedChangepoints:number[], tStart:number}}
 */
export function buildGamDesign(labels, {
  changepoints = DEFAULT_GAM_OPTIONS.changepoints,
  weeklyOrder = DEFAULT_GAM_OPTIONS.weeklyOrder,
  yearlyOrder = DEFAULT_GAM_OPTIONS.yearlyOrder,
  weeklyCycle = 7,
  yearlyCycle = 365.25,
  holidays = CN_HOLIDAYS,
  tStart = 0,
} = {}) {
  const n = labels.length;
  if (n === 0) throw new RangeError('buildGamDesign: labels 为空');
  const lastT = tStart + n - 1;
  const usableCp = changepoints.filter((cp) => Number.isInteger(cp) && cp < lastT);
  const droppedChangepoints = changepoints.filter((cp) => !(Number.isInteger(cp) && cp < lastT));
  const names = [];
  const groups = { trend: [], weekly: [], yearly: [], holiday: [] };

  names.push('趋势 t');
  groups.trend.push(names.length - 1);
  for (const cp of usableCp) {
    names.push(`变点 t>${cp}`);
    groups.trend.push(names.length - 1);
  }
  for (let k = 1; k <= weeklyOrder; k++) {
    names.push(`周度 sin${k}`);
    groups.weekly.push(names.length - 1);
    names.push(`周度 cos${k}`);
    groups.weekly.push(names.length - 1);
  }
  for (let k = 1; k <= yearlyOrder; k++) {
    names.push(`年度 sin${k}`);
    groups.yearly.push(names.length - 1);
    names.push(`年度 cos${k}`);
    groups.yearly.push(names.length - 1);
  }

  const { names: holNames, columns: holCols } = holidayIndicators(labels, holidays);
  for (const nm of holNames) {
    names.push(nm);
    groups.holiday.push(names.length - 1);
  }

  const d0 = epochDay(labels[0]);
  const Xfull = [];
  for (let i = 0; i < n; i++) {
    const t = i + tStart;
    const day = d0 + i;
    const dow = dayOfWeek(day);
    const doy = dayOfYearISO(labels[i]);
    const row = [t];
    for (const cp of usableCp) row.push(Math.max(0, t - cp));
    for (let k = 1; k <= weeklyOrder; k++) {
      row.push(q(Math.sin((2 * Math.PI * k * dow) / weeklyCycle)));
      row.push(q(Math.cos((2 * Math.PI * k * dow) / weeklyCycle)));
    }
    for (let k = 1; k <= yearlyOrder; k++) {
      row.push(q(Math.sin((2 * Math.PI * k * doy) / yearlyCycle)));
      row.push(q(Math.cos((2 * Math.PI * k * doy) / yearlyCycle)));
    }
    for (const colArr of holCols) row.push(colArr[i]);
    Xfull.push(row);
  }

  // ★ 通用护栏：剔除全样本恒定的列。
  //   变点超范围只是其中一种情形；同样会踩到的是「样本没覆盖到某个节假日」
  //   —— 例如把数据截到年中，国庆窗口两列就全是 0，与截距共线，
  //   底层 ols 会拒绝，用户看到的却是整个模块崩掉。
  //   这里主动剔除并回报列名，比让异常冒到 UI 层合理。
  const keep = [];
  const droppedColumns = [];
  for (let j = 0; j < names.length; j++) {
    let mean = 0;
    for (const r of Xfull) mean += r[j];
    mean /= Xfull.length;
    let ss = 0;
    for (const r of Xfull) ss += (r[j] - mean) ** 2;
    if (ss === 0) droppedColumns.push(names[j]);
    else keep.push(j);
  }
  const remap = new Map(keep.map((j, i) => [j, i]));
  const X = Xfull.map((r) => keep.map((j) => r[j]));
  const keptNames = keep.map((j) => names[j]);
  const keptGroups = {};
  for (const k of Object.keys(groups)) {
    keptGroups[k] = groups[k].filter((j) => remap.has(j)).map((j) => remap.get(j));
  }

  return {
    X, names: keptNames, groups: keptGroups, tStart,
    changepoints: usableCp, droppedChangepoints, droppedColumns,
  };
}

/**
 * 拟合 GAM 并拆出各组件序列（供组件小图直接绘制）。
 *
 * ★ mode='multiplicative' 的实现方式与 Prophet 一致：**在对数空间拟合，再指数变换回去**。
 *   y → log(y) 后做加性 GAM，等价于原始尺度上的乘法结构 Y = T × S_week × S_year × H。
 *   返回的分量因此是"倍数因子"（如 1.08 = 高于基准 8%），趋势分量则是水平本身。
 *   乘法残差 = 实际 ÷ 拟合，是无量纲倍数，可直接和 1 比较。
 *   注意：R² / 残差 σ 是**对数空间**的数字，别拿去和加法模式横向比。
 *
 * 无论哪种模式，都保证：fitted + residual = 原序列（加法）或 fitted × residual = 原序列（乘法）。
 *
 * @param {string[]} labels
 * @param {number[]} values
 * @returns {{fit:object, names:string[], groups:object,
 *            components:{trend:number[],weekly:number[],yearly:number[],holiday:number[],residual:number[],
 *                        fitted:number[]}, summary:object}}
 */
export function fitGam(labels, values, options = {}) {
  const opt = { ...DEFAULT_GAM_OPTIONS, ...options };
  const mode = opt.mode || 'additive';
  if (mode !== 'additive' && mode !== 'multiplicative') {
    throw new RangeError(`fitGam: mode 只能是 additive / multiplicative，收到 ${mode}`);
  }
  if (labels.length !== values.length) {
    throw new RangeError(`fitGam: labels 与 values 长度不一致 (${labels.length} vs ${values.length})`);
  }
  if (mode === 'multiplicative' && values.some((v) => v <= 0)) {
    throw new RangeError('fitGam: 乘法模式要求全部为正数（存在 0 或负值，常见于缺货归零，请先清洗）');
  }
  const y = mode === 'multiplicative' ? values.map((v) => Math.log(v)) : values;

  const { X, names, groups, changepoints: cps, droppedChangepoints, droppedColumns } = buildGamDesign(labels, opt);
  const fit = ols(X, y, { minRowsPerParam: opt.minRowsPerParam ?? 2 });

  const contrib = (cols) => {
    const out = new Array(values.length).fill(0);
    for (let i = 0; i < values.length; i++) {
      for (const j of cols) out[i] += fit.beta[j + 1] * X[i][j];
    }
    return out;
  };
  let trend = contrib(groups.trend);
  // 截距归入趋势项（它是趋势的基线水平，不该平摊到别处）
  for (let i = 0; i < trend.length; i++) trend[i] += fit.beta[0];
  let weekly = contrib(groups.weekly);
  let yearly = contrib(groups.yearly);
  let holiday = contrib(groups.holiday);
  const fittedRaw = trend.map((v, i) => v + weekly[i] + yearly[i] + holiday[i]);

  let fitted;
  let residual;
  if (mode === 'multiplicative') {
    const ex = (a) => a.map(Math.exp);
    trend = ex(trend); weekly = ex(weekly); yearly = ex(yearly); holiday = ex(holiday);
    fitted = ex(fittedRaw);
    residual = values.map((v, i) => v / fitted[i]);   // 乘性残差：1.05 表示高估 5%
  } else {
    fitted = fittedRaw;
    residual = values.map((v, i) => v - fitted[i]);
  }

  // 分段斜率：t 的系数 = 首段斜率；每个变点列的系数 = 该点的斜率增量
  const slopes = [fit.beta[1]];
  let acc = fit.beta[1];
  for (let k = 0; k < cps.length; k++) {
    acc += fit.beta[2 + k];
    slopes.push(acc);
  }

  // 周内效应剖面的均值（用于“哪天出货最多”）
  const dowProfile = new Array(7).fill(0);
  const dowCount = new Array(7).fill(0);
  for (let i = 0; i < labels.length; i++) {
    const d = dayOfWeek(epochDay(labels[i]));
    dowProfile[d] += weekly[i];
    dowCount[d] += 1;
  }
  const dowMean = dowProfile.map((s, d) => (dowCount[d] ? s / dowCount[d] : 0));

  // 节假日效应（绝对量与占基准的百分比）
  const holidayEffects = names
    .map((nm, j) => ({ nm, j }))
    .filter(({ j }) => groups.holiday.includes(j))
    .map(({ nm, j }) => ({
      name: nm,
      coef: fit.beta[j + 1],
      se: fit.se[j + 1],
      t: fit.tStat[j + 1],
      pctOfBase: (fit.beta[j + 1] / (values.reduce((a, b) => a + b, 0) / values.length)) * 100,
    }));

  const summary = {
    mode,
    slopes,
    changepoints: cps,
    droppedChangepoints,
    droppedColumns,
    changepointSharpeness: fit.beta.slice(2, 2 + cps.length),
    dowMean,
    bestDow: dowMean.indexOf(Math.max(...dowMean)),
    worstDow: dowMean.indexOf(Math.min(...dowMean)),
    holidayEffects,
    r2: fit.r2,
    adjR2: fit.adjR2,
    sigma: fit.sigma,
    nParam: fit.beta.length,
    n: fit.n,
  };

  return { fit, names, groups, X, labels, options: opt, mode, components: { trend, weekly, yearly, holiday, residual, fitted }, summary };
}

/**
 * 未来外推：用已拟合模型预测未来日期。
 * 注意外推的风险 —— 周度/年度项可以照旧，但**趋势项会线性外推**，
 * 这正是 Prophet 需要"趋势不确定性区间"的原因；此处给出 ±z·σ 的朴素区间。
 *
 * 乘法模式下在对数空间预测后指数还原，区间也用乘性形式（mean × e^±zσ），
 * 这样区间不会在低量级时出现负的下界。
 */
export function forecastGam(model, futureLabels, { z = 1.959963984540054 } = {}) {
  const { fit, names, summary } = model;
  const opt = model.options || DEFAULT_GAM_OPTIONS;
  const mult = model.mode === 'multiplicative';
  // 用完整标签序列重建设计矩阵，保证 t 连续、周期基函数对齐
  const allLabels = [...model.labels, ...futureLabels];
  const { X } = buildGamDesign(allLabels, { ...opt, changepoints: summary.changepoints });
  const out = [];
  for (let i = model.labels.length; i < allLabels.length; i++) {
    let yhat = fit.beta[0];
    for (let j = 0; j < names.length; j++) yhat += fit.beta[j + 1] * X[i][j];
    const h = i - model.labels.length + 1;
    const sig = fit.sigma * Math.sqrt(h);
    if (mult) {
      const m = Math.exp(yhat);
      out.push({ label: allLabels[i], mean: m, lower: m * Math.exp(-z * sig), upper: m * Math.exp(z * sig) });
    } else {
      out.push({ label: allLabels[i], mean: yhat, lower: yhat - z * sig, upper: yhat + z * sig });
    }
  }
  return out;
}

/** 未来 n 天的日期标签（沿用日粒度，直接接在历史末尾）。 */
export function futureLabels(labels, n) {
  if (!Array.isArray(labels) || labels.length === 0) throw new RangeError('futureLabels: labels 为空');
  const last = epochDay(labels[labels.length - 1]);
  return Array.from({ length: n }, (_, i) => isoFromDay(last + i + 1));
}

/** 把 Prophet 式组件拆解翻译成计划员能读的业务结论（模块 5 的贴士区）。 */
export function prophetNarrative(summary, avgLevel) {
  const dow = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const lines = [];
  lines.push(`趋势段斜率：${summary.slopes.map((s, i) => `第${i + 1}段 ${s >= 0 ? '+' : ''}${s.toFixed(2)} 件/天`).join('，')}`);
  lines.push(`周内最高 ${dow[summary.bestDow]}（较周均 ${summary.dowMean[summary.bestDow] >= 0 ? '+' : ''}${summary.dowMean[summary.bestDow].toFixed(0)} 件/天），最低 ${dow[summary.worstDow]}（${summary.dowMean[summary.worstDow].toFixed(0)} 件/天）`);
  const cny = summary.holidayEffects.find((h) => h.name.startsWith('春节·节前'));
  const cnyHol = summary.holidayEffects.find((h) => h.name.startsWith('春节·假期'));
  if (cny) {
    lines.push(`春节前窗口平均拉动 ${cny.coef >= 0 ? '+' : ''}${cny.coef.toFixed(0)} 件/天`
      + `（≈ 基准水平的 ${cny.pctOfBase >= 0 ? '+' : ''}${cny.pctOfBase.toFixed(1)}%），`
      + `假期内 ${cnyHol ? `${cnyHol.pctOfBase >= 0 ? '+' : ''}${cnyHol.pctOfBase.toFixed(1)}%` : '—'}`);
  }
  if (Number.isFinite(summary.adjR2)) {
    lines.push(`模型解释力 调整 R² = ${summary.adjR2.toFixed(4)}（${summary.nParam} 个参数 / ${summary.n} 个观测）`);
  }
  return lines;
}
