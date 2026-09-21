/**
 * app.js —— 应用外壳：导航、模块装载、全局重置
 *
 * 模块契约（每个 src/modules/*.js 默认导出的对象）：
 *   { id, num, group, title, short, req, subtitle,
 *     create(ctx) -> { root: HTMLElement, destroy?(): void, reset?(): void } }
 * ctx 提供 { comp, charts, fmt, tips, controls }。
 *
 * ★ 切换模块时**必须**先销毁上一个模块的图表实例（charts.destroyAll()）：
 *   ECharts 每个实例都注册在内部表里并持有 canvas，不销毁就会随每次切换累积，
 *   并且探针会读到上一次渲染留下的陈旧实例。
 */

import * as comp from './ui/components.js';
import * as charts from './ui/chart_helper.js';
import { controlRegistry } from './ui/components.js';

import mod0 from './modules/mod0_cleaning.js';
import mod1 from './modules/mod1_decomposition.js';
import mod2 from './modules/mod2_moving_average.js';
import mod3 from './modules/mod3_holt_winters.js';
import mod4 from './modules/mod4_promo_ml.js';
import mod5 from './modules/mod5_prophet.js';
import mod6 from './modules/mod6_error_bias.js';
import mod7 from './modules/mod7_safety_stock.js';

const MODULES = [mod0, mod1, mod2, mod3, mod4, mod5, mod6, mod7];

const ctx = {
  comp,
  charts,
  controls: controlRegistry(),
  fmt: {
    num: charts.fmt,
    money: charts.money,
    pct: charts.pct,
    signed: charts.signed,
    compact: charts.compact,
    dow: charts.DOW_CN,
  },
};

const view = document.getElementById('view');
const railList = document.getElementById('rail-list');
const rail = document.getElementById('rail');
const navToggle = document.getElementById('btn-nav-toggle');

let active = null; // { mod, api }

/* ───────────────────────── 侧边导航 ───────────────────────── */

function buildRail() {
  let lastGroup = null;
  for (const m of MODULES) {
    if (m.group !== lastGroup) {
      lastGroup = m.group;
      railList.appendChild(comp.h('li', { class: 'rail-group', text: m.group }));
    }
    const li = comp.h('li');
    const btn = comp.h('button', {
      type: 'button',
      class: 'rail-item',
      'data-mod': m.id,
      onclick: () => activate(m.id, true),
    }, [
      comp.h('span', { class: 'rail-num', text: String(m.num) }),
      comp.h('span', { class: 'rail-label', text: m.short || m.title }),
    ]);
    li.appendChild(btn);
    railList.appendChild(li);
  }
}

function markActive(id) {
  for (const btn of railList.querySelectorAll('.rail-item')) {
    const on = btn.dataset.mod === id;
    if (on) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  }
}

/* ───────────────────────── 模块装载 ───────────────────────── */

function teardown() {
  if (active) {
    try {
      active.api?.destroy?.();
    } catch (e) {
      console.error('[forecastforplanner] 模块 destroy 失败', e);
    }
    active = null;
  }
  charts.destroyAll();
  ctx.controls = controlRegistry();
}

function activate(id, pushHash = false) {
  const mod = MODULES.find((m) => m.id === id) || MODULES[0];
  teardown();

  let api;
  try {
    api = mod.create(ctx);
  } catch (e) {
    console.error('[forecastforplanner] 模块初始化失败', e);
    view.replaceChildren(comp.h('div', {}, [
      comp.moduleHeader({ req: mod.req, title: mod.title, sub: mod.subtitle }),
      comp.errorBox({
        title: '模块初始化失败',
        message: '这是程序缺陷，不是你的参数问题。请把下面的报错信息带给我们。',
        detail: String(e && e.stack ? e.stack : e),
      }),
    ]));
    markActive(mod.id);
    active = { mod, api: null };
    return;
  }

  active = { mod, api };
  view.replaceChildren(api.root);
  markActive(mod.id);

  // 每讲都有配套讲义页（lectures/modN.html）。入口挂在模块标题下面，
  // 只有被点名的文字是链接 —— 不做整卡可点。
  const head = api.root.querySelector('.mod-head');
  if (head && !head.querySelector('.mod-lec')) {
    head.insertAdjacentHTML('beforeend',
      `<a class="mod-lec" href="lectures/${mod.id}.html">看第 ${mod.num} 讲讲义 →</a>`);
  }

  // ★ 首绘必须在**挂载之后**执行，这是整个渲染链最关键的一步。
  //   模块的 create() 只负责搭 DOM 与接线，不出图；出图在这里做：
  //   此时容器已在文档里，读 clientWidth 会强制同步布局，ECharts 才能量到真实宽度。
  //   反例（已踩过）：在 create() 里 setOption → 容器脱离文档 → 宽度量成 0
  //   → zrender 在尺寸为 0 时根本不创建 canvas → 之后 resize() 也救不回来，
  //   症状是"页面结构齐全、图表区域一片空白"，而且只在切换模块时出现。
  try {
    if (typeof api?.update === 'function') api.update();
  } catch (e) {
    console.error('[forecastforplanner] 首次绘制失败', e);
    globalThis.__FFP_DEBUG__.lastError = String(e && e.stack ? e.stack : e);
    // 不能只写 console：这类错误正是"图表区一片空白"的成因，
    // 必须显示在页面上，否则用户（和探针）都看不到原因。
    view.appendChild(comp.errorBox({
      title: '模块绘制失败',
      message: '这是程序缺陷，不是你的参数问题。报错信息如下。',
      detail: String(e && e.stack ? e.stack : e),
    }));
  }
  charts.resizeAll();

  if (pushHash && location.hash !== `#${mod.id}`) {
    history.replaceState(null, '', `#${mod.id}`);
  }
  if (globalThis.__FFP_DEBUG__) {
    globalThis.__FFP_DEBUG__.activeModule = mod.id;
    globalThis.__FFP_DEBUG__.chartCount = charts.chartCount();
  }
  // 移动端选完就收起导航
  if (window.matchMedia('(max-width: 900px)').matches) {
    rail.hidden = true;
    navToggle.setAttribute('aria-expanded', 'false');
  }
  view.scrollIntoView({ block: 'start', behavior: 'auto' });
}

/* ───────────────────────── 顶栏按钮 ───────────────────────── */

document.getElementById('btn-reset-all').addEventListener('click', () => {
  if (!active) return;
  if (typeof active.api?.reset === 'function') {
    active.api.reset();
  } else {
    ctx.controls.resetAll();
  }
});

navToggle.addEventListener('click', () => {
  const open = rail.hidden;
  rail.hidden = !open;
  navToggle.setAttribute('aria-expanded', String(open));
});

window.addEventListener('hashchange', () => {
  const id = location.hash.replace(/^#/, '');
  if (id && id !== active?.mod.id) activate(id, false);
});

/* ───────────────────────── 启动 ───────────────────────── */

if (window.matchMedia('(max-width: 900px)').matches) rail.hidden = true;

buildRail();
activate(location.hash.replace(/^#/, '') || MODULES[0].id, true);

// 给测试/探针用的只读句柄
globalThis.__FFP_DEBUG__ = {
  modules: MODULES.map((m) => ({ id: m.id, num: m.num, title: m.title })),
  activeModule: active?.mod.id ?? null,
  chartCount: charts.chartCount(),
  activate: (id) => activate(id, true),
  chartCountNow: () => charts.chartCount(),
  chartDigest: () => charts.digest(),
  chartDump: () => charts.dump(),
  controlCount: () => ctx.controls.count(),
};

// 就绪门：真浏览器探针必须等这个标志，不能只等 DOM 存在 ——
// 模块脚本是异步加载的，外壳 HTML 早就解析完了，此时点导航是点在没有监听的按钮上。
document.documentElement.dataset.ffpReady = 'true';
