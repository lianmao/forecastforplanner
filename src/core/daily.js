/**
 * daily.js —— 日粒度教学数据集 (纯函数，无 DOM 依赖)
 *
 * 为什么模块 5（Prophet 类组件拆解）必须用**日数据**而不是月数据：
 *   - 周度季节性在月数据上根本不存在，而“周一至周日哪天出货最多”是计划员真实的排产问题；
 *   - “春节前两周集中突击下单”这种窗口效应，月粒度会把窗口糊成一格，看不出形状；
 *   - 变点（changepoint）检测也需要足够密度才能定位到「哪一天拐的」。
 *
 * ★ 日期一律用 UTC 整数天运算（epochDay），不做任何本地时区换算。
 *   本地时区 + 夏令时会让日期在边界上偏移一天，这类 bug 极难发现。
 */

import { q } from './quantize.js';

export const DAY_MS = 86400000;

/** 'YYYY-MM-DD' → 距 1970-01-01 的天数（UTC）。 */
export function epochDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new RangeError(`epochDay: 日期格式应为 'YYYY-MM-DD'，收到 ${iso}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

/** 天数 → 'YYYY-MM-DD'（UTC）。 */
export function isoFromDay(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 连续 n 天的日期标签。 */
export function dailyLabels(startISO, n) {
  const d0 = epochDay(startISO);
  return Array.from({ length: n }, (_, i) => isoFromDay(d0 + i));
}

/** 星期（0=周日 … 6=周六）。1970-01-01 是周四。 */
export function dayOfWeek(day) {
  return (((day % 7) + 7 + 4) % 7);
}

/** 年内第几天（0 起算）。 */
export function dayOfYearISO(iso) {
  const y = Number(iso.slice(0, 4));
  return epochDay(iso) - epochDay(`${y}-01-01`);
}

/**
 * 中国主要节假日日期表（农历节日公历日期每年变动，真实项目应接节假日字典）。
 * 这里只覆盖数据集用到的 2023–2025。
 */
export const CN_HOLIDAYS = {
  cny: { label: '春节', dates: ['2023-01-22', '2024-02-10', '2025-01-29'], pre: 14, during: 8 },
  national: { label: '国庆', dates: ['2023-10-01', '2024-10-01', '2025-10-01'], pre: 10, during: 8 },
  double11: { label: '双 11', dates: ['2023-11-11', '2024-11-11', '2025-11-11'], pre: 4, during: 6 },
};

/** 生成模型的真实效应强度（占基准水平的比例），用来做「学回来对不对」的对照。 */
export const HOLIDAY_EFFECTS = {
  cny: { pre: 0.35, during: -0.55 },
  national: { pre: 0.12, during: -0.3 },
  double11: { pre: 0.25, during: -0.15 },
};

/**
 * 把节假日窗口展开成 0/1 指示向量（Prophet 的节假日回归量就是这么做的）。
 * 每个节假日两列：节前囤货窗口 + 假期窗口。
 * @returns {{names:string[], columns:number[][], windows:object}}
 */
export function holidayIndicators(labels, holidays = CN_HOLIDAYS) {
  const n = labels.length;
  const idx = new Map(labels.map((l, i) => [l, i]));
  const names = [];
  const columns = [];
  const windows = {};
  for (const [key, cfg] of Object.entries(holidays)) {
    const pre = new Array(n).fill(0);
    const during = new Array(n).fill(0);
    const ranges = [];
    for (const d of cfg.dates) {
      const di = idx.get(d);
      if (di === undefined) continue; // 该节假日不在数据范围内
      const ps = di - cfg.pre;
      const pe = di - 1;
      const de = di + cfg.during - 1;
      for (let i = Math.max(0, ps); i <= Math.min(n - 1, pe); i++) pre[i] = 1;
      for (let i = Math.max(0, di); i <= Math.min(n - 1, de); i++) during[i] = 1;
      ranges.push({ date: d, index: di, pre: [ps, pe], during: [di, de] });
    }
    names.push(`${cfg.label}·节前${cfg.pre}天`);
    columns.push(pre);
    names.push(`${cfg.label}·假期${cfg.during}天`);
    columns.push(during);
    windows[key] = { label: cfg.label, ranges };
  }
  return { names, columns, windows };
}

/**
 * 日粒度合成数据集：趋势（含变点）+ 周度周期 + 年度周期 + 节假日窗口 + 噪音。
 *
 * 趋势用**分段线性**构造，这样 GAM 的 {t, max(0,t−cp)} 基函数可以**精确表示**它 ——
 * 于是“模型能不能把变点学回来”就变成一个可断言的精确命题，而不只是看着像。
 *
 * @param {object} o
 * @param {number} o.n 天数，默认 1095（3 年）
 * @param {string} o.start 起始日期
 * @param {number[]} o.changepoints 变点位置（天序号）
 * @param {number[]} o.slopes 各分段斜率（件/天），长度 = changepoints.length + 1
 * @param {number} o.base 起始水平
 * @param {number} o.weeklyAmp 周度振幅
 * @param {number} o.weeklyOrder 周度谐波阶数（生成侧固定 2 阶）
 * @param {number} o.yearlyAmp 年度振幅
 * @param {number} o.noise 噪音标准差
 */
export function makeDailyDataset({
  n = 1095, start = '2023-01-01', base = 1200,
  changepoints = [365, 730], slopes = [0.35, -0.2, 0.5],
  weeklyAmp = 90, yearlyAmp = 130, noise = 55, seed = 2023,
  holidays = CN_HOLIDAYS, holidayEffects = HOLIDAY_EFFECTS,
} = {}) {
  if (slopes.length !== changepoints.length + 1) {
    throw new RangeError(`makeDailyDataset: slopes 长度应为 changepoints+1 = ${changepoints.length + 1}，收到 ${slopes.length}`);
  }
  const labels = dailyLabels(start, n);
  const d0 = epochDay(start);

  // 分段线性趋势：trend(t) = base + Σ_{t'=1..t} slope(t')，其中 slope 由「小于 t 的变点个数」决定。
  // 这个形状与 GAM 的 {1, t, max(0,t−cp)} 基函数**完全等价**，
  // 所以「模型能否把变点与斜率学回来」是可精确断言的，而不是“看着差不多”。
  const trend = new Array(n).fill(base);
  for (let t = 1; t < n; t++) {
    let seg = 0;
    for (const cp of changepoints) if (cp < t) seg += 1;
    trend[t] = trend[t - 1] + slopes[seg];
  }

  const { columns: holCols, windows } = holidayIndicators(labels, holidays);
  const weekly = new Array(n).fill(0);
  const yearly = new Array(n).fill(0);
  const holiday = new Array(n).fill(0);
  const rng = makeRngLocal(seed);

  for (let t = 0; t < n; t++) {
    const day = d0 + t;
    const dow = dayOfWeek(day);
    const doy = dayOfYearISO(labels[t]);
    // 周度：周末高、周中低（2 阶谐波，形状比单正弦更像真实出货曲线）
    // q() 量化 sin/cos 输出：Math.sin 在不同 V8 版本间有 1~2 ULP 差异，
    // 不量化的话 node --test 通过不代表浏览器里也通过（详见 generator.js 顶部说明）。
    weekly[t] = q(weeklyAmp * (0.75 * Math.cos((2 * Math.PI * dow) / 7)
      + 0.25 * Math.cos((4 * Math.PI * dow) / 7)));
    yearly[t] = q(yearlyAmp * Math.cos((2 * Math.PI * doy) / 365.25));
  }

  // 按 holidayIndicators 的列顺序应用（每节假日两列：pre、during）
  let col = 0;
  for (const [key, cfg] of Object.entries(holidays)) {
    const eff = holidayEffects[key];
    if (!eff) { col += 2; continue; }
    const pre = holCols[col];
    const dur = holCols[col + 1];
    for (let t = 0; t < n; t++) {
      if (pre[t]) holiday[t] += eff.pre * base;
      if (dur[t]) holiday[t] += eff.during * base;
    }
    col += 2;
  }

  const values = new Array(n);
  const noiseArr = new Array(n);
  for (let t = 0; t < n; t++) {
    noiseArr[t] = standardNormalLocal(rng) * noise;
    values[t] = trend[t] + weekly[t] + yearly[t] + holiday[t] + noiseArr[t];
  }

  return {
    labels, values, windows, changepoints, slopes,
    components: { trend, weekly, yearly, holiday, noise: noiseArr },
    holidayEffects,
    truth: { base, slopes, changepoints, weeklyAmp, yearlyAmp, holidayEffects },
  };
}

function makeRngLocal(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormalLocal(rng) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += rng();
  return s - 6;
}
