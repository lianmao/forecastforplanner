/**
 * driver-all.mjs —— 真浏览器探针驱动（8 个模块 × 每个控件）
 *
 * 契约：本文件必须是「一个表达式」，由 scripts/browser-check.mjs 注入页面执行。
 *
 * 它回答的问题只有一个：**渲染出来的控件，是不是真的接上了线？**
 * 只看"控件存在"或"没报错"是抓不到死控件的 —— 必须驱动它，并断言产生了可见效果。
 *
 * 可见效果的判据（三者任一变化即算生效）：
 *   ① 图表指纹（各序列长度与末值）
 *   ② KPI 卡片文本
 *   ③ #view 内各图表容器的**渲染高度**（用来抓"切换显示"这类只改可见性的控件 ——
 *      不能用 display 值判断，浏览器对 [hidden] 的实现不走作者可见的 display）
 *
 * 控件按 DOM 顺序驱动两轮：有些控件有顺序依赖（例如"未来一期开促销"必须先打开，
 * "折扣力度"滑杆才会影响结果），第二轮专门补测第一轮没生效的那些。
 */
(async () => {
  const out = {
    railItems: 0,
    modules: [],
    totalControls: 0,
    changedOnFirstPass: 0,
    changedOnRetry: 0,
    failures: [],
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitUntil = async (fn, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      let v = false;
      try { v = fn(); } catch { v = false; }
      if (v) return true;
      await sleep(60);
    }
    return false;
  };

  const snapshot = () => {
    let chartFp = 'n/a';
    try { chartFp = globalThis.__FFP_DEBUG__.chartDigest(); } catch { /* ignore */ }
    // KPI 的**主值与副文案都要**：有的模块主值（清洗前均值）是恒定的，
    // 变化只体现在副文案（清洗后均值）上，只读主值会漏判成"死控件"。
    const kpis = Array.from(document.querySelectorAll('#view .kpi-val'))
      .map((e) => e.textContent).join('|');
    const subs = Array.from(document.querySelectorAll('#view .kpi-sub'))
      .map((e) => e.textContent).join('|');
    const heights = Array.from(document.querySelectorAll('#view .chart'))
      .map((e) => e.clientHeight).join(',');
    const shown = Array.from(document.querySelectorAll('#view [hidden]')).length;
    const tableRows = document.querySelectorAll('#view table.data tbody tr').length;
    return `${chartFp}||${kpis}||${subs}||${heights}||rows:${tableRows}||hidden:${shown}`;
  };

  const labelOf = (inp) => {
    const ctl = inp.closest('.ctl');
    const el = ctl ? ctl.querySelector('.ctl-label') : null;
    return inp.getAttribute('aria-label') || (el && el.textContent) || inp.type;
  };

  /** 让控件产生一个「与当前值不同」的新值 */
  const drive = (inp) => {
    if (inp.type === 'range') {
      const min = Number(inp.min), max = Number(inp.max), v = Number(inp.value);
      const span = max - min;
      let nv = v + span * 0.35;
      if (nv > max - span * 0.05) nv = min + span * 0.25;
      inp.value = String(nv);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (inp.type === 'checkbox') { inp.click(); return true; }
    if (inp.type === 'radio') {
      if (inp.checked) return false;      // 已选中的再点不会触发 change
      inp.click();
      return true;
    }
    const nv = Math.min(Number(inp.max || 1000), Math.max(Number(inp.min || 0), Number(inp.value) * 1.5 || 50));
    inp.value = String(nv);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  const rail = Array.from(document.querySelectorAll('.rail-item'));
  out.railItems = rail.length;
  if (rail.length !== 8) out.failures.push(`导轨项数应为 8，实际 ${rail.length}`);

  for (const btn of rail) {
    const id = btn.dataset.mod;
    btn.click();
    const rendered = await waitUntil(
      () => globalThis.__FFP_DEBUG__.activeModule === id
        && document.querySelectorAll('#view canvas').length > 0,
    );
    const mod = { id, rendered, canvases: [], controlCount: 0, deadControls: [], failures: [] };
    if (!rendered) {
      mod.failures.push('模块未渲染出画布');
      out.failures.push(`[${id}] 模块未渲染出画布`);
      out.modules.push(mod);
      continue;
    }
    // 等图表完成首帧绘制（ECharts 动画 220ms）
    await sleep(320);

    for (const c of document.querySelectorAll('#view canvas')) {
      const r = c.getBoundingClientRect();
      const size = `${Math.round(r.width)}x${Math.round(r.height)}`;
      mod.canvases.push(size);
      if (r.width < 120 || r.height < 60) {
        mod.failures.push(`画布尺寸异常 ${size}`);
      }
    }
    // 模块自身声明的控件数必须与 DOM 里能抓到的数量一致
    try { mod.declaredControls = globalThis.__FFP_DEBUG__.controlCount(); } catch { /* ignore */ }

    const inputs = Array.from(document.querySelectorAll('#view input'));
    mod.controlCount = inputs.length;
    out.totalControls += inputs.length;
    if (!inputs.length) mod.failures.push('模块没有任何控件');

    // 第一轮
    const pending = [];
    for (const inp of inputs) {
      const label = labelOf(inp);
      const before = snapshot();
      const drove = drive(inp);
      if (!drove) continue;                 // 已选中的 radio，跳过
      await sleep(240);
      const after = snapshot();
      if (before !== after) {
        mod.changed = (mod.changed || 0) + 1;
        out.changedOnFirstPass += 1;
      } else {
        pending.push({ inp, label });
      }
    }
    // 第二轮：补测第一轮无效果的控件（排除顺序依赖造成的假失败）
    for (const { inp, label } of pending) {
      const before = snapshot();
      const drove = drive(inp);
      if (!drove) continue;
      await sleep(240);
      const after = snapshot();
      if (before !== after) {
        out.changedOnRetry += 1;
      } else {
        mod.deadControls.push(label);
        mod.failures.push(`控件无可见效果：${label}`);
      }
    }

    if (mod.failures.length) out.failures.push(`[${id}] ${mod.failures.join('; ')}`);
    out.modules.push(mod);
  }

  out.moduleCount = out.modules.length;
  out.modulesWithIssues = out.modules.filter((m) => m.failures.length).map((m) => m.id);
  out.failureCount = out.failures.length;
  return JSON.stringify(out);
})()
