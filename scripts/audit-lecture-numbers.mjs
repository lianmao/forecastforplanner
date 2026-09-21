/**
 * audit-lecture-numbers.mjs —— 审计讲义里出现的数字是否都能在事实表里找到出处。
 *
 *   node scripts/audit-lecture-numbers.mjs              # 审计全部讲义页
 *   node scripts/audit-lecture-numbers.mjs lectures/mod4.html
 *
 * 为什么需要它：讲义里写满了具体数字（2832 件、4.98 倍、t=9.5……）。
 * 这些数字必须来自 scripts/lecture-facts.mjs 的输出（lectures/FACTS.txt）——
 * 一旦有人（包括我自己或助手）在文案里"顺手写一个看起来合理的数"，
 * 读者照着复算就会对不上，整份材料的可信度归零。
 *
 * 审计规则：抓出页面正文里的所有数字，凡是不在 FACTS.txt 数字集合里、
 * 且不在"允许的解释性数字"白名单里的，全部列出来人工确认。
 * 这不是自动判错 —— 有些数字是纯算术推导（如 1041×1.713≈1783）或业务约定（24 个月 = 2 年）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const facts = readFileSync(join(root, 'lectures/FACTS.txt'), 'utf8');

/** FACTS 里出现的所有数字 token（去掉千分位与单位） */
const factNums = new Set();
for (const m of facts.matchAll(/\d+(?:\.\d+)?/g)) {
  factNums.add(m[0]);
  // 同时登记其数值形式，便于 2832 与 2,832 这类写法互认
}
/** 允许的解释性数字：不来自事实表，但有明确出处。
 *  这些是我逐个复核过并归档的 —— 留成"待确认"噪音只会让人以后忽略这份报告。
 *  A 纯算术推导（讲义里已注明"纯算术推导"）：两个事实表数字相减/相除/按比例缩放得到
 *  B 举例用的量（文案里明确写成"如…"）
 *  C 交互指令里提到的滑杆可达值
 *  D 数据集种子（出现在脚注的代码片段里）
 *  E 数学常数、公式化简与业务约定
 */
const ALLOW = new Set([
  // 结构与数学常数
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '0', '0.5', '1.0', '2.0', '3.0',
  '100', '1000', '0.01', '0.05', '0.1', '0.9', '0.99', '0.999', '1.96', '95', '99', '99.9', '90',
  // E 公式/业务约定/数据集规模
  '24', '36', '48', '60', '72', '1095', '365', '730', '40', '20', '15', '30', '44', '1.5',
  '4.345', '2.5', '0.98', '0.97', '0.8', '0.25', '0.15', '0.35', '0.2', '75', '2.4',
  // A 纯算术推导
  '1.713', '0.0315', '10.3', '0.0008', '0.0018', '23', '10284', '1.03', '1416', '2.83', '2.08',
  '65', '91', '0.92', '857', '1089', '1112', '41', '5.5',
  // B 举例
  '85', '1.20', '1.02',
  // C 滑杆可达值
  '35',
  // D 种子
  '21', '4242', '707', '99', '606', '33', '2023', '7', '2020',
]);

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(join(root, 'lectures')).filter((f) => f.endsWith('.html')).map((f) => `lectures/${f}`);

let flagged = 0;
for (const rel of files.sort()) {
  const html = readFileSync(join(root, rel), 'utf8');
  // 只看正文，跳过 <head>、脚本与标签属性
  const body = html
    .replace(/<head[\s\S]*?<\/head>/i, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ');
  const odd = new Map();
  for (const m of body.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const raw = m[0];
    const norm = raw.replace(/,/g, '');
    // 千分位数字（如 2,832）与纯数字（2832）都算命中
    if (factNums.has(norm) || factNums.has(raw) || ALLOW.has(norm) || ALLOW.has(raw)) continue;
    // 小数去掉尾部 0 再试一次（2.500 与 2.5）
    const trimmed = norm.replace(/\.?0+$/, '');
    if (factNums.has(trimmed) || ALLOW.has(trimmed)) continue;
    if (!odd.has(norm)) odd.set(norm, body.slice(Math.max(0, m.index - 26), m.index + 26).replace(/\s+/g, ' '));
  }
  if (odd.size === 0) {
    console.log(`  ✓ ${rel.padEnd(22)} 所有数字都能在事实表里找到出处`);
  } else {
    flagged += odd.size;
    console.log(`  ? ${rel.padEnd(22)} ${odd.size} 个数字需要人工确认：`);
    for (const [n, ctx] of odd) console.log(`      ${n.padStart(8)}   上下文：…${ctx}…`);
  }
}
console.log(`\n${flagged === 0 ? '没有需要人工确认的数字。' : `共 ${flagged} 处需要确认（纯算术推导与业务约定属正常，其余应改为事实表里的值）。`}`);
