/**
 * driver-probe.mjs —— 极简状态探针：把页面关键状态原样回传，不做任何断言。
 * 用途：当"看起来什么都没渲染"时，先用它定位是 app 没起来、还是模块没挂载。
 */
(async () => {
  const q = (s) => document.querySelector(s);
  const view = document.getElementById('view');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = (tag) => ({
    tag,
    viewChildren: view.children.length,
    canvasInView: document.querySelectorAll('#view canvas').length,
    inputs: document.querySelectorAll('#view input').length,
    chartCount: globalThis.__FFP_DEBUG__?.chartCountNow?.(),
    dump: globalThis.__FFP_DEBUG__?.chartDump?.(),
  });
  const out = {
    readyFlag: document.documentElement.dataset.ffpReady ?? null,
    activeModule: globalThis.__FFP_DEBUG__?.activeModule ?? null,
    steps: [],
  };

  out.steps.push(snap('初始（页面加载后的 mod0）'));

  globalThis.__FFP_DEBUG__.activate('mod0');
  await sleep(600);
  out.steps.push(snap('重新激活 mod0 后 600ms'));

  await sleep(1500);
  out.steps.push(snap('再等 1500ms'));

  globalThis.__FFP_DEBUG__.activate('mod1');
  await sleep(800);
  out.steps.push(snap('切到 mod1 后 800ms'));

  return JSON.stringify(out);
})()
