/**
 * check-lectures.mjs —— 一口气跑完 9 个讲义页的真浏览器探针。
 *
 *   node scripts/check-lectures.mjs                 # 本地 http://localhost:8110/lectures/
 *   BASE=https://lianmao.github.io/forecastforplanner/lectures/ node scripts/check-lectures.mjs
 *
 * 为什么要这个脚本：讲义是 9 个页面，逐个手敲 browser-check 命令迟早会漏掉某一页，
 * 而漏掉的那一页正好可能是别人点进去看的唯一一页。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://localhost:8110/lectures/';
const PAGES = ['', 'mod0.html', 'mod1.html', 'mod2.html', 'mod3.html', 'mod4.html',
  'mod5.html', 'mod6.html', 'mod7.html'];

// ★ 就绪门必须等到 lecture.js **执行完**：顶部条与目录都是它注入的。
//   早期版本用的是 !!document.querySelector('.lec-body') —— 那个元素本来就在静态 HTML 里，
//   于是门在模块执行前就通过了：本地（1ms 加载完）侥幸全绿，线上（1~2 秒）9 页全挂。
//   教训：就绪门要断言"JS 跑过之后的产物"，不能断言静态 HTML 里已有的东西。
const READY = "!!document.querySelector('.lec-top') && document.querySelectorAll('#lecToc a').length > 1";
const results = [];

for (const p of PAGES) {
  const url = BASE + p;
  const r = spawnSync(process.execPath, [join(here, 'browser-check.mjs'), url, join(here, 'driver-lecture.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, READY_EXPR: READY },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = /RESULT: ALL BROWSER CHECKS PASSED/.test(out);
  // 从驱动返回的 JSON 里取出失败明细（如果有）
  const m = out.match(/\{\n {2}"checks":[\s\S]*?\n\}\n/);
  let fails = [];
  if (m) {
    try { fails = JSON.parse(m[0]).failures || []; } catch { /* ignore */ }
  }
  const label = p === '' ? 'index.html（目录页）' : p;
  results.push({ label, pass, fails });
  console.log(`  ${pass ? '✓' : '✗'} ${label}${pass ? '' : ` — ${fails.join(' | ') || '见上方输出'}`}`);
}

const bad = results.filter((x) => !x.pass);
console.log(`\n${bad.length ? `${bad.length} 个讲义页未通过` : `全部 ${results.length} 个讲义页通过`}（${BASE}）`);
process.exit(bad.length ? 1 : 0);
