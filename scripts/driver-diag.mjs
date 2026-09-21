/**
 * driver-diag.mjs —— 诊断驱动：激活指定模块并回传页面上的报错与图表状态。
 * 用法：DIAG_MOD=mod7 node scripts/browser-check.mjs http://localhost:8110/ scripts/driver-diag.mjs
 */
(async () => {
  const target = (globalThis.__DIAG_MOD__) || new URLSearchParams(location.hash.slice(1)).get('m') || 'mod7';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { target, errors: [] };

  // 逐模块激活，记录每个模块的 canvas 数与 DOM 里的报错文本
  const rail = Array.from(document.querySelectorAll('.rail-item'));
  out.modules = [];
  for (const btn of rail) {
    btn.click();
    await sleep(700);
    const errEl = document.querySelector('#view .err');
    const canvases = Array.from(document.querySelectorAll('#view canvas')).map((c) => {
      const r = c.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}`;
    });
    out.modules.push({
      id: btn.dataset.mod,
      canvases,
      errorHead: errEl ? (errEl.querySelector('strong')?.textContent || '') : '',
      errorPre: errEl ? (errEl.querySelector('pre')?.textContent || '').slice(0, 900) : '',
      errMsg: errEl ? (errEl.querySelector('p')?.textContent || '') : '',
    });
  }
  return JSON.stringify(out);
})()
