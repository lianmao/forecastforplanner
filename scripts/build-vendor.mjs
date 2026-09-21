/**
 * build-vendor.mjs —— 把 node_modules 里的第三方库打成 vendor/ 下的单文件 ESM 产物并提交进仓库。
 *
 * 为什么要有这一步：
 *   jsdelivr / unpkg 在国内不可靠（本机实测 cdn.jsdelivr.net 直接 0 字节超时）。
 *   把 echarts 按需子集打成 ESM 单文件提交进仓库，用户端只加载我们自己的同源文件，
 *   既没有 CDN 依赖，也比直接引 echarts.min.js（全量 ~1MB）小。
 *
 * 用法：npm run vendor
 * 产物：vendor/echarts.esm.js（真正被 index.html 引用），vendor/VERSIONS.txt（版本留档）
 */
import { build } from 'esbuild';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'vendor');
await mkdir(vendorDir, { recursive: true });

// ── 只注册本工具真正用到的图表与组件，这是体积的关键 ──
const ENTRY = `
import * as echarts from 'echarts/core';
import { LineChart, BarChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  MarkLineComponent,
  MarkPointComponent,
  MarkAreaComponent,
  DataZoomComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  ToolboxComponent,
  VisualMapComponent,
  GraphicComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart, BarChart, ScatterChart,
  GridComponent, TooltipComponent, LegendComponent, TitleComponent,
  MarkLineComponent, MarkPointComponent, MarkAreaComponent,
  DataZoomComponent, DataZoomInsideComponent, DataZoomSliderComponent,
  ToolboxComponent, VisualMapComponent, GraphicComponent,
  CanvasRenderer,
]);

// 只导出 app 实际用到的 API 面，避免把整个命名空间拖进产物（体积差一倍以上）
export const init = echarts.init;
export const use = echarts.use;
export const registerTheme = echarts.registerTheme;
export const graphic = echarts.graphic;
export default { init: echarts.init, use: echarts.use, registerTheme: echarts.registerTheme, graphic: echarts.graphic };
`;

const outfile = path.join(vendorDir, 'echarts.esm.js');
await build({
  stdin: { contents: ENTRY, resolveDir: root, sourcefile: 'echarts-entry.js', loader: 'js' },
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  metafile: true,
});

const echartsVer = require('echarts/package.json').version;
const esbuildVer = require('esbuild/package.json').version;
const { size } = await stat(outfile);
await writeFile(
  path.join(vendorDir, 'VERSIONS.txt'),
  [
    `echarts  ${echartsVer}   → vendor/echarts.esm.js (${(size / 1024).toFixed(1)} KB)`,
    `esbuild  ${esbuildVer}   (仅构建期使用，运行时不加载)`,
    '',
    '重新生成：npm run vendor',
    '勿手工编辑 vendor/ 下的文件。',
    '',
  ].join('\n'),
);
console.log(`✓ vendor/echarts.esm.js  ${(size / 1024).toFixed(1)} KB  (echarts ${echartsVer})`);
