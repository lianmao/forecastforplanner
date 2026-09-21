/**
 * measure-recovery.mjs —— 一次性标定脚本：测出「真拟合」到底能把生成参数还原到什么程度。
 * 结果用来给单测定容差（凭感觉写阈值等于没写）。不属于测试套件。
 *
 * 用法：node scripts/measure-recovery.mjs
 */
import { synthSeries } from '../src/core/generator.js';
import { applyPromo, fitPromoModel, forecastScenario, DEFAULT_PROMOS } from '../src/core/promo_sim.js';
import { makeDailyDataset } from '../src/core/daily.js';
import { fitGam } from '../src/core/prophet_sim.js';

const f = (x, n = 4) => (Number.isFinite(x) ? x.toFixed(n) : String(x));

console.log('══ ① 促销折扣弹性 κ 的还原（真值 2.5）══');
for (const seed of [21, 22, 23, 24, 25]) {
  const nat = synthSeries({ n: 40, base: 1000, trend: 6, seasonality: 120, noise: 50, seed });
  const { values } = applyPromo(nat.values, { promos: DEFAULT_PROMOS, kappa: 2.5, eta: 1, lambda: 0.45 });
  const r = fitPromoModel(values, { promos: DEFAULT_PROMOS, startMonth: 1, kappa: 2.5 });
  const err = Math.abs(r.recoveredKappa - 2.5) / 2.5;
  console.log(`  seed=${seed}  学回 κ=${f(r.recoveredKappa)}  相对误差 ${(err * 100).toFixed(1)}%  `
    + `调整R²=${f(r.fit.adjR2, 4)}  剔除列=${r.dropped.length}`);
}

console.log('\n══ ② 无促销历史时：促销效应不可识别（应返回 null 而不是编一个数）══');
{
  const nat = synthSeries({ n: 40, base: 1000, trend: 6, seasonality: 120, noise: 50, seed: 21 });
  const r = fitPromoModel(nat.values, { promos: [], startMonth: 1 });
  console.log(`  identifiable=${r.identifiable}  recoveredKappa=${r.recoveredKappa}`);
  console.log(`  被剔除的恒定列：${r.dropped.join(' / ') || '（无）'}`);
}

console.log('\n══ ③ GAM 分段斜率还原（真值 [0.35, -0.2, 0.5]，变点 [365,730]）══');
for (const seed of [2023, 2024, 2025]) {
  const d = makeDailyDataset({ n: 1095, seed });
  const g = fitGam(d.labels, d.values);
  const errs = g.summary.slopes.map((s, i) => Math.abs(s - d.truth.slopes[i]));
  console.log(`  seed=${seed}  学回斜率=${g.summary.slopes.map((s) => f(s, 4)).join(', ')}  `
    + `最大绝对误差 ${Math.max(...errs).toExponential(2)}  调整R²=${f(g.summary.adjR2, 5)}`);
}

console.log('\n══ ④ GAM 节假日窗口效应还原（真值：春节前 +0.35×base，假期 −0.55×base）══');
{
  const d = makeDailyDataset({ n: 1095, seed: 2023 });
  const g = fitGam(d.labels, d.values);
  const base = d.truth.base;
  for (const h of g.summary.holidayEffects) {
    const truthPct = h.name.includes('节前')
      ? (h.name.startsWith('春节') ? 0.35 : h.name.startsWith('国庆') ? 0.12 : 0.25)
      : (h.name.startsWith('春节') ? -0.55 : h.name.startsWith('国庆') ? -0.3 : -0.15);
    const truthAbs = truthPct * base;
    console.log(`  ${h.name.padEnd(16)} 学回 ${f(h.coef, 1).padStart(9)} 件/天  真值 ${f(truthAbs, 1).padStart(9)}  `
      + `误差 ${(Math.abs(h.coef - truthAbs) / Math.abs(truthAbs) * 100).toFixed(2)}%  t=${f(h.t, 1)}`);
  }
  console.log(`  周内最高/最低：${g.summary.bestDow} / ${g.summary.worstDow}（0=周日）`);
  console.log(`  周度分量剖面 ${g.summary.dowMean.map((v) => f(v, 0)).join(', ')}`);
}

console.log('\n══ ⑤ 负向对照：变点位置给错时，斜率必须学不回来（证明 ③ 的断言有区分度）══');
{
  const d = makeDailyDataset({ n: 1095, seed: 2023 });
  const wrong = fitGam(d.labels, d.values, { changepoints: [100, 900] });
  const errs = wrong.summary.slopes.map((s, i) => Math.abs(s - d.truth.slopes[i]));
  console.log(`  变点给错 [100,900] → 学回斜率=${wrong.summary.slopes.map((s) => f(s, 4)).join(', ')}  `
    + `最大误差 ${Math.max(...errs).toFixed(4)}`);
  console.log('  （与 ③ 的误差对比：数量级差异即断言区分度）');
}

console.log('\n══ ⑥ 促销情景预测：关/开促销的下一期差异 ══');
{
  const nat = synthSeries({ n: 40, base: 1000, trend: 6, seasonality: 120, noise: 50, seed: 21 });
  const { values } = applyPromo(nat.values, { promos: DEFAULT_PROMOS, kappa: 2.5, eta: 1, lambda: 0.45 });
  for (const disc of [0.9, 0.8, 0.7, 0.6]) {
    const s = forecastScenario(values, { discount: disc, promos: DEFAULT_PROMOS, startMonth: 1 });
    console.log(`  折扣 ${disc}  无促销 ${f(s.withoutPromo, 0)}  有促销 ${f(s.withPromo, 0)}  `
      + `增量 ${f(s.lift, 0)} (${f(s.liftPct, 1)}%)`);
  }
}
