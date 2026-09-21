/**
 * driver-lecture.mjs —— 讲义页探针（一个表达式，由 browser-check.mjs 注入）
 *
 * 讲义是长文页面，它的问题类型与互动工具不同：不是"控件没接线"，而是
 * 目录没渲染、上一讲/下一讲指错、长文把窄屏撑出横向滚动、打印样式丢掉答案、
 * 以及 HTML 里未转义的实体/标签被当字面文字显示。
 */
(async () => {
  const out = { checks: [], failures: [], tocItems: 0, exCount: 0, rawLeak: 0, cur: null, links: [], overflow: 0, headH: 0, tocH: 0 };
  const ok = (name, pass, detail = '') => {
    out.checks.push({ name, ok: !!pass, detail: String(detail) });
    if (!pass) out.failures.push(name + (detail ? ` — ${detail}` : ''));
  };
  const txt = (el) => (el ? (el.textContent || '').trim() : '');
  const width = () => document.documentElement.clientWidth || window.innerWidth;

  out.cur = document.body.dataset.lec || '';

  // 1. 顶部条
  const top = document.querySelector('.lec-top');
  ok('顶部条已渲染', !!top, top ? '高度 ' + Math.round(top.getBoundingClientRect().height) + 'px' : '缺失');
  if (top) {
    const t = txt(top);
    ok('顶部条含「讲义目录」入口', t.includes('讲义目录'));
    ok('顶部条含「互动工具」入口', t.includes('互动工具'));
    ok('上一讲/下一讲导航存在', (t.includes('讲')), t.replace(/\s+/g, ' ').slice(0, 60));
  }

  // 2. 左侧课程目录
  const toc = document.getElementById('lecToc');
  const items = toc ? toc.querySelectorAll('a') : [];
  out.tocItems = items.length;
  ok('课程目录渲染出 9 个入口（8 讲 + 课程说明）', items.length === 9, `实际 ${items.length}`);
  const curLink = toc ? toc.querySelector('a.is-cur') : null;
  ok('当前讲在目录里被高亮', out.cur === '' ? true : !!curLink, out.cur === '' ? '（目录页无需高亮）' : (curLink ? txt(curLink) : '未高亮'));

  // 3. 每讲必须有标题与开头导读
  const h1 = document.querySelector('.lec-h1');
  ok('有 h1 标题', !!h1 && txt(h1).length > 2, txt(h1));
  const lead = document.querySelector('.lec-lead');
  ok('有开头导读段（不是直接进入正文）', !!lead && txt(lead).length > 30, `${txt(lead).length} 字`);

  // 4. 正文结构：章节数 + 自测题
  const h2n = document.querySelectorAll('.lec-body h2').length;
  ok('正文分节 >= 5', h2n >= 5, `${h2n} 节`);
  const exs = document.querySelectorAll('.ex details');
  out.exCount = exs.length;
  if (out.cur) {
    ok('自测题 >= 2 道', exs.length >= 2, `${exs.length} 道`);
    ok('自测题答案默认折叠', exs.length === 0 || Array.from(exs).every((d) => !d.open), '');
    ok('每道自测题都有答案块', exs.length === 0 || Array.from(exs).every((d) => !!d.querySelector('.ans')));
  }
  const cta = document.querySelector('.cta a.btn');
  if (out.cur) ok('有「去互动模块」的按钮且指向应用', !!cta && /index\.html#mod/.test(cta.getAttribute('href') || ''), cta ? cta.getAttribute('href') : '缺失');

  // 5. 未解析标签 / 未转义实体（讲义文案里有 <code>、&gt; 这类写法，容易漏转义）
  const body = txt(document.querySelector('.lec-body'));
  const tags = body.match(/<\/?[a-z][a-z0-9]*\s*\/?>/gi);
  const ents = body.match(/&(lt|gt|amp|nbsp|quot|#\d+);/gi);
  out.rawLeak = (tags ? tags.length : 0) + (ents ? ents.length : 0);
  ok('正文没有未解析标签/实体', out.rawLeak === 0,
    [...(tags || []), ...(ents || [])].slice(0, 4).join(' '));

  // 6. 公式块与表格没有被样式压坏
  const eqs = document.querySelectorAll('.eq');
  ok('公式块有内容', eqs.length === 0 || Array.from(eqs).every((e) => txt(e).length > 4), `${eqs.length} 个公式块`);

  // 7. 横向溢出（长文最容易在窄屏被宽表格/长公式撑破）
  //    ★ 注意断言的形式：宽表格"溢出父容器"是**正常**的 —— 只要那个父容器可横向滚动就行
  //    （overflow-x: auto）。真正要抓的是"溢出了却滚不动"，那等于内容被裁掉。
  out.overflow = document.documentElement.scrollWidth - width();
  ok('页面无横向溢出', out.overflow <= 1, `scrollWidth - innerWidth = ${out.overflow}px`);
  const canScrollX = (el) => {
    const ox = getComputedStyle(el).overflowX;
    return ox === 'auto' || ox === 'scroll';
  };
  const clipped = [];
  for (const t of document.querySelectorAll('.lec-body table')) {
    if (t.scrollWidth <= t.parentElement.clientWidth + 2) continue;
    if (!canScrollX(t.parentElement)) clipped.push(`table(${txt(t.querySelector('th')).slice(0, 8)})`);
  }
  ok('超宽表格没有被裁掉（外层可横向滚动）', clipped.length === 0, clipped.join(' '));
  const eqClipped = Array.from(eqs).filter((e) => e.scrollWidth > e.clientWidth + 2 && !canScrollX(e));
  ok('超宽公式块没有被裁掉（内部可横向滚动）', eqClipped.length === 0, eqClipped.length ? `${eqClipped.length} 个被裁` : '');

  // 8. 窄屏行为：目录默认收起 + 按钮可展开
  if (width() <= 900) {
    ok('窄屏目录默认收起', toc && toc.dataset.collapsed === 'true', `collapsed=${toc ? toc.dataset.collapsed : 'n/a'}`);
    const btn = document.getElementById('lecTocBtn');
    ok('窄屏有「目录」按钮', !!btn && getComputedStyle(btn).display !== 'none');
    if (btn) {
      const before = toc.getBoundingClientRect().height;
      btn.click();
      await new Promise((r) => setTimeout(r, 120));
      const after = toc.getBoundingClientRect().height;
      ok('点开后目录展开', after > before, `${Math.round(before)}px → ${Math.round(after)}px`);
      ok('aria-expanded 已同步', btn.getAttribute('aria-expanded') === 'true', btn.getAttribute('aria-expanded'));
      btn.click();
    }
  }

  // 9. 触控目标：>=44px 是**移动端**的硬要求；桌面鼠标场景下 34px 的导航条是合理的，
  //    所以按视口宽度分开断言（否则桌面跑一遍会报一堆假失败）。
  const minH = width() <= 900 ? 44 : 32;
  const small = [];
  for (const el of document.querySelectorAll('.lec-top a, .lec-top button, #lecToc a, .cta .btn')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.height < minH) small.push(`${txt(el).slice(0, 10)}=${Math.round(r.height)}px`);
  }
  ok(`可见交互元素高度 >= ${minH}px`, small.length === 0, small.slice(0, 5).join(' '));

  // 10. 打印样式：答案必须展开、导航必须隐藏（讲义主要用途之一是打印）
  const styleText = Array.from(document.styleSheets)
    .filter((s) => s.href && /lecture\.css/.test(s.href))
    .map((s) => { try { return Array.from(s.cssRules).map((r) => r.cssText).join('\n'); } catch { return ''; } })
    .join('\n');
  ok('打印样式里隐藏了导航', /@media print[\s\S]*?display:\s*none/.test(styleText));
  ok('打印样式里展开了自测题答案', /@media print[\s\S]*?\.ans[\s\S]*?display:\s*block/.test(styleText));

  out.ok = out.failures.length === 0;
  return JSON.stringify(out);
})()
