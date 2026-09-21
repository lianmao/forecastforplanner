/**
 * mod0_cleaning.js —— 模块 0：数据清洗与异常修复（REQ-MOD-00）
 *
 * 交互：异常值策略 + 灵敏度 k + 缺货策略 → 实时看「原始脏数据 vs 清洗后」
 * 和清洗前后的统计指标卡片。
 *
 * ★ 执行顺序是「先修缺货、再判异常」，与需求文档表格的顺序相反。
 *   理由见 cleaning.js 顶部与 DECISIONS.md D3。UI 上会明确写出来，
 *   免得计划员以为工具搞错了。
 */
import { makeCleaningDataset } from '../core/generator.js';
import { cleanSeries, OUTLIER_METHODS } from '../core/cleaning.js';

const OUTLIER_OPTS = [
  { value: 'keep', label: '保留原始脏数据' },
  { value: 'winsorize', label: 'IQR 盖帽截断' },
  { value: 'median', label: '中位数替换' },
  { value: 'drop-interpolate', label: '剔除并线性插值' },
];

const STOCKOUT_OPTS = [
  { value: 'keep', label: '保留为 0' },
  { value: 'linear', label: '线性插值补齐' },
  { value: 'yoy', label: '历史同期填充' },
];

const META = {
  id: 'mod0',
  num: 0,
  group: '第 0 步 · 数据准备',
  title: '数据清洗与异常值修复实验',
  short: '数据清洗',
  req: 'REQ-MOD-00',
};

const mod0 = {
  ...META,
  subtitle: '历史销量里混着「大客户一次性团购爆单」和「工厂缺料断供导致的假零销量」。'
    + '直接喂给模型会两头出错：把断货当成需求萎缩而减少备货（恶性断货），'
    + '把单次爆单当成爆发增长而盲目备货（呆滞积压）。',

  create(ctx) {
    const { comp, charts, fmt } = ctx;
    const controls = ctx.controls;

    const data = makeCleaningDataset();
    const state = {
      outlierMethod: 'keep',
      k: 1.5,
      stockoutMethod: 'keep',
    };

    /* ── 图表 ── */
    const chartEl = comp.chartBox({ id: 'mod0-chart', size: 'chart-lg' });
    const statsEl = comp.grid(4, [], '');
    const tableHost = comp.h('div', { class: 'table-wrap' });

    const kpiMean = comp.kpi({ label: '均值', value: '—' });
    const kpiStd = comp.kpi({ label: '标准差', value: '—' });
    const kpiCv = comp.kpi({ label: '变异系数 CV', value: '—', sub: '标准差 / 均值 × 100%' });
    const kpiPoints = comp.kpi({ label: '被改动的时间点', value: '—', sub: '爆单截断 + 缺货填补' });
    statsEl.append(kpiMean.el, kpiStd.el, kpiCv.el, kpiPoints.el);

    /* ── 控件 ── */
    const cOutlier = controls.add(comp.radio({
      label: '异常值处理策略',
      options: OUTLIER_OPTS,
      value: state.outlierMethod,
      help: '应对大宗偶发爆单的清洗方法',
      onChange: (v) => { state.outlierMethod = v; update(); },
    }));

    const cK = controls.add(comp.slider({
      label: '异常灵敏度阈值 k',
      min: 1, max: 3, step: 0.2, value: state.k, decimals: 1,
      help: 'IQR 上下界 = Q1/Q3 ± k×IQR。k 越小越激进，判定的异常点越多。',
      onChange: (v) => { state.k = v; update(); },
    }));

    const cStock = controls.add(comp.radio({
      label: '缺货断点处理策略',
      options: STOCKOUT_OPTS,
      value: state.stockoutMethod,
      help: '应对缺料断供导致销量为 0 的修正策略',
      onChange: (v) => { state.stockoutMethod = v; update(); },
    }));

    /* ── 更新逻辑：只 setOption 与改 KPI，不重建 DOM ── */
    function update() {
      const r = cleanSeries(data.values, {
        outlierMethod: state.outlierMethod,
        k: state.k,
        stockoutMethod: state.stockoutMethod,
        period: 12,
      });
      const t = charts.theme();

      // 异常点分两级标注：极端爆单（远超任何 k 的上界）与中等幅度异常
      // （正好落在 k 的判定边界之间，是 k 滑杆能产生反馈的原因）
      const extremePts = data.truth.extremeSpikeIndices.map((i) => [data.labels[i], data.values[i]]);
      const moderatePts = data.truth.moderateSpikeIndices.map((i) => [data.labels[i], data.values[i]]);
      const zeroPts = data.truth.zeroed.map((i) => [data.labels[i], 0]);

      const series = [
        charts.line('原始脏数据', data.values, { color: t.dirty, width: 1.6, dash: 'dashed', z: 3 }),
        charts.line('清洗后数据', r.values, { color: t.clean, width: 2.6, z: 4 }),
        charts.scatter('极端爆单（大客户团购）', extremePts, { color: t.dirty, size: 11, symbol: 'triangle' }),
        charts.scatter('中等幅度异常', moderatePts, { color: t.s[1], size: 9, symbol: 'diamond' }),
        charts.scatter('缺货断点（假零销量）', zeroPts, { color: t.muted, size: 9, symbol: 'rect' }),
      ];
      // 缺货区间高亮
      const runs = data.truth.stockoutRuns;
      if (runs.length) {
        series[1].markArea = charts.markArea(
          runs.map(([s, e]) => [data.labels[s], data.labels[e]]),
          { color: t.muted, opacity: 0.14 },
        );
      }

      charts.setOption(chartEl, {
        ...charts.baseOption({}),
        xAxis: charts.catAxis(data.labels),
        yAxis: charts.valAxis('出货量'),
        series,
      }, { notMerge: true });

      // KPI
      const b = r.before;
      const a = r.after;
      kpiMean.set(fmt.num(b.mean, 0), {
        subText: `清洗后 ${fmt.num(a.mean, 0)}（${fmt.signed(a.mean - b.mean, 0)}）`,
      });
      kpiStd.set(fmt.num(b.std, 0), {
        subText: `清洗后 ${fmt.num(a.std, 0)}（${fmt.signed(a.std - b.std, 0)}）`,
        toneText: a.std < b.std ? 'kpi ok' : 'kpi',
      });
      kpiCv.set(fmt.pct(b.cv, 1), {
        subText: `清洗后 ${fmt.pct(a.cv, 1)}（${fmt.signed(a.cv - b.cv, 1)} pt）`,
        toneText: a.cv < b.cv ? 'kpi ok' : 'kpi',
      });
      const changed = r.meta.clipped.length + r.meta.replaced.length + r.meta.removed.length + r.meta.filled.length;
      kpiPoints.set(String(changed), {
        subText: `截断 ${r.meta.clipped.length} · 替换 ${r.meta.replaced.length} · `
          + `剔除 ${r.meta.removed.length} · 补齐 ${r.meta.filled.length}`,
      });

      renderTable(r);
    }

    function renderTable(r) {
      const rows = [];
      const push = (kind, i, from, to) => rows.push({ kind, i, from, to });
      for (const c of r.meta.clipped) push(c.side === 'high' ? '爆单→盖帽' : '低点→盖帽', c.index, c.from, c.to);
      for (const c of r.meta.replaced) push('异常→中位数', c.index, c.from, c.to);
      for (const c of r.meta.removed) push('异常→剔除插值', c.index, c.from, null);
      for (const c of r.meta.filled) push(`缺货→${c.how === 'yoy' ? '去年同期' : c.how === 'linear' ? '线性插值' : '外延'}`, c.index, 0, c.value);

      const body = rows.length
        ? rows.map((x) => comp.h('tr', {}, [
          comp.h('td', { text: data.labels[x.i] }),
          comp.h('td', { text: x.kind }),
          comp.h('td', { class: 'num', text: fmt.num(x.from, 0) }),
          comp.h('td', { class: 'num', text: x.to === null ? '（插值）' : fmt.num(x.to, 0) }),
        ]))
        : [comp.h('tr', {}, [comp.h('td', { colspan: '4', class: 'dim', text: '当前策略没有改动任何数据点。' })])];

      tableHost.replaceChildren(comp.h('table', { class: 'data' }, [
        comp.h('thead', {}, [comp.h('tr', {}, [
          comp.h('th', { text: '期间' }),
          comp.h('th', { text: '处理方式' }),
          comp.h('th', { text: '原值' }),
          comp.h('th', { text: '新值' }),
        ])]),
        comp.h('tbody', {}, body),
      ]));
    }

    /* ── 组装 ── */
    const root = comp.h('div', {}, [
      comp.moduleHeader({ req: META.req, title: META.title, sub: this.subtitle }),

      comp.grid(2, [
        comp.card({
          title: '清洗策略',
          hint: `共 ${data.values.length} 期数据`,
          body: [
            comp.h('div', { class: 'controls' }, [cOutlier.el, cK.el, cStock.el]),
            comp.h('p', { class: 'ctl-help mt', html:
              '执行顺序：<strong>先修缺货 → 再判异常</strong>。'
              + '缺货期被置 0，若先判异常会把这些 0 当成低异常点盖帽抬起来，'
              + '丢掉「缺货」这个语义；选「保留为 0」时这些点会被<strong>豁免</strong>，'
              + '既不参与 IQR 统计也不被盖帽。' }),
            comp.h('p', { class: 'ctl-help', html:
              '本数据集的真值（仅用于教学对照）：<br>'
              + `极端爆单 ${data.truth.extremeSpikeIndices.map((i) => data.labels[i]).join('、')}（放大 3.2 倍）<br>`
              + `中等幅度异常 ${data.truth.moderateSpikeIndices.map((i) => data.labels[i]).join('、')}（放大 1.2~1.7 倍，正好落在 k 的判定边界之间，拖动上面的滑杆能直接看到它们进出）<br>`
              + `缺货区间 ${data.truth.stockoutRuns.map(([s, e]) => `${data.labels[s]}~${data.labels[e]}`).join('、')}` }),
          ],
        }),
        comp.card({
          title: '原始脏数据 vs 清洗后',
          hint: '红色虚线为原始，绿色实线为清洗后',
          body: [chartEl],
        }),
      ]),

      comp.h('div', { class: 'mt' }, [statsEl]),

      comp.grid(2, [
        comp.card({ title: '被改动的数据点', body: [tableHost] }),
        comp.h('div', { class: 'grid', style: 'gap:14px' }, [
          comp.tipBox({
            lines: [
              '<strong>垃圾进，垃圾出（Garbage In, Garbage Out）。</strong>'
              + '分清「因缺货导致的零销量」与「市场真的没有需求的零销量」是计划员的基本功。',
              '不加修正就把缺货当作无需求，系统的下一轮预测会更低、计划量更少，'
              + '于是<strong>继续缺货</strong> —— 这就是恶性断货循环。',
              '反过来，把大客户一次性团购当成趋势，接下来几个月的备货都会偏高，变成呆滞库存。',
            ],
          }),
          comp.whyBox({
            title: '为什么盖帽（Winsorize）比替换成中位数更温和',
            body: [
              '<p>盖帽把超出上下界的值<strong>拉回边界</strong>，保留了「这一期确实比平常高」的信息；'
              + '中位数替换会把这一期直接抹平成序列中位数，连方向都丢了。</p>',
              '<p>代价是：盖帽后的值仍然受边界影响，如果异常点密集，边界本身也会被抬高（IQR 是稳健统计量，'
              + '但仍然会被大比例的异常污染）。所以 k 的值要看业务：快消日用品 k=1.5 偏激进，'
              + '耐用品、项目型需求 k=2.0~3.0 更合适。</p>',
              '<p>把滑杆拉到 1.0 再对比统计卡片：你会看到<strong>标准差被压下去了，但均值几乎不动</strong> —— '
              + '这正是稳健统计量的意义。</p>',
            ],
          }),
        ]),
      ]),
    ]);

    // ★ 首次绘制**故意不在这里做**：此时 root 还没挂到 document 上，
    //   ECharts 量到的容器宽度是 0，zrender 在尺寸为 0 时不会创建画布，
    //   之后 resize() 也救不回来。改由 app.js 在挂载完成后调用 api.update()。
    return {
      root,
      update,          // app.js 在容器挂载后会再调一次（图表容器必须已布局才能测量宽度）
      reset() {
        cOutlier.set('keep');
        cK.set(1.5);
        cStock.set('keep');
        state.outlierMethod = 'keep';
        state.k = 1.5;
        state.stockoutMethod = 'keep';
        update();
      },
      destroy() { /* 图表由 app.js 的 charts.destroyAll() 统一销毁 */ },
    };
  },
};

export default mod0;
