/**
 * cleaning.js —— 时序数据清洗：异常值修复 + 缺货零值修复 (纯函数，无 DOM 依赖)
 *
 * ⚠️ 与需求规格书的一处差异（有意的，已在 meta.order 里回报给 UI）：
 *   规格书表格先列“异常值处理策略”再列“缺货断点处理策略”，但执行顺序必须是
 *   **先修缺货、再判异常**。原因：缺货期被置 0，Q1/Q3 会被这些假零拉低，
 *   下界变成 0 附近，真正的低异常点反而漏检；反过来把 0 当异常又被盖帽到
 *   上下界之上，丢失“缺货”这一语义。所以：
 *     stockoutMethod != 'keep'  → 先补齐零值，再在补齐后的序列上做异常检测；
 *     stockoutMethod == 'keep'  → 零值不参与 IQR 统计，也不被当作异常值盖帽
 *                                 （它们已由计划员判定为缺货，不是异常）。
 */

/** 线性插值分位数（等价 numpy.quantile 默认 method='linear'）。接受未排序输入。 */
export function quantile(values, p) {
  if (!Array.isArray(values) || values.length === 0) throw new RangeError('quantile: 输入为空');
  if (!(p >= 0 && p <= 1)) throw new RangeError(`quantile: p 需在 [0,1]，收到 ${p}`);
  const x = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (x.length === 0) throw new RangeError('quantile: 无非有限数值可用');
  if (x.length === 1) return x[0];
  const pos = p * (x.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return x[lo];
  return x[lo] + (pos - lo) * (x[hi] - x[lo]);
}

/** IQR 阈值区间：Q1/Q3 + 灵敏度 k → [Q1−k·IQR, Q3+k·IQR]。 */
export function iqrBounds(values, k = 1.5) {
  if (!(k > 0)) throw new RangeError(`iqrBounds: k 必须为正，收到 ${k}`);
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;
  return { q1, q3, iqr, lower: q1 - k * iqr, upper: q3 + k * iqr };
}

function assertSeries(values, fn) {
  if (!Array.isArray(values) || values.length === 0) throw new RangeError(`${fn}: 序列为空`);
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new RangeError(`${fn}: 第 ${i} 期非有限数值 (${values[i]})`);
  }
}

/**
 * Winsorization 盖帽截断：超出上下界的值就地截断到边界，保留序列长度与连续性。
 * @param {number[]} values
 * @param {number} k 灵敏度
 * @param {Set<number>} [exemptIdx] 豁免位置（如已知缺货零值），不参与统计也不被截断
 */
export function winsorize(values, k = 1.5, exemptIdx = new Set()) {
  assertSeries(values, 'winsorize');
  const pool = values.filter((_, i) => !exemptIdx.has(i));
  const b = iqrBounds(pool, k);
  const out = values.slice();
  const clipped = [];
  for (let i = 0; i < values.length; i++) {
    if (exemptIdx.has(i)) continue;
    if (values[i] > b.upper) {
      out[i] = b.upper;
      clipped.push({ index: i, from: values[i], to: b.upper, side: 'high' });
    } else if (values[i] < b.lower) {
      out[i] = b.lower;
      clipped.push({ index: i, from: values[i], to: b.lower, side: 'low' });
    }
  }
  return { values: out, clipped, bounds: b };
}

/** 中位数替换：异常点直接换成全序列中位数（比盖帽更粗暴，会丢失季节信息）。 */
export function medianReplace(values, k = 1.5, exemptIdx = new Set()) {
  assertSeries(values, 'medianReplace');
  const pool = values.filter((_, i) => !exemptIdx.has(i));
  const med = quantile(pool, 0.5);
  const b = iqrBounds(pool, k);
  const out = values.slice();
  const replaced = [];
  for (let i = 0; i < values.length; i++) {
    if (exemptIdx.has(i)) continue;
    if (values[i] > b.upper || values[i] < b.lower) {
      out[i] = med;
      replaced.push({ index: i, from: values[i], to: med });
    }
  }
  return { values: out, replaced, bounds: b, median: med };
}

/** 剔除异常点后用线性插值补齐（保留时间轴对齐，不留空洞）。 */
export function dropInterpolate(values, k = 1.5, exemptIdx = new Set()) {
  assertSeries(values, 'dropInterpolate');
  const pool = values.filter((_, i) => !exemptIdx.has(i));
  const b = iqrBounds(pool, k);
  const kept = values.map((v, i) => (!exemptIdx.has(i) && (v > b.upper || v < b.lower) ? null : v));
  const removed = [];
  kept.forEach((v, i) => { if (v === null) removed.push({ index: i, from: values[i] }); });
  return { values: linearFill(kept), removed, bounds: b };
}

/**
 * 在含 null 的序列上做线性插值补齐；两端用最近的已知值外延（无法插值时的诚实降级）。
 * @param {(number|null)[]} arr
 */
export function linearFill(arr) {
  const out = arr.slice();
  const known = [];
  out.forEach((v, i) => { if (v !== null && Number.isFinite(v)) known.push(i); });
  if (known.length === 0) throw new RangeError('linearFill: 没有任何已知点可插值');
  if (known.length === 1) return out.map((v) => (v === null ? out[known[0]] : v));
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null && Number.isFinite(out[i])) continue;
    // 找左右最近的已知点
    let lo = -1;
    let hi = -1;
    for (const k2 of known) { if (k2 < i) lo = k2; else { hi = k2; break; } }
    if (lo === -1) out[i] = out[hi];
    else if (hi === -1) out[i] = out[lo];
    else out[i] = out[lo] + ((out[hi] - out[lo]) * (i - lo)) / (hi - lo);
  }
  return out;
}

/**
 * 缺货零值区间侦测：连续为 0 且长度 >= minLen 的区间。
 * 单期 0 可能是真实零需求，故默认要求“连续”2 期以上。
 */
export function detectStockoutRuns(values, { minLen = 2 } = {}) {
  assertSeries(values, 'detectStockoutRuns');
  if (!Number.isInteger(minLen) || minLen < 1) throw new RangeError(`detectStockoutRuns: minLen 需 >=1，收到 ${minLen}`);
  const runs = [];
  let s = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === 0) { if (s === -1) s = i; } else if (s !== -1) {
      if (i - s >= minLen) runs.push([s, i - 1]);
      s = -1;
    }
  }
  if (s !== -1 && values.length - s >= minLen) runs.push([s, values.length - 1]);
  return runs;
}

/**
 * 缺货区间修复。
 *   method='linear' → 用区间前后两个已知点线性插值；
 *   method='yoy'    → 用去年同期的值（需 period 期前的数据）；
 * 区间落在序列首/尾（缺一侧邻居）时，用另一侧最近已知值外延，并在 meta 里标注。
 */
export function repairStockouts(values, runs, { method = 'linear', period = 12 } = {}) {
  assertSeries(values, 'repairStockouts');
  if (method !== 'linear' && method !== 'yoy') {
    throw new RangeError(`repairStockouts: method 只能是 linear / yoy，收到 ${method}`);
  }
  const out = values.slice();
  const filled = [];
  const lastKnownBefore = (i) => {
    for (let j = i - 1; j >= 0; j--) if (out[j] > 0) return { index: j, value: out[j] };
    return null;
  };
  const firstKnownAfter = (i) => {
    for (let j = i + 1; j < out.length; j++) if (out[j] > 0) return { index: j, value: out[j] };
    return null;
  };
  for (const [s, e] of runs) {
    // 区间内已全为 0，故左右参照点都在区间之外取值，逐点赋值不会污染插值锚点
    const L = lastKnownBefore(s);
    const R = firstKnownAfter(e);
    for (let i = s; i <= e; i++) {
      let v;
      let how;
      if (method === 'yoy' && i - period >= 0 && out[i - period] > 0) {
        v = out[i - period];
        how = 'yoy';
      } else if (L && R) {
        v = L.value + ((R.value - L.value) * (i - L.index)) / (R.index - L.index);
        how = 'linear';
      } else if (L) {
        v = L.value;
        how = 'extrapolate-head';
      } else if (R) {
        v = R.value;
        how = 'extrapolate-tail';
      } else {
        throw new RangeError('repairStockouts: 序列全为 0，无任何已知水平可参考');
      }
      out[i] = v;
      filled.push({ index: i, value: v, how });
    }
  }
  return { values: out, filled };
}

/** 描述性统计（清洗前后对比卡片用）。std 为样本标准差；cv = std/mean × 100%。 */
export function describe(values) {
  assertSeries(values, 'describe');
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    n,
    mean,
    std,
    cv: mean === 0 ? NaN : (std / mean) * 100,
    median: quantile(values, 0.5),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export const OUTLIER_METHODS = ['keep', 'winsorize', 'median', 'drop-interpolate'];
export const STOCKOUT_METHODS = ['keep', 'linear', 'yoy'];

/**
 * 模块 0 的主入口：一次调用完成「缺货修复 → 异常处理」全链路。
 *
 * @param {number[]} values 脏序列
 * @param {object} o
 * @param {'keep'|'winsorize'|'median'|'drop-interpolate'} o.outlierMethod
 * @param {number} o.k 异常灵敏度
 * @param {'keep'|'linear'|'yoy'} o.stockoutMethod
 * @param {number} o.period 季节周期（yoy 用）
 * @param {number} o.minRunLen 缺货判定的最小连续长度
 */
export function cleanSeries(values, {
  outlierMethod = 'keep', k = 1.5, stockoutMethod = 'keep', period = 12, minRunLen = 2,
} = {}) {
  assertSeries(values, 'cleanSeries');
  if (!OUTLIER_METHODS.includes(outlierMethod)) throw new RangeError(`cleanSeries: 未知异常处理策略 ${outlierMethod}`);
  if (!STOCKOUT_METHODS.includes(stockoutMethod)) throw new RangeError(`cleanSeries: 未知缺货处理策略 ${stockoutMethod}`);

  const before = describe(values);
  let work = values.slice();
  const meta = {
    order: 'stockout → outlier',
    stockoutRuns: detectStockoutRuns(work, { minLen: minRunLen }),
    filled: [],
    clipped: [],
    replaced: [],
    removed: [],
    bounds: null,
  };

  // ① 缺货修复
  if (stockoutMethod !== 'keep' && meta.stockoutRuns.length > 0) {
    const r = repairStockouts(work, meta.stockoutRuns, { method: stockoutMethod, period });
    work = r.values;
    meta.filled = r.filled;
  }

  // ② 异常值处理（'keep' 的零值豁免：它们是已知缺货，不是异常）
  const exempt = new Set();
  if (stockoutMethod === 'keep') {
    for (const [s, e] of meta.stockoutRuns) for (let i = s; i <= e; i++) exempt.add(i);
  }
  meta.exemptZeroCount = exempt.size;

  if (outlierMethod === 'winsorize') {
    const r = winsorize(work, k, exempt);
    work = r.values; meta.clipped = r.clipped; meta.bounds = r.bounds;
  } else if (outlierMethod === 'median') {
    const r = medianReplace(work, k, exempt);
    work = r.values; meta.replaced = r.replaced; meta.bounds = r.bounds;
  } else if (outlierMethod === 'drop-interpolate') {
    const r = dropInterpolate(work, k, exempt);
    work = r.values; meta.removed = r.removed; meta.bounds = r.bounds;
  }

  return { values: work, before, after: describe(work), meta };
}
