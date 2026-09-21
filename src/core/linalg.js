/**
 * linalg.js —— 最小二乘求解器（供促销特征模型与 Prophet 类 GAM 使用）(纯函数)
 *
 * 三条来自实战的硬规则，别绕过：
 *
 * 1. **内部先标准化再解正规方程**。特征量纲跨好几个数量级时（月序数 ~20、原始量级 ~1e5），
 *    X'X 的条件数会烂到系数变成 ±0.9 / +2.8 的乱码。这里对非截距列标准化，
 *    解完再通过雅可比矩阵把系数**与标准误**一起换算回原尺度。
 *
 * 2. **秩亏必须报警，不能给伪解**。行数不足以支撑参数个数时，统计库常常返回
 *    一个最小范数“伪解”，看起来像个分数，其实根本不是拟合。这里直接拒绝。
 *
 * 3. **常量列必须点名报错**。常量列与截距完全共线，报错信息里要指出是第几列，
 *    否则用户只看到“秩亏”三个字无从排查。
 */

function assertMatrix(X, y, fn) {
  if (!Array.isArray(X) || !Array.isArray(y)) throw new RangeError(`${fn}: X / y 必须是数组`);
  if (X.length === 0) throw new RangeError(`${fn}: 输入为空`);
  if (X.length !== y.length) throw new RangeError(`${fn}: X 行数 ${X.length} 与 y 长度 ${y.length} 不一致`);
  const p = X[0].length;
  if (!Number.isInteger(p) || p < 1) throw new RangeError(`${fn}: X 每行至少 1 列`);
  for (let i = 0; i < X.length; i++) {
    if (!Array.isArray(X[i]) || X[i].length !== p) throw new RangeError(`${fn}: 第 ${i} 行列数不一致`);
    for (let j = 0; j < p; j++) {
      if (!Number.isFinite(X[i][j])) throw new RangeError(`${fn}: X[${i}][${j}] 非有限数值`);
    }
    if (!Number.isFinite(y[i])) throw new RangeError(`${fn}: y[${i}] 非有限数值`);
  }
  return p;
}

/** 高斯-约当消元求逆（带部分主元），同时返回主元最小值用于奇异性判断。 */
function invert(A0) {
  const n = A0.length;
  const A = A0.map((row) => row.slice());
  const I = A.map((_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  let minPivot = Infinity;
  let maxPivot = 0;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (piv !== c) {
      [A[c], A[piv]] = [A[piv], A[c]];
      [I[c], I[piv]] = [I[piv], I[c]];
    }
    const d = A[c][c];
    if (d === 0) return { inv: null, minPivot: 0, maxPivot: 1 };
    minPivot = Math.min(minPivot, Math.abs(d));
    maxPivot = Math.max(maxPivot, Math.abs(d));
    for (let j = 0; j < n; j++) { A[c][j] /= d; I[c][j] /= d; }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f === 0) continue;
      for (let j = 0; j < n; j++) { A[r][j] -= f * A[c][j]; I[r][j] -= f * I[c][j]; }
    }
  }
  return { inv: I, minPivot, maxPivot };
}

/**
 * 普通最小二乘。模型形状：y ≈ b0 + b1·x1 + … + b_{p−1}·x_{p−1}
 * 内部自动加截距列（X 不要自己带常数列）。
 *
 * @param {number[][]} X 设计矩阵，n 行 p 列
 * @param {number[]} y 目标
 * @param {object} [o]
 * @param {number} [o.minRowsPerParam=2] 每参数最少样本行数（秩亏护栏）
 * @returns {{beta:number[], se:number[], tStat:number[], fitted:number[], residuals:number[],
 *            r2:number, adjR2:number, sigma:number, n:number, p:number, dof:number,
 *            columnMeans:number[], columnScales:number[]}}
 */
export function ols(X, y, { minRowsPerParam = 2 } = {}) {
  const p = assertMatrix(X, y, 'ols');
  const n = y.length;
  const nParam = p + 1; // 含截距
  if (n < minRowsPerParam * nParam) {
    throw new RangeError(
      `ols: 样本 ${n} 行不足以稳定拟合 ${nParam} 个参数（要求至少 ${minRowsPerParam} 行/参数 = ${minRowsPerParam * nParam} 行）。`
      + ' 请减少特征或延长历史窗口 —— 强行求解只会得到没有意义的伪解。',
    );
  }

  // ── 常量列检查（常量列与截距共线，必须点名）──
  const columnMeans = new Array(p).fill(0);
  const columnScales = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    let m = 0;
    for (let i = 0; i < n; i++) m += X[i][j];
    m /= n;
    columnMeans[j] = m;
    let s = 0;
    for (let i = 0; i < n; i++) s += (X[i][j] - m) ** 2;
    const sd = Math.sqrt(s / (n - 1));
    if (sd === 0) {
      throw new RangeError(
        `ols: 第 ${j} 列（0 起算）在全样本上恒定 = ${m}，与截距完全共线，无法估计。`
        + ' 请移除该特征（例如某促销开关从头到尾都是 0）。',
      );
    }
    columnScales[j] = sd;
  }

  // ── 标准化设计矩阵（截距列不标准化）──
  const Z = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(nParam).fill(1);
    for (let j = 0; j < p; j++) row[j + 1] = (X[i][j] - columnMeans[j]) / columnScales[j];
    Z.push(row);
  }

  // ── 正规方程 A = Z'Z, b = Z'y ──
  const A = Array.from({ length: nParam }, () => new Array(nParam).fill(0));
  const b = new Array(nParam).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < nParam; j++) {
      b[j] += Z[i][j] * y[i];
      for (let k = j; k < nParam; k++) A[j][k] += Z[i][j] * Z[i][k];
    }
  }
  for (let j = 0; j < nParam; j++) for (let k = 0; k < j; k++) A[j][k] = A[k][j];

  const { inv, minPivot, maxPivot } = invert(A);
  if (!inv) throw new RangeError('ols: 设计矩阵奇异（存在完全共线的特征组合），无法估计。');
  if (minPivot < 1e-10 * maxPivot) {
    throw new RangeError(
      `ols: 设计矩阵接近秩亏（最小主元 / 最大主元 = ${(minPivot / maxPivot).toExponential(2)}，已触机器精度）。`
      + ' 特征之间存在强共线，请删减特征或改用正则化方法。',
    );
  }

  const c = inv.map((row) => row.reduce((s, v, j) => s + v * b[j], 0)); // 标准化尺度下的系数

  // ── 雅可比换算回原尺度：beta = J·c ──
  // J[0][0]=1, J[0][j]=−m_j/s_j, J[j][j]=1/s_j
  const J = Array.from({ length: nParam }, () => new Array(nParam).fill(0));
  J[0][0] = 1;
  for (let j = 1; j < nParam; j++) {
    J[j][j] = 1 / columnScales[j - 1];
    J[0][j] = -columnMeans[j - 1] / columnScales[j - 1];
  }
  const beta = J.map((row) => row.reduce((s, v, j) => s + v * c[j], 0));

  // ── 残差与拟合优度 ──
  const fitted = new Array(n).fill(0);
  const residuals = new Array(n).fill(0);
  let sse = 0;
  for (let i = 0; i < n; i++) {
    let f = beta[0];
    for (let j = 0; j < p; j++) f += beta[j + 1] * X[i][j];
    fitted[i] = f;
    residuals[i] = y[i] - f;
    sse += residuals[i] ** 2;
  }
  const ybar = y.reduce((a, v) => a + v, 0) / n;
  const sst = y.reduce((a, v) => a + (v - ybar) ** 2, 0);
  const r2 = sst === 0 ? 1 : 1 - sse / sst;
  const dof = n - nParam;
  const sigma = dof > 0 ? Math.sqrt(sse / dof) : NaN;
  const adjR2 = dof > 0 ? 1 - (1 - r2) * ((n - 1) / dof) : NaN;

  // ── 标准误：Cov(c) = σ²·A⁻¹ → Cov(β) = J·Cov(c)·J' ──
  let se;
  if (Number.isFinite(sigma)) {
    const cov = J.map((Ji) => {
      const JC = new Array(nParam).fill(0);
      for (let k = 0; k < nParam; k++) {
        let s = 0;
        for (let j = 0; j < nParam; j++) s += Ji[j] * inv[j][k];
        JC[k] = s;
      }
      return JC;
    });
    se = cov.map((JCi, i) => {
      let v = 0;
      for (let k = 0; k < nParam; k++) v += JCi[k] * J[i][k];
      return Math.sqrt(Math.max(0, v) * sigma * sigma);
    });
  } else {
    se = new Array(nParam).fill(NaN);
  }
  const tStat = beta.map((bv, i) => (se[i] > 0 ? bv / se[i] : NaN));

  return {
    beta, se, tStat, fitted, residuals, r2, adjR2, sigma,
    n, p, dof, columnMeans, columnScales,
    standardized: { beta: c, nobs: n, nparam: nParam },
  };
}

/**
 * 特征重要性：用「标准化系数绝对值」排序（等价于看效应量，而不是分裂次数）。
 * 只统计原始特征（不含截距），并归一化到合计 100。
 */
export function standardizedImportance(fit) {
  const raw = [];
  for (let j = 0; j < fit.p; j++) {
    // β_j 是原尺度系数；乘以该列标准差 → 得到“该列变动一个标准差带来的目标变动”
    raw.push(Math.abs(fit.beta[j + 1]) * fit.columnScales[j]);
  }
  const total = raw.reduce((a, c) => a + c, 0);
  return raw.map((v, j) => ({ index: j, effect: v, weightPct: total === 0 ? 0 : (v / total) * 100 }));
}
