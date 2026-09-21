/**
 * mod7_safety_stock.js —— 模块 7：服务水平与安全库存成本博弈（REQ-MOD-04）
 *
 * 销售总监说「把满足率从 95% 提到 99.5%，不就是多备一点点货吗」。
 * 这个模块给计划员一副对话弹药：把代价算成钱，并把"每提高一个百分点要多少钱"
 * 的陡峭化过程画出来。
 *
 * ★ 只声称可证明的部分（见 DECISIONS.md D6）：
 *   数学上 Z 随 SL→1 趋于无穷，但在 99.9% 处并没有"爆炸"（Z(95%)→Z(99%) 增 41%，
 *   Z(99%)→Z(99.9%) 只增 33%）。真正可证明的是成本曲线的**凸性** ——
 *   每提高一个百分点所需的额外资金在快速放大。测试断言的是凸性，文案也据此措辞。
 *
 * ★ 单位一致性是这里最贵的坑：σ 按月、L 按周混用会让安全库存偏大 √4.345 ≈ 2.08 倍。
 *   模块里专门做了一个开关让你看到这个数字。
 */
import { synthSeries, periodLabels } from '../core/generator.js';
import { holtWintersFit } from '../core/stats.js';
import {
  zFactor, safetyStock, holdingCost, serviceLevelCurve, escalate, WEEKS_PER_MONTH,
} from '../core/inventory.js';

const META = {
  id: 'mod7',
  num: 7,
  group: '第三阶段 · 业务闭环',
  title: '服务水平与安全库存的资金博弈',
  short: '安全库存',
  req: 'REQ-MOD-04',
};

/** σ 的来源要说得清楚：它是上面那个 SKU 的月度预测残差标准差，不是拍出来的常数 */
const SIGMA_DATASET = synthSeries({
  n: 48, start: '2021-01', base: 12000, trend: 90, seasonality: 1500, noise: 600, seed: 707,
});
const SIGMA_FIT = holtWintersFit(SIGMA_DATASET.values, {
  alpha: 0.35, beta: 0.15, gamma: 0.25, phi: 0.97, period: 12,
});
const SIGMA = Math.round(SIGMA_FIT.sigma);

const H = 12;

export default {
  ...META,
  subtitle: '交付满足率从 95% 提到 99.5%，销售说"不就多备一点点"。'
    + '这个模块把那"一点点"换算成年持有成本，并让你看到每提高一个百分点，代价是怎么陡起来的。',

  create(ctx) {
    const { comp, charts, fmt } = ctx;
    const controls = ctx.controls;
    const state = { sl: 0.95, lead: 4, unitCost: 100, holdingRate: 0.2, unit: 'month' };

    const chartEl = comp.h('div', { class: 'chart chart-md', id: 'mod7-chart' });
    const costEl = comp.h('div', { class: 'chart chart-md', id: 'mod7-cost' });
    const kpiHost = comp.h('div', { class: 'grid grid-4' });
    const verdictHost = comp.h('div', {});
    const tableHost = comp.h('div', { class: 'table-wrap' });
    const unitWarnHost = comp.h('div', { hidden: true });

    const demandLabels = periodLabels('2026-01', H);

    const cSl = controls.add(comp.slider({
      label: '服务水平（订单满足率）', min: 0.9, max: 0.999, step: 0.001, value: state.sl, decimals: 3,
      format: (v) => `${(v * 100).toFixed(1)}%`,
      help: '期望的不缺货概率。99.9% 意味着平均 1000 个订货周期只允许 1 次缺货。',
      onChange: (v) => { state.sl = v; update(); },
    }));
    const cL = controls.add(comp.slider({
      label: '采购提前期 L', min: 1, max: 12, step: 1, value: state.lead,
      help: '供应链交期长度。注意单位必须与 σ 一致 —— 这里 σ 是月度的。',
      onChange: (v) => { state.lead = v; update(); },
    }));
    const cCost = controls.add(comp.numberField({
      label: '单件成本（元）', min: 10, max: 1000, step: 10, value: state.unitCost,
      help: 'SKU 的采购单价。',
      onChange: (v) => { state.unitCost = v; update(); },
    }));
    const cRate = controls.add(comp.slider({
      label: '年持有成本率', min: 0.1, max: 0.4, step: 0.01, value: state.holdingRate, decimals: 2,
      format: (v) => `${(v * 100).toFixed(0)}%`,
      help: '仓储费 + 资金占用利息 + 呆滞报废损失率的总和。',
      onChange: (v) => { state.holdingRate = v; update(); },
    }));
    const cUnit = controls.add(comp.radio({
      label: '提前期单位',
      options: [
        { value: 'month', label: '月（与 σ 同单位，正确）' },
        { value: 'week', label: '周（需要换算）' },
      ],
      value: state.unit,
      help: 'σ 是月度误差。若提前期用周表示，必须先除以 4.345 换成月。',
      onChange: (v) => { state.unit = v; update(); },
    }));

    /** 提前期换算成「月」（σ 的周期单位） */
    function leadMonths() {
      return state.unit === 'month' ? state.lead : state.lead / WEEKS_PER_MONTH;
    }

    function update() {
      const L = leadMonths();
      const sc = {
        sigma: SIGMA, leadTime: L, serviceLevel: state.sl,
        unitCost: state.unitCost, holdingRate: state.holdingRate,
      };
      const ss = safetyStock(sc);
      const hc = holdingCost({ safetyStockQty: ss, unitCost: state.unitCost, holdingRate: state.holdingRate });
      const z = zFactor(state.sl);
      const t = charts.theme();

      /* ── 图 1：库存水位（预测需求 + 安全库存警戒线）── */
      // 需求预测用 SIGMA_DATASET 的季节形态外推，保证曲线有业务形状
      const last12 = SIGMA_DATASET.values.slice(-12);
      const mean12 = last12.reduce((a, b) => a + b, 0) / 12;
      const demand = demandLabels.map((_, i) => {
        const d = SIGMA_DATASET.values[SIGMA_DATASET.values.length - 12 + i];
        return Math.round(d);
      });
      const ssLine = demand.map(() => Math.round(ss));
      const totalLine = demand.map((d) => Math.round(d + ss));

      charts.setOption(chartEl, {
        ...charts.baseOption({
          legend: { data: ['预测基本需求', '安全库存 SS', '总库存水位（需求 + SS）'] },
        }),
        xAxis: charts.catAxis(demandLabels, {}),
        yAxis: charts.valAxis('数量'),
        series: [
          charts.line('预测基本需求', demand, { color: t.s[0], width: 2.4, area: true, areaOpacity: 0.12, z: 4 }),
          charts.line('安全库存 SS', ssLine, { color: t.s[1], width: 2, dash: 'dashed', z: 5 }),
          charts.line('总库存水位（需求 + SS）', totalLine, { color: t.s[2], width: 1.8, z: 3 }),
        ],
      }, { notMerge: true });

      /* ── 图 2：成本爆炸曲线 ── */
      const curve = serviceLevelCurve({
        sigma: SIGMA, leadTime: L, unitCost: state.unitCost, holdingRate: state.holdingRate,
      });
      const point = curve.reduce((best, p) => (Math.abs(p.serviceLevel - state.sl) < Math.abs(best.serviceLevel - state.sl) ? p : best), curve[0]);

      charts.setOption(costEl, {
        ...charts.baseOption({
          legend: { data: ['年持有成本', 'Z 因子（右轴）'] },
        }),
        xAxis: {
          type: 'value',
          min: 0.9,
          max: 0.999,
          name: '服务水平',
          nameTextStyle: { color: t.muted, fontSize: 12 },
          axisLine: { lineStyle: { color: t.line2 } },
          axisTick: { show: false },
          axisLabel: {
            color: t.muted, fontSize: 11,
            formatter: (v) => `${(v * 100).toFixed(1)}%`,
          },
          splitLine: { lineStyle: { color: t.line, type: 'dashed' } },
        },
        yAxis: [
          charts.valAxis('年持有成本（元）', { formatter: (v) => charts.compact(v) }),
          {
            ...charts.valAxis('Z 因子', { scale: false }),
            splitLine: { show: false },
          },
        ],
        series: [
          {
            name: '年持有成本',
            type: 'line',
            data: curve.map((p) => [p.serviceLevel, Number(p.holdingCost.toFixed(0))]),
            showSymbol: false,
            lineStyle: { width: 2.6, color: t.s[1] },
            areaStyle: { color: t.s[1], opacity: 0.12 },
            z: 5,
            markPoint: {
              symbol: 'circle',
              symbolSize: 11,
              itemStyle: { color: t.danger, borderColor: t.panel, borderWidth: 2 },
              label: {
                show: true, position: 'top', color: t.danger, fontSize: 11, fontWeight: 600,
                formatter: () => `当前 ${(state.sl * 100).toFixed(1)}%`,
              },
              // ★ 必须是 {coord: [x, y]} 对象形式。写成裸数组 [[x, y]] 时 ECharts 会把
              //   内层数组的元素当成"数据项"去写 .label 属性，于是抛
              //   "Cannot create property 'label' on number 0.95" —— 整个模块崩掉。
              data: [{ coord: [point.serviceLevel, Number(point.holdingCost.toFixed(0))] }],
            },
          },
          {
            name: 'Z 因子（右轴）',
            type: 'line',
            yAxisIndex: 1,
            data: curve.map((p) => [p.serviceLevel, Number(p.z.toFixed(4))]),
            showSymbol: false,
            lineStyle: { width: 1.6, color: t.muted, type: 'dashed' },
            z: 3,
          },
        ],
      }, { notMerge: true });

      /* ── KPI ── */
      const missing = (1 - state.sl) * 100;
      kpiHost.replaceChildren(
        comp.kpi({
          label: 'Z 因子 Φ⁻¹(SL)', value: z.toFixed(4),
          sub: `SL=${(state.sl * 100).toFixed(1)}% → 允许缺货概率 ${missing.toFixed(2)}%`,
          tone: 'accent',
        }).el,
        comp.kpi({
          label: '安全库存 SS', value: fmt.num(ss, 0), unit: '件',
          sub: `Z × σ × √L = ${z.toFixed(3)} × ${SIGMA} × √${L.toFixed(3)}`,
        }).el,
        comp.kpi({
          label: '年持有成本', value: charts.money(hc),
          sub: `SS × 单价 ${state.unitCost} × 持有率 ${(state.holdingRate * 100).toFixed(0)}%`,
          tone: 'accent',
        }).el,
        comp.kpi({
          label: '每 1 件安全库存的年成本',
          value: `${fmt.num(state.unitCost * state.holdingRate, 1)}`,
          unit: '元/件·年',
          sub: `单价 × 持有率；SS 每多 100 件 → 多花 ${fmt.num(state.unitCost * state.holdingRate * 100, 0)} 元/年`,
        }).el,
      );

      /* ── 单位一致性警告 ── */
      const wrongSs = safetyStock({ ...sc, leadTime: state.lead }); // 把周当月的错误算法
      const ratio = wrongSs / ss;
      if (state.unit === 'week') {
        unitWarnHost.hidden = false;
        unitWarnHost.replaceChildren(comp.h('div', { class: 'tip tip-alert' }, [
          comp.h('p', { class: 'tip-title', text: '单位换算已生效，但请记住这个坑' }),
          comp.h('p', { html:
            `当前提前期 ${state.lead} 周已折算为 ${L.toFixed(3)} 个月（÷ ${WEEKS_PER_MONTH}）。`
            + `如果你<strong>忘记换算</strong>，直接拿 ${state.lead} 当月份代入公式，`
            + `安全库存会变成 <strong>${fmt.num(wrongSs, 0)} 件</strong>（当前正确值的 `
            + `<strong>${ratio.toFixed(2)} 倍</strong>，理论倍数 √${WEEKS_PER_MONTH} = ${Math.sqrt(WEEKS_PER_MONTH).toFixed(3)}），`
            + `一年多花的持有成本约 <strong>${charts.money(Math.abs(holdingCost({ safetyStockQty: wrongSs, unitCost: state.unitCost, holdingRate: state.holdingRate }) - hc))}</strong>。` }),
        ]));
      } else {
        unitWarnHost.hidden = false;
        unitWarnHost.replaceChildren(comp.h('p', { class: 'ctl-help', html:
          `当前 σ = ${SIGMA} 件/月，提前期按<strong>月</strong>输入，两者同单位，公式直接成立。`
          + '把上面的单位切到「周」，可以看到忘记换算的代价。' }));
      }

      /* ── 对话弹药：从 95% 提到 99% 要多少钱 ── */
      const e1 = escalate({ ...sc, leadTime: L, from: 0.95, to: 0.99 });
      const e2 = escalate({ ...sc, leadTime: L, from: 0.99, to: 0.999 });
      const slope1 = e1.deltaHoldingCost / 0.04;
      const slope2 = e2.deltaHoldingCost / 0.009;
      const steep = slope2 / slope1;

      verdictHost.replaceChildren(comp.card({
        title: '对话弹药：把服务水平往上推的真实代价',
        hint: '直接可以把这些数字摆到桌上',
        body: [
          comp.h('p', { class: 'tight', html:
            `把满足率从 <strong>95% 提到 99%</strong>：安全库存 ` 
            + `${fmt.num(e1.from.safetyStock, 0)} → ${fmt.num(e1.to.safetyStock, 0)} 件（+${e1.deltaHoldingCostPct.toFixed(1)}% 成本，`
            + `多花 <strong>${charts.money(e1.deltaHoldingCost)}</strong>/年）；`
            + `对应的缺货概率从 5% 降到 1%（相对下降 ${e1.missingRateReductionPct.toFixed(0)}%）。` }),
          comp.h('p', { class: 'tight', style: 'margin-top:8px', html:
            `再从 <strong>99% 提到 99.9%</strong>：缺货概率从 1% 降到 0.1%，`
            + `但年成本要多 <strong>${charts.money(e2.deltaHoldingCost)}</strong>。` }),
          comp.h('p', { class: 'tight', style: 'margin-top:8px', html:
            `按「每提高 1 个百分点所需成本」衡量：95%→99% 段约 <strong>${charts.money(slope1)}</strong>/点，`
            + `99%→99.9% 段约 <strong>${charts.money(slope2)}</strong>/点 —— `
            + `陡了 <strong>${steep.toFixed(1)} 倍</strong>。这就是"非线性爆炸"可证明的部分。` }),
          comp.h('p', { class: 'ctl-help', style: 'margin-top:8px', text:
            '诚实边界：Z 因子在 99.9% 处并没有趋于无穷（它只是从 2.326 涨到 3.090），'
            + '真正陡起来的是成本曲线本身。别把"趋于无穷"当成 99.9% 就是天文数字的理论依据 —— '
            + '把这张表算出来给对方看，比引用极限更有效。' }),
        ],
      }));

      /* ── 服务水平对照表 ── */
      const levels = [0.9, 0.95, 0.98, 0.99, 0.995, 0.999];
      tableHost.replaceChildren(comp.h('table', { class: 'data' }, [
        comp.h('thead', {}, [comp.h('tr', {}, [
          comp.h('th', { text: '服务水平' }),
          comp.h('th', { text: '允许缺货概率' }),
          comp.h('th', { text: 'Z 因子' }),
          comp.h('th', { text: '安全库存' }),
          comp.h('th', { text: '相对 90% 成本倍数' }),
          comp.h('th', { text: '年持有成本' }),
        ])]),
        comp.h('tbody', {}, levels.map((lv) => {
          const s = safetyStock({ sigma: SIGMA, leadTime: L, serviceLevel: lv });
          const c = holdingCost({ safetyStockQty: s, unitCost: state.unitCost, holdingRate: state.holdingRate });
          const base = safetyStock({ sigma: SIGMA, leadTime: L, serviceLevel: 0.9 });
          return comp.h('tr', {}, [
            comp.h('td', { text: `${(lv * 100).toFixed(1)}%` }),
            comp.h('td', { class: 'num', text: `${((1 - lv) * 100).toFixed(2)}%` }),
            comp.h('td', { class: 'num', text: zFactor(lv).toFixed(4) }),
            comp.h('td', { class: 'num', text: fmt.num(s, 0) }),
            comp.h('td', { class: 'num', text: `${(s / base).toFixed(2)}×` }),
            comp.h('td', { class: 'num', text: charts.money(c) }),
          ]);
        })),
      ]));
    }

    const root = comp.h('div', {}, [
      comp.moduleHeader({ req: META.req, title: META.title, sub: this.subtitle }),

      comp.grid(2, [
        comp.card({
          title: '库存策略参数',
          hint: `σ = ${SIGMA} 件/月（来自本 SKU 的预测残差，月度）`,
          body: [
            comp.h('div', { class: 'controls' }, [cSl.el, cL.el, cCost.el, cRate.el, cUnit.el]),
            unitWarnHost,
          ],
        }),
        comp.h('div', { class: 'grid', style: 'gap:14px' }, [
          comp.card({ title: '库存水位：预测需求之上的安全库存警戒线', body: [chartEl] }),
          comp.card({ title: '成本随服务水平的变化', hint: '看曲线右端怎么翘起来', body: [costEl] }),
        ]),
      ]),

      comp.h('div', { class: 'mt' }, [kpiHost]),
      comp.h('div', { class: 'mt' }, [verdictHost]),

      comp.grid(2, [
        comp.card({ title: '服务水平对照表', body: [tableHost], cls: 'mt' }),
        comp.h('div', { class: 'grid', style: 'gap:14px' }, [
          comp.tipBox({
            lines: [
              '服务水平越接近 100%，Z 值增长越快，追求最后那 1% 不缺货需要付出成倍的库存持有成本。',
              '计划员的价值就是找到最佳平衡点，而不是无底线堆库存。',
              '公式 <code>SS = Z × σ × √L</code> 里有两个杠杆比服务水平更划算：'
              + '<strong>降低 σ</strong>（把预测做准）和<strong>缩短 L</strong>（换供应商、改运输方式）。'
              + '把 L 从 4 个月压到 2 个月，安全库存只降 29% 但等于永久省下这笔钱 —— '
              + '而提高服务水平是每年都要付的钱。',
            ],
          }),
          comp.whyBox({
            title: '为什么 √L 而不是 L',
            body: [
              '<p>提前期内的需求是<strong>多个周期不确定性叠加</strong>。独立同分布时方差线性累加，'
              + '标准差按 √L 增长 —— 所以安全库存随提前期呈次线性增长：交期翻 4 倍，SS 只翻 2 倍。</p>',
              '<p>这个性质的实务含义：<strong>交期长的供应商并没有想象中那么不可接受</strong>，'
              + '但要警惕需求相关性 —— 如果各期需求高度正相关（比如促销季连续起量），'
              + '方差会按 L² 累加，SS 就真的随 L 线性增长了。这正是"促销期要单独算安全库存"的原因。</p>',
              '<p>另外，σ 必须来自<strong>样本外</strong>预测误差（模块 6 里那个残差标准差）。'
              + '用样本内拟合残差会把 σ 低估，安全库存随之偏低 —— 这是很多公司"算出来 95% 服务水平、'
              + '实际只有 85%"的真正原因。</p>',
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
        cSl.set(0.95);
        cL.set(4);
        cCost.set(100);
        cRate.set(0.2);
        cUnit.set('month');
        Object.assign(state, { sl: 0.95, lead: 4, unitCost: 100, holdingRate: 0.2, unit: 'month' });
        update();
      },
      destroy() {},
    };
  },
};
