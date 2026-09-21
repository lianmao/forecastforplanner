# 系统实现方案说明书 (Implementation Specification - GitHub Pages 部署版)

## 1. 方案定位与技术选型 (Overview & Tech Stack)

### 1.1 方案定位
本项目采用**纯前端单页架构 (Pure Client-Side Web Application)**，并通过 **GitHub Pages** 提供全球免运维的高可用静态网站托管。
- **目标用户体验**：计划员无需在本地电脑安装任何 Python、C++ 编译器或虚拟环境，只需在浏览器中打开网址（如 `https://<username>.github.io/forecastforplanner/`）即可秒开使用。
- **免休眠与高可用**：相比免费容器平台的休眠与冷启动，GitHub Pages **24 小时在线、永不休眠、毫秒级载入**。
- **本地计算与隐私安全**：所有时序算法与图表计算均在计划员本地浏览器的 JavaScript/WebAssembly 引擎中运行，用户上传的自定义业务数据绝不离手，兼具企业级数据隐私安全。

---

### 1.2 核心技术栈

| 分层 | 选型技术 | 选型依据与优势 |
| :--- | :--- | :--- |
| **构建与脚手架** | **Vite + Vanilla JS / Vue 3** | 构建产物极度轻量（< 1MB），冷启动与 HMR 极速，原生支持 GitHub Pages 相对路径部署。 |
| **图表可视化引擎** | **Apache ECharts 5.x** | 国内外工业界标准，完美支持时序缩放 (DataZoom)、动态阴影带（置信区间）、分量子图、双 Y 轴与 60FPS 丝滑渲染。 |
| **算法与计算层** | **自研轻量数学与时序引擎 (`src/core/`)** | 纯 ES6 编写，内置时间序列拆解、SMA/WMA、Holt-Winters 递推公式、正态分布反函数（$\Phi^{-1}$）与业务特征响应模型。 |
| **CI/CD 自动化流水线**| **GitHub Actions** | 自动化 CI/CD，只要代码 `git push` 到 `main` 分支，10 秒内自动编译并发布至 `gh-pages` 静态分支。 |
| **配套源码课件** | **Jupyter Notebooks (`notebooks/*.ipynb`)** | 随仓库一同提供，供有 Python 进阶学习需求的学员下载或在 Google Colab 中打开。 |

---

## 2. 系统整体架构设计 (System Architecture)

```mermaid
graph TD
    User([计划员浏览器 / 移动端]) -->|访问 URL: https://username.github.io/forecastforplanner/| GHPages[GitHub Pages 静态 CDN]
    
    subgraph Browser Client [浏览器客户端本地内存运行 (零服务器开销)]
        direction TB
        UI[UI 交互层: 侧边栏导航 + 参数控制滑杆/开关]
        
        subgraph Core Engine [前端纯算法引擎 (src/core/)]
            GEN[generator.js: 典型时序数据生成器]
            CLN[cleaning.js: IQR 截断与缺货线性插值]
            STA[stats.js: 拆解 / SMA / Holt-Winters 阻尼平滑]
            MLP[promo_sim.js: 促销脉冲与透支效应特征模型]
            PROP[prophet_sim.js: 周期傅里叶级数与节假日加性分解]
            INV[inventory.js: MAE/MAPE/Bias 与安全库存非线性成本模型]
        end
        
        ECH[ECharts 动态可视化渲染器: 毫秒级无感重绘]
        TIP[业务小贴士卡片: 启发式业务释疑]

        UI --> Core Engine
        Core Engine --> ECH
        Core Engine --> TIP
    end

    GHPages --> Browser Client
```

### 2.1 数据流转与响应机制
1. **输入触发**：计划员拖动界面上的滑杆（如滑动窗口 $k$、平滑系数 $\alpha$、服务水平 $SL$）或切换单选框；
2. **纯前端瞬时计算**：事件监听器触发对应的纯 JS 算法函数，计算耗时通常小于 **5ms**；
3. **视图增量重绘**：调用 `echartsInstance.setOption(...)`，仅更新数据序列与高亮标注，视觉无跳变、无白屏，帧率保持在 **60 FPS**；
4. **业务指标联动**：同步刷新界面顶部的核心 KPI 卡片（如当前 MAE、库存资金增加额、风险指示灯）。

---

## 3. 核心算法在前端的纯 JS 落地实现

### 3.1 模块 0：数据清洗与异常修复 (`src/core/cleaning.js`)
* **IQR 四分位截断算法 (Winsorization)**：
  - 计算分位数：$Q1 = \text{percentile}(X, 25), Q3 = \text{percentile}(X, 75), IQR = Q3 - Q1$；
  - 阈值区间：$[Q1 - k \cdot IQR, Q3 + k \cdot IQR]$；
  - 超出区间的数值自动截断至上下界，保留原序列平滑连续性。
* **缺货假零值修复**：
  - 检测连续为 0 的区间，采用**线性插值 (Linear Interpolation)** 或 **去年同期对应周期值** 进行填充替换。

### 3.2 模块 1：时序拆解与传统统计模型 (`src/core/stats.js`)
* **时序三要素即时合成与分解**：
  - 加法模型：$Y(t) = \text{Trend}(t) + \text{Seasonal}(t) + \text{Noise}(t)$
  - 乘法模型：$Y(t) = \text{Trend}(t) \times \text{Seasonal}(t) \times \text{Noise}(t)$
  - 季节性波形由正弦傅里叶项驱动：$\text{Seasonal}(t) = A \cdot \sin(2\pi t / 12 + \theta)$
* **移动平均与拐点滞后侦测**：
  - 简单移动平均 (SMA)：滑动窗口求和；
  - 线性加权移动平均 (WMA)：权重 $w_i = \frac{i}{\sum i}$；
  - 拐点判定：计算数值一阶差分 $\Delta Y_t = Y_t - Y_{t-1}$，当差分符号由正转负时判定为波峰，测量预测线波峰滞后的步长 $\Delta t$。
* **三次指数平滑 Holt-Winters（含阻尼趋势）**：
  - 水平递推：$L_t = \alpha (Y_t - S_{t-m}) + (1-\alpha)(L_{t-1} + \phi T_{t-1})$
  - 趋势递推：$T_t = \beta (L_t - L_{t-1}) + (1-\beta) \phi T_{t-1}$
  - 季节递推：$S_t = \gamma (Y_t - L_{t-1} - \phi T_{t-1}) + (1-\gamma) S_{t-m}$
  - 未来 $h$ 期外推：$\hat{Y}_{t+h} = L_t + \sum_{i=1}^h \phi^i T_t + S_{t+h-m}$

### 3.3 模块 2：促销与节假日特征工程仿真 (`src/core/promo_sim.js`)
* **促销提升度 (Lift Effect) 与透支低谷 (Post-promo Dip)**：
  - 计划员调节折扣力度 $d$（如 0.7 代表 7 折，让利 $30\%$）；
  - 瞬时销量拉动系数：$\text{Lift} = 1 + \kappa \cdot (1 - d)^{\eta}$（$\kappa$ 为价格弹性敏感度）；
  - 需求透支衰减函数：在促销结束后的接连 2 个周期内，销量按指数衰减形式下挫：
    $$\Delta Y_{\text{dip}}(t+1) = - \lambda \cdot (\text{Lift} - 1) \cdot Y_{\text{base}}, \quad \Delta Y_{\text{dip}}(t+2) = - 0.5 \cdot \Delta Y_{\text{dip}}(t+1)$$
* **特征贡献权重动态条形图**：
  - 根据折扣深度和滞后项波动，动态归一化渲染特征重要性（Feature Importance）。

### 3.4 模块 3：Prophet 工业级组件拆解仿真 (`src/core/prophet_sim.js`)
* **广义加性模型组件化拆解**：
  - 趋势变点 (Changepoints)：在第 12、24 期设置趋势斜率变动 $\delta_j$；
  - 周度周期项：$s_{\text{weekly}}(t) = \sum_{n=1}^3 (a_n \cos(\frac{2\pi n t}{7}) + b_n \sin(\frac{2\pi n t}{7}))$；
  - 节假日脉冲向量：在预置日历长假（如春节、国庆）的前 2 期注入提前囤货脉冲峰值，后 1 期注入假期停产停工断崖波谷。

### 3.5 模块 4：预测误差与安全库存财务博弈 (`src/core/inventory.js`)
* **多维度误差度量**：
  - $\text{MAE} = \frac{1}{n} \sum |A_t - F_t|$
  - $\text{MAPE} = \frac{1}{n} \sum |\frac{A_t - F_t}{A_t}| \times 100\%$
  - $\text{WAPE} = \frac{\sum |A_t - F_t|}{\sum A_t} \times 100\%$
  - $\text{Bias} = \frac{\sum (F_t - A_t)}{\sum A_t} \times 100\%$
* **高精度正态分布反函数 (Acklam's Algorithm)**：
  - 纯 JS 实现标准正态反累积分布函数 $Z = \Phi^{-1}(SL)$，精确计算 $SL \in [0.900, 0.999]$ 下的 $Z$ 因子（如 $95\% \rightarrow 1.645$，$99.9\% \rightarrow 3.090$）；
* **安全库存与非线性资金成本爆炸计算**：
  - $SS = Z \times \sigma_{\text{residual}} \times \sqrt{L}$；
  - $\text{Holding Cost} = SS \times \text{Unit Cost} \times \text{Holding Rate}$；
  - 实时绘制随服务水平增加，资金持有成本呈**指数级向上拉升的非线性爆炸曲线**。

---

## 4. 前端工程目录结构 (Project Directory Structure)

```text
forecastforplanner/
├── .github/
│   └── workflows/
│       └── deploy.yml              # GitHub Actions 自动化部署流水线
├── REQUIREMENTS.md                 # 需求规格说明书
├── IMPLEMENTATION.md               # 系统实现方案说明书 (本文档)
├── README.md                       # 项目介绍与本地运行指引
├── index.html                      # 单页应用入口
├── package.json                    # 项目元数据与依赖定义
├── vite.config.js                  # Vite 配置文件 (配置相对路径 base: './')
├── public/                         # 纯静态资源 (favicon, 样例 CSV 数据)
│   ├── retail_sales_sample.csv
│   └── spare_parts_sample.csv
├── src/
│   ├── main.js                     # 应用初始化与路由控制
│   ├── style.css                   # 全局样式系统 (现代商务/供应链主题色)
│   ├── core/                       # 纯函数算法引擎 (无 UI 依赖)
│   │   ├── generator.js            # 场景数据集生成器
│   │   ├── cleaning.js             # 异常截断与缺失填补算法
│   │   ├── stats.js                # 拆解、SMA/WMA、Holt-Winters 递推
│   │   ├── promo_sim.js            # 促销拉升与透支特征模型
│   │   ├── prophet_sim.js          # 加性组件与节假日脉冲分解
│   │   └── inventory.js            # 误差度量、Acklam 正态逆函数、安全库存模型
│   ├── modules/                    # 各教学模块页面逻辑与图表组装
│   │   ├── mod0_cleaning.js        # 模块 0：数据清洗实训
│   │   ├── mod1_decomposition.js   # 模块 1：时序要素拆解
│   │   ├── mod2_moving_average.js  # 模块 2：移动平均与滞后
│   │   ├── mod3_holt_winters.js    # 模块 3：指数平滑参数敏感度
│   │   ├── mod4_promo_ml.js        # 模块 4：促销与折扣特征工程
│   │   ├── mod5_prophet.js         # 模块 5：Prophet 工业级组件分解
│   │   ├── mod6_error_bias.js      # 模块 6：预测误差与 Bias 偏向预警
│   │   └── mod7_safety_stock.js    # 模块 7：服务水平与安全库存成本博弈
│   └── ui/                         # UI 通用组件库
│       ├── chart_helper.js         # ECharts 主题与通用配置封装
│       ├── components.js           # 控件生成函数 (Slider, Radio, Toggle)
│       └── tooltips.js             # 计划员通俗业务贴士卡片
└── notebooks/                      # 配套的 Python 进阶学习课件
    ├── 01_传统统计预测原理.ipynb
    └── 02_机器学习与安全库存.ipynb
```

---

## 5. GitHub Pages 自动化部署配置 (CI/CD Pipeline)

通过在项目根目录创建 `.github/workflows/deploy.yml`，实现代码提交即部署：

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build static site
        run: npm run build

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: './dist'

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

---

## 6. 实施路线与开发任务分解 (Execution Roadmap)

### 阶段一：前端工程底座与算法核心库搭建 (Phase 1)
- [ ] 初始化 Vite 前端工程，配置 `vite.config.js` 的 `base: './'`（确保静态资源在 GitHub Pages 正常加载）；
- [ ] 配置 `.github/workflows/deploy.yml` 流水线；
- [ ] 编写 `src/core/generator.js`（经典零售场景时序序列生成）与 `src/core/cleaning.js`（IQR 截断、插值）；
- [ ] 编写 `src/core/stats.js`（时序分解合成、SMA/WMA 移动平均滞后、Holt-Winters 递推算法）。

### 阶段二：传统时序与基础教学模块实现 (Phase 2)
- [ ] 引入 ECharts 并封装 `src/ui/chart_helper.js`（适配深色/浅色、响应式图表大小重置）；
- [ ] 组装完成：
  - **模块 0**：数据清洗实训（脏数据对比图与统计卡片）；
  - **模块 1**：时序拆解实验（Trend/Seasonality/Noise 三滑杆联动）；
  - **模块 2**：移动平均（平滑 vs 拐点滞后虚线标注）；
  - **模块 3**：Holt-Winters 三次指数平滑（$\alpha, \beta, \gamma, \phi$ 参数调控与未来 12 期外推带）。

### 阶段三：机器学习特征与现代模型模块实现 (Phase 3)
- [ ] 编写 `src/core/promo_sim.js` 与 `src/core/prophet_sim.js`；
- [ ] 组装完成：
  - **模块 4**：促销特征工程（促销开关、折扣滑杆、瞬时拉升 Lift 与透支 Dip 阴影标示、特征贡献度条形图）；
  - **模块 5**：Prophet 组件分解（节假日开关、自动变点标注、周度/年度季节性独立小图看板）。

### 阶段四：库存闭环沙盘与上线交付 (Phase 4)
- [ ] 编写 `src/core/inventory.js`（正态反函数、MAE/MAPE/Bias 风险雷达、安全库存非线性成本模型）；
- [ ] 组装完成：
  - **模块 6**：预测误差与 Bias 偏向预警看板（高库存 vs 频繁断货风险灯）；
  - **模块 7**：服务水平与安全库存成本博弈计算器（90%~99.9% 成本指数级飙升曲线）；
- [ ] 整体 UI 美化、中英文术语统一与引导贴士排版；
- [ ] 编写项目使用与课件说明文档 `README.md`，执行构建验证并完成初次上线部署。
