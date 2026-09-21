/**
 * calibrate-promo.mjs —— 促销数据集设计标定脚本（不是测试，手工运行）。
 *
 * 作用：实测「折扣弹性 κ 能被还原到什么程度」在不同数据集设计下的差别，
 *   结论已经写回 promo_sim.js 的 DEFAULT_PROMOS 注释与测试容差。
 * 改动促销次数/折扣区间/特征工程后，重跑本脚本再更新容差 —— 别凭感觉定阈值。
 *
 * 用法：node scripts/calibrate-promo.mjs
 */
import { synthSeries } from '../src/core/generator.js';
import { applyPromo, fitPromoModel } from '../src/core/promo_sim.js';
import { fitGam } from '../src/core/prophet_sim.js';
import { makeDailyDataset } from '../src/core/daily.js';

const f = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : String(x));

const CONFIGS = {
  A_现方案4次: [{ index: 9, discount: 0.85 }, { index: 18, discount: 0.75 }, { index: 27, discount: 0.65 }, { index: 33, discount: 0.8 }],
  B_6次宽区间: [5, 11, 17, 23, 29, 34].map((index, i) => ({ index, discount: [0.9, 0.6, 0.8, 0.5, 0.75, 0.65][i] })),
  C_8次宽区间: [4, 8, 13, 17, 21, 26, 30, 34].map((index, i) => ({ index, discount: [0.95, 0.6, 0.85, 0.5, 0.75, 0.55, 0.9, 0.7][i] })),
  D_10次: [3, 6, 10, 13, 17, 20, 24, 28, 32, 35].map((index, i) => ({ index, discount: [0.95, 0.6, 0.85, 0.5, 0.75, 0.55, 0.9, 0.65, 0.8, 0.7][i] })),
};

console.log('促销折扣弹性 κ 还原实验（真值 2.5，每组 8 个种子）');
console.log('配置'.padEnd(16), '平均绝对误差'.padEnd(12), '最大误差'.padEnd(10), '平均学回值'.padEnd(10));
for (const [name, promos] of Object.entries(CONFIGS)) {
  const errs = [];
  const recs = [];
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    const nat = synthSeries({ n: 40, base: 1000, trend: 6, seasonality: 120, noise: 50, seed });
    const { values } = applyPromo(nat.values, { promos, kappa: 2.5, eta: 1, lambda: 0.45 });
    const r = fitPromoModel(values, { promos, startMonth: 1 });
    if (r.recoveredKappa === null) { errs.push(NaN); continue; }
    errs.push(Math.abs(r.recoveredKappa - 2.5) / 2.5);
    recs.push(r.recoveredKappa);
  }
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  const meanRec = recs.reduce((a, b) => a + b, 0) / recs.length;
  console.log(name.padEnd(16), `${(mean * 100).toFixed(1)}%`.padEnd(12),
    `${(Math.max(...errs) * 100).toFixed(1)}%`.padEnd(10), f(meanRec).padEnd(10));
}

console.log('\n各配置逐种子明细：');
for (const [name, promos] of Object.entries(CONFIGS)) {
  const line = [];
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    const nat = synthSeries({ n: 40, base: 1000, trend: 6, seasonality: 120, noise: 50, seed });
    const { values } = applyPromo(nat.values, { promos, kappa: 2.5, eta: 1, lambda: 0.45 });
    const r = fitPromoModel(values, { promos, startMonth: 1 });
    line.push(`${seed}:${f(r.recoveredKappa, 2)}`);
  }
  console.log(' ', name.padEnd(16), line.join('  '));
}

console.log('\nGAM 趋势重建精度（斜率误差 vs 趋势序列整体误差）——3 个种子');
for (const seed of [2023, 2024, 2025]) {
  const d = makeDailyDataset({ n: 1095, seed });
  const g = fitGam(d.labels, d.values);
  const slopeErr = g.summary.slopes.map((s, i) => Math.abs(s - d.truth.slopes[i]));
  let maxTrendErr = 0;
  for (let i = 0; i < d.labels.length; i++) {
    maxTrendErr = Math.max(maxTrendErr, Math.abs(g.components.trend[i] - d.components.trend[i]));
  }
  console.log(`  seed=${seed} 斜率最大误差 ${Math.max(...slopeErr).toFixed(4)}  `
    + `趋势序列最大误差 ${maxTrendErr.toFixed(1)} 件（相对 ${(maxTrendErr / d.truth.base * 100).toFixed(1)}%）`
    + `  残差σ=${f(g.summary.sigma, 1)}`);
}

console.log('\nGAM 周日历谐波阶数对节假日还原的影响');
for (const weeklyOrder of [1, 2, 3]) {
  for (const yearlyOrder of [1, 2]) {
    const d = makeDailyDataset({ n: 1095, seed: 2023 });
    const g = fitGam(d.labels, d.values, { weeklyOrder, yearlyOrder });
    const hol = g.summary.holidayEffects
      .map((h) => `${h.name.slice(0, 4)}:${h.coef.toFixed(0)}`)
      .join(' ');
    console.log(`  周${weeklyOrder}/年${yearlyOrder} 参数${g.summary.nParam} 调整R²=${f(g.summary.adjR2, 4)}  ${hol}`);
  }
}
