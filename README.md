# Forecast for Planner · 供应链计划员预测互动教程

一个**纯前端、零依赖、免安装**的互动教学工具：把「从预测数字到库存决策」这条链路拆成 8 个可以亲手拖滑杆的实验。

打开网页就能用。所有计算都在你自己的浏览器里完成，**不上传任何数据、不需要注册、不需要服务器**。

---

## 它解决什么问题

供应链计划员每天在用 ERP / APS / 预测系统，但大多不清楚黑盒算法背后的统计学与机器学习原理。
面对业务部门质疑、异常波动、需要手动干预（Override）的时候，往往拿不出科学依据。

这个工具让计划员亲手把参数拉到底，看清三件事：

1. **每个参数在业务上意味着什么**（α 调高会怎样、窗口拉长会怎样、服务水平提到 99% 要花多少钱）
2. **模型什么时候会骗你**（MAPE 失真、Bias 累积、共线导致的伪解、外推失效）
3. **预测误差如何变成库存与资金**（σ → 安全库存 → 年持有成本）

---

## 八个模块

| # | 模块 | 一句话 |
| :--- | :--- | :--- |
| 0 | 数据清洗与异常修复 | 分清「缺货导致的假零销量」与「真的没需求」，避免恶性断货循环 |
| 1 | 时间序列三要素拆解 | 你设的趋势/季节/噪音，拆解能不能还原回来 |
| 2 | 移动平均与拐点滞后 | 平滑度与响应速度的取舍，量出「慢了几期」的代价 |
| 3 | 阻尼三次指数平滑 | α/β/γ/φ 每个参数对应一句业务话；φ 是防止预测上天的刹车 |
| 4 | 促销与折扣特征工程 | 从历史里**真的学出折扣弹性**，并检查它学得准不准 |
| 5 | Prophet 式组件拆解 | 趋势变点 / 周内节奏 / 年度淡旺季 / 节假日脉冲，每一项单独拿给业务方看 |
| 6 | 预测误差与 Bias 预警 | 为什么「准确率 85%」没有信息量；MAPE 为什么会失真 |
| 7 | 服务水平与安全库存博弈 | 把「多备一点点」换算成年持有成本，并看到成本曲线的凸性 |

---

## 本地运行

需要一个静态文件服务器（ES Module 不能用 `file://` 打开）：

```bash
cd ~/forecastforplanner
node scripts/serve.mjs 8110          # 然后打开 http://localhost:8110/
```

或者任意静态服务器：`python3 -m http.server 8110`（在此目录下）。

---

## 验证（四层，全部可复现）

```bash
npm run serve &        # 终端 A：本地静态服务器 http://localhost:8110/

npm run test           # ① 算法层：118 项单测，纯 node，无需浏览器（约 0.4 秒）
npm run check          # ② 真浏览器：8 模块 × 38 控件逐个驱动，断言每个控件都产生可见效果
npm run check:mobile   # ③ 移动端：44px 触控目标、无横向溢出、导航默认收起
npm run shots          # ④ 截图到 /tmp/ffp-shots —— 然后**必须人眼看**

npm run check:live     # 对线上部署跑同一套真浏览器检查
npm run calibrate      # 改动数据集设计或特征工程后重跑，用实测数字更新测试容差
```

第 ②③④ 层不是可选项。本项目抓到的最严重的几个缺陷（图表宽度为零、多子图叠在一起、
页面显示字面 `<strong>` 标签、误差阴影锚到 0 轴以下）**全部**是这两层发现的，
单元测试对它们完全无感 —— 详见 `DECISIONS.md` 的 D10。

---

## 配套讲义（课件）

互动工具解决"手上有没有感觉"，讲义解决"讲不讲得清道理"。两者一一对应，互相跳转。

打开方式：**<https://lianmao.github.io/forecastforplanner/lectures/>**
（本地：`npm run serve` 后访问 <http://localhost:8110/lectures/>，或从互动工具右上角的「讲义」进入）

| 文件 | 内容 |
| :--- | :--- |
| `lectures/index.html` | 课程说明、8 讲结构、三条学习路径、前置知识、诚实声明 |
| `lectures/mod0.html` | 第 0 讲 数据清洗与异常修复 |
| `lectures/mod1.html` | 第 1 讲 时间序列三要素拆解 |
| `lectures/mod2.html` | 第 2 讲 移动平均与拐点滞后 |
| `lectures/mod3.html` | 第 3 讲 阻尼三次指数平滑 |
| `lectures/mod4.html` | 第 4 讲 促销与折扣特征工程 |
| `lectures/mod5.html` | 第 5 讲 Prophet 式组件拆解 |
| `lectures/mod6.html` | 第 6 讲 预测误差与 Bias 预警 |
| `lectures/mod7.html` | 第 7 讲 服务水平与安全库存 |
| `lectures/FACTS.txt` | **讲义里每一个数字的出处**（由脚本生成，勿手工编辑） |

每一讲固定 7 节：业务痛点 → 理论 → 公式与符号含义 → 参数怎么调 → 三个常见误用 →
去互动模块验证什么 → 自测题（答案默认折叠）。**支持直接打印**：浏览器打印时会自动展开
自测题答案、隐藏导航与目录，适合当纸质讲义发给学员。

### 讲义里的数字为什么可信

讲义写满了具体数字（安全库存 2832 件、折扣弹性还原误差 3.3%、边际成本放大 4.98 倍……）。
这些数字不是"写文章时顺手打的"，而是三级可追溯：

```bash
npm run facts           # 1. 从代码里复算出所有数字 → lectures/FACTS.txt
npm run audit:numbers   # 2. 审计：讲义里出现的每个数字都要能在 FACTS.txt 里找到出处
                        #    找不到的会被列出来人工确认（允许纯算术推导与业务约定）
npm run check:lec       # 3. 9 个讲义页逐个跑真浏览器探针（目录/自测题/溢出/触控目标/打印样式）
```

改动了 `src/core/` 或数据集参数后，**必须重跑 `npm run facts` 并同步讲义**。
`npm run audit:numbers` 就是为此设的闸门 —— 它已经抓出过一处我自己写错的数字
（详见 `DECISIONS.md` 的 D12）。

---

## 技术选型：为什么是「零构建 + vendor」

| | 本方案 | Vite + 打包 |
| :--- | :--- | :--- |
| 应用代码 | 原生 ES Module，无构建 | 需要打包器 |
| 第三方库 | `vendor/echarts.esm.js`（638 KB，提交进仓库） | node_modules → 产物 |
| 算法层测试 | `node --test` 直接跑 | 需要额外配置 |
| 部署 | 推送静态文件 | CI 编译后发布 |

- **不用 CDN**：国内 jsdelivr 实测 0 字节超时；依赖进仓库，用户只加载同源文件。
- **体积更小**：用 esbuild 只注册用到的 echarts 子集，638 KB vs 全量 1007 KB。
- **可测**：`src/core/` 全是纯函数、零 DOM 依赖，118 项单测在 node 上跑，0.4 秒。
- 重新生成 vendor：`npm i && npm run vendor`（改 `scripts/build-vendor.mjs` 的注册清单）。

```
index.html            单页外壳
src/
  app.js              模块装载、哈希路由、挂载后首绘
  style.css           主题（含深色模式、移动端 44px 触控目标）
  core/               纯函数算法引擎（零 DOM 依赖，node --test 全覆盖）
    quantize.js       跨引擎数值一致性（只量化 sin/cos 输出）
    generator.js      种子化数据集生成
    cleaning.js       IQR 盖帽 / 中位数 / 剔除插值 / 缺货零值修复
    stats.js          拆解合成、SMA/WMA、拐点滞后、阻尼 Holt-Winters
    metrics.js        MAE / MAPE / WAPE / Bias
    inventory.js      Acklam+Halley Φ⁻¹、SS=Z·σ·√L、成本凸性
    linalg.js         内部标准化 OLS（含标准误与秩亏护栏）
    promo_sim.js      促销交互特征、折扣弹性可识别性
    prophet_sim.js    日粒度 GAM（分段趋势/周度/年度/节假日窗口）
    daily.js          日粒度数据与节假日窗口（UTC 整数天）
  ui/                 ECharts 封装、控件工厂、KPI 与贴纸卡片
  modules/            8 个教学模块
scripts/              构建 / 本地服务 / 探针 / 截图 / 标定
tests/                118 项单测
vendor/               echarts 子集（勿手工编辑）
```

---

## 诚实边界

这个工具刻意不吹牛。以下几条在界面上就写明了，也在 `DECISIONS.md` 里记录了理由：

- **Φ⁻¹ 不是「绝对精确」**：与 scipy 实测最大偏差 9.3e-15。对安全库存远远够用，但不要用它复现 scipy 末位。
- **Holt-Winters 不复现 statsmodels**：本实现用固定初始状态 + 用户给定参数递推；statsmodels 会联合最优化初始状态，两者不可能逐位一致。
- **安全库存的「成本爆炸」**：可证明的是成本曲线的**凸性**（每提高 1 个百分点的边际成本在放大），
  而不是「Z 值趋于无穷」—— 99.9% 处 Z 只是从 2.326 涨到 3.090。
- **促销弹性还原误差**：8 次力度不同的促销下平均 6.7%、最差 16.2%（实测标定，见 `scripts/calibrate-promo.mjs`）；
  在互动模块的默认数据集上，κ 的还原误差是 3.3%（真值 2.5，学回 2.583）。
  历史里只有 **1 次**促销时，模型会**直接拒绝求解**（设计矩阵秩亏，最小主元/最大主元 = 1.87e-16）——
  数据里没有的信息，模型变不出来；2 次仍可识别（κ=2.604）但不足以支撑任何结论。
- **用生成数据而非真实业务数据**：所有数据集由 `generator.js` / `daily.js` 按已知参数生成，
  因此「模型能不能学回真值」是可断言的命题。换成真实数据后结论可能不同。

---

## 数据与隐私

- 所有计算在浏览器本地完成，**没有任何后端请求**。
- 没有用户上传通道：数据集全部由本地代码生成（这是刻意的设计选择，见上一条边界）。
- 无埋点、无 Cookie、无第三方 CDN。

---

## 部署

静态文件，推到任意静态托管即可。GitHub Pages 需要：

```bash
touch .nojekyll                     # 仓库里已有
git push origin main
gh api -X POST repos/<owner>/<repo>/pages -f 'source[branch]=main' -f 'source[path]=/'
curl -sS -o /dev/null -w '%{http_code}\n' https://<owner>.github.io/<repo>/src/app.js
```

若本机 22 端口被网络策略阻断（推不上去），改用 GitHub 的 443 SSH 端点：

```bash
git remote set-url origin ssh://git@ssh.github.com:443/<owner>/<repo>.git
```
