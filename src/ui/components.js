/**
 * components.js —— 控件与容器工厂
 *
 * 设计要点：**控件创建后返回一个句柄**，模块靠句柄读值、写值、重置。
 * 不存在"渲染出来了但没接线"的控件：onChange 是必填参数，缺了会直接抛错。
 * （"渲染出来的控件不等于接好线的控件"是这类应用最常见的假完成。）
 */

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export { h };

/* ───────────────────────── 容器 ───────────────────────── */

export function card({ title, hint, body = [], cls = '' } = {}) {
  const kids = [];
  if (title) {
    kids.push(h('div', { class: 'card-title' }, [
      h('span', { text: title }),
      hint ? h('span', { class: 'hint', text: hint }) : null,
    ]));
  }
  for (const b of [].concat(body)) if (b) kids.push(b);
  return h('div', { class: `card ${cls}`.trim() }, kids);
}

export function grid(n, children, cls = '') {
  return h('div', { class: `grid grid-${n} ${cls}`.trim() }, [].concat(children).filter(Boolean));
}

export function chartBox({ id, size = '' } = {}) {
  return h('div', { class: `chart ${size}`.trim(), id });
}

export function moduleHeader({ req, title, sub }) {
  return h('header', { class: 'mod-head' }, [
    req ? h('span', { class: 'mod-req', text: req }) : null,
    h('h1', { class: 'mod-title', text: title }),
    // sub 允许内联标签（<strong> 等）：模块的副标题里确实会用强调。
    // 早先用 textContent 渲染，结果标签被当字面文字显示出来 —— 截图里一眼可见，
    // 任何 DOM 断言都查不出"页面上的文字多了一堆尖括号"。
    sub ? h('p', { class: 'mod-sub', html: sub }) : null,
  ]);
}

/* ───────────────────────── 贴士 / 说明 ───────────────────────── */

export function tipBox({ title = '计划员小贴士', lines = [], tone = '' } = {}) {
  return h('div', { class: `tip ${tone === 'alert' ? 'tip-alert' : ''}`.trim() }, [
    h('p', { class: 'tip-title', text: title }),
    // 字符串一律按 HTML 渲染：贴士文案里用了 <strong>/<code> 做强调，
    // 用 textContent 会把标签当字面文字显示在页面上（截图里一眼可见，
    // 而任何 DOM 断言都只看到"文字变长了"，查不出来）。
    ...[].concat(lines).map((l) => h('p', { html: l })),
  ]);
}

export function whyBox({ title = '为什么是这样', body = [] } = {}) {
  return h('details', { class: 'why' }, [
    h('summary', {}, [h('span', { text: title })]),
    h('div', { class: 'why-body' }, [].concat(body).map((b) => (
      typeof b === 'string' ? h('p', { html: b }) : b
    ))),
  ]);
}

export function errorBox({ title = '这个参数组合下模型拒绝给出结果', message, detail }) {
  return h('div', { class: 'err' }, [
    h('strong', { text: title }),
    h('p', { text: message }),
    detail ? h('pre', { text: detail }) : null,
  ]);
}

/* ───────────────────────── KPI ───────────────────────── */

export function kpi({ label, value = '—', unit = '', sub = '', tone = '' }) {
  const valEl = h('div', { class: 'kpi-val', text: String(value) });
  const unitEl = unit ? h('span', { class: 'kpi-unit', text: unit }) : null;
  const subEl = h('div', { class: 'kpi-sub', text: sub });
  const el = h('div', { class: `kpi ${tone}`.trim() }, [
    h('div', { class: 'kpi-label', text: label }),
    h('div', {}, [valEl, unitEl].filter(Boolean)),
    subEl,
  ]);
  return {
    el,
    set(v, { unitText, subText, toneText } = {}) {
      valEl.textContent = String(v);
      if (unitEl && unitText !== undefined) unitEl.textContent = unitText;
      if (subText !== undefined) subEl.textContent = subText;
      if (toneText !== undefined) el.className = `kpi ${toneText}`.trim();
    },
  };
}

/* ───────────────────────── 控件 ───────────────────────── */

const noopGuard = (fn, name) => {
  if (typeof fn !== 'function') {
    throw new TypeError(`控件「${name}」缺少 onChange 回调 —— 不允许创建没有接线的控件`);
  }
};

/**
 * 滑杆。拖动时不重建 DOM，只回调 onChange（图表更新走 setOption），
 * 这是"滑杆响应 <200ms"的关键。
 */
export function slider({
  label, min, max, step, value, unit = '', decimals = 0, help = '', onChange, format = null,
}) {
  noopGuard(onChange, label);
  const fmtVal = format || ((v) => (decimals === 0 ? String(Math.round(v)) : v.toFixed(decimals)));
  const valEl = h('span', { class: 'ctl-val', text: `${fmtVal(value)}${unit}` });
  const input = h('input', {
    type: 'range', min, max, step, value,
    'aria-label': label,
    oninput: () => {
      const v = Number(input.value);
      valEl.textContent = `${fmtVal(v)}${unit}`;
      onChange(v);
    },
  });
  const el = h('div', { class: 'ctl' }, [
    h('div', { class: 'ctl-top' }, [h('label', { class: 'ctl-label', text: label, for: inputId(input) }), valEl]),
    input,
    help ? h('div', { class: 'ctl-help', text: help }) : null,
  ]);
  input.id = inputId(input);
  return {
    el,
    get: () => Number(input.value),
    set(v) {
      input.value = String(v);
      valEl.textContent = `${fmtVal(v)}${unit}`;
    },
    default: value,
  };
}

/** 单选（分段按钮组） */
export function radio({ label, options, value, help = '', onChange, inline = true }) {
  noopGuard(onChange, label);
  const name = `r-${Math.random().toString(36).slice(2, 9)}`;
  const inputs = [];
  const wrap = h('div', { class: 'seg' }, options.map((o) => {
    const id = `${name}-${o.value}`;
    const input = h('input', {
      type: 'radio', name, id, value: o.value,
      onchange: () => onChange(o.value),
    });
    if (o.value === value) input.checked = true;
    if (o.title) input.setAttribute('title', o.title);
    inputs.push({ input, value: o.value });
    return h('label', { for: id, title: o.title || '' }, [input, h('span', { text: o.label })]);
  }));
  const el = h('div', { class: 'ctl' }, [
    h('div', { class: 'ctl-top' }, [h('span', { class: 'ctl-label', text: label })]),
    wrap,
    help ? h('div', { class: 'ctl-help', text: help }) : null,
  ]);
  return {
    el,
    get: () => inputs.find((i) => i.input.checked)?.value,
    set(v) {
      for (const i of inputs) i.input.checked = (i.value === v);
    },
    default: value,
  };
}

/** 开关 */
export function toggle({ label, value, help = '', onChange }) {
  noopGuard(onChange, label);
  const input = h('input', {
    type: 'checkbox',
    onchange: () => onChange(input.checked),
  });
  input.checked = !!value;
  const el = h('div', { class: 'ctl' }, [
    h('label', { class: 'switch' }, [
      input,
      h('span', { class: 'track' }),
      h('span', { class: 'switch-label', text: label }),
    ]),
    help ? h('div', { class: 'ctl-help', text: help }) : null,
  ]);
  return {
    el,
    get: () => input.checked,
    set(v) { input.checked = !!v; },
    default: !!value,
  };
}

/** 数字输入 */
export function numberField({
  label, min, max, step, value, unit = '', help = '', onChange,
}) {
  noopGuard(onChange, label);
  const input = h('input', {
    class: 'num', type: 'number', min, max, step, value,
    'aria-label': label,
    oninput: () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) onChange(clamp(v, min, max));
    },
    onblur: () => {
      const v = clamp(Number(input.value), min, max);
      input.value = String(v);
      onChange(v);
    },
  });
  const el = h('div', { class: 'ctl' }, [
    h('div', { class: 'ctl-top' }, [
      h('span', { class: 'ctl-label', text: label }),
      unit ? h('span', { class: 'ctl-val', text: unit }) : null,
    ]),
    input,
    help ? h('div', { class: 'ctl-help', text: help }) : null,
  ]);
  return {
    el,
    get: () => clamp(Number(input.value), min, max),
    set(v) { input.value = String(v); },
    default: value,
  };
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function inputId(el) {
  if (!el.id) el.id = `i-${Math.random().toString(36).slice(2, 9)}`;
  return el.id;
}

/** 控件集合的批量重置（顶栏「恢复默认参数」用） */
export function controlRegistry() {
  const items = [];
  return {
    add(handle) { items.push(handle); return handle; },
    resetAll() {
      for (const c of items) {
        c.set(c.default);
      }
    },
    count: () => items.length,
  };
}
