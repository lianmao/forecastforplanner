/**
 * promo_sim.test.mjs —— 促销拉升/透支模型 + 折扣弹性 κ 的还原能力。
 *
 * ★ 这里最重要的一条断言是「模型能不能把生成侧的真值学回来」。
 *   容差不是拍脑袋定的：scripts/calibrate-promo.mjs 实测 8 个种子下
 *   平均相对误差 6.7%、最差 16.2%，所以这里用「单种子 < 14%、多种子平均 < 15%」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  liftFactor, promoEffect, applyPromo, buildFeatureMatrix, fitPromoModel,
  forecastScenario, featureVector, DEFAULT_PROMOS, PROMO_FEATURE_NAMES, INTERACTION_NAME,
} from '../src/core/promo_sim.js';
import { makePromoDataset, synthSeries } from '../src/core/generator.js';

test('liftFactor = 1 + κ(1−d)^η，且 η=1 时对 (1−d) 严格线性', () => {
  assert.equal(liftFactor({ discount: 0.8, kappa: 2.5, eta: 1 }), 1.5);
  assert.equal(liftFactor({ discount: 0.6, kappa: 2.5, eta: 1 }) - 1, 2.5 * 0.4);
  assert.equal(liftFactor({ discount: 1, kappa: 2.5, eta: 1 }), 1, '不打折不应有拉升');
  // η<1 表示边际效应递减更慢（折扣越深、增量越大得越快）
  assert.ok(liftFactor({ discount: 0.8, kappa: 2.5, eta: 0.5 }) > liftFactor({ discount: 0.8, kappa: 2.5, eta: 1 }));
  assert.throws(() => liftFactor({ discount: 0 }), /折扣需在/);
  assert.throws(() => liftFactor({ discount: 1.2 }), /折扣需在/);
  assert.throws(() => liftFactor({ discount: 0.8, kappa: -1 }), /κ 需 >=0/);
  assert.throws(() => liftFactor({ discount: 0.8, eta: 0 }), /η 需 >0/);
});

test('promoEffect：拉升量与透支量手算核对', () => {
  const e = promoEffect({ base: 1000, discount: 0.8, kappa: 2.5, eta: 1, lambda: 0.45 });
  assert.equal(e.liftFactor, 1.5);
  assert.equal(e.liftQty, 500);
  assert.deepEqual(e.dips, [-225, -112.5]);
});

test('applyPromo 在平坦序列上的精确效果，且不污染传入数组', () => {
  const flat = new Array(10).fill(1000);
  const snapshot = flat.slice();
  const r = applyPromo(flat, { promos: [{ index: 5, discount: 0.8 }] });
  assert.equal(r.values[5], 1500);
  assert.equal(r.values[6], 775);
  assert.equal(r.values[7], 887.5);
  assert.equal(r.values[4], 1000);
  assert.equal(r.values[8], 1000);
  assert.deepEqual(flat, snapshot, 'applyPromo 不能改动调用方数组');
  assert.throws(() => applyPromo(flat, { promos: [{ index: 99, discount: 0.8 }] }), /促销位置越界/);
});

test('透支必须在促销后两期内衰减，且总额小于拉升额（不能无中生有）', () => {
  const r = applyPromo(new Array(12).fill(1000), { promos: [{ index: 3, discount: 0.7, }] });
  const lift = r.lift[0].delta;
  const dips = r.dip.map((d) => d.delta);
  assert.equal(dips.length, 2);
  assert.ok(dips[0] < 0 && dips[1] < 0);
  assert.ok(Math.abs(dips[1]) < Math.abs(dips[0]), '第二期透支幅度应更小');
  assert.ok(Math.abs(dips.reduce((a, b) => a + b, 0)) < lift, '透支总量应小于拉升量');
});

test('buildFeatureMatrix：行数与交互项列的定义', () => {
  const values = new Array(10).fill(1000);
  const promos = [{ index: 5, discount: 0.8 }];
  const m = buildFeatureMatrix(values, { promos, startMonth: 1 });
  assert.equal(m.rows.length, 8, 'n−2 行（需要 lag1/lag2）');
  assert.deepEqual(m.rows, [2, 3, 4, 5, 6, 7, 8, 9]);
  const rowIdx = m.rows.indexOf(5);
  const intIdx = m.names.indexOf(INTERACTION_NAME);
  assert.ok(intIdx >= 0);
  // 交互项 = (1−d) × Lag1。注意 1−0.8 = 0.19999999999999996（不是精确的 0.2），
  // 所以断言用 1e-9 容差 —— 要求它等于 200 是在要求浮点数做不可能的事。
  assert.ok(Math.abs(m.X[rowIdx][intIdx] - 200) < 1e-9,
    `交互项 ${m.X[rowIdx][intIdx]}，期望 ≈ 200`);
  assert.notEqual(m.X[rowIdx][intIdx], 200);
  // 非促销行的交互项为 0
  assert.equal(m.X[m.rows.indexOf(6)][intIdx], 0);
  assert.equal(m.kept.length, m.names.length);
});

test('featureVector 与 buildFeatureMatrix 逐列一致（训练/预测同一条路径）', () => {
  const values = [1000, 1020, 990, 1050, 1100, 1080];
  const m = buildFeatureMatrix(values, { promos: [{ index: 4, discount: 0.7 }], startMonth: 1 });
  for (let r = 0; r < m.rows.length; r++) {
    const i = m.rows[r];
    const discount = i === 4 ? 0.7 : null;
    const v = featureVector({
      lag1: values[i - 1], lag2: values[i - 2], discount, monthIdx: (i % 12),
    });
    assert.deepEqual(m.X[r], m.kept.map((j) => v[j]), `第 ${r} 行不一致`);
  }
});

test('恒定的特征列被剔除并如实回报（而不是让整模块崩掉）', () => {
  const nat = synthSeries({ n: 40, seed: 21 });
  const m = buildFeatureMatrix(nat.values, { promos: [], startMonth: 1 });
  assert.ok(m.dropped.includes('Promo 促销标志'));
  assert.ok(m.dropped.includes(INTERACTION_NAME));
  assert.ok(!m.names.includes(INTERACTION_NAME));
  // 有促销时该列应保留
  const m2 = buildFeatureMatrix(nat.values, { promos: DEFAULT_PROMOS, startMonth: 1 });
  assert.ok(m2.names.includes(INTERACTION_NAME));
});

test('★ 核心断言：从数据里把折扣弹性 κ 学回来（真值 2.5，单种子容差 14%）', () => {
  const d = makePromoDataset({ n: 40, seed: 21, kappa: 2.5, eta: 1 });
  const r = fitPromoModel(d.values, { promos: d.promos, startMonth: 1, kappa: 2.5 });
  assert.ok(r.identifiable, '有 8 次不同折扣的促销时，弹性必须可识别');
  const errPct = Math.abs(r.recoveredKappa - 2.5) / 2.5 * 100;
  assert.ok(errPct < 14, `学回 κ=${r.recoveredKappa.toFixed(3)}，相对误差 ${errPct.toFixed(1)}% 超限`);
  // 标准误必须有限且为正（否则 t 值无从判断，UI 也无法提示“这次估得准不准”）
  const imp = r.importance.find((x) => x.name === INTERACTION_NAME);
  assert.ok(imp.se > 0 && Number.isFinite(imp.t));
});

test('★ 多种子扫描：不是挑种子挑出来的好结果（平均误差 < 15%，每个 < 30%）', () => {
  const errs = [];
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    const d = makePromoDataset({ n: 40, seed, kappa: 2.5, eta: 1 });
    const r = fitPromoModel(d.values, { promos: d.promos, startMonth: 1 });
    assert.ok(r.recoveredKappa > 0, `seed=${seed} 学回了非正的弹性 ${r.recoveredKappa}`);
    errs.push(Math.abs(r.recoveredKappa - 2.5) / 2.5);
  }
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(Math.max(...errs) < 0.30, `最差相对误差 ${(Math.max(...errs) * 100).toFixed(1)}%`);
  assert.ok(mean < 0.15, `平均相对误差 ${(mean * 100).toFixed(1)}%`);
});

test('负向对照：只有一次促销时，模型直接拒绝给数（比给一个看似确定的错数字好）', () => {
  const nat = synthSeries({ n: 40, base: 1000, trend: 6, seasonality: 120, noise: 50, seed: 21 });
  const one = [{ index: 20, discount: 0.8 }];
  const { values } = applyPromo(nat.values, { promos: one, kappa: 2.5, eta: 1 });
  // 38 行里只有 1 行是促销 → 促销标志与强度交互列近乎恒定，
  // 设计矩阵接近秩亏（实测最小/最大主元 ≈ 2.7e-18，已触机器精度）。
  // 正确行为是**拒绝**，而不是返回一个伪解（那才会骗到计划员）。
  assert.throws(() => fitPromoModel(values, { promos: one, startMonth: 1 }), /接近秩亏|奇异/);
  // 对照：8 次不同折扣的促销下同一份数据可以正常求解
  const d = makePromoDataset({ n: 40, seed: 21 });
  assert.doesNotThrow(() => fitPromoModel(d.values, { promos: d.promos, startMonth: 1 }));
});

test('forecastScenario：折扣越深，情景增量越大；不开促销时增量为 0', () => {
  const d = makePromoDataset({ n: 40, seed: 21 });
  const base = forecastScenario(d.values, { discount: null, promos: d.promos, startMonth: 1 });
  assert.equal(base.lift, 0, '不开促销时增量必须为 0');
  const lifts = [0.95, 0.85, 0.7, 0.6, 0.5].map((disc) => {
    const s = forecastScenario(d.values, { discount: disc, promos: d.promos, startMonth: 1 });
    assert.ok(s.withPromo > s.withoutPromo, `折扣 ${disc} 的促销情景应高于无促销情景`);
    assert.ok(Math.abs(s.lift - (s.withPromo - s.withoutPromo)) < 1e-9);
    return s.lift;
  });
  for (let i = 1; i < lifts.length; i++) {
    assert.ok(lifts[i] > lifts[i - 1], `折扣加深时增量应单调增大：${lifts[i - 1]} → ${lifts[i]}`);
  }
});

test('DEFAULT_PROMOS 的设计约束：次数够、折扣区间够宽、彼此间隔 ≥3 期', () => {
  assert.ok(DEFAULT_PROMOS.length >= 6, '促销次数太少则弹性不可识别');
  const discs = DEFAULT_PROMOS.map((p) => p.discount);
  assert.ok(Math.max(...discs) - Math.min(...discs) >= 0.3, '折扣区间必须够宽');
  assert.equal(new Set(discs).size, discs.length, '折扣力度不应重复');
  for (let i = 1; i < DEFAULT_PROMOS.length; i++) {
    assert.ok(DEFAULT_PROMOS[i].index - DEFAULT_PROMOS[i - 1].index >= 3,
      '促销间隔过近会让透支期与下一次促销互相污染');
  }
});

test('特征名表与生成的特征列数一致（防止加了列忘了改名）', () => {
  const m = buildFeatureMatrix(new Array(10).fill(1000), { promos: DEFAULT_PROMOS, startMonth: 1 });
  assert.equal(PROMO_FEATURE_NAMES.length, 7);
  assert.equal(m.X[0].length, m.names.length);
});
