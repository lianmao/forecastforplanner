/**
 * inventory.test.mjs —— Φ⁻¹ 精度、安全库存公式、成本非线性凸性。
 *
 * 这一模块直接决定「向老板要多少钱」，所以断言必须钉到小数位。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normInv, normCdf, normPdf, erf, erfc, zFactor, safetyStock, holdingCost,
  inventoryScenario, serviceLevelCurve, escalate, WEEKS_PER_MONTH,
} from '../src/core/inventory.js';

/** 与 scipy.stats.norm.ppf 对照的参考值（双精度）。 */
const REFERENCE = [
  [0.500000, 0],
  [0.900000, 1.2815515655446004],
  [0.950000, 1.6448536269514722],
  [0.975000, 1.959963984540054],
  [0.990000, 2.3263478740408408],
  [0.995000, 2.5758293035489004],
  [0.999000, 3.090232306167813],
  [0.999900, 3.71901648545568],
];

test('normInv 对 scipy.stats.norm.ppf 参考值误差 < 1e-14', () => {
  // 阈值说明：Acklam 初值经两步 Halley 精修后，与 scipy 的实测最大偏差是 9.3e-15
  // （p=0.999），典型 4e-16。1e-14 是留了一档余量的诚实边界，不是“完全一致”。
  let worst = 0;
  for (const [p, z] of REFERENCE) {
    const diff = Math.abs(normInv(p) - z);
    worst = Math.max(worst, diff);
    assert.ok(diff < 1e-14, `Φ⁻¹(${p}) 偏差 ${diff.toExponential(2)} 超限`);
  }
  assert.ok(worst < 1e-14, `实测最大偏差 ${worst.toExponential(2)}`);
});

test('normInv 与 normCdf 互为精确逆（回环误差 < 1e-16，即亚 ULP 量级）', () => {
  // 实测最大偏差 2.776e-17。1 ULP 在 p≈0.999 附近约 1.1e-16，
  // 所以这是「不到一个 ULP」—— 两个函数出自同一套定义、互为精确逆。
  let worst = 0;
  for (const p of [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 0.999, 0.9999]) {
    const rt = normCdf(normInv(p));
    worst = Math.max(worst, Math.abs(rt - p));
  }
  assert.ok(worst < 1e-16, `回环最大偏差 ${worst.toExponential(3)}`);
});

test('erf/erfc/normPdf 已知点核对（容差按 erfc 逼近的实际能力定）', () => {
  // erfc 的 Chebyshev 展开实测绝对误差 ~1.6e-15（erfc(0)=1.0000000000000016），
  // 所以这里不能用 1e-16 级别的容差 —— 那是在要求逼近做得比它还准。
  assert.ok(Math.abs(erf(0)) < 2e-15, `erf(0) = ${erf(0)}`);
  assert.ok(Math.abs(erfc(0) - 1) < 2e-15);
  assert.ok(Math.abs(erf(1) - 0.8427007929497149) < 1e-14);
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-15);
  assert.ok(Math.abs(normPdf(0) - 1 / Math.sqrt(2 * Math.PI)) < 1e-16);
  assert.ok(Math.abs(normCdf(1.96) - 0.9750021048517795) < 1e-14);
  // 对称性：Φ(−x) = 1 − Φ(x)
  assert.ok(Math.abs(normCdf(-1.5) - (1 - normCdf(1.5))) < 1e-15);
});

test('normInv 对称性：Φ⁻¹(1−p) = −Φ⁻¹(p)', () => {
  for (const p of [0.01, 0.1, 0.25, 0.4]) {
    assert.ok(Math.abs(normInv(1 - p) + normInv(p)) < 1e-14, `p=${p}`);
  }
});

test('normInv 端点与非法输入', () => {
  assert.equal(normInv(0), -Infinity);
  assert.equal(normInv(1), Infinity);
  assert.throws(() => normInv(-0.1), /需在 \(0,1\)/);
  assert.throws(() => normInv(2), /需在 \(0,1\)/);
});

test('zFactor 把百分比误当小数传入时必须报错（而不是算出离谱的库存）', () => {
  assert.equal(zFactor(0.95).toFixed(12), '1.644853626951');
  assert.equal(zFactor(0.99).toFixed(12), '2.326347874041');
  assert.throws(() => zFactor(95), /服务水平需在 \(0,1\)/);
});

test('safetyStock = Z·σ·√L 精确值核对', () => {
  const ss = safetyStock({ sigma: 100, leadTime: 4, serviceLevel: 0.95 });
  assert.equal(ss.toFixed(10), (1.6448536269514722 * 100 * 2).toFixed(10));
  assert.equal(ss.toFixed(4), '328.9707');
  // √L 的次线性：交期翻 4 倍，SS 只翻 2 倍
  const ss16 = safetyStock({ sigma: 100, leadTime: 16, serviceLevel: 0.95 });
  assert.equal(ss16.toFixed(6), (ss * 2).toFixed(6));
});

test('σ 或 L 为 0 / 负数必须报错（否则会静默给出 0 安全库存）', () => {
  assert.throws(() => safetyStock({ sigma: -1, leadTime: 4, serviceLevel: 0.95 }), /sigma 需 >=0/);
  assert.throws(() => safetyStock({ sigma: 100, leadTime: 0, serviceLevel: 0.95 }), /leadTime 需 >0/);
  assert.equal(safetyStock({ sigma: 0, leadTime: 4, serviceLevel: 0.95 }), 0);
});

test('单位不一致的代价可量化：σ 按月、L 按周混用时 SS 会偏大 √4.345 倍', () => {
  const correct = safetyStock({ sigma: 100, leadTime: 4 / WEEKS_PER_MONTH, serviceLevel: 0.95 });
  const wrong = safetyStock({ sigma: 100, leadTime: 4, serviceLevel: 0.95 });
  const ratio = wrong / correct;
  assert.ok(Math.abs(ratio - Math.sqrt(WEEKS_PER_MONTH)) < 1e-12, `实际倍数 ${ratio}`);
  assert.ok(ratio > 2.08 && ratio < 2.09, '这正是“单位混用”在真实项目里最贵的一个错');
});

test('holdingCost = SS × 单件成本 × 持有率', () => {
  const c = holdingCost({ safetyStockQty: 328.97072539029444, unitCost: 100, holdingRate: 0.2 });
  assert.equal(c.toFixed(6), (328.97072539029444 * 20).toFixed(6));
  assert.throws(() => holdingCost({ safetyStockQty: 10, unitCost: 0, holdingRate: 0.2 }), /unitCost 需 >0/);
  assert.throws(() => holdingCost({ safetyStockQty: 10, unitCost: 100, holdingRate: 0 }), /holdingRate 需 >0/);
});

test('serviceLevelCurve：90%→99.9% 步长 0.1% 共 100 个点，成本严格单调递增', () => {
  const pts = serviceLevelCurve({ sigma: 100, leadTime: 4, unitCost: 100, holdingRate: 0.2 });
  assert.equal(pts.length, 100);
  assert.equal(pts[0].serviceLevel.toFixed(4), '0.9000');
  assert.equal(pts[99].serviceLevel.toFixed(4), '0.9990');
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i].holdingCost > pts[i - 1].holdingCost, `第 ${i} 点成本未递增`);
    assert.ok(pts[i].safetyStock > pts[i - 1].safetyStock);
  }
});

test('成本曲线的凸性（“非线性爆炸”的可证明部分）：越靠上，每提高 1 个百分点越贵', () => {
  const base = { sigma: 100, leadTime: 4, unitCost: 100, holdingRate: 0.2 };
  const e1 = escalate({ ...base, from: 0.95, to: 0.99 });
  const e2 = escalate({ ...base, from: 0.99, to: 0.999 });
  const slope1 = e1.deltaHoldingCost / (0.99 - 0.95);
  const slope2 = e2.deltaHoldingCost / (0.999 - 0.99);
  assert.ok(slope2 > slope1, `第二段斜率 ${slope2.toFixed(0)} 应大于第一段 ${slope1.toFixed(0)}`);
  assert.ok(slope2 / slope1 > 3, `斜率放大约 ${(slope2 / slope1).toFixed(2)} 倍（要求 > 3 倍）`);
});

test('escalate 给出完整的“卖方压力”对话弹药', () => {
  const r = escalate({ sigma: 100, leadTime: 4, unitCost: 100, holdingRate: 0.2, from: 0.95, to: 0.99 });
  assert.equal(r.from.z.toFixed(6), '1.644854');
  assert.equal(r.to.z.toFixed(6), '2.326348');
  assert.ok(r.deltaSafetyStock > 0);
  assert.ok(r.deltaHoldingCost > 0);
  assert.equal(r.deltaHoldingCostPct.toFixed(4), (((2.3263478740408408 / 1.6448536269514722) - 1) * 100).toFixed(4));
  // 缺货概率从 5% 降到 1% = 相对降幅 80%
  assert.equal(r.missingRateReductionPct.toFixed(6), '80.000000');
  assert.equal(r.zGrowthPct.toFixed(4), (((2.3263478740408408 / 1.6448536269514722) - 1) * 100).toFixed(4));
});

test('负向对照：把服务水平往上推时，成本绝不能下降（单调性断言有区分度）', () => {
  const base = { sigma: 100, leadTime: 4, unitCost: 100, holdingRate: 0.2 };
  const goDown = escalate({ ...base, from: 0.99, to: 0.95 });
  assert.ok(goDown.deltaHoldingCost < 0, '降服务水平必须降成本，否则公式写反了');
  assert.ok(goDown.missingRateReductionPct < 0);
});

test('inventoryScenario 与分步计算一致；非法服务水平抛错', () => {
  const s = inventoryScenario({ sigma: 100, leadTime: 4, serviceLevel: 0.95, unitCost: 100, holdingRate: 0.2 });
  assert.equal(s.z, zFactor(0.95));
  assert.equal(s.safetyStock, safetyStock({ sigma: 100, leadTime: 4, serviceLevel: 0.95 }));
  assert.equal(s.holdingCost, holdingCost({ safetyStockQty: s.safetyStock, unitCost: 100, holdingRate: 0.2 }));
  assert.throws(() => inventoryScenario({ sigma: 100, leadTime: 4, serviceLevel: 1, unitCost: 10, holdingRate: 0.2 }), /服务水平需在/);
});
