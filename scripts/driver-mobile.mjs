/**
 * driver-mobile.mjs —— 移动端布局与触控目标探针（420×800 视口下运行）
 *
 * 契约同 driver-all.mjs：一个表达式，由 browser-check.mjs 注入。
 *
 * 这里断言的是**几何与渲染状态**，不是 class 名或样式字符串：
 *   · 导航默认收起（读 rail 的渲染高度，不读 display —— 浏览器对 [hidden]
 *     的实现走 shadow slot，作者可见的 computed display 可能仍是 block）
 *   · 点「目录」后 rail 真的展开、aria-expanded 同步
 *   · 所有可点元素的渲染尺寸 >= 44×44（移动端触控目标硬要求）
 *   · 没有横向溢出（scrollWidth <= innerWidth + 1）
 */
(async () => {
  const out = { viewport: `${window.innerWidth}x${window.innerHeight}`, checks: [], failures: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rail = document.getElementById('rail');
  const toggle = document.getElementById('btn-nav-toggle');
  const view = document.getElementById('view');

  const push = (name, ok, detail = '') => {
    out.checks.push({ name, ok, detail });
    if (!ok) out.failures.push(`${name}${detail ? ' — ' + detail : ''}`);
  };

  // ① 窄屏下「目录」按钮必须可见，rail 必须默认收起
  const toggleDisplay = getComputedStyle(toggle).display;
  push('窄屏「目录」按钮可见', toggleDisplay !== 'none', `display=${toggleDisplay}`);
  const railH0 = rail.getBoundingClientRect().height;
  push('导航默认收起', railH0 < 5, `rail 渲染高度 ${railH0.toFixed(0)}px`);

  // ② 点开后必须真的展开，且 aria-expanded 同步
  toggle.click();
  await sleep(160);
  const railH1 = rail.getBoundingClientRect().height;
  push('点开后导航展开', railH1 > railH0 + 40, `${railH0.toFixed(0)}px → ${railH1.toFixed(0)}px`);
  push('aria-expanded 已同步', toggle.getAttribute('aria-expanded') === 'true',
    `aria-expanded=${toggle.getAttribute('aria-expanded')}`);
  push('展开后目录项可见', document.querySelectorAll('.rail-item').length === 8,
    `${document.querySelectorAll('.rail-item').length} 项`);

  // ③ 触控目标 >= 44px（遍历所有可见的按钮/单选标签/开关/滑杆/数字框）
  const targets = [];
  const collect = () => {
    const sel = '.rail-item, .btn, .seg label, .switch, input[type="range"], input.num, summary.why > *, .why > summary';
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;          // 不可见
      if (getComputedStyle(el).display === 'none') continue;
      targets.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className || el.type || '',
        w: Math.round(r.width),
        h: Math.round(r.height),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 22),
      });
    }
  };
  collect();
  // 也进一个模块看看模块内的控件（折叠目录后）
  toggle.click();
  await sleep(140);
  const railItem = document.querySelector('.rail-item[data-mod="mod1"]');
  if (railItem) { railItem.click(); await sleep(600); }
  collect();

  const small = targets.filter((t) => t.h < 44 || t.w < 44);
  push('所有可见触控目标 >= 44px', small.length === 0,
    small.slice(0, 5).map((t) => `${t.tag}.${t.cls}(${t.w}x${t.h})`).join(' / '));

  // ④ 无横向溢出
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  push('无横向溢出', overflow <= 1, `scrollWidth - innerWidth = ${overflow}px`);

  // ⑤ 画布在窄屏下也不为 0
  const canvasSizes = Array.from(document.querySelectorAll('#view canvas')).map((c) => {
    const r = c.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)}`;
  });
  push('窄屏画布尺寸正常', canvasSizes.every((s) => {
    const [w, h] = s.split('x').map(Number);
    return w >= 120 && h >= 60;
  }), canvasSizes.join(', '));

  out.targetCount = targets.length;
  out.smallTargets = small.length;
  out.failureCount = out.failures.length;
  return JSON.stringify(out);
})()
