/**
 * steps-shots.mjs —— 截图步骤：8 个模块各拍「页首」与「向下滚动一屏」两张。
 * 契约见 scripts/screenshot.mjs：export default [{ name, setup }]，setup 是页面内执行的 async 函数体。
 */
const mods = [
  ['mod0', '数据清洗'],
  ['mod1', '时序拆解'],
  ['mod2', '移动平均'],
  ['mod3', '指数平滑'],
  ['mod4', '促销特征'],
  ['mod5', 'Prophet'],
  ['mod6', '误差Bias'],
  ['mod7', '安全库存'],
];

const steps = [];
for (const [id, name] of mods) {
  steps.push({
    name: `${id}-a-页首`,
    setup: `
      globalThis.__FFP_DEBUG__.activate('${id}');
      await sleep(700);
      window.scrollTo(0, 0);
      await sleep(200);
    `,
  });
  steps.push({
    name: `${id}-b-下半页`,
    setup: `
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(400);
    `,
  });
}
export default steps;
