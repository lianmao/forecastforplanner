/**
 * mod6_error_bias.js —— 模块 6：预测误差体系与偏向性看板（REQ-MOD-07）
 *
 * 汇报时人人都在说"预测准确率 85%"，但仓库依然畅销款断货、滞销款爆仓。
 * 原因是单一准确率指标掩盖了「系统性偏高」还是「系统性偏低」。
 *
 * ★ 这里用的是**样本外**误差：模型只看前 24 期，去预测后 12 期。
 *   用样本内拟合残差算误差会系统性低估真实误差，那是自欺欺人。
 */
import { synthSeries } from '../core/generator.js';
import { holtWintersFit, holtWintersForecast } from '../core/stats.js';
import { summarize, biasRisk } from '../core/metrics.js';

const META = {
  id: 'mod6',
  num: 6,
  group: '第三阶段 · 业务闭环',
  title: '预测误差体系与偏向性预警看板',
  short: '误差与 Bias',
  req: 'REQ-MOD-07',
};

const N = 36;
const TRAIN = 24;
const H = N - TRAIN; // 12
const BASE = synthSeries({
  n: N, start: '2022-01', base: 12000, trend: 80, seasonality: 1500, noise: 700, seed: 606,
});

export default {
  ...META,
  subtitle: '「预测准确率 85%」这句话本身没有信息量。'
    + '真正决定仓库是爆仓还是断货的，是误差的<strong>方向</strong>（Bias）和它对库存的<strong>杠杆</strong>。'
    + '这个模块让你亲手把 Bias 拉出来，看四个指标如何各说各话。',

  create(ctx) {
    const { comp, charts, fmt } = ctx;
    const controls = ctx.controls;
    const state = { shift: 0, intermittent: false };

    const chartEl = comp.h('div', { class: 'chart chart-lg', id: 'mod6-chart' });
    const kpiHost = comp.h('div', { class: 'grid grid-4' });
    const riskHost = comp.h('div', {});
    const tableHost = comp.h('div', { class: 'table-wrap' });
    const errHost = comp.h('div', { hidden: true });

    const cShift = controls.add(comp.slider({
      label: '人工干预偏移量', min: -50, max: 50, step: 5, value: 0, unit: '%',
      help: '模拟计划员主观把预测整体调高或调低。这是 Bias 最常见的来源。',
      onChange: (v) => { state.shift = v; update(); },
    }));
    const cInt = controls.add(comp.toggle({
      label: '注入间歇性低销量场景',
      value: false,
      help: '把最后 4 期实际销量压到很低并制造一个 0 —— 用来观察 MAPE 的失真。',
      onChange: (v) => { state.intermittent = v; update(); },
    }));

    /* ── 固定的样本外预测：只用前 24 期训练 ── */
    const train = BASE.values.slice(0, TRAIN);
    const testLabels = BASE.labels.slice(TRAIN);
    const fit = holtWintersFit(train, { alpha: 0.35, beta: 0.15, gamma: 0.25, phi: 0.97, period: 12 });
    const fc = holtWintersForecast(fit, H);
    const baseForecast = fc.mean;

    function actuals() {
      const a = BASE.values.slice(TRAIN);
      if (!state.intermittent) return a;
      // 后 4 期压到 12%，并把倒数第 2 期置 0（真实业务里的缺货或退市前夜）
      const out = a.slice();
      for (let i = H - 4; i < H; i++) out[i] = Math.round(a[i] * 0.12);
      out[H - 2] = 0;
      return out;
    }

    function update() {
      const actual = actuals();
      const forecast = baseForecast.map((v) => v * (1 + state.shift / 100));

      // 对齐：只用有预测值的区间（HW 从第 1 期起有拟合，这里样本外全部有效）
      const a = actual;
      const f = forecast;
      const t = charts.theme();

      const over = a.map((v, i) => Math.max(0, f[i] - v));
      const under = a.map((v, i) => Math.min(0, f[i] - v));

      const anchor1 = a; // 高估区间锚在「实际」之上
      const anchor2 = a; // 低估区间单独一个 stack，向「实际」之下生长
      const invisible = (data, stack, showInLegend = false) => ({
        name: `_anchor_${stack}`,
        type: 'line',
        data,
        stack,
        symbol: 'none',
        lineStyle: { opacity: 0, width: 0 },
        itemStyle: { opacity: 0 },
        areaStyle: { opacity: 0 },
        silent: true,
        showInLegend,
        tooltip: { show: false },
        legendHoverLink: false,
        z: 1,
      });
      const region = (name, data, stack, color) => ({
        name,
        type: 'line',
        data,
        stack,
        symbol: 'none',
        lineStyle: { opacity: 0, width: 0 },
        areaStyle: { color, opacity: 0.22 },
        silent: true,
        z: 1,
        tooltip: { show: false },
        legendHoverLink: false,
        emphasis: { disabled: true },
      });

      charts.setOption(chartEl, {
        ...charts.baseOption({
          legend: { data: ['实际销量', '系统预测', '高估区间', '低估区间'] },
        }),
        xAxis: charts.catAxis(testLabels, {}),
        yAxis: charts.valAxis('出货量'),
        series: [
          invisible(anchor1, 'over'),
          region('高估区间', over, 'over', t.danger),
          invisible(anchor2, 'under'),
          region('低估区间', under, 'under', t.ok),
          charts.line('实际销量', a, { color: t.ink2, width: 2.6, z: 6 }),
          charts.line('系统预测', f, { color: t.s[0], width: 2.2, dash: 'dashed', z: 5 }),
        ],
      }, { notMerge: true });

      /* ── 指标 ── */
      let s;
      try {
        s = summarize(a, f);
      } catch (e) {
        errHost.hidden = false;
        errHost.replaceChildren(comp.errorBox({
          title: '指标无法计算',
          message: '例如实际需求全为 0 时，百分比类指标没有定义。',
          detail: String(e && e.message ? e.message : e),
        }));
        return;
      }
      errHost.hidden = true;
      const risk = biasRisk(s.bias);

      kpiHost.replaceChildren(
        comp.kpi({
          label: 'MAE 平均绝对误差', value: fmt.num(s.mae, 0), unit: '件',
          sub: '平均每期偏离多少件实物 —— 最直观、最不容易被误解',
        }).el,
        comp.kpi({
          label: 'MAPE 平均绝对百分比误差', value: fmt.pct(s.mape, 1),
          sub: s.mapeExcluded > 0
            ? `${s.mapeExcluded} 期实际为 0 已被剔除 —— 这正是 MAPE 的失真`
            : '注意：低销量期会把百分比推到天文数字',
          tone: s.mapeExcluded > 0 || s.mape > 60 ? 'danger' : '',
        }).el,
        comp.kpi({
          label: 'WAPE 加权百分比误差', value: fmt.pct(s.wape, 1),
          sub: '用总量做分母，不受除零影响 —— 汇报建议用这个',
          tone: 'accent',
        }).el,
        comp.kpi({
          label: 'Bias 偏向性', value: fmt.signed(s.bias, 1), unit: '%',
          sub: s.bias > 0 ? '正 = 系统性高估（积压风险）' : s.bias < 0 ? '负 = 系统性低估（断货风险）' : '无系统性偏向',
          tone: Math.abs(s.bias) > 10 ? 'danger' : Math.abs(s.bias) > 5 ? 'warn' : 'ok',
        }).el,
      );

      /* ── 风险预警灯 ── */
      riskHost.replaceChildren(comp.h('div', {
        class: `tip ${risk.level.startsWith('danger') ? 'tip-alert' : ''}`,
      }, [
        comp.h('p', {
          class: 'tip-title',
          text: risk.level === 'ok' ? '风险状态：健康'
            : risk.level === 'unknown' ? '风险状态：无法判定'
              : `风险预警：${risk.label}`,
        }),
        comp.h('p', { text: risk.hint }),
        comp.h('p', {
          class: 'dim',
          style: 'font-size:12.5px;margin-top:6px',
          text: `判据：|Bias| ≥ 10% 触发红色预警，≥ 5% 触发黄色提醒。当前 |Bias| = ${Math.abs(s.bias).toFixed(1)}%，`
            + `残差标准差 σ = ${fmt.num(s.residualStd, 0)} 件（这个数会直接进模块 7 的安全库存公式）。`,
        }),
      ]));

      /* ── 明细表 ── */
      const rows = testLabels.map((lb, i) => {
        const err = a[i] - f[i];
        return comp.h('tr', {}, [
          comp.h('td', { text: lb }),
          comp.h('td', { class: 'num', text: fmt.num(a[i], 0) }),
          comp.h('td', { class: 'num', text: fmt.num(f[i], 0) }),
          comp.h('td', { class: 'num', text: fmt.signed(err, 0) }),
          comp.h('td', {}, [
            comp.h('span', {
              class: `badge ${err > 0 ? 'good' : err < 0 ? 'hot' : ''}`,
              text: err > 0 ? '低估' : err < 0 ? '高估' : '命中',
            }),
          ]),
        ]);
      });
      tableHost.replaceChildren(comp.h('table', { class: 'data' }, [
        comp.h('thead', {}, [comp.h('tr', {}, [
          comp.h('th', { text: '期间（样本外）' }),
          comp.h('th', { text: '实际' }),
          comp.h('th', { text: '预测' }),
          comp.h('th', { text: '误差（实际−预测）' }),
          comp.h('th', { text: '方向' }),
        ])]),
        comp.h('tbody', {}, rows),
      ]));
    }

    const root = comp.h('div', {}, [
      comp.moduleHeader({ req: META.req, title: META.title, sub: this.subtitle }),
      errHost,

      comp.grid(2, [
        comp.card({
          title: '模拟人工干预',
          hint: `模型只看前 ${TRAIN} 期，评估后 ${H} 期（样本外）`,
          body: [
            comp.h('div', { class: 'controls' }, [cShift.el, cInt.el]),
            comp.h('p', { class: 'ctl-help', html:
              '注意这里是<strong>真样本外</strong>：指数平滑模型只用前 24 期训练，'
              + '去预测后 12 期。用样本内拟合残差算误差会系统性低估真实误差。' }),
            comp.h('p', { class: 'ctl-help', html:
              `训练段（前 ${TRAIN} 期）拟合残差 σ = <strong>${fmt.num(fit.sigma, 0)} 件</strong>，`
              + '这是"模型认为自己有多准"的自我评估；真正的检验是右边的样本外误差。' }),
          ],
        }),
        comp.card({ title: '实际 vs 预测：误差方向一眼可见', hint: '红色阴影 = 高估，绿色阴影 = 低估', body: [chartEl] }),
      ]),

      comp.h('div', { class: 'mt' }, [kpiHost]),
      comp.h('div', { class: 'mt' }, [riskHost]),

      comp.grid(2, [
        comp.card({ title: '样本外逐期明细', body: [tableHost], cls: 'mt' }),
        comp.h('div', { class: 'grid', style: 'gap:14px' }, [
          comp.tipBox({
            lines: [
              '<strong>永远不要只看单点准确率。</strong>一个平均准确率 90% 但 Bias 为 +25% 的预测方案，'
              + '在供应链上是吞噬企业现金流的隐形杀手。',
              '控制好 Bias（方向）往往比抠最后 1% 的精度对公司更致命 —— '
              + '因为 Bias 会<strong>逐期累积到库存水位上</strong>，而随机误差不会。',
              '把滑杆从 0 推到 +30：MAE 几乎线性上升，但 Bias 同时变成红色 —— '
              + '这就是为什么汇报里必须同时给这两个数。',
            ],
          }),
          comp.whyBox({
            title: 'MAPE 为什么会失真，WAPE 为什么更可靠',
            body: [
              '<p>MAPE 的分母是<strong>每一期的实际值</strong>。当某期实际销量很低（间歇性需求、'
              + '缺货、退市前夜），分母很小，单个百分比就会爆掉，把平均值整体拉高。</p>',
              '<p>打开「注入间歇性低销量场景」：你会看到 MAPE 剧烈上升（甚至因出现 0 而剔除期数），'
              + '而 WAPE 基本稳定。因为 WAPE 的分母是<strong>总量</strong>，低销量期在总量里权重本来就小。</p>',
              '<p>结论：<strong>对外汇报用 WAPE + Bias</strong>，MAPE 只在销量稳定、无零值的场景下才可比。'
              + 'MAPE 唯一的好处是"不用解释单位"。</p>',
              '<p>另外注意 Bias 的公式是 <code>Σ(F−A)/Σ(A)</code> —— '
              + '因为分子带符号，正负误差会相互抵消。所以 Bias 接近 0 <strong>不代表误差小</strong>，'
              + '只代表没有系统性方向。必须和 MAE / WAPE 一起看。</p>',
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
        cShift.set(0);
        cInt.set(false);
        Object.assign(state, { shift: 0, intermittent: false });
        update();
      },
      destroy() {},
    };
  },
};
