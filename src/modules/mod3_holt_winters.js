/**
 * mod3_holt_winters.js —— 模块 3：阻尼三次指数平滑（REQ-MOD-05）
 *
 * 教学点：α/β/γ 不是"天书参数"，每个都对应一句业务话。
 * 并且阻尼系数 φ 是防止新产品上线初期「预测盲目上天」的刹车器 ——
 * 本模块同时画出 φ=1（无阻尼）的外推线做对照，差别一眼可见。
 *
 * ★ 诚实边界（写在界面上，不是藏在代码里）：本实现是「固定初始状态 + 你给的参数」
 *   递推，不会复现 statsmodels 那种「联合最优化初始状态与平滑参数」的结果。
 *   可以复现的是公式本身；任何"与 Python 完全一致"的说法都不成立。
 */
import { synthSeries, periodLabels } from '../core/generator.js';
import { holtWinters, holtWintersFit, holtWintersForecast, styleLabel } from '../core/stats.js';
import { rmse, mae } from '../core/metrics.js';

const META = {
  id: 'mod3',
  num: 3,
  group: '第一阶段 · 传统统计',
  title: '阻尼三次指数平滑：参数敏感度实验',
  short: '指数平滑',
  req: 'REQ-MOD-05',
};

const N = 60;
const START = '2020-01';
const H = 12;

const DATA = synthSeries({
  n: N, start: START, base: 1000, trend: 4, seasonality: 60, noise: 25, seed: 33,
});

export default {
  ...META,
  subtitle: 'ERP 里的 α、β、γ 参数像天书。这个模块让你拖滑杆，直接看到「调大调小对业务预测意味着什么」'
    + '—— 包括那把防止新品类预测上天的刹车：阻尼系数 φ。',

  create(ctx) {
    const { comp, charts, fmt } = ctx;
    const controls = ctx.controls;
    const state = { alpha: 0.3, beta: 0.1, gamma: 0.2, phi: 0.98 };

    const chartEl = comp.h('div', { class: 'chart chart-lg', id: 'mod3-chart' });
    const kpiHost = comp.h('div', { class: 'grid grid-4' });
    const styleHost = comp.h('div', {});
    const tableHost = comp.h('div', { class: 'table-wrap' });

    const cA = controls.add(comp.slider({
      label: '水平权重 α', min: 0.01, max: 0.99, step: 0.05, value: state.alpha, decimals: 2,
      help: '近期基准水平的敏感度。大 = 追随最新变动；小 = 依赖历史平稳。',
      onChange: (v) => { state.alpha = v; update(); },
    }));
    const cB = controls.add(comp.slider({
      label: '趋势权重 β', min: 0.01, max: 0.99, step: 0.05, value: state.beta, decimals: 2,
      help: '斜率趋势的更新敏感度。',
      onChange: (v) => { state.beta = v; update(); },
    }));
    const cG = controls.add(comp.slider({
      label: '季节权重 γ', min: 0.01, max: 0.99, step: 0.05, value: state.gamma, decimals: 2,
      help: '季节周期波形的更新灵敏度。',
      onChange: (v) => { state.gamma = v; update(); },
    }));
    const cP = controls.add(comp.slider({
      label: '阻尼系数 φ', min: 0.8, max: 1, step: 0.02, value: state.phi, decimals: 2,
      help: '抑制趋势过度盲目外推的收敛因子。φ=1 表示不阻尼，长期外推会无限上翘。',
      onChange: (v) => { state.phi = v; update(); },
    }));

    const future = periodLabels(DATA.labels[N - 1], H + 1).slice(1);

    function update() {
      const values = DATA.values;
      const params = { ...state, period: 12, seasonal: true };
      const fit = holtWintersFit(values, params);
      const fc = holtWintersForecast(fit, H);
      const undamped = holtWintersFit(values, { ...params, phi: 1 });
      const fcUndamped = holtWintersForecast(undamped, H);

      const labels = [...DATA.labels, ...future];
      const n = labels.length;
      const pad = (arr) => [...arr, ...new Array(H).fill(null)];

      const hist = [...values, ...new Array(H).fill(null)];
      const fittedLine = pad(fit.fitted);
      const fcMean = [...new Array(N - 1).fill(null), values[N - 1], ...fc.mean];
      const fcLower = [...new Array(N - 1).fill(null), values[N - 1], ...fc.lower];
      const fcUpper = [...new Array(N - 1).fill(null), values[N - 1], ...fc.upper];
      const fcUn = [...new Array(N - 1).fill(null), values[N - 1], ...fcUndamped.mean];

      const t = charts.theme();
      const bandSeries = charts.band(fcLower, fcUpper, { color: t.s[1], name: '95% 预测区间' });

      const fittedPairs = fit.fitted.filter((f) => f !== null);
      const actualPairs = values.slice(values.length - fittedPairs.length);
      const fitRmse = rmse(actualPairs, fittedPairs);
      const fitMae = mae(actualPairs, fittedPairs);

      charts.setOption(chartEl, {
        ...charts.baseOption({
          // ★ 图例必须用白名单：ECharts 的系列**没有** showInLegend 属性，
          //   唯一可靠的排除方式是不把它的名字放进 legend.data。
          //   否则置信区间带会多出一项「xxx 上界」，看起来像两个不同的东西。
          legend: { data: ['历史实际', '模型拟合', '无阻尼外推（φ=1）', `预测（φ=${state.phi.toFixed(2)}）`] },
        }),
        xAxis: charts.catAxis(labels, { zoom: null }),
        yAxis: charts.valAxis('出货量'),
        series: [
          ...bandSeries,
          charts.line('历史实际', hist, { color: t.ink2, width: 2, z: 5 }),
          charts.line('模型拟合', fittedLine, { color: t.s[0], width: 1.6, z: 4 }),
          charts.line('无阻尼外推（φ=1）', fcUn, { color: t.s[4], width: 1.4, dash: 'dotted', z: 3 }),
          charts.line(`预测（φ=${state.phi.toFixed(2)}）`, fcMean, { color: t.s[1], width: 2.6, z: 6 }),
        ],
      }, { notMerge: true });

      /* ── 阻尼的量化：第 h 期的趋势累计权重 ── */
      let cumPhi = 0;
      let p = 1;
      for (let i = 0; i < H; i++) { p *= state.phi; cumPhi += p; }

      kpiHost.replaceChildren(
        comp.kpi({
          label: '拟合 RMSE', value: fmt.num(fitRmse, 0), unit: '件',
          sub: `MAE ${fmt.num(fitMae, 0)} 件 · 残差 σ ${fmt.num(fit.sigma, 0)}`,
        }).el,
        comp.kpi({
          label: `第 ${H} 期预测`, value: fmt.num(fc.mean[H - 1], 0), unit: '件',
          sub: `相对最新实际 ${fmt.signed(((fc.mean[H - 1] / values[N - 1]) - 1) * 100, 1)}%`,
          tone: 'accent',
        }).el,
        comp.kpi({
          label: `第 ${H} 期趋势累计权重`,
          value: cumPhi.toFixed(2),
          sub: `φ=1 时是 ${H} —— 阻尼把它压到 ${(cumPhi / H * 100).toFixed(0)}%`,
          tone: cumPhi < H * 0.7 ? 'ok' : 'warn',
        }).el,
        comp.kpi({
          label: '预测区间宽度', value: fmt.num(fc.upper[H - 1] - fc.lower[H - 1], 0), unit: '件',
          sub: 'σ√h 扩散：越远越不确定',
        }).el,
      );

      /* ── 风格仪表卡 ── */
      const st = styleLabel(state);
      styleHost.replaceChildren(comp.card({
        title: '模型风格仪表',
        hint: `α=${state.alpha.toFixed(2)} β=${state.beta.toFixed(2)} γ=${state.gamma.toFixed(2)} φ=${state.phi.toFixed(2)}`,
        body: [
          comp.h('p', { style: 'margin:0 0 6px;font-size:20px;font-weight:700;color:var(--accent)', text: st.tag }),
          comp.h('p', { class: 'ctl-help', style: 'font-size:13px', text: st.desc }),
        ],
      }));

      /* ── 未来 12 期明细 ── */
      tableHost.replaceChildren(comp.h('table', { class: 'data' }, [
        comp.h('thead', {}, [comp.h('tr', {}, [
          comp.h('th', { text: '期间' }),
          comp.h('th', { text: '点预测' }),
          comp.h('th', { text: '下界 95%' }),
          comp.h('th', { text: '上界 95%' }),
          comp.h('th', { text: '区间宽度' }),
        ])]),
        comp.h('tbody', {}, future.map((lb, i) => comp.h('tr', {}, [
          comp.h('td', { text: lb }),
          comp.h('td', { class: 'num', text: fmt.num(fc.mean[i], 0) }),
          comp.h('td', { class: 'num', text: fmt.num(fc.lower[i], 0) }),
          comp.h('td', { class: 'num', text: fmt.num(fc.upper[i], 0) }),
          comp.h('td', { class: 'num', text: fmt.num(fc.upper[i] - fc.lower[i], 0) }),
        ]))),
      ]));
    }

    const root = comp.h('div', {}, [
      comp.moduleHeader({ req: META.req, title: META.title, sub: this.subtitle }),

      comp.grid(2, [
        comp.card({
          title: '四个平滑参数',
          hint: `${N} 期历史 + 外推 ${H} 期`,
          body: [
            comp.h('div', { class: 'controls' }, [cA.el, cB.el, cG.el, cP.el]),
            comp.h('p', { class: 'ctl-help', html:
              '初始状态固定取「前两个完整季节的均值与斜率差」，而不是最优化求解 —— '
              + '所以这里的数字<strong>不会与 statsmodels 逐位一致</strong>，'
              + '但它能让你看到参数的作用方向，那才是计划员需要的东西。' }),
          ],
        }),
        comp.card({ title: '拟合与未来 12 期外推', hint: '橙色为阻尼后预测，红色点线为无阻尼对照', body: [chartEl] }),
      ]),

      comp.h('div', { class: 'mt' }, [kpiHost]),

      comp.grid(2, [
        styleHost,
        comp.tipBox({
          lines: [
            'α 调得过高（如 &gt; 0.8），模型会像<strong>惊弓之鸟</strong>：'
            + '把客户的一次偶发加单当成大势已来，下一期计划量立刻跟着飙。',
            'α 过低（如 &lt; 0.1），模型变成<strong>迟钝的恐龙</strong>：'
            + '市场已经变了它还在按两年前的水平预测。',
            '把 φ 从 0.98 拖到 0.80，看红色点线（无阻尼）和橙线（阻尼）分开多少 —— '
            + '那就是「新产品上线初期盲目加量」被刹掉的部分。',
          ],
        }),
      ]),

      comp.grid(2, [
        comp.card({ title: '未来 12 期预测明细', body: [tableHost], cls: 'mt' }),
        comp.whyBox({
          title: '为什么"预测区间"必须显示出来',
          body: [
            '<p>区间宽度按 <code>σ·√h</code> 扩散：σ 是你历史拟合的残差标准差，h 是外推期数。</p>',
            '<p>这解释了一件很反直觉的事：<strong>越远的预测越不该被当成一个确定数字用</strong>。'
            + '把它当成"至少 / 至多"去设计安全库存，比当成点值靠谱得多 —— '
            + '这正是模块 7 要算的东西。</p>',
            '<p>注意本实现用的是教学简化式，不是 statsmodels 的精确预测方差公式，'
            + '所以区间宽度是"同量级"而不是"完全一致"。方向是对的，别拿它去做财务精算。</p>',
            '<p>还有一个容易被忽略的边界：<strong>残差里有自相关时，σ 会被低估</strong>，'
            + '区间会显得比真实情况窄。判断方法还是那句话 —— 看残差图里有没有结构。</p>',
          ],
        }),
      ]),
    ]);

    // ★ 首次绘制**故意不在这里做**：此时 root 还没挂到 document 上，
    //   ECharts 量到的容器宽度是 0，zrender 在尺寸为 0 时不会创建画布，
    //   之后 resize() 也救不回来。改由 app.js 在挂载完成后调用 api.update()。
    return {
      root,
      update,          // app.js 在容器挂载后会再调一次（图表容器必须已布局才能测量宽度）
      reset() {
        for (const [c, v] of [[cA, 0.3], [cB, 0.1], [cG, 0.2], [cP, 0.98]]) c.set(v);
        Object.assign(state, { alpha: 0.3, beta: 0.1, gamma: 0.2, phi: 0.98 });
        update();
      },
      destroy() {},
    };
  },
};
