/**
 * mod5_prophet.js —— 模块 5：Prophet 式广义加性模型组件拆解（REQ-MOD-06）
 *
 * 用日粒度数据（3 年 1095 天）做真拟合：分段趋势 + 周度傅里叶 + 年度傅里叶 + 节假日窗口，
 * 每一项都能单独画出来给业务方看 —— 这就是 Prophet 最大的商业价值：业务透明度。
 *
 * 与 Prophet 的两处差异（已在 DECISIONS.md 记录）：
 *   1. 本节用**等距变点网格**代替 Prophet 的稀疏先验（changepoint_prior_scale）。
 *      滑杆控制的是变点个数，直接对应"趋势灵活度"这个业务含义。
 *   2. 乘法模式用"对数空间拟合 + 指数还原"，与 Prophet 的实现方式一致。
 */
import { makeDailyDataset, dailyLabels } from '../core/daily.js';
import { fitGam, forecastGam, futureLabels, prophetNarrative } from '../core/prophet_sim.js';

const META = {
  id: 'mod5',
  num: 5,
  group: '第二阶段 · 特征与机器学习',
  title: 'Prophet 式组件拆解：变点、周度与节假日',
  short: 'Prophet 组件',
  req: 'REQ-MOD-06',
};

const N = 1095;
const DATA = makeDailyDataset({ n: N, seed: 2023 });

/** k 个等距变点（k=0 表示不检测变点，退化为单一线性趋势） */
function changepointsFor(k) {
  if (k <= 0) return [];
  return Array.from({ length: k }, (_, i) => Math.round((N * (i + 1)) / (k + 1)));
}

export default {
  ...META,
  subtitle: '公司 SKU 成千上万，没有算法工程师逐个调参；而春节、国庆每年公历日期都在变，'
    + '传统模型对不齐日历脉冲。Prophet 这类工具的价值在于把「趋势变点 / 周内节奏 / 年度淡旺季 / 节假日脉冲」'
    + '拆成可解释、可拿去和业务方对话的组件。',

  create(ctx) {
    const { comp, charts, fmt } = ctx;
    const controls = ctx.controls;
    const state = { holidays: true, cpCount: 2, mode: 'additive', horizon: 60 };

    const chartEl = comp.h('div', { class: 'chart chart-lg', id: 'mod5-chart', style: 'height:400px' });
    const compEl = comp.h('div', { class: 'chart', id: 'mod5-comp', style: 'height:560px' });
    const kpiHost = comp.h('div', { class: 'grid grid-4' });
    const readHost = comp.h('div', {});
    const errHost = comp.h('div', { hidden: true });
    const tableHost = comp.h('div', { class: 'table-wrap' });

    const cHol = controls.add(comp.toggle({
      label: '节假日效应',
      value: state.holidays,
      help: '关闭后不加载节假日窗口回归量，节假日脉冲会被算进残差或趋势里。',
      onChange: (v) => { state.holidays = v; update(); },
    }));
    const cCp = controls.add(comp.slider({
      label: '变点数量（趋势灵活度）', min: 0, max: 6, step: 1, value: state.cpCount,
      help: '变点越多，趋势越能贴合历史；但外推时也更容易把噪音当成新趋势。',
      onChange: (v) => { state.cpCount = v; update(); },
    }));
    const cMode = controls.add(comp.radio({
      label: '季节性模式',
      options: [
        { value: 'additive', label: '加法' },
        { value: 'multiplicative', label: '乘法' },
      ],
      value: state.mode,
      help: '乘法模式在对数空间拟合：周内/节假日的起伏按比例放大，适合旺季基数更高的品类。',
      onChange: (v) => { state.mode = v; update(); },
    }));
    const cH = controls.add(comp.radio({
      label: '预测窗口（天）',
      options: [
        { value: 30, label: '30 天' },
        { value: 60, label: '60 天' },
        { value: 90, label: '90 天' },
      ],
      value: state.horizon,
      onChange: (v) => { state.horizon = Number(v); update(); },
    }));

    function update() {
      const cps = changepointsFor(state.cpCount);
      let g;
      try {
        g = fitGam(DATA.labels, DATA.values, {
          changepoints: cps,
          holidays: state.holidays ? undefined : {},
          mode: state.mode,
        });
      } catch (e) {
        errHost.hidden = false;
        errHost.replaceChildren(comp.errorBox({
          title: '这个参数组合下模型拒绝拟合',
          message: '如：乘法模式遇到 0 或负值、变点数量超出样本长度导致设计矩阵秩亏。请调整参数或先清洗数据。',
          detail: String(e && e.message ? e.message : e),
        }));
        return;
      }
      errHost.hidden = true;

      const future = futureLabels(DATA.labels, state.horizon);
      const fc = forecastGam(g, future);
      const t = charts.theme();

      const allLabels = [...DATA.labels, ...future];
      const hLen = DATA.labels.length;
      const pad = (arr, headNulls = 0) => [
        ...new Array(headNulls).fill(null), ...arr, ...new Array(state.horizon).fill(null),
      ];
      const fittedLine = pad(g.components.fitted, 0);
      const fcLine = pad([], hLen - 1).slice(0, hLen - 1)
        .concat([DATA.values[hLen - 1], ...fc.map((p) => p.mean)]);
      const fcLower = [...new Array(hLen - 1).fill(null), DATA.values[hLen - 1], ...fc.map((p) => p.lower)];
      const fcUpper = [...new Array(hLen - 1).fill(null), DATA.values[hLen - 1], ...fc.map((p) => p.upper)];

      const fittedSeries = charts.line('模型拟合', fittedLine, { color: t.s[0], width: 1.4, z: 4 });
      if (g.summary.changepoints.length) {
        fittedSeries.markLine = {
          silent: true,
          symbol: ['none', 'none'],
          lineStyle: { color: t.s[4], width: 1, type: 'dashed', opacity: 0.85 },
          label: {
            show: true, formatter: '变点', color: t.s[4], fontSize: 10, position: 'insideEndTop',
          },
          data: g.summary.changepoints.map((cp) => ({ xAxis: DATA.labels[cp] })),
        };
      }

      charts.setOption(chartEl, {
        ...charts.baseOption({
          dataZoom: charts.zoomControl({ start: 40, end: 100 }),
          legend: { data: ['实际出货', '模型拟合', '预测', '95% 区间'] },
        }),
        xAxis: charts.catAxis(allLabels, {}),
        yAxis: charts.valAxis('出货量/天'),
        series: [
          ...charts.band(fcLower, fcUpper, { color: t.s[1], name: '95% 区间' }),
          charts.line('实际出货', pad(DATA.values, 0), { color: t.ink2, width: 1.4, z: 5 }),
          fittedSeries,
          charts.line('预测', fcLine, { color: t.s[1], width: 2.2, z: 6 }),
        ],
      }, { notMerge: true });

      /* ── 组件拆解看板：4 个 grid 纵向排列 ── */
      const XS = [0, 1, 2, 3].map(() => charts.catAxis(allLabels, {}));
      for (let i = 0; i < 3; i++) XS[i].axisLabel.show = false;
      // 组件子图不需要完整标签，避免拥挤
      XS[3].axisLabel.fontSize = 10;

      const mkY = (name, opts = {}) => {
        const a = charts.valAxis(name, opts);
        a.splitNumber = 2;
        a.axisLabel.fontSize = 10;
        return a;
      };
      const isMult = state.mode === 'multiplicative';
      const zeroLine = isMult ? 1 : 0;

      charts.setOption(compEl, {
        ...charts.baseOption({ grid: false, legend: false, dataZoom: false, tooltip: { trigger: 'axis' } }),
        animation: false,
        grid: [
          { left: 70, right: 24, top: 22, height: '33%' },
          { left: 70, right: 24, top: '48%', height: '13%' },
          { left: 70, right: 24, top: '65%', height: '13%' },
          { left: 70, right: 24, top: '82%', height: '13%' },
        ],
        xAxis: XS,
        yAxis: [
          mkY(isMult ? '长期趋势（水平）' : '长期趋势', {}),
          mkY(isMult ? '周内因子（×）' : '周内效应', {}),
          mkY(isMult ? '年度因子（×）' : '年度效应', {}),
          mkY(isMult ? '节假日因子（×）' : '节假日效应', {}),
        ],
        series: [
          charts.line('趋势', pad(g.components.trend, 0), { color: t.s[0], width: 1.6, xAxisIndex: 0, yAxisIndex: 0 }),
          charts.line('周内', pad(g.components.weekly, 0), {
            color: t.s[2], width: 1.1, xAxisIndex: 1, yAxisIndex: 1,
            area: true, areaOpacity: 0.18,
          }),
          charts.line('年度', pad(g.components.yearly, 0), {
            color: t.s[3], width: 1.1, xAxisIndex: 2, yAxisIndex: 2,
            area: true, areaOpacity: 0.18,
          }),
          charts.line('节假日', pad(g.components.holiday, 0), {
            color: t.s[1], width: 1.1, xAxisIndex: 3, yAxisIndex: 3,
            area: true, areaOpacity: 0.2,
          }),
        ],
      }, { notMerge: true });

      /* ── KPI ── */
      const cnyPre = g.summary.holidayEffects.find((h) => h.name.startsWith('春节·节前'));
      const cnyDur = g.summary.holidayEffects.find((h) => h.name.startsWith('春节·假期'));
      const fcAvg = fc.reduce((a, p) => a + p.mean, 0) / fc.length;

      kpiHost.replaceChildren(
        comp.kpi({
          label: '模型解释力',
          value: Number.isFinite(g.summary.adjR2) ? g.summary.adjR2.toFixed(4) : '—',
          sub: `调整 R²${isMult ? '（对数空间）' : ''} · ${g.summary.nParam} 参数 / ${N} 观测`,
          tone: g.summary.adjR2 > 0.9 ? 'ok' : '',
        }).el,
        comp.kpi({
          label: '残差标准差 σ',
          value: fmt.num(g.summary.sigma, 1),
          unit: isMult ? '（对数）' : '件/天',
          sub: '模块 7 的安全库存就吃这个数',
        }).el,
        comp.kpi({
          label: '识别到的变点',
          value: String(g.summary.changepoints.length),
          unit: `/${state.cpCount}`,
          sub: g.summary.droppedChangepoints.length
            ? `有 ${g.summary.droppedChangepoints.length} 个变点落在样本外被丢弃`
            : `位置 ${g.summary.changepoints.join('、') || '—'}`,
        }).el,
        comp.kpi({
          label: `未来 ${state.horizon} 天日均预测`,
          value: fmt.num(fcAvg, 0),
          unit: '件/天',
          sub: `最新实际 ${fmt.num(DATA.values[hLen - 1], 0)} → ${fmt.signed((fcAvg / DATA.values[hLen - 1] - 1) * 100, 1)}%`,
          tone: 'accent',
        }).el,
      );

      /* ── 业务化解读 ── */
      const lines = prophetNarrative(g.summary, DATA.values.reduce((a, b) => a + b, 0) / N);
      if (cnyPre && cnyDur) {
        lines.push(`春节窗口：节前 ${fmt.signed(cnyPre.coef, 0)} 件/天，假期内 ${fmt.signed(cnyDur.coef, 0)} 件/天 `
          + `（t 值 ${cnyPre.t.toFixed(1)} / ${cnyDur.t.toFixed(1)}）`);
      }
      if (!state.holidays) lines.push('已关闭节假日效应：注意观察节假日子图是否变平、残差 σ 是否上升。');
      if (g.summary.droppedColumns.length) {
        lines.push(`以下回归量在本时间范围内恒为常数，已剔除：${g.summary.droppedColumns.join('、')}`);
      }
      readHost.replaceChildren(comp.card({
        title: '业务化解读',
        hint: '可以直接拿去和销售、生产对话的句子',
        body: lines.map((l) => comp.h('p', { class: 'ctl-help', style: 'font-size:12.5px', text: l })),
      }));

      /* ── 节假日效应明细 ── */
      const rows = g.summary.holidayEffects.map((h) => comp.h('tr', {}, [
        comp.h('td', { text: h.name }),
        comp.h('td', { class: 'num', text: fmt.signed(h.coef, 0) }),
        comp.h('td', { class: 'num', text: fmt.signed(h.pctOfBase, 1) }),
        comp.h('td', { class: 'num', text: fmt.num(h.se, 1) }),
        comp.h('td', { class: 'num', text: Number.isFinite(h.t) ? h.t.toFixed(1) : '—' }),
      ]));
      tableHost.replaceChildren(comp.h('table', { class: 'data' }, [
        comp.h('thead', {}, [comp.h('tr', {}, [
          comp.h('th', { text: '窗口' }),
          comp.h('th', { text: isMult ? '系数（对数）' : '效应（件/天）' }),
          comp.h('th', { text: '占均值 %' }),
          comp.h('th', { text: '标准误' }),
          comp.h('th', { text: 't 值' }),
        ])]),
        comp.h('tbody', {}, rows.length ? rows : [
          comp.h('tr', {}, [comp.h('td', { colspan: '5', class: 'dim', text: '节假日效应已关闭或本范围内无可用窗口。' })]),
        ]),
      ]));
    }

    const root = comp.h('div', {}, [
      comp.moduleHeader({ req: META.req, title: META.title, sub: this.subtitle }),
      errHost,

      comp.grid(2, [
        comp.card({
          title: '模型开关',
          hint: `${N} 天日粒度数据（2023-01-01 ~ 2025-12-30）`,
          body: [
            comp.h('div', { class: 'controls' }, [cHol.el, cCp.el, cMode.el, cH.el]),
            comp.h('p', { class: 'ctl-help', html:
              '这里用<strong>等距变点网格</strong>代替 Prophet 的稀疏先验（changepoint_prior_scale）：'
              + '滑杆控制变点个数，业务含义就是「趋势允许有多灵活」。'
              + '变点越多越贴合历史，但外推时也更容易把噪音当成新趋势。' }),
          ],
        }),
        comp.card({ title: '历史拟合与未来外推', hint: '紫色虚线为识别到的趋势变点；可拖动下方缩放条', body: [chartEl] }),
      ]),

      comp.h('div', { class: 'mt' }, [kpiHost]),

      comp.card({
        title: '组件拆解看板',
        hint: 'Prophet 的核心卖点：每一项都能单独拿给业务方看',
        body: [compEl],
        cls: 'mt',
      }),

      comp.grid(2, [
        readHost,
        comp.h('div', { class: 'grid', style: 'gap:14px' }, [
          comp.tipBox({
            lines: [
              'Prophet 的最大优势是<strong>业务透明度</strong>：利用组件拆解图，你可以向销售和生产团队直观证明',
              '「春节前两周客户会集中突击下单，节后首周需求骤降」，从而合理安排工厂放假与节前备库。',
              '把「变点数量」从 0 拉到 6：你会看到趋势线越来越贴合历史，但请记住 —— '
              + '<strong>贴合历史不等于预测未来</strong>。变点越多，外推的不确定性越大。',
            ],
          }),
          comp.whyBox({
            title: '为什么节假日必须做成「窗口回归量」而不是「当天标记」',
            body: [
              '<p>如果只用"10 月 1 日 = 1"这样的单日标记，模型只能告诉你"国庆当天多了多少"，'
              + '而计划员真正需要知道的是<strong>节前备货窗口</strong> —— 提前多少天开始起量、起多少。</p>',
              '<p>做成「节前 N 天」+「假期 M 天」两个窗口回归量之后，'
              + '系数直接读成"节前 14 天平均每天多出 X 件"，这才是能拿去排产的数字。</p>',
              '<p>代价是：窗口相邻的两个回归量会互相挤占（本数据里国庆节前窗口的估计就偏低了 15% 左右），'
              + '所以窗口长度要按业务实际提前期来设，不能为了好看随便拉长。</p>',
              '<p>还有一个常见坑：把数据截到年中，国庆窗口列会全是 0，'
              + '与截距完全共线 —— 本工具会直接剔除这些列并回报，而不是给你一个崩掉的页面。</p>',
            ],
          }),
        ]),
      ]),

      comp.card({ title: '节假日窗口效应明细', body: [tableHost], cls: 'mt' }),
    ]);

    // ★ 首次绘制**故意不在这里做**：此时 root 还没挂到 document 上，
    //   ECharts 量到的容器宽度是 0，zrender 在尺寸为 0 时不会创建画布，
    //   之后 resize() 也救不回来。改由 app.js 在挂载完成后调用 api.update()。
    return {
      root,
      update,          // app.js 在容器挂载后会再调一次（图表容器必须已布局才能测量宽度）
      reset() {
        cHol.set(true);
        cCp.set(2);
        cMode.set('additive');
        cH.set(60);
        Object.assign(state, { holidays: true, cpCount: 2, mode: 'additive', horizon: 60 });
        update();
      },
      destroy() {},
    };
  },
};
