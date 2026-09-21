/**
 * mod1_decomposition.js —— 模块 1：时间序列三要素拆解与即时合成（REQ-MOD-01）
 *
 * 三个滑杆（趋势 / 季节性 / 噪音）即时合成序列，再用经典拆解把三要素拆回去。
 * 教学点：**你设的参数能不能被拆解还原**。拆不回来就说明拆解方法有偏，
 * 而不是"数据不好"。
 *
 * 单张 ECharts 用 4 个 grid 做「主图 + 3 条分量子图」，共用同一条时间轴。
 */
import { synthSeries, periodLabels } from '../core/generator.js';
import { decompose } from '../core/stats.js';

const META = {
  id: 'mod1',
  num: 1,
  group: '第一阶段 · 传统统计',
  title: '时间序列三要素拆解与即时合成',
  short: '时序拆解',
  req: 'REQ-MOD-01',
};

const N = 72;
const START = '2020-01';
const BASE = 1000;

export default {
  ...META,
  subtitle: '销量大涨时，分不清是周期性旺季、产品生命周期在增长，还是不可控的偶然扰动（噪音），'
    + '就会错误地加备货。把序列拆成 趋势 + 季节 + 残差 是看清这件事的基本功。',

  create(ctx) {
    const { comp, charts, fmt } = ctx;
    const controls = ctx.controls;

    const state = { mode: 'additive', trend: 2, seasonality: 20, noise: 5 };

    const chartEl = comp.h('div', { class: 'chart', id: 'mod1-chart', style: 'height:640px' });
    const kpiHost = comp.h('div', { class: 'grid grid-4' });
    const tableHost = comp.h('div', { class: 'table-wrap' });

    const kSlope = controls.add(comp.slider({
      label: '趋势斜率（件/月）', min: -5, max: 10, step: 0.5, value: state.trend, decimals: 1,
      help: '销量长期的基本盘增长 / 萎缩速度',
      onChange: (v) => { state.trend = v; update(); },
    }));
    const kSeason = controls.add(comp.slider({
      label: '季节性振幅 A（件）', min: 0, max: 50, step: 1, value: state.seasonality,
      help: '淡旺季差异的剧烈程度（周期固定 12 个月）',
      onChange: (v) => { state.seasonality = v; update(); },
    }));
    const kNoise = controls.add(comp.slider({
      label: '随机噪音强度（件）', min: 0, max: 30, step: 1, value: state.noise,
      help: '市场偶发不可控扰动的标准差',
      onChange: (v) => { state.noise = v; update(); },
    }));
    const kMode = controls.add(comp.radio({
      label: '分解模式',
      options: [
        { value: 'additive', label: '加法模型', title: 'Y = T + S + R，季节波动绝对幅度恒定' },
        { value: 'multiplicative', label: '乘法模型', title: 'Y = T × S × R，季节波动随基本盘成比例放大' },
      ],
      value: state.mode,
      help: '选择序列各成分的合成机制。乘法模型下季节项表达为倍数（如 1.08 = 高于基准 8%）。',
      onChange: (v) => { state.mode = v; update(); },
    }));

    function buildSeries() {
      return synthSeries({
        n: N, start: START, base: BASE,
        trend: state.trend, seasonality: state.seasonality, noise: state.noise,
        seed: 4242, mode: state.mode,
      });
    }

    function update() {
      const s = buildSeries();
      const d = decompose(s.values, { mode: state.mode, period: 12 });
      const t = charts.theme();
      const isAdd = state.mode === 'additive';

      /* ── 4 宫格布局：主图高、三条分量各占一段 ──
         容器高度固定 640px，所以网格用**像素**定位，不用百分比 ——
         百分比在不同容器高度下会互相挤压，像素值是确定的。
         轴的 gridIndex 必须逐个指定，否则全部画在第一个网格上。 */
      const XS = [0, 1, 2, 3].map((i) => charts.catAxis(s.labels, { gridIndex: i }));
      for (let i = 0; i < 3; i++) XS[i].axisLabel.show = false;

      const yAxis = [
        charts.valAxis('出货量', { gridIndex: 0 }),
        charts.valAxis('趋势 T', { gridIndex: 1 }),
        charts.valAxis(isAdd ? '季节 S（件）' : '季节 S（倍数）', { gridIndex: 2 }),
        charts.valAxis('残差 R', { gridIndex: 3 }),
      ];
      for (let i = 1; i <= 3; i++) {
        yAxis[i].splitNumber = 2;
        yAxis[i].axisLabel.fontSize = 10;
      }

      const series = [
        charts.line('实际序列 Y', s.values, { color: t.ink2, width: 2.2, xAxisIndex: 0, yAxisIndex: 0 }),
        charts.line('趋势 T', d.trend, { color: t.s[0], width: 2, dash: 'solid', xAxisIndex: 1, yAxisIndex: 1 }),
        charts.line(isAdd ? '季节 S' : '季节 S ×基准', isAdd ? d.seasonalSeries : d.seasonalSeries.map((v) => v * BASE),
          { color: t.s[1], width: 1.8, xAxisIndex: 2, yAxisIndex: 2, area: true, areaOpacity: 0.1 }),
        charts.line('残差 R', d.residual, { color: t.s[4], width: 1.4, xAxisIndex: 3, yAxisIndex: 3 }),
      ];
      // 主图上叠加「趋势+季节」，直观显示噪音造成的偏离
      series.push(charts.line('趋势 + 季节',
        s.values.map((v, i) => (d.trend[i] === null ? null
          : isAdd ? d.trend[i] + d.seasonalSeries[i] : d.trend[i] * d.seasonalSeries[i])),
        { color: t.s[2], width: 1.4, dash: 'dashed', xAxisIndex: 0, yAxisIndex: 0 }));

      charts.setOption(chartEl, {
        ...charts.baseOption({
          grid: false,
          legend: { top: 0, left: 0 },
          tooltip: { trigger: 'axis' },
        }),
        animation: false,
        grid: [
          { left: 64, right: 22, top: 56, height: 184 },
          { left: 64, right: 22, top: 300, height: 85 },
          { left: 64, right: 22, top: 415, height: 85 },
          { left: 64, right: 22, top: 530, height: 85 },
        ],
        xAxis: XS,
        yAxis,
        series,
      }, { notMerge: true });

      /* ── KPI：把你设的参数和拆解还原出来的对照 ── */
      const slope = d.trendSlope;
      const ampOut = isAdd ? d.seasonalAmp : d.seasonalAmp * 100;
      const ampIn = isAdd ? state.seasonality * 2 : state.seasonality * 2 / BASE * 100;
      const resShare = (() => {
        const res = d.residual.filter((r) => r !== null);
        const m = res.reduce((a, b) => a + b, 0) / res.length;
        const sd = Math.sqrt(res.reduce((a, b) => a + (b - m) ** 2, 0) / (res.length - 1));
        const all = s.values;
        const am = all.reduce((a, b) => a + b, 0) / all.length;
        const asd = Math.sqrt(all.reduce((a, b) => a + (b - am) ** 2, 0) / (all.length - 1));
        return (sd / asd) * 100;
      })();

      kpiHost.replaceChildren(
        comp.kpi({
          label: '拆解出的趋势斜率',
          value: slope === null ? '—' : slope.toFixed(2),
          unit: '件/月',
          sub: `你设定的是 ${state.trend.toFixed(1)} 件/月`,
          tone: slope !== null && Math.abs(slope - state.trend) < 0.4 ? 'accent' : '',
        }).el,
        comp.kpi({
          label: '季节峰谷差',
          value: ampOut.toFixed(isAdd ? 0 : 1),
          unit: isAdd ? '件' : '%',
          sub: `你设定的是 ${ampIn.toFixed(isAdd ? 0 : 1)}${isAdd ? ' 件' : '%'}（= 2A）`,
        }).el,
        comp.kpi({
          label: '残差标准差',
          value: d.noiseStd.toFixed(1),
          unit: isAdd ? '件' : '',
          sub: `你设定的是 ${state.noise} 件`,
          tone: Math.abs(d.noiseStd - state.noise) < 2 ? 'accent' : '',
        }).el,
        comp.kpi({
          label: '噪音占整体波动',
          value: resShare.toFixed(1),
          unit: '%',
          sub: '残差标准差 ÷ 原序列标准差',
        }).el,
      );

      /* ── 季节指数表（一个周期 12 期）── */
      const rows = d.seasonal.map((v, m) => comp.h('tr', {}, [
        comp.h('td', { text: periodLabels(`${START.slice(0, 4)}-01`, 12)[m]?.slice(5) ?? String(m + 1) }),
        comp.h('td', { class: 'num', text: isAdd ? v.toFixed(1) : `${v.toFixed(4)}（${((v - 1) * 100).toFixed(2)}%）` }),
      ]));
      tableHost.replaceChildren(comp.h('table', { class: 'data' }, [
        comp.h('thead', {}, [comp.h('tr', {}, [
          comp.h('th', { text: '月份' }),
          comp.h('th', { text: isAdd ? '季节指数（件）' : '季节指数（倍数 = 相对基准）' }),
        ])]),
        comp.h('tbody', {}, rows),
      ]));
    }

    const root = comp.h('div', {}, [
      comp.moduleHeader({ req: META.req, title: META.title, sub: this.subtitle }),

      comp.grid(2, [
        comp.card({
          title: '合成三要素',
          hint: `${N} 期月度数据`,
          body: [
            comp.h('div', { class: 'controls' }, [kMode.el, kSlope.el, kSeason.el, kNoise.el]),
            comp.h('p', { class: 'ctl-help mt', html:
              '你的滑杆<strong>先合成</strong>一条序列，下面的图表再把它<strong>拆解</strong>回去。'
              + '两条路走的必须是同一套数学，否则拆解结果没有意义。' }),
          ],
        }),
        comp.h('div', { class: 'grid', style: 'gap:14px' }, [
          chartEl,
          comp.h('p', { class: 'ctl-help', html:
            '趋势线两端<strong>故意留缺口</strong>：居中移动平均需要前后各 6 期才能算出一个趋势值，'
            + '序列头尾没有足够历史。这是诚实的做法 —— 与其外推补一个假值，不如留白。' }),
        ]),
      ]),

      comp.h('div', { class: 'mt' }, [kpiHost]),

      comp.grid(2, [
        comp.card({ title: '一个周期内的季节指数', body: [tableHost] }),
        comp.h('div', { class: 'grid', style: 'gap:14px' }, [
          comp.tipBox({
            lines: [
              '把 <strong>Noise（噪音）拉到最大</strong>，你会发现原本清晰的季节波峰变得模糊难辨。'
              + '实际业务里，过滤噪音、识别真实趋势是避免「牛鞭效应」的第一步。',
              '但注意：噪音不改变趋势斜率，只让<strong>短期判断</strong>更不可靠。'
              + '所以不要用一两个月的波动去改年度预测。',
            ],
          }),
          comp.whyBox({
            title: '加法模型还是乘法模型？看季节波动的绝对幅度',
            body: [
              '<p>加法：季节波动的<strong>绝对幅度恒定</strong>（每月都是 ±20 件）—— 适合成熟稳定的品类。</p>',
              '<p>乘法：季节波动的<strong>绝对幅度随基本盘放大</strong>（旺季卖得多，旺季超出量也更多）'
              + '—— 适合还在增长的品类、或促销驱动的品类。</p>',
              '<p>判断方法：把历史分成前后两段，各自算季节峰谷差。后段明显更大 → 用乘法。'
              + '本模块把乘法模型的季节指数表达为<strong>倍数</strong>（1.08 = 高于基准 8%），'
              + '就是为了让你可以直接把它乘到预测基准上。</p>',
              '<p>拆解本身也有边界：居中移动平均假设「一个完整周期内季节效应相互抵消」，'
              + '如果周期设错（比如真实周期是 13 期却按 12 期拆），季节项会被算进残差里。</p>',
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
        kMode.set('additive');
        kSlope.set(2);
        kSeason.set(20);
        kNoise.set(5);
        Object.assign(state, { mode: 'additive', trend: 2, seasonality: 20, noise: 5 });
        update();
      },
      destroy() {},
    };
  },
};
