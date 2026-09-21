/**
 * mod2_moving_average.js —— 模块 2：移动平均平滑与反应滞后体验（REQ-MOD-02）
 *
 * 教学点：**平滑与滞后是一对不可分割的取舍**。
 * 窗口 k 越大越平滑（不受单笔偶发采购干扰），但对市场拐点的反应越迟钝。
 * 产品进入衰退期时，大窗口会导致严重高估与库存积压。
 *
 * 数据用带两个明确拐点的测试序列（makeTurningPointSeries），方便量化滞后。
 */
import { makeTurningPointSeries } from '../core/generator.js';
import { movingAverage, peakLag } from '../core/stats.js';

const META = {
  id: 'mod2',
  num: 2,
  group: '第一阶段 · 传统统计',
  title: '移动平均：平滑度与拐点滞后',
  short: '移动平均',
  req: 'REQ-MOD-02',
};

const DATA = makeTurningPointSeries({ n: 36, noise: 8, seed: 7 });

function std(arr) {
  const v = arr.filter((x) => Number.isFinite(x));
  if (v.length < 2) return NaN;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
}

export default {
  ...META,
  subtitle: '销售经理说看「过去 3 个月平均」，采购经理说看「过去 12 个月平均」。'
    + '这不是谁对谁错，而是平滑噪声与快速响应拐点之间必须做的取舍 —— 这个模块让你亲手量出代价。',

  create(ctx) {
    const { comp, charts, fmt } = ctx;
    const controls = ctx.controls;
    const state = { method: 'sma', k: 3 };

    const chartEl = comp.h('div', { class: 'chart chart-lg', id: 'mod2-chart' });
    const kpiHost = comp.h('div', { class: 'grid grid-4' });
    const tableHost = comp.h('div', { class: 'table-wrap' });
    const readout = comp.h('p', { class: 'ctl-help' });

    const cMethod = controls.add(comp.radio({
      label: '平滑方法',
      options: [
        { value: 'sma', label: '简单移动平均 SMA', title: '窗口内等权' },
        { value: 'wma', label: '线性加权移动平均 WMA', title: '近期权重更高' },
      ],
      value: state.method,
      help: 'SMA 等权；WMA 权重 1,2,…,k，最近一期权重最大。',
      onChange: (v) => { state.method = v; update(); },
    }));
    const cK = controls.add(comp.slider({
      label: '滑动窗口 k（期）', min: 2, max: 24, step: 1, value: state.k,
      help: '计算平均所参考的历史期数。注意这是「单侧」窗口：只用过去，不用未来。',
      onChange: (v) => { state.k = v; update(); },
    }));

    function update() {
      const values = DATA.values;
      const labels = DATA.labels;
      const ma = movingAverage(values, { method: state.method, k: state.k });
      const lag = peakLag(values, ma);
      const t = charts.theme();

      const smoothedStd = std(ma);
      const rawStd = std(values);
      const smoothRatio = smoothedStd / rawStd;

      const maSeries = charts.line(
        `${state.method.toUpperCase()}（k=${state.k}）`, ma,
        { color: t.s[0], width: 3, z: 6 },
      );

      // 滞后指示：从「实际峰值」到「平滑后峰值」画一段水平虚线，高低差一眼可见
      if (lag.pairs.length) {
        maSeries.markLine = {
          silent: true,
          symbol: ['none', 'none'],
          lineStyle: { color: t.s[1], width: 1.4, type: 'dashed', opacity: 0.9 },
          label: { show: false },
          data: lag.pairs.map((p) => ([
            { coord: [labels[p.actualIndex], values[p.actualIndex]] },
            { coord: [labels[p.smoothedIndex], values[p.actualIndex]] },
          ])),
        };
        maSeries.markPoint = {
          symbol: 'circle',
          symbolSize: 10,
          itemStyle: { color: t.s[1], borderColor: t.panel, borderWidth: 1.5 },
          label: {
            show: true, position: 'top', distance: 8,
            color: t.s[1], fontSize: 11, fontWeight: 600,
            formatter: (p) => `滞后 ${lag.pairs[p.dataIndex]?.lag ?? ''} 期`,
          },
          data: lag.pairs.map((p) => ({ coord: [labels[p.smoothedIndex], ma[p.smoothedIndex]] })),
        };
      }

      charts.setOption(chartEl, {
        ...charts.baseOption({}),
        xAxis: charts.catAxis(labels, {}),
        yAxis: charts.valAxis('出货量'),
        series: [
          charts.line('实际销量', values, { color: t.ink2, width: 1.8, z: 3, opacity: 0.95 }),
          maSeries,
        ],
      }, { notMerge: true });

      kpiHost.replaceChildren(
        comp.kpi({
          label: '平均拐点滞后',
          value: lag.meanLag === null ? '—' : lag.meanLag.toFixed(1),
          unit: '期',
          sub: lag.pairs.length ? `基于 ${lag.pairs.length} 个拐点` : '当前窗口下未识别到成对拐点',
          tone: lag.meanLag !== null && lag.meanLag >= 3 ? 'warn' : 'accent',
        }).el,
        comp.kpi({
          label: '平滑后波动',
          value: smoothRatio.toFixed(3),
          unit: '×',
          sub: `原序列标准差 ${fmt.num(rawStd, 1)} → ${fmt.num(smoothedStd, 1)}`,
          tone: smoothRatio < 0.6 ? 'ok' : '',
        }).el,
        comp.kpi({
          label: '预测线可用期数',
          value: String(values.length - state.k + 1),
          unit: `/${values.length}`,
          sub: `窗口 k=${state.k} 吃掉前 ${state.k - 1} 期`,
        }).el,
        comp.kpi({
          label: '方法',
          value: state.method === 'sma' ? 'SMA' : 'WMA',
          sub: state.method === 'wma' ? '近期权重更高，拐点反应略快' : '等权，最平稳',
        }).el,
      );

      const rows = lag.pairs.length
        ? lag.pairs.map((p) => comp.h('tr', {}, [
          comp.h('td', { text: labels[p.actualIndex] }),
          comp.h('td', { text: labels[p.smoothedIndex] }),
          comp.h('td', { class: 'num', text: `${p.lag} 期` }),
          comp.h('td', { class: 'num', text: fmt.num(values[p.actualIndex], 0) }),
          comp.h('td', { class: 'num', text: fmt.num(ma[p.smoothedIndex], 0) }),
        ]))
        : [comp.h('tr', {}, [comp.h('td', { colspan: '5', class: 'dim', text: '未识别到成对的峰值 —— 窗口太长时平滑线可能已经找不到峰。' })])];
      tableHost.replaceChildren(comp.h('table', { class: 'data' }, [
        comp.h('thead', {}, [comp.h('tr', {}, [
          comp.h('th', { text: '实际峰值期' }),
          comp.h('th', { text: '平滑峰值期' }),
          comp.h('th', { text: '滞后' }),
          comp.h('th', { text: '实际值' }),
          comp.h('th', { text: '平滑值' }),
        ])]),
        comp.h('tbody', {}, rows),
      ]));

      readout.textContent = lag.meanLag === null
        ? '把窗口调小一些，让平滑线能保留住峰的形状，才能量出滞后。'
        : `按当前窗口，预测线平均比实际拐点慢 ${lag.meanLag.toFixed(1)} 期。`
          + `这意味着拐点出现后你会继续按旧趋势备货约 ${lag.meanLag.toFixed(0)} 个月 —— 那几个月就是积压或断货的来源。`;
    }

    const root = comp.h('div', {}, [
      comp.moduleHeader({ req: META.req, title: META.title, sub: this.subtitle }),

      comp.grid(2, [
        comp.card({
          title: '平滑参数',
          hint: `${DATA.values.length} 期月度数据（含 2 个明显拐点）`,
          body: [
            comp.h('div', { class: 'controls' }, [cMethod.el, cK.el]),
            readout,
            comp.h('p', { class: 'ctl-help', html:
              '注意：<strong>移动平均只能用过去</strong>（单侧窗口）。'
              + '这是它天然滞后的根源 —— 任何只用历史数据的方法都躲不开，'
              + '差别只在滞后多少期。' }),
          ],
        }),
        comp.card({ title: '实际销量 vs 平滑预测线', hint: '橙色虚线标出滞后', body: [chartEl] }),
      ]),

      comp.h('div', { class: 'mt' }, [kpiHost]),

      comp.grid(2, [
        comp.card({ title: '拐点滞后明细', body: [tableHost] }),
        comp.h('div', { class: 'grid', style: 'gap:14px' }, [
          comp.tipBox({
            lines: [
              '滑动窗口 k 越长，曲线越平稳（不受单笔偶发采购干扰），但对市场拐点的反应越迟钝。',
              '<strong>当产品进入生命周期衰退期时，大窗口会导致严重高估预测与库存积压。</strong>'
              + ' 把 k 从 3 拉到 12，看左侧「平均拐点滞后」和「平滑后波动」两个数字同时变大变小 —— '
              + '这就是取舍的量化形式。',
            ],
          }),
          comp.whyBox({
            title: '为什么 WMA 比 SMA 反应快一点，但快得有限',
            body: [
              '<p>SMA 对窗口内每期等权，第 k 期前的数据掉了权重和第 k+1 期进来的权重一样，'
              + '所以整条线像一个固定长度的"平均箱"被拖着走。</p>',
              '<p>WMA 给最近一期 k/(k(k+1)/2) 的权重（k=3 时是 1/2），'
              + '新信息进来能立刻抬高曲线 —— 但<strong>它仍然要等新信息进来</strong>，'
              + '所以只是把滞后从 k/2 期缩短一点，不可能消除。</p>',
              '<p>真正想消除滞后，得引外部信息（促销计划、大客户订单、竞品动作），'
              + '这就是后面模块 4 存在的理由。</p>',
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
        cMethod.set('sma');
        cK.set(3);
        Object.assign(state, { method: 'sma', k: 3 });
        update();
      },
      destroy() {},
    };
  },
};
