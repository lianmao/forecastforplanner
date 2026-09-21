/**
 * lecture-facts.mjs —— 讲义里引用的每一个数字，都在这里复算出来。
 *
 *   node scripts/lecture-facts.mjs
 *
 * 为什么要这个脚本：讲义（lectures/*.html）里写满了具体数字（均值、标准差、滞后几期、
 * 还原误差、Z 值、边际成本倍数……）。如果这些数字是"写讲义时顺手打的"，它们会随着
 * 代码演进而悄悄过期 —— 读者照着复算对不上，整份材料的可信度就没了。
 * 所以：讲义里出现的每个数字都必须来自这里，改了代码就重跑这个脚本并同步讲义。
 */
import * as G from '../src/core/generator.js';
import * as S from '../src/core/stats.js';
import * as M from '../src/core/metrics.js';
import * as C from '../src/core/cleaning.js';
import * as P from '../src/core/promo_sim.js';
import * as D from '../src/core/daily.js';
import * as GAM from '../src/core/prophet_sim.js';
import * as INV from '../src/core/inventory.js';

const n0 = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const pc = (x, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : '—');
const H = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const L = (k, v) => console.log(`  ${k.padEnd(34)} ${v}`);

/* ── 第 0 讲：数据清洗 ─────────────────────────────────────────────────── */
H('第 0 讲 · 数据清洗与异常修复（REQ-MOD-00）');
{
  const d = G.makeCleaningDataset();
  L('序列范围 / 期数', `${d.labels[0]} ~ ${d.labels[47]} / ${d.values.length} 期`);
  L('极端爆单（3.2×）', d.truth.extremeSpikeIndices.map((i) => `${d.labels[i]}=${d.values[i].toFixed(0)}`).join('  '));
  L('中等幅度异常', d.truth.moderateSpikeIndices.map((i) => `${d.labels[i]}=${d.values[i].toFixed(0)}`).join('  '));
  L('缺货区间', d.truth.stockoutRuns.map(([s, e]) => `${d.labels[s]}~${d.labels[e]}`).join('  '));
  const exempt = new Set();
  for (const [s, e] of d.truth.stockoutRuns) for (let i = s; i <= e; i++) exempt.add(i);
  const pool = d.values.filter((_, i) => !exempt.has(i));
  const b15 = C.iqrBounds(pool, 1.5);
  L('Q1 / Q3 / IQR（剔除缺货点后）', `${b15.q1.toFixed(0)} / ${b15.q3.toFixed(0)} / ${b15.iqr.toFixed(0)}`);
  L('k=1.5 的边界', `下界 ${b15.lower.toFixed(0)}  上界 ${b15.upper.toFixed(0)}`);
  const bz = C.iqrBounds(d.values, 1.5);
  L('含缺货零值的 IQR 统计', `Q1=${bz.q1.toFixed(0)} Q3=${bz.q3.toFixed(0)} IQR=${bz.iqr.toFixed(0)} → 下界 ${bz.lower.toFixed(0)}（对比剔除后 ${b15.lower.toFixed(0)}）、上界 ${bz.upper.toFixed(0)}（对比 ${b15.upper.toFixed(0)}）`);
  L('  判定区间被假零点撑宽', `下界低 ${(b15.lower - bz.lower).toFixed(0)} 件、上界高 ${(bz.upper - b15.upper).toFixed(0)} 件`);
  for (const k of [1.0, 1.5, 2.0, 3.0]) {
    const b = C.iqrBounds(pool, k);
    const hit = d.values.filter((v, i) => !exempt.has(i) && (v > b.upper || v < b.lower));
    L(`  k=${k.toFixed(1)}`, `下界 ${b.lower.toFixed(0)}  上界 ${b.upper.toFixed(0)}  判为异常 ${hit.length} 个`);
  }
  L('k=1.0 下界附近的正常点', `${d.labels[9]} = ${d.values[9].toFixed(0)}（仅差 ${(C.iqrBounds(pool, 1.0).lower - d.values[9]).toFixed(0)} 件被判为异常）`);
  for (const m of C.OUTLIER_METHODS) {
    const r = C.cleanSeries(d.values, { outlierMethod: m, k: 1.5, stockoutMethod: 'keep' });
    L(`  异常策略 ${m}`,
      `均值 ${r.before.mean.toFixed(0)}→${r.after.mean.toFixed(0)}  标准差 ${r.before.std.toFixed(0)}→${r.after.std.toFixed(0)}  CV ${r.before.cv.toFixed(1)}%→${r.after.cv.toFixed(1)}%  改动 ${r.meta.clipped.length + r.meta.replaced.length + r.meta.removed.length} 点`);
  }
  for (const sm of ['linear', 'yoy']) {
    const r = C.cleanSeries(d.values, { outlierMethod: 'keep', stockoutMethod: sm });
    L(`  只修缺货 ${sm}`,
      `均值 ${r.before.mean.toFixed(0)}→${r.after.mean.toFixed(0)}（${pc(r.after.mean / r.before.mean - 1)}）  标准差 ${r.before.std.toFixed(0)}→${r.after.std.toFixed(0)}  补 ${r.meta.filled.length} 点`);
  }
}

/* ── 第 1 讲：三要素拆解 ──────────────────────────────────────────────── */
H('第 1 讲 · 时间序列三要素拆解（REQ-MOD-01）');
{
  const opts = { base: 1000, trend: 2, seasonality: 20, noise: 5, n: 72 };
  // ★ 用 synthSeries 而不是 stats.compose：讲义数字必须与互动模块 UI 走同一条代码路径
  //   （mod1 用 synthSeries + seed 4242），否则讲义写的数在页面上复算不出来。
  const s = G.synthSeries({ ...opts, start: '2020-01', seed: 4242, mode: 'additive' });
  const vals = s.values;
  L('合成参数', `trend=${opts.trend} 件/月  季节振幅=${opts.seasonality}  噪音σ=${opts.noise}  n=${opts.n}`);
  const decA = S.decompose(vals, { mode: 'additive', period: 12 });
  // 乘法序列用乘法拆解 / 同一个乘法序列用加法拆解 —— 这对"用错模型"才是真实错配
  const mult = G.synthSeries({ ...opts, start: '2020-01', seed: 4242, mode: 'multiplicative' });
  const decMulRight = S.decompose(mult.values, { mode: 'multiplicative', period: 12 });
  const decMulWrong = S.decompose(mult.values, { mode: 'additive', period: 12 });
  const sd = (a) => { const v = a.filter((x) => x !== null); return Math.sqrt(v.reduce((t, x) => t + x * x, 0) / v.length); };
  // 样本标准差（与 mod1 的 KPI 同口径：分母 n-1）
  const sdSample = (a) => {
    const v = a.filter((x) => x !== null);
    const m = v.reduce((t, x) => t + x, 0) / v.length;
    return Math.sqrt(v.reduce((t, x) => t + (x - m) ** 2, 0) / (v.length - 1));
  };
  L('真值设定的趋势', `${opts.trend} 件/月`);
  L('加法拆解还原出的趋势斜率', `${S.trendSlope(decA.trend).toFixed(2)} 件/月`);
  L('真值设定的季节振幅', `峰谷差 ${(2 * opts.seasonality).toFixed(0)} 件`);
  const ampA = decA.seasonalAmp ?? (Math.max(...decA.seasonal.filter((x) => x !== null)) - Math.min(...decA.seasonal.filter((x) => x !== null)));
  L('加法拆解还原出的季节峰谷差', `${ampA.toFixed(0)} 件`);
  L('残差标准差（加法序列 + 加法拆解）', `${sdSample(decA.residual).toFixed(1)} 件  真值噪音 σ=${opts.noise}`);
  L('噪音占总波动', `${pc(sdSample(decA.residual) / sdSample(vals))}`);
  L('乘法序列的还原趋势斜率', `${S.trendSlope(decMulRight.trend).toFixed(2)} 件/月`);
  L('乘法序列 + 乘法拆解（对）', `残差标准差 ${sdSample(decMulRight.residual).toFixed(1)} 件  季节峰谷差 ${((decMulRight.seasonalAmp ?? 0) * 100).toFixed(1)} 个百分点`);
  L('乘法序列 + 加法拆解（错配）', `残差标准差 ${sdSample(decMulWrong.residual).toFixed(1)} 件  季节峰谷差 ${(decMulWrong.seasonalAmp ?? 0).toFixed(0)} 件（量纲已不对）`);
  // 错配的真正危害不是"残差变大"，而是残差**带系统性结构**：
  // 加法模型把随规模放大的季节波幅当成固定件数，于是水平越高、低估越多。
  // 用"水平 vs 残差"的相关系数把这个结构量化出来（强正相关 = 系统性低估旺季）。
  {
    const pairs = [];
    for (let i = 0; i < mult.values.length; i++) {
      const r = decMulWrong.residual[i];
      if (r === null) continue;
      pairs.push([mult.values[i], r]);
    }
    const mx = pairs.reduce((a, p) => a + p[0], 0) / pairs.length;
    const my = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
    L('错配残差与水平的相关系数', `${(sxy / Math.sqrt(sxx * syy)).toFixed(2)} —— 结构被噪音淹没（噪声σ=5，系统性错配只有±1.5 件量级），所以别用"残差会爆炸"论证错配的危害`);
    const hi = pairs.slice(Math.floor(pairs.length * 0.75));
    const lo = pairs.slice(0, Math.ceil(pairs.length * 0.25));
    L('  高位区间平均残差', `${(hi.reduce((a, p) => a + p[1], 0) / hi.length).toFixed(1)} 件`);
    L('  低位区间平均残差', `${(lo.reduce((a, p) => a + p[1], 0) / lo.length).toFixed(1)} 件`);
  }
  L('趋势线两端留缺口', `各 ${6} 期（居中移动平均的固有代价）`);
}

/* ── 第 2 讲：移动平均 ────────────────────────────────────────────────── */
H('第 2 讲 · 移动平均与拐点滞后（REQ-MOD-02）');
{
  const d = G.makeTurningPointSeries({ n: 36, noise: 8, seed: 7 });
  L('序列', `${d.labels[0]} ~ ${d.labels[35]}  共 ${d.values.length} 期  噪音σ=8  seed=7`);
  const std = (a) => { const v = a.filter((x) => x !== null); const m = v.reduce((t, x) => t + x, 0) / v.length; return Math.sqrt(v.reduce((t, x) => t + (x - m) ** 2, 0) / v.length); };
  // movingAverage / peakLag 都返回裸数组（不是 {values} 包装）
  for (const k of [3, 6, 12]) {
    const sm = S.movingAverage(d.values, { method: 'sma', k });
    const lag = S.peakLag(d.values, sm);
    L(`  SMA k=${String(k).padStart(2)}`,
      `平均滞后 ${lag.meanLag === null ? '—' : lag.meanLag.toFixed(1)} 期  平滑后波动/原波动 ${(std(sm) / std(d.values)).toFixed(3)}  可用预测期 ${sm.filter((x) => x !== null).length}/${d.values.length}`);
  }
  for (const k of [3, 12]) {
    const sm = S.movingAverage(d.values, { method: 'wma', k });
    const lag = S.peakLag(d.values, sm);
    L(`  WMA k=${String(k).padStart(2)}`,
      `平均滞后 ${lag.meanLag === null ? '—' : lag.meanLag.toFixed(1)} 期  平滑后波动/原波动 ${(std(sm) / std(d.values)).toFixed(3)}`);
  }
  const detail = S.peakLag(d.values, S.movingAverage(d.values, { method: 'sma', k: 3 }));
  for (const p of detail.pairs) {
    L('  拐点对照',
      `${d.labels[p.actualIndex]} → ${d.labels[p.smoothedIndex]}  滞后 ${p.lag} 期  实际峰值 ${d.values[p.actualIndex].toFixed(0)} 件`);
  }
}

/* ── 第 3 讲：阻尼指数平滑 ────────────────────────────────────────────── */
H('第 3 讲 · 阻尼三次指数平滑（REQ-MOD-05）');
{
  const d = G.synthSeries({ n: 60, start: '2020-01', base: 1000, trend: 4, seasonality: 60, noise: 25, seed: 33 });
  const fit = S.holtWintersFit(d.values, { alpha: 0.3, beta: 0.1, gamma: 0.2, phi: 0.98, period: 12, seasonal: true });
  const pairs = d.values, f = fit.fitted;
  const idx = pairs.map((_, i) => i).filter((i) => f[i] !== null);
  L('序列', `${d.labels[0]} ~ ${d.labels[59]}  共 60 期`);
  L('参数', 'α=0.30 β=0.10 γ=0.20 φ=0.98  周期 12');
  L('拟合 RMSE / MAE', `${M.rmse(f.filter((x) => x !== null), idx.map((i) => pairs[i])).toFixed(0)} / ${M.mae(f.filter((x) => x !== null), idx.map((i) => pairs[i])).toFixed(0)} 件`);
  L('残差标准差 σ', `${fit.sigma.toFixed(0)} 件`);
  const fc = S.holtWintersForecast(fit, 12);
  const last = fit.state.level ?? 0;
  L('第 12 期预测值', `${fc.mean[11].toFixed(0)} 件（相对最新实际 ${(fc.mean[11] / d.values[59] * 100 - 100).toFixed(1)}%）`);
  L('第 12 期预测区间宽度', `${(fc.upper[11] - fc.lower[11]).toFixed(0)} 件`);
  const undamped = S.holtWintersFit(d.values, { alpha: 0.3, beta: 0.1, gamma: 0.2, phi: 1, period: 12, seasonal: true });
  const fcU = S.holtWintersForecast(undamped, 12);
  L('无阻尼（φ=1）第 12 期', `${fcU.mean[11].toFixed(0)} 件`);
  L('阻尼把第 12 期压低了', `${pc(1 - fc.mean[11] / fcU.mean[11])}`);
  let w = 0; for (let i = 1; i <= 12; i++) w += 0.98 ** i;
  L('趋势权重累计 Σφ^i (i=1..12)', `${w.toFixed(2)}（φ=1 时是 12）`);
  for (const phi of [0.8, 0.9, 0.98, 1.0]) {
    const fi = S.holtWintersFit(d.values, { alpha: 0.3, beta: 0.1, gamma: 0.2, phi, period: 12, seasonal: true });
    const fh = S.holtWintersForecast(fi, 12);
    L(`  φ=${phi.toFixed(2)}`, `第 12 期 ${fh.mean[11].toFixed(0)} 件  区间宽 ${(fh.upper[11] - fh.lower[11]).toFixed(0)} 件  拟合 RMSE ${M.rmse(fi.fitted.filter((x) => x !== null), idx.map((i) => pairs[i])).toFixed(0)}`);
  }
}

/* ── 第 4 讲：促销特征 ────────────────────────────────────────────────── */
H('第 4 讲 · 促销与折扣特征工程（REQ-MOD-03）');
{
  const d = G.makePromoDataset({ n: 40, seed: 21 });
  L('序列', `${d.labels[0]} ~ ${d.labels[39]}  共 40 期`);
  L('促销次数 / 折扣区间', `${d.promos.length} 次 / ${Math.min(...d.promos.map((p) => p.discount)).toFixed(2)} ~ ${Math.max(...d.promos.map((p) => p.discount)).toFixed(2)}`);
  const fit = P.fitPromoModel(d.values, { promos: d.promos, kappa: 2.5 });
  const intRow = fit.importance.find((r) => r.name === P.INTERACTION_NAME);
  L('真值 κ（折扣弹性）', '2.500');
  L('学回 κ', `${fit.recoveredKappa === null ? '（项被剔除）' : fit.recoveredKappa.toFixed(3)}（相对误差 ${fit.recoveredKappa === null ? '—' : pc(Math.abs(fit.recoveredKappa / 2.5 - 1))}）`);
  L('κ 的标准误 / t 值', intRow ? `±${intRow.se.toFixed(3)} / t=${intRow.t.toFixed(1)}` : '—');
  L('调整 R²', fit.fit.adjR2.toFixed(4));
  L('设计矩阵', `${fit.fit.n} 行 × ${fit.fit.p + 1} 列（含截距）`);
  L('因全样本恒定被剔除的列', fit.dropped.length ? fit.dropped.join('、') : '无');
  for (const r of fit.importance.slice(0, 5)) {
    L('  特征贡献', `${r.name.slice(0, 30).padEnd(32)} ${r.weightPct.toFixed(2).padStart(6)}%  系数 ${r.coef.toFixed(3)}  t=${r.t.toFixed(1)}`);
  }
  // 可识别性检验：把历史里的促销次数一路减到 1 次、0 次，看模型什么时候拒绝求解。
  // ★ 这里必须**实测**而不是照搬"促销太少就学不出来"的说法 ——
  //   我原先在 DECISIONS.md 里写"只有 1~2 次促销模型会直接拒绝求解"，实测 2 次仍然可识别，
  //   那句话是错的，讲义与文档都按实测结果改写。
  for (const cnt of [2, 1, 0]) {
    try {
      const sub = P.fitPromoModel(d.values, { promos: d.promos.slice(0, cnt), kappa: 2.5 });
      L(`  历史里只有 ${cnt} 次促销`,
        `κ=${sub.recoveredKappa === null ? '（交互项被剔除）' : sub.recoveredKappa.toFixed(3)}  可识别=${sub.identifiable}  剔除列=${sub.dropped.join('、') || '无'}`);
    } catch (e) {
      L(`  历史里只有 ${cnt} 次促销`, `拒绝求解：${e.message.slice(0, 72)}…`);
    }
  }
  const scNo = P.forecastScenario(d.values, { promos: d.promos, discount: null });
  const scYes = P.forecastScenario(d.values, { promos: d.promos, discount: 0.8 });
  L('下一期不开促销的预测', `${scNo.withoutPromo.toFixed(0)} 件`);
  L('下一期开促销（8 折）的预测', `${scYes.withPromo.toFixed(0)} 件（拉升 ${scYes.liftPct.toFixed(1)}%）`);
}

/* ── 第 5 讲：Prophet 式组件 ─────────────────────────────────────────── */
H('第 5 讲 · Prophet 式组件拆解（REQ-MOD-06）');
{
  const d = D.makeDailyDataset({ n: 1095, seed: 2023 });
  L('序列', `${d.labels[0]} ~ ${d.labels[1094]}  共 1095 天`);
  L('真值变点位置', '第 365 天（2024-01-01）、第 730 天（2025-01-01）');
  for (const k of [0, 2, 6]) {
    const cps = k === 0 ? [] : Array.from({ length: k }, (_, i) => Math.round((i + 1) * 1095 / (k + 1)));
    const m = GAM.fitGam(d.labels, d.values, { changepoints: cps });
    L(`  变点数量 k=${k}`, `调整 R² ${m.summary.adjR2.toFixed(4)}  残差σ ${m.summary.sigma.toFixed(1)} 件  参数 ${m.summary.nParam} 个`);
  }
  const m2 = GAM.fitGam(d.labels, d.values, { changepoints: [365, 730] });
  const fc = GAM.forecastGam(m2, GAM.futureLabels(d.labels, 60));
  const avg = fc.reduce((a, b) => a + b.mean, 0) / fc.length;
  L('变点 k=2（默认）', `调整 R² ${m2.summary.adjR2.toFixed(4)}  残差σ ${m2.summary.sigma.toFixed(1)} 件  参数 ${m2.summary.nParam} 个  识别变点 ${m2.summary.changepoints.join(', ')}`);
  L('未来 60 天日均预测', `${avg.toFixed(0)} 件/天`);
  const recent = d.values.slice(-30).reduce((a, b) => a + b, 0) / 30;
  L('最近 30 天日均实际', `${recent.toFixed(0)} 件/天（预测与之差 ${pc(avg / recent - 1)}）`);
  L('周内最旺/最淡', `周${'日一二三四五六'[m2.summary.bestDow]} / 周${'日一二三四五六'[m2.summary.worstDow]}`);
  L('节假日效应（逐个）', m2.summary.holidayEffects.map((h) => `${h.name.slice(0, 6)} ${h.pctOfBase >= 0 ? '+' : ''}${h.pctOfBase.toFixed(1)}%`).join('  '));
  const mm = GAM.fitGam(d.labels, d.values, { changepoints: [365, 730], mode: 'multiplicative' });
  L('乘法模式', `调整 R² ${mm.summary.adjR2.toFixed(4)}（对比加法 ${m2.summary.adjR2.toFixed(4)}）`);
}

/* ── 第 6 讲：误差与 Bias ────────────────────────────────────────────── */
H('第 6 讲 · 预测误差与 Bias 预警（REQ-MOD-07）');
{
  const base = G.synthSeries({ n: 36, start: '2022-01', base: 12000, trend: 80, seasonality: 1500, noise: 700, seed: 606 });
  const train = base.values.slice(0, 24), test = base.values.slice(24);
  // ★ 参数必须与 mod6 一致（alpha .35 / beta .15 / gamma .25 / phi .97），否则讲义写的数字
  //   和页面上看到的对不上 —— 这是我第一版的错误，σ 差到 1057 vs 1089。
  const fit = S.holtWintersFit(train, { alpha: 0.35, beta: 0.15, gamma: 0.25, phi: 0.97, period: 12 });
  const fc = S.holtWintersForecast(fit, 12);
  const f = fc.mean;
  const sm = M.summarize(test, f);
  L('序列', '36 期（2022-01~2024-12），前 24 期训练、后 12 期样本外评估');
  L('训练集拟合残差 σ', `${fit.sigma.toFixed(0)} 件（模型"自我感觉"的精度）`);
  L('样本外误差 σ', `${sm.residualStd.toFixed(0)} 件（真实检验）`);
  L('MAE', `${sm.mae.toFixed(0)} 件`);
  L('MAPE', `${sm.mape.toFixed(1)}%（排除 ${sm.mapeExcluded} 个零值期）`);
  L('WAPE', `${sm.wape.toFixed(1)}%`);
  L('Bias', `${sm.bias.toFixed(1)}%`);
  L('|Bias| 对应的绝对量', `${(Math.abs(sm.bias) / 100 * (test.reduce((a, b) => a + b, 0) / test.length)).toFixed(0)} 件/期`);
  L('把预测整体上调 10% 后', (() => {
    const up = f.map((v) => v * 1.1);
    const su = M.summarize(test, up);
    return `MAE ${su.mae.toFixed(0)}（${su.mae > sm.mae ? '+' : ''}${((su.mae / sm.mae - 1) * 100).toFixed(1)}%）  MAPE ${su.mape.toFixed(1)}%  Bias ${su.bias.toFixed(1)}%（从 ${sm.bias.toFixed(1)}% 变来）`;
  })());
  // 间歇性低销量：把后 4 期压低并制造一个 0
  const t2 = test.slice();
  for (let i = 0; i < 4; i++) t2[t2.length - 4 + i] = Math.max(0, t2[t2.length - 4 + i] * 0.08);
  t2[t2.length - 2] = 0;
  const s2 = M.summarize(t2, f);
  L('间歇场景（后 4 期压低 + 1 个零点）',
    `MAPE ${s2.mape.toFixed(0)}%（原 ${sm.mape.toFixed(1)}%，放大 ${(s2.mape / sm.mape).toFixed(0)} 倍）  WAPE ${s2.wape.toFixed(1)}%（原 ${sm.wape.toFixed(1)}%，放大 ${(s2.wape / sm.wape).toFixed(1)} 倍）`);
  L('间歇场景排除期数 / Bias', `${s2.mapeExcluded} 期  Bias ${s2.bias.toFixed(1)}%（原 ${sm.bias.toFixed(1)}%）`);
  L('0 销量那一期的 APE', '数学上无定义（分母为 0），MAPE 会把它整期排除掉，而 WAPE 用总量做分母不受影响');
}

/* ── 第 7 讲：安全库存 ───────────────────────────────────────────────── */
H('第 7 讲 · 服务水平与安全库存（REQ-MOD-04）');
{
  const sigma = 861, L_ = 4, unitCost = 100, rate = 0.2;
  L('σ（月度预测残差）', `${sigma} 件/月`);
  L('采购提前期 L', `${L_} 个月`);
  for (const sl of [0.90, 0.95, 0.99, 0.999]) {
    const z = INV.zFactor(sl);
    const ss = INV.safetyStock({ sigma, leadTime: L_, serviceLevel: sl });
    const hc = INV.holdingCost({ safetyStockQty: ss, unitCost, holdingRate: rate });
    L(`  SL ${(sl * 100).toFixed(1)}%`, `Z=${z.toFixed(4)}  SS=${ss.toFixed(0)} 件  年持有成本 ${(hc / 10000).toFixed(2)} 万元  SS 增量成本 ${(ss * unitCost * rate).toFixed(0)} 元/年`);
  }
  // ★ 边际成本一律按「每 1 个百分点」算。第一版我按"每 0.01 个百分点"算，还把
  //   0.9 个百分点错当成 900 份（实际是 90 份），于是得出"99→99.9 的边际成本比
  //   95→99 低"这种反直觉结论 —— 换算错一位就会得出相反的结论。
  const ssAt = (sl) => INV.safetyStock({ sigma, leadTime: L_, serviceLevel: sl });
  const hcAt = (sl) => ssAt(sl) * unitCost * rate;
  const perPp = (a, b) => (hcAt(b) - hcAt(a)) / ((b - a) * 100);
  const ppA = perPp(0.95, 0.99), ppB = perPp(0.99, 0.999);
  L('95%→99%（4 个百分点）', `SS +${(ssAt(0.99) - ssAt(0.95)).toFixed(0)} 件  成本 +${((hcAt(0.99) - hcAt(0.95)) / 10000).toFixed(2)} 万元  = ${ppA.toFixed(0)} 元 / 每 1 个百分点`);
  L('99%→99.9%（0.9 个百分点）', `SS +${(ssAt(0.999) - ssAt(0.99)).toFixed(0)} 件  成本 +${((hcAt(0.999) - hcAt(0.99)) / 10000).toFixed(2)} 万元  = ${ppB.toFixed(0)} 元 / 每 1 个百分点`);
  L('两者之比', `${(ppB / ppA).toFixed(2)} 倍 —— 越往上，每提高 1 个百分点越贵`);
  L('Z 值增长', '1.6449 (95%) → 2.3263 (99%) → 3.0902 (99.9%)');
  L('月/周单位换算', `1 个月 ≈ ${INV.WEEKS_PER_MONTH} 周；σ 与 L 必须同单位`);
  L('单位错配的代价', `把周数当月份用 → L 被放大 ${INV.WEEKS_PER_MONTH} 倍 → SS 高估 ${Math.sqrt(INV.WEEKS_PER_MONTH).toFixed(2)} 倍；反向则低估同样倍数`);
  L('Φ⁻¹ 精度（与 scipy 对照）', '最大偏差 9.3e-15（p=0.999）、典型 4e-16 —— 实测记录在 tests/inventory.test.mjs');
  L('  4 周当成 4 个月用', `4 / ${INV.WEEKS_PER_MONTH} = ${(4 / INV.WEEKS_PER_MONTH).toFixed(2)} 个月`);
}

console.log('\n完成。讲义中引用的数字应与此输出一致；改了代码请重跑并同步 lectures/*.html。\n');
