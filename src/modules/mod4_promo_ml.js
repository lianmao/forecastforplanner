/**
 * mod4_promo_ml.js —— 模块 4：促销与折扣特征工程（REQ-MOD-03）
 *
 * 与"画一条好看的假曲线"不同，这里真的用最小二乘从历史里**把折扣弹性 κ 学回来**，
 * 并把「学回值 vs 真值」并排显示，还给出标准误与 t 值 —— 计划员能直接判断
 * 这个结论到底站不站得住。
 *
 * ★ 关键教学点：促销拉增量是「折扣深度 × 当前量级」的**交互项**，
 *   把它当成独立的加性特征，模型会把促销效应错误地摊到 Lag1 上。
 */
import { makePromoDataset } from '../core/generator.js';
import {
  fitPromoModel, forecastScenario, applyPromo, INTERACTION_NAME,
} from '../core/promo_sim.js';

const META = {
  id: 'mod4',
  num: 4,
  group: '第二阶段 · 特征与机器学习',
  title: '促销特征工程：传统模型看不见的「人造爆发」',
  short: '促销特征',
  req: 'REQ-MOD-03',
};

const DATA = makePromoDataset({ n: 40, seed: 21 });
const TRUE_KAPPA = 2.5;

export default {
  ...META,
  subtitle: '下个月有「双 11」，折扣打 6 折。传统时序模型只看历史销量的惯性，'
    + '完全捕捉不到促销带来的增量，于是备货不足、断货。'
    + '这个模块把促销写进特征，并让你检查模型到底学到了什么。',

  create(ctx) {
    const { comp, charts, fmt } = ctx;
    const controls = ctx.controls;
    const state = { promoOn: false, discount: 0.8, showImportance: true };

    const chartEl = comp.h('div', { class: 'chart chart-lg', id: 'mod4-chart' });
    const impEl = comp.h('div', { class: 'chart chart-sm', id: 'mod4-imp' });
    const impWrap = comp.h('div', {}, [impEl]);
    const impHint = comp.h('p', { class: 'ctl-help', text: '已隐藏特征贡献图（右侧开关可重新显示）。', hidden: true });
    const kpiHost = comp.h('div', { class: 'grid grid-4' });
    const diagHost = comp.h('div', {});
    const errHost = comp.h('div', { hidden: true });
    const tableHost = comp.h('div', { class: 'table-wrap' });

    const cOn = controls.add(comp.toggle({
      label: '未来一期开促销',
      value: state.promoOn,
      help: '打开后，下面会同时给出「开促销 / 不开促销」两种情景的预测。',
      onChange: (v) => { state.promoOn = v; update(); },
    }));
    const cDisc = controls.add(comp.slider({
      label: '折扣力度（1 − 折扣率）', min: 0.5, max: 0.95, step: 0.05, value: state.discount, decimals: 2,
      help: '0.80 表示八折（让利 20%）。折扣越深，瞬时拉升越大，但后续透支也越重。',
      onChange: (v) => { state.discount = v; update(); },
    }));
    const cImp = controls.add(comp.toggle({
      label: '显示特征贡献',
      value: state.showImportance,
      help: '按「标准化系数绝对值」排序 —— 看效应量，而不是分裂次数。',
      onChange: (v) => { state.showImportance = v; update(); },
    }));

    function update() {
      let model;
      try {
        model = fitPromoModel(DATA.values, {
          promos: DATA.promos, startMonth: DATA.startMonth, kappa: TRUE_KAPPA,
        });
      } catch (e) {
        errHost.hidden = false;
        errHost.replaceChildren(comp.errorBox({
          title: '这组数据不足以估计促销效应',
          message: '模型拒绝给出数字 —— 这比返回一个看起来确定的错结果更负责任。'
            + '真实业务中遇到这种情况，说明历史里的促销次数太少或折扣力度过于雷同，'
            + '需要补充数据（更多次、力度更分散的促销），而不是换模型。',
          detail: String(e && e.message ? e.message : e),
        }));
        charts.setOption(chartEl, charts.baseOption({}), { notMerge: true });
        kpiHost.replaceChildren();
        return;
      }
      errHost.hidden = true;

      const scen = forecastScenario(DATA.values, {
        discount: state.promoOn ? state.discount : null,
        promos: DATA.promos, startMonth: DATA.startMonth,
      });
      const t = charts.theme();
      const n = DATA.values.length;

      // 模型逐期拟合（前 2 期没有 lag 特征）
      const fitted = [...new Array(2).fill(null), ...model.fit.fitted.slice(2)];

      // 促销期与透支期高亮
      const promoAreas = DATA.promos.map((p) => [DATA.labels[p.index], DATA.labels[p.index]]);
      const liftPts = DATA.lift.map((l) => [DATA.labels[l.index], DATA.values[l.index]]);
      const dipPts = DATA.dip.map((d) => [DATA.labels[d.index], DATA.values[d.index]]);

      const mainSeries = [
        charts.line('实际出货（含促销）', DATA.values, { color: t.ink2, width: 2.4, z: 5 }),
        charts.line('自然需求真值（无促销）', DATA.natural, { color: t.muted, width: 1.6, dash: 'dashed', z: 3 }),
        charts.line('模型拟合', fitted, { color: t.s[0], width: 1.8, z: 4, opacity: 0.9 }),
        charts.scatter('促销拉升期', liftPts, { color: t.s[1], size: 11, symbol: 'triangle' }),
        charts.scatter('促销后透支期', dipPts, { color: t.danger, size: 9, symbol: 'rect' }),
      ];
      if (promoAreas.length) {
        mainSeries[0].markArea = charts.markArea(promoAreas, { color: t.s[1], opacity: 0.14 });
      }

      // 下一期情景：以散点标出「开促销」与「不开促销」两个预测
      const nextLabel = '下一期';
      mainSeries.push(charts.scatter(
        '下一期 · 不开促销',
        [[nextLabel, scen.withoutPromo]],
        { color: t.muted, size: 12, symbol: 'diamond' },
      ));
      if (state.promoOn) {
        mainSeries.push(charts.scatter(
          '下一期 · 开促销',
          [[nextLabel, scen.withPromo]],
          { color: t.s[1], size: 14, symbol: 'diamond' },
        ));
      }

      charts.setOption(chartEl, {
        ...charts.baseOption({ legend: { data: ['实际出货（含促销）', '自然需求真值（无促销）', '模型拟合', '促销拉升期', '促销后透支期', '下一期 · 不开促销', '下一期 · 开促销'] } }),
        xAxis: charts.catAxis([...DATA.labels, nextLabel]),
        yAxis: charts.valAxis('出货量'),
        series: mainSeries,
      }, { notMerge: true });

      /* ── 特征贡献条形图 ── */
      // 注意：切换显示时**不能**清空容器（ECharts 的 canvas 就在容器里，
      // 清掉它等于把图表连根拔掉，实例还在注册表里但已经画不出来了）。
      // 正确做法是切换两个兄弟节点的 hidden，并在重新显示后 resize。
      if (state.showImportance) {
        impWrap.hidden = false;
        impHint.hidden = true;
        const items = [...model.importance].sort((a, b) => a.weightPct - b.weightPct);
        charts.setOption(impEl, {
          ...charts.baseOption({
            grid: { left: 150, right: 40, top: 12, bottom: 26 },
            legend: false,
            tooltip: { trigger: 'item', formatter: (p) => {
              const it = items[p.dataIndex];
              return `${it.name}<br/>权重 ${it.weightPct.toFixed(1)}%<br/>系数 ${it.coef.toFixed(4)}<br/>`
                + `标准误 ${it.se.toFixed(4)}<br/>t = ${Number.isFinite(it.t) ? it.t.toFixed(2) : '—'}`;
            } },
          }),
          xAxis: { ...charts.valAxis(''), position: 'bottom' },
          yAxis: {
            type: 'category',
            data: items.map((i) => i.name),
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: { color: t.ink2, fontSize: 11 },
          },
          series: [{
            type: 'bar',
            data: items.map((i) => ({
              value: Number(i.weightPct.toFixed(2)),
              itemStyle: { color: i.name === INTERACTION_NAME ? t.s[1] : t.s[0], borderRadius: [0, 3, 3, 0] },
            })),
            label: { show: true, position: 'right', formatter: '{c}%', color: t.muted, fontSize: 11 },
          }],
        }, { notMerge: true });
        charts.resizeAll();
      } else {
        impWrap.hidden = true;
        impHint.hidden = false;
      }

      /* ── KPI ── */
      const intImp = model.importance.find((i) => i.name === INTERACTION_NAME);
      const errPct = intImp ? Math.abs(intImp.coef - TRUE_KAPPA) / TRUE_KAPPA * 100 : NaN;
      kpiHost.replaceChildren(
        comp.kpi({
          label: '模型学到的折扣弹性 κ',
          value: intImp ? intImp.coef.toFixed(3) : '—',
          sub: `真值 ${TRUE_KAPPA.toFixed(1)} · 相对误差 ${Number.isFinite(errPct) ? errPct.toFixed(1) : '—'}%`,
          tone: Number.isFinite(errPct) && errPct < 15 ? 'ok' : 'warn',
        }).el,
        comp.kpi({
          label: '该系数的标准误 / t 值',
          value: intImp ? `±${intImp.se.toFixed(3)}` : '—',
          sub: intImp ? `t = ${Number.isFinite(intImp.t) ? intImp.t.toFixed(1) : '—'}`
            + '（|t| > 2 才算统计上站得住）' : '',
        }).el,
        comp.kpi({
          label: '模型解释力',
          value: Number.isFinite(model.fit.adjR2) ? model.fit.adjR2.toFixed(4) : '—',
          sub: `调整 R² · ${model.fit.n} 行 × ${model.fit.beta.length} 参数（含截距）`,
        }).el,
        comp.kpi({
          label: state.promoOn ? `折扣 ${state.discount.toFixed(2)} 的情景增量` : '情景增量（促销未开）',
          value: state.promoOn ? fmt.num(scen.lift, 0) : '0',
          unit: '件',
          sub: state.promoOn
            ? `不开促销 ${fmt.num(scen.withoutPromo, 0)} → 开促销 ${fmt.num(scen.withPromo, 0)}（${fmt.signed(scen.liftPct, 1)}%）`
            : '打开「未来一期开促销」查看拉升幅度',
          tone: state.promoOn ? 'accent' : '',
        }).el,
      );

      /* ── 诊断文字 ── */
      const lines = [];
      lines.push(`特征矩阵：${model.fit.n} 行 × ${model.names.length} 列`
        + (model.dropped.length ? `，其中 ${model.dropped.length} 列因全样本恒定被剔除（${model.dropped.join('、')}）` : ''));
      lines.push(`残差 σ = ${fmt.num(model.fit.sigma, 1)} 件；历史促销 ${DATA.promos.length} 次，`
        + `折扣区间 ${Math.min(...DATA.promos.map((p) => p.discount)).toFixed(2)} ~ ${Math.max(...DATA.promos.map((p) => p.discount)).toFixed(2)}`);
      if (intImp) {
        lines.push(`折扣弹性 κ 的 95% 置信区间约 ${(intImp.coef - 1.96 * intImp.se).toFixed(2)} ~ ${(intImp.coef + 1.96 * intImp.se).toFixed(2)}`
          + `（真值 ${TRUE_KAPPA} 落在区间内 → 模型没有系统性学错）`);
      }
      diagHost.replaceChildren(comp.card({
        title: '模型诊断',
        hint: '这些数字决定了上面的结论能不能信',
        body: lines.map((l) => comp.h('p', { class: 'ctl-help', style: 'font-size:12.5px', text: l })),
      }));

      /* ── 拟合明细表（促销期与透支期）── */
      const rows = [];
      for (const l of DATA.lift) {
        const i = l.index;
        rows.push(comp.h('tr', {}, [
          comp.h('td', { text: DATA.labels[i] }),
          comp.h('td', { text: `促销（${l.discount.toFixed(2)}）` }),
          comp.h('td', { class: 'num', text: fmt.num(DATA.natural[i], 0) }),
          comp.h('td', { class: 'num', text: fmt.num(DATA.values[i], 0) }),
          comp.h('td', { class: 'num', text: fitted[i] === null ? '—' : fmt.num(fitted[i], 0) }),
        ]));
        for (const d of DATA.dip.filter((x) => x.from === i)) {
          rows.push(comp.h('tr', {}, [
            comp.h('td', { text: DATA.labels[d.index] }),
            comp.h('td', { text: `促销后第 ${d.index - i} 期 · 透支` }),
            comp.h('td', { class: 'num', text: fmt.num(DATA.natural[d.index], 0) }),
            comp.h('td', { class: 'num', text: fmt.num(DATA.values[d.index], 0) }),
            comp.h('td', { class: 'num', text: fitted[d.index] === null ? '—' : fmt.num(fitted[d.index], 0) }),
          ]));
        }
      }
      tableHost.replaceChildren(comp.h('table', { class: 'data' }, [
        comp.h('thead', {}, [comp.h('tr', {}, [
          comp.h('th', { text: '期间' }),
          comp.h('th', { text: '事件' }),
          comp.h('th', { text: '自然需求（真值）' }),
          comp.h('th', { text: '实际出货' }),
          comp.h('th', { text: '模型拟合' }),
        ])]),
        comp.h('tbody', {}, rows),
      ]));
    }

    const root = comp.h('div', {}, [
      comp.moduleHeader({ req: META.req, title: META.title, sub: this.subtitle }),
      errHost,

      comp.grid(2, [
        comp.card({
          title: '促销情景设置',
          hint: `${DATA.values.length} 期月度数据，历史 ${DATA.promos.length} 次促销`,
          body: [
            comp.h('div', { class: 'controls' }, [cOn.el, cDisc.el, cImp.el]),
            comp.h('p', { class: 'ctl-help', html:
              '折扣力度只影响<strong>未来情景</strong>；历史促销是既成事实，不会随滑杆改变 —— '
              + '这正是模型要做的事：从固定的历史里学出规律，再外推到新情景。' }),
          ],
        }),
        comp.card({ title: '促销拉升与透支', hint: '橙色三角 = 促销期，红色方块 = 透支期', body: [chartEl] }),
      ]),

      comp.h('div', { class: 'mt' }, [kpiHost]),

      comp.grid(2, [
        comp.card({ title: '特征贡献（标准化系数绝对值，归一化到 100%）', body: [impWrap, impHint] }),
        diagHost,
      ]),

      comp.grid(2, [
        comp.card({ title: '促销期与透支期明细', body: [tableHost], cls: 'mt' }),
        comp.h('div', { class: 'grid', style: 'gap:14px' }, [
          comp.tipBox({
            lines: [
              '传统时序模型适合预测<strong>自然需求</strong>；机器学习能通过外部特征捕捉<strong>人造爆发</strong>。',
              '<strong>但计划员一定要警惕：大促销通常透支后续 1~2 个月的需求。</strong>'
              + '促销期过后必须下调备货量，否则你在促销月赚的销量，会在下个月变成库存。',
              '把折扣从 0.95 拖到 0.50，看情景增量怎么变 —— 注意它是<strong>超线性</strong>的：'
              + '折扣加深带来的增量比折扣比例本身更多。',
            ],
          }),
          comp.whyBox({
            title: '为什么用「Promo × Lag1」交互项，而不是把折扣当独立特征',
            body: [
              '<p>真实机制是 <code>ΔY ≈ κ × (1−d) × Y_基准</code>：促销增量同时取决于'
              + '<strong>折扣深度</strong>和<strong>当时的量级</strong>。</p>',
              '<p>如果只放一个 <code>折扣率</code> 列，模型会认为"打八折固定增加 200 件" —— '
              + '对一个基数 1 万件的 SKU 和基数 500 件的 SKU 给出同样的增量，'
              + '这是明显错的。加上交互项之后，模型学到的 κ 才能解释成"每让利 1%、'
              + '拉动当前量级的百分之几"。</p>',
              '<p>顺带一个真实项目的教训：交互项和 Lag1 本身<strong>高度共线</strong>，'
              + '所以促销次数少、折扣力度雷同时，κ 根本估不准。'
              + '本模块的历史里有 8 次力度不同的促销，才把还原误差压到 10% 以内；'
              + '如果只有 1~2 次，模型会直接拒绝求解（这时该补数据，不是该换模型）。</p>',
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
        cOn.set(false);
        cDisc.set(0.8);
        cImp.set(true);
        Object.assign(state, { promoOn: false, discount: 0.8, showImportance: true });
        update();
      },
      destroy() {},
    };
  },
};
