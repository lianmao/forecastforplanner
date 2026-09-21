/**
 * lecture.js —— 讲义页共享的导航与目录（零依赖，原生 ES Module）
 *
 * 为什么要有这个文件：9 个讲义页的目录/上一讲/下一讲如果手写进每页 HTML，
 * 加一讲就要改 9 个文件，而且必然漂移。课程表只此一份。
 *
 * 页面契约（每页 HTML 里要有）：
 *   <body data-lec="mod3">  … <aside id="lecToc"></aside>  <article class="lec-body">…</article>
 */
export const LECTURES = [
  { id: 'mod0', n: '第 0 讲', t: '数据清洗与异常修复', f: 'mod0.html', m: 'mod0_cleaning' },
  { id: 'mod1', n: '第 1 讲', t: '时间序列三要素拆解', f: 'mod1.html', m: 'mod1_decomposition' },
  { id: 'mod2', n: '第 2 讲', t: '移动平均与拐点滞后', f: 'mod2.html', m: 'mod2_moving_average' },
  { id: 'mod3', n: '第 3 讲', t: '阻尼三次指数平滑', f: 'mod3.html', m: 'mod3_holt_winters' },
  { id: 'mod4', n: '第 4 讲', t: '促销与折扣特征工程', f: 'mod4.html', m: 'mod4_promo_ml' },
  { id: 'mod5', n: '第 5 讲', t: 'Prophet 式组件拆解', f: 'mod5.html', m: 'mod5_prophet' },
  { id: 'mod6', n: '第 6 讲', t: '预测误差与 Bias 预警', f: 'mod6.html', m: 'mod6_error_bias' },
  { id: 'mod7', n: '第 7 讲', t: '服务水平与安全库存', f: 'mod7.html', m: 'mod7_safety_stock' },
];

const cur = document.body.dataset.lec || '';
const i = LECTURES.findIndex((l) => l.id === cur);
const A = '../index.html';        // 互动工具（应用程序外壳）
const HOME = 'index.html';         // 讲义目录

/** 顶部条：回目录 / 上一讲 / 下一讲 / 去互动工具 */
function topbar() {
  const prev = i > 0 ? LECTURES[i - 1] : null;
  // 目录页（data-lec 为空）时"下一讲"指向第 0 讲，而不是两个都禁用
  const next = i === -1 ? LECTURES[0] : (i < LECTURES.length - 1 ? LECTURES[i + 1] : null);
  const nl = (href, text, cls = '') => `<a class="lec-navlink ${cls}" href="${href}">${text}</a>`;
  return `<header class="lec-top"><div class="lec-top-in">
    <div class="lec-brand"><b>Forecast for Planner</b><span>配套讲义 · 供应链计划员预测课程</span></div>
    <div class="lec-top-spacer"></div>
    <button class="lec-tocbtn" id="lecTocBtn" aria-expanded="false">目录</button>
    ${nl(HOME, '讲义目录')}
    ${nl(A, '互动工具')}
    ${prev ? nl(prev.f, `← ${prev.n}`) : '<span class="lec-navlink" aria-disabled="true">← 已是第一讲</span>'}
    ${next ? nl(next.f, `${next.n} →`) : '<span class="lec-navlink" aria-disabled="true">已是最后一讲 →</span>'}
  </div></header>`;
}

/** 左侧目录（窄屏默认收起，与互动工具同一套交互） */
function toc() {
  const li = LECTURES.map((l) => `<li><a class="${l.id === cur ? 'is-cur' : ''}" href="${l.f}">
    <span class="n">${l.n.replace('第 ', '').replace(' 讲', '')}</span><span>${l.t}</span></a></li>`).join('');
  return `<h2>课程目录</h2><ol>${li}</ol>
    <div class="toc-extra"><a href="${HOME}"><span class="n">·</span><span>课程说明与学习路径</span></a></div>`;
}

// ★ 顺序很重要：先把顶部条插进 DOM，再去取里面的 #lecTocBtn。
//   反过来的话 getElementById 拿到 null → addEventListener 抛错 → 整个脚本停在这里，
//   顶部条根本不会被插入（一个"顺序写反"就让整条导航消失）。
document.body.insertAdjacentHTML('afterbegin', topbar());

const aside = document.getElementById('lecToc');
if (aside) {
  aside.innerHTML = toc();
  const btn = document.getElementById('lecTocBtn');
  const narrow = window.matchMedia('(max-width: 900px)');
  const sync = () => {
    const collapsed = narrow.matches;
    aside.dataset.collapsed = String(collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
  };
  btn.addEventListener('click', () => {
    const collapsed = aside.dataset.collapsed === 'true';
    aside.dataset.collapsed = String(!collapsed);
    btn.setAttribute('aria-expanded', String(collapsed));
  });
  narrow.addEventListener('change', sync);
  sync();
}

/** 自测题：打印时把答案展开，屏幕上保持折叠 */
if (window.matchMedia) {
  const onPrint = () => document.querySelectorAll('.ex details').forEach((d) => { d.open = true; });
  window.addEventListener('beforeprint', onPrint);
}
