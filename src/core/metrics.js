/**
 * metrics.js —— 预测误差度量 (纯函数，无 DOM 依赖)
 *
 * ★ 单位约定（容易搞错，务必看清）：
 *   mae / rmse / residualStd  → 与销量同量纲（件）
 *   mape / wape / bias        → 百分数，返回 2.91 表示 2.91%（不是 0.0291）
 *
 * ★ 符号约定：
 *   误差 e = 实际 A − 预测 F（残差方向）
 *   Bias = Σ(F − A) / Σ(A) × 100
 *     Bias > 0 → 系统性高估（乐观过剩）→ 呆滞库存、资金沉淀
 *     Bias < 0 → 系统性低估（悲观短缺）→ 断货、紧急调货
 */

function assertPair(actual, forecast, fn) {
  if (!Array.isArray(actual) || !Array.isArray(forecast)) {
    throw new RangeError(`${fn}: actual / forecast 必须是数组`);
  }
  if (actual.length === 0) throw new RangeError(`${fn}: 输入为空`);
  if (actual.length !== forecast.length) {
    throw new RangeError(`${fn}: 长度不一致 actual=${actual.length} forecast=${forecast.length}`);
  }
  for (let i = 0; i < actual.length; i++) {
    if (!Number.isFinite(actual[i]) || !Number.isFinite(forecast[i])) {
      throw new RangeError(`${fn}: 第 ${i} 期存在非有限数值 (${actual[i]}, ${forecast[i]})`);
    }
  }
}

/** 平均绝对误差 MAE —— “平均每期偏离多少件实物”，最直观。 */
export function mae(actual, forecast) {
  assertPair(actual, forecast, 'mae');
  let s = 0;
  for (let i = 0; i < actual.length; i++) s += Math.abs(actual[i] - forecast[i]);
  return s / actual.length;
}

/** 均方根误差 RMSE —— 对大偏差惩罚更重（平方放大），对大额爆单更敏感。 */
export function rmse(actual, forecast) {
  assertPair(actual, forecast, 'rmse');
  let s = 0;
  for (let i = 0; i < actual.length; i++) {
    const e = actual[i] - forecast[i];
    s += e * e;
  }
  return Math.sqrt(s / actual.length);
}

/**
 * 平均绝对百分比误差 MAPE。
 * ★ 刻意保留它的缺陷以便教学：实际值为 0 的期无法计算（除零），
 *   低销量期会把百分比推到天文数字 —— 这正是“MAPE 失真”。
 * 返回 { value, excluded, zeroPeriods, n }：value 只对非零实际期取均值；
 * 若全为 0，value = NaN（无法定义）。
 */
export function mape(actual, forecast) {
  assertPair(actual, forecast, 'mape');
  let s = 0;
  let used = 0;
  const zeroPeriods = [];
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === 0) { zeroPeriods.push(i); continue; }
    s += Math.abs((actual[i] - forecast[i]) / actual[i]);
    used += 1;
  }
  return {
    value: used === 0 ? NaN : (s / used) * 100,
    excluded: zeroPeriods.length,
    zeroPeriods,
    n: actual.length,
  };
}

/**
 * 加权百分比误差 WAPE = Σ|A−F| / Σ|A| × 100。
 * 用总量做分母 → 消除除零问题，反映大盘真实偏差（推荐用这个汇报）。
 * 若 Σ|A| = 0 则无法定义，返回 NaN。
 */
export function wape(actual, forecast) {
  assertPair(actual, forecast, 'wape');
  let num = 0;
  let den = 0;
  for (let i = 0; i < actual.length; i++) {
    num += Math.abs(actual[i] - forecast[i]);
    den += Math.abs(actual[i]);
  }
  return den === 0 ? NaN : (num / den) * 100;
}

/**
 * 预测偏向性 Bias = Σ(F−A) / Σ(A) × 100（按需求规格书的定义，分母不含绝对值）。
 * 正 → 高估；负 → 低估。Σ(A)=0 时返回 NaN。
 */
export function bias(actual, forecast) {
  assertPair(actual, forecast, 'bias');
  let num = 0;
  let den = 0;
  for (let i = 0; i < actual.length; i++) {
    num += forecast[i] - actual[i];
    den += actual[i];
  }
  return den === 0 ? NaN : (num / den) * 100;
}

/**
 * 残差标准差 σ = std(A − F)，样本标准差（n−1）。
 * 这是模块 7 安全库存的输入：SS = Z · σ · √L。
 * 用样本标准差而非总体标准差：残差是对总体误差的一次抽样。
 */
export function residualStd(actual, forecast) {
  assertPair(actual, forecast, 'residualStd');
  const n = actual.length;
  if (n < 2) throw new RangeError('residualStd: 至少需要 2 期才能估标准差');
  let mean = 0;
  for (let i = 0; i < n; i++) mean += actual[i] - forecast[i];
  mean /= n;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = (actual[i] - forecast[i]) - mean;
    s += d * d;
  }
  return Math.sqrt(s / (n - 1));
}

/** 一次性汇总全部指标，供误差看板（模块 6）直接消费。 */
export function summarize(actual, forecast) {
  const m = mape(actual, forecast);
  return {
    n: actual.length,
    mae: mae(actual, forecast),
    rmse: rmse(actual, forecast),
    mape: m.value,
    mapeExcluded: m.excluded,
    mapeZeroPeriods: m.zeroPeriods,
    wape: wape(actual, forecast),
    bias: bias(actual, forecast),
    residualStd: residualStd(actual, forecast),
  };
}

/**
 * 业务风险分级（模块 6 的预警灯）。
 * 依据 Bias 方向与幅度：|Bias| <= 5% 视为健康。
 */
export function biasRisk(biasPct) {
  if (!Number.isFinite(biasPct)) return { level: 'unknown', label: '无法计算', hint: '当期实际需求为 0，百分比类指标无定义' };
  if (biasPct > 10) return { level: 'danger-high', label: '库存积压与报废风险', hint: `预测系统性高估 ${biasPct.toFixed(1)}%，呆滞库存与资金占用将持续累积` };
  if (biasPct > 5) return { level: 'warn-high', label: '轻度乐观偏向', hint: `高估 ${biasPct.toFixed(1)}%，建议复核是否高估了大客户订单` };
  if (biasPct < -10) return { level: 'danger-low', label: '缺料停产与客户流失风险', hint: `预测系统性低估 ${Math.abs(biasPct).toFixed(1)}%，将出现频繁断货与紧急调货` };
  if (biasPct < -5) return { level: 'warn-low', label: '轻度悲观偏向', hint: `低估 ${Math.abs(biasPct).toFixed(1)}%，存在缺货隐患` };
  return { level: 'ok', label: '偏向健康', hint: '预测无系统性偏差，误差主要来自随机波动' };
}
