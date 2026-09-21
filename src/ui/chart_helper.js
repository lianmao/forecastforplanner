/**
 * chart_helper.js —— ECharts 封装（唯一的图表创建入口）
 *
 * 三条纪律，违反必然出 bug：
 * 1. **所有图表必须经由 setOption() 创建**，实例登记在 registry 里。
 *    绕过去自己 echarts.init() 会让模块切换时泄漏实例（ECharts 每个实例都持有
 *    canvas 与全局注册表项，重建后旧实例仍在），并让探针读到上一次渲染的陈旧数据。
 * 2. **模块销毁时必须 destroyAll()**。
 * 3. 图表容器不能在 display:none 里初始化 —— ECharts 会退化成 300×150 的默认尺寸，
 *    看起来像"图表坏了"。本项目的模块容器在创建时都是可见的。
 */
import { init } from '../../vendor/echarts.esm.js';

const registry = new Map(); // HTMLElement → EChartsInstance

/** 读取 CSS 变量，让图表配色跟随样式表（含深色模式） */
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function theme() {
  return {
    ink: cssVar('--ink', '#15181d'),
    ink2: cssVar('--ink-2', '#3d4550'),
    muted: cssVar('--muted', '#6b7480'),
    line: cssVar('--line', '#e2e4e8'),
    line2: cssVar('--line-2', '#cfd3d9'),
    panel: cssVar('--panel', '#ffffff'),
    accent: cssVar('--accent', '#1f6feb'),
    ok: cssVar('--ok', '#15803d'),
    warn: cssVar('--warn', '#b45309'),
    danger: cssVar('--danger', '#b91c1c'),
    dirty: cssVar('--dirty', '#dc2626'),
    clean: cssVar('--clean', '#059669'),
    s: [cssVar('--s1'), cssVar('--s2'), cssVar('--s3'), cssVar('--s4'), cssVar('--s5'), cssVar('--s6')],
  };
}

/** 取得（或创建）某个容器上的图表实例 */
export function getChart(el) {
  let c = registry.get(el);
  if (!c || c.isDisposed()) {
    if (!el.isConnected) {
      // 开发期护栏：脱离文档的容器宽度会被量成 0，zrender 在尺寸为 0 时不会创建画布，
      // 之后 resize() 也救不回来。这类 bug 在页面上只表现为"图表空白"，
      // 必须在这里喊出来。模块契约要求首绘发生在挂载之后（见 app.js 的 activate）。
      console.warn('[forecastforplanner] 图表容器尚未挂载到 document 就初始化，'
        + '宽度会被量成 0 且无法恢复。请把首次绘制移到模块挂载之后。', el.id || el);
    }
    c = init(el, null, { renderer: 'canvas' });
    registry.set(el, c);
  }
  return c;
}

/** 唯一推荐的更新入口 */
export function setOption(el, option, opts = {}) {
  const c = getChart(el);
  c.setOption(option, { notMerge: opts.notMerge ?? false, lazyUpdate: true, silent: true });
  return c;
}

/** 图表尺寸变化（折叠面板展开、窗口缩放、导航切换后都要调用） */
export function resizeAll() {
  for (const [el, c] of registry) {
    if (c.isDisposed()) { registry.delete(el); continue; }
    if (el.isConnected && el.clientWidth > 0) c.resize();
  }
}

export function destroyAll() {
  for (const [, c] of registry) {
    if (!c.isDisposed()) c.dispose();
  }
  registry.clear();
}

export function chartCount() {
  let n = 0;
  for (const [, c] of registry) if (!c.isDisposed()) n += 1;
  return n;
}

/**
 * 所有在册图表的「指纹」：每个图表各序列的长度 + **全序列数值校验和**。
 * 供真浏览器探针判断「某个控件到底有没有产生可见效果」——
 * 只看 DOM 有没有变化是抓不到"控件没接线"这种 bug 的。
 *
 * ★ 校验和必须覆盖**整条序列**：早期版本只取末尾 3 个点，于是
 *   "清洗策略只改了序列中段的爆单点"这种真实生效的控件被误判为死控件。
 *   一个从没失败过的探针不是证据 —— 这里踩的正是这个坑。
 */
export function digest() {
  const parts = [];
  for (const [el, c] of registry) {
    if (c.isDisposed()) continue;
    try {
      const opt = c.getOption();
      const series = (opt.series || []).map((s) => {
        const d = Array.isArray(s.data) ? s.data : [];
        let sum = 0;
        for (const v of d) {
          const n = Array.isArray(v) ? Number(v[1]) : Number(v);
          if (Number.isFinite(n)) sum += n;
        }
        return `${d.length}:${Math.round(sum * 1000) / 1000}`;
      }).join(';');
      parts.push(`${el.clientHeight}px|${series}`);
    } catch {
      parts.push('err');
    }
  }
  return parts.join(' || ');
}

/**
 * 在册图表的运行时快照（排障用）：容器是否已挂载、渲染尺寸、子节点数。
 * 「图表初始化在脱离 DOM 时发生」这类 bug 只能靠这些字段定位 ——
 * chartCount 说有实例、但 canvas 不在文档里，就是它的指纹。
 */
export function dump() {
  const rows = [];
  for (const [el, c] of registry) {
    rows.push({
      id: el.id || '(no id)',
      disposed: c.isDisposed(),
      connected: el.isConnected,
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
      clientW: el.clientWidth,
      childEls: el.childElementCount,
      innerHtmlLen: el.innerHTML.length,
      canvasesInside: el.querySelectorAll('canvas').length,
      canvasInDoc: el.querySelectorAll('canvas').length > 0
        && document.contains(el.querySelector('canvas')),
      echartsWidth: (() => { try { return c.getWidth(); } catch { return -1; } })(),
    });
  }
  return rows;
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeAll, 120);
});

/* ───────────────────────── 通用 option 片段 ───────────────────────── */

export function baseOption({ grid, legend, tooltip, dataZoom } = {}) {
  const t = theme();
  return {
    animationDuration: 220,
    animationEasing: 'cubicOut',
    textStyle: { fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif' },
    grid: { left: 62, right: 20, top: 34, bottom: 46, containLabel: false, ...grid },
    legend: legend === false ? undefined : {
      type: 'scroll',
      top: 0,
      left: 0,
      itemWidth: 14,
      itemHeight: 8,
      itemGap: 12,
      icon: 'roundRect',
      textStyle: { color: t.ink2, fontSize: 12 },
      ...(typeof legend === 'object' ? legend : {}),
    },
    tooltip: tooltip === false ? undefined : {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'cross', crossStyle: { color: t.line2 }, label: { backgroundColor: t.ink2 } },
      backgroundColor: t.panel,
      borderColor: t.line2,
      borderWidth: 1,
      textStyle: { color: t.ink, fontSize: 12 },
      padding: [7, 10],
      ...(typeof tooltip === 'object' ? tooltip : {}),
    },
    dataZoom: dataZoom === false ? undefined : dataZoom,
  };
}

/** 类目轴（时间标签） */
export function catAxis(labels, { name, zoom = null, boundaryGap = false } = {}) {
  const t = theme();
  const axis = {
    type: 'category',
    data: labels,
    boundaryGap,
    name,
    nameTextStyle: { color: t.muted, fontSize: 12 },
    axisLine: { lineStyle: { color: t.line2 } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
    splitLine: { show: false },
  };
  if (zoom) {
    axis.axisLabel = { ...axis.axisLabel, ...(zoom.label || {}) };
  }
  return axis;
}

/** 数值轴 */
export function valAxis(name, { min, max, formatter, scale = true } = {}) {
  const t = theme();
  return {
    type: 'value',
    name,
    min,
    max,
    scale,
    nameTextStyle: { color: t.muted, fontSize: 12 },
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: {
      color: t.muted,
      fontSize: 11,
      formatter: formatter || ((v) => compact(v)),
    },
    splitLine: { lineStyle: { color: t.line, type: 'dashed' } },
  };
}

/** 缩放控件（默认两者都关，需要时显式打开） */
export function zoomControl({ start = 0, end = 100, both = true } = {}) {
  const t = theme();
  const common = { start, end, borderColor: t.line2, fillerColor: 'rgba(31,111,235,.10)', textStyle: { color: t.muted, fontSize: 11 } };
  return both
    ? [{ type: 'inside', start, end }, { type: 'slider', height: 20, bottom: 8, ...common }]
    : [{ type: 'inside', start, end }];
}

/** 折线序列 */
export function line(name, data, {
  color, width = 2, dash = null, area = false, areaOpacity = 0.12,
  symbol = 'none', showSymbol, opacity = 1, step = false, z = 2, xAxisIndex = 0, yAxisIndex = 0,
} = {}) {
  const t = theme();
  const c = color || t.accent;
  return {
    name, type: 'line', data,
    xAxisIndex, yAxisIndex,
    step,
    z,
    symbol: showSymbol ? 'circle' : symbol,
    symbolSize: showSymbol ? 5 : 4,
    showSymbol: !!showSymbol,
    smooth: false,
    connectNulls: false,          // null 必须断线：SMA 前 k−1 期没有值，不能连过去
    sampling: 'lttb',
    lineStyle: { width, color: c, type: dash || 'solid', opacity, cap: 'round' },
    itemStyle: { color: c },
    areaStyle: area ? { color: c, opacity: areaOpacity } : undefined,
    emphasis: { focus: 'series', lineStyle: { width: width + 0.6 } },
    ...(dash ? {} : {}),
  };
}

/** 柱状序列 */
export function bar(name, data, { color, opacity = 0.85, xAxisIndex = 0, yAxisIndex = 0 } = {}) {
  const t = theme();
  return {
    name, type: 'bar', data,
    xAxisIndex, yAxisIndex,
    itemStyle: { color: color || t.s[1], opacity, borderRadius: [3, 3, 0, 0] },
    emphasis: { focus: 'series' },
  };
}

/** 散点（用于标出异常点、拐点、促销点） */
export function scatter(name, data, { color, size = 9, symbol = 'circle' } = {}) {
  const t = theme();
  return {
    name, type: 'scatter', data, z: 12,
    symbol, symbolSize: size,
    itemStyle: { color: color || t.danger, borderColor: t.panel, borderWidth: 1.2 },
    emphasis: { focus: 'series' },
  };
}

/**
 * 置信区间带：用「两条堆叠折线」实现。
 * 下界线透明、上界线画面积 —— 这是 ECharts 做区间带的通行做法，
 * 直接给一条线设 areaStyle 只会填到 0 轴。
 */
export function band(lower, upper, { color, name = '95% 区间', opacity = 0.14 } = {}) {
  const t = theme();
  const c = color || t.accent;
  const diff = upper.map((u, i) => (u === null || lower[i] === null ? null : u - lower[i]));
  return [
    {
      name, type: 'line', data: lower, stack: `band-${name}`, symbol: 'none',
      lineStyle: { opacity: 0, width: 0 }, itemStyle: { opacity: 0 },
      areaStyle: { opacity: 0 }, silent: true, z: 1, tooltip: { show: false }, legendHoverLink: false,
    },
    {
      name: `${name} 上界`, type: 'line', data: diff, stack: `band-${name}`, symbol: 'none',
      lineStyle: { opacity: 0, width: 0 }, itemStyle: { opacity: 0 },
      areaStyle: { color: c, opacity }, silent: true, z: 1,
      tooltip: { show: false }, legendHoverLink: false,
    },
  ];
}

/** 垂直参考线（标记某个时期） */
export function markLine(labelText, { color, width = 1, dash = 'dashed', xValue } = {}) {
  const t = theme();
  return {
    silent: true,
    symbol: 'none',
    lineStyle: { color: color || t.muted, width, type: dash },
    label: { formatter: labelText, color: color || t.muted, fontSize: 11, position: 'insideEndTop' },
    data: [{ xAxis: xValue ?? labelText }],
  };
}

/** 区域高亮（促销期、缺货期等） */
export function markArea(areas, { color, opacity = 0.12, label = '' } = {}) {
  const t = theme();
  return {
    silent: true,
    itemStyle: { color: color || t.warn, opacity },
    label: label ? { show: true, formatter: label, color: t.muted, fontSize: 11, position: 'insideTop' } : { show: false },
    data: areas.map(([a, b]) => [{ xAxis: a }, { xAxis: b }]),
  };
}

/* ───────────────────────── 数字格式化 ───────────────────────── */

const nf0 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const nf3 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });

export function fmt(v, digits = null) {
  if (v === null || v === undefined) return '—';
  if (typeof v !== 'number' || Number.isNaN(v)) return '—';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '-∞';
  if (digits === 0) return nf0.format(v);
  if (digits === 1) return nf1.format(v);
  if (digits === 2) return nf2.format(v);
  if (digits === 3) return nf3.format(v);
  return nf1.format(v);
}

/** 轴标签紧凑格式：1.2万 / 3500 */
export function compact(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(a >= 1e6 ? 0 : 1)}万`;
  if (a >= 1000) return `${Math.round(v)}`;
  if (a >= 1) return `${v.toFixed(a >= 10 ? 0 : 1)}`;
  return `${v.toFixed(2)}`;
}

export function money(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)} 亿元`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(digits)} 万元`;
  return `${nf0.format(v)} 元`;
}

export function pct(v, digits = 1) {
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

export function signed(v, digits = 1) {
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
}

export const DOW_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export { registry };
