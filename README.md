<style>
  .resplat-root {
    font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
    background: #181A1B;
    color: #DCD9D4;
    max-width: 880px;
    margin: 0 auto;
    padding: 0;
  }
  .resplat-root * { box-sizing: border-box; }

  /* Hero */
  .hero {
    background: #222426;
    text-align: center;
    padding: 60px 24px 50px;
  }
  .hero-tag {
    color: #FA7F2A;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.4em;
    text-transform: uppercase;
  }
  .hero h1 {
    color: #E8E6E3;
    font-size: 88px;
    font-weight: 800;
    letter-spacing: -0.045em;
    margin: 22px 0 0;
    line-height: 1;
  }
  .hero-sub {
    color: rgba(156, 179, 198, 0.85);
    font-size: 15px;
    letter-spacing: 0.033em;
    margin-top: 18px;
  }
  .hero-buttons {
    display: flex;
    justify-content: center;
    gap: 12px;
    margin-top: 30px;
    flex-wrap: wrap;
  }
  .btn-primary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #BD5005;
    color: #DDDAD5;
    font-size: 14px;
    font-weight: 700;
    padding: 10px 22px;
    border-radius: 8px;
    text-decoration: none;
    border: 1px solid #7D7467;
  }
  .btn-secondary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(24, 26, 27, 0.06);
    color: #DCD9D4;
    font-size: 14px;
    font-weight: 700;
    padding: 10px 22px;
    border-radius: 8px;
    text-decoration: none;
    border: 1px solid #7D7467;
  }

  /* Content area */
  .content {
    background: #222426;
    padding: 0 28px 100px;
  }

  /* Badges row */
  .badges-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 24px 0;
    flex-wrap: wrap;
    gap: 12px;
  }
  .badges { display: flex; gap: 8px; }
  .badge {
    display: inline-flex;
    border-radius: 6px;
    overflow: hidden;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.027em;
  }
  .badge-label {
    background: #484E51;
    color: #E8E6E3;
    padding: 4px 8px;
  }
  .badge-value-orange {
    background: #9E5200;
    color: #E8E6E3;
    padding: 4px 8px;
  }
  .badge-value-green {
    background: #1C975C;
    color: #E8E6E3;
    padding: 4px 8px;
  }
  .powered-by {
    color: #BDB7AE;
    font-size: 12px;
  }
  .powered-by span { color: #FFAA50; }

  /* Divider */
  .divider {
    border: none;
    border-top: 1px solid #7D7467;
    margin: 0;
  }

  /* Section */
  .section { padding-top: 56px; }
  .section-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-left: 14px;
    border-left: 3px solid #A94804;
  }
  .section-heading img { flex-shrink: 0; }
  .section-title {
    color: #DCD9D4;
    font-size: 22px;
    font-weight: 700;
    line-height: 1.5;
    margin: 0;
  }
  .section-title-lg {
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.018em;
  }
  .section-desc {
    color: #9B9385;
    font-size: 14px;
    line-height: 1.85;
    margin: 6px 0 0;
  }

  /* Intro block */
  .intro-block {
    padding-left: 18px;
    border-left: 3px solid #A94804;
  }
  .intro-block p {
    color: #DCD9D4;
    font-size: 15px;
    line-height: 1.85;
    margin: 0;
  }
  .intro-block strong { color: #FA7F2A; font-weight: 700; }
  .intro-secondary {
    color: #9B9385;
    font-size: 14px;
    line-height: 1.85;
    margin-top: 18px;
  }
  .intro-secondary strong { color: #DCD9D4; font-weight: 700; }

  /* Warning box */
  .warning-box {
    display: flex;
    gap: 10px;
    background: rgba(174, 127, 3, 0.05);
    border: 1px solid rgba(166, 120, 3, 0.25);
    border-radius: 8px;
    padding: 14px 18px;
    margin-top: 20px;
  }
  .warning-box .warn-icon { color: #FBC434; font-size: 15px; flex-shrink: 0; }
  .warning-box .warn-text {
    color: #DCD9D4;
    font-size: 13px;
    line-height: 1.65;
  }
  .warning-box .warn-text strong { font-weight: 700; }
  .warning-box .warn-text .muted { color: #9B9385; }

  /* Cards row */
  .cards-row {
    display: flex;
    gap: 14px;
    margin-top: 24px;
    flex-wrap: wrap;
  }
  .card {
    flex: 1;
    min-width: 200px;
    background: #282B2D;
    border: 1px solid #7D7467;
    border-radius: 10px;
    padding: 20px;
  }
  .card-icon {
    width: 38px;
    height: 38px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card-icon-orange { background: rgba(189, 80, 5, 0.1); }
  .card-icon-amber { background: rgba(158, 82, 0, 0.1); }
  .card-icon-red { background: rgba(172, 46, 0, 0.1); }
  .card h4 {
    color: #DCD9D4;
    font-size: 14px;
    font-weight: 700;
    margin: 14px 0 6px;
  }
  .card p {
    color: #9B9385;
    font-size: 13px;
    line-height: 1.6;
    margin: 0;
  }

  /* Feature cards (copy/separate/merge) */
  .feature-cards {
    display: flex;
    gap: 12px;
    margin-top: 20px;
    flex-wrap: wrap;
  }
  .feature-card {
    flex: 1;
    min-width: 150px;
    background: #282B2D;
    border: 1px solid #7D7467;
    border-radius: 10px;
    padding: 18px;
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .feature-card-icon {
    width: 34px;
    height: 34px;
    border-radius: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .feature-card h4 {
    color: #DCD9D4;
    font-size: 14px;
    font-weight: 700;
    margin: 0 0 4px;
  }
  .feature-card p {
    color: #9B9385;
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
  }

  /* Wrapper image */
  .wrapper-img-container {
    position: relative;
    border: 1px solid #7D7467;
    border-radius: 10px;
    overflow: hidden;
    margin-top: 20px;
    height: 180px;
  }
  .wrapper-img-container img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.7;
  }
  .wrapper-img-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(34,36,38,0.5) 0%, rgba(51,41,34,0.42) 25%, rgba(75,48,29,0.34) 50%, rgba(114,59,21,0.26) 75%, rgba(145,68,14,0.22) 88%, rgba(189,80,5,0.18) 100%);
    display: flex;
    align-items: flex-end;
    padding: 16px;
  }
  .wrapper-img-label {
    color: rgba(250, 127, 42, 0.8);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.083em;
    text-transform: uppercase;
  }

  /* Data table */
  .data-table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #7D7467;
    border-radius: 8px;
    overflow: hidden;
    margin-top: 20px;
  }
  .data-table th {
    background: #061733;
    color: #9B9385;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.073em;
    text-transform: uppercase;
    text-align: left;
    padding: 9px 16px;
    border-bottom: 1px solid #7D7467;
  }
  .data-table td {
    padding: 11.5px 16px;
    font-size: 14px;
    color: #DCD9D4;
    line-height: 1.5;
    border-bottom: 1px solid rgba(128, 119, 106, 0.3);
    vertical-align: top;
  }
  .data-table tr:nth-child(odd) td { background: #282B2D; }
  .data-table tr:nth-child(even) td { background: #222B35; }
  .data-table tr:last-child td { border-bottom: none; }
  .data-table td.name-orange { color: #FA7F2A; font-weight: 700; }
  .data-table td.name-amber { color: #FFAA50; font-weight: 700; }
  .data-table td.name-red { color: #FF723F; font-weight: 700; }
  .data-table td.category { color: #FA7F2A; font-weight: 600; font-size: 14px; }
  .data-table td.category-amber { color: #FFAA50; }
  .data-table td.category-red { color: #FF723F; }
  .data-table td.check { color: #56E088; font-weight: 700; text-align: center; }
  .data-table td.dash { color: #BDB7AE; text-align: center; }

  /* Lists */
  .feature-list {
    list-style: none;
    padding: 0;
    margin: 20px 0 0;
  }
  .feature-list li {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    color: #DCD9D4;
    font-size: 14px;
    line-height: 1.6;
    padding: 5px 0;
  }
  .dot-orange {
    width: 6px;
    height: 6px;
    background: #BD5005;
    border-radius: 3px;
    flex-shrink: 0;
    margin-top: 8px;
  }
  .dot-green {
    width: 6px;
    height: 6px;
    background: #1C975C;
    border-radius: 3px;
    flex-shrink: 0;
    margin-top: 8px;
  }

  /* Tool cards (opacity/size) */
  .tool-cards {
    display: flex;
    gap: 14px;
    margin-top: 20px;
    flex-wrap: wrap;
  }
  .tool-card {
    flex: 1;
    min-width: 250px;
    border: 1px solid #7D7467;
    border-radius: 10px;
    overflow: hidden;
    background: #282B2D;
  }
  .tool-card-preview {
    height: 100px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-bottom: 1px solid #7D7467;
    position: relative;
  }
  .tool-card-preview-orange { background: rgba(172, 46, 0, 0.05); }
  .tool-card-preview-amber { background: rgba(174, 127, 3, 0.05); }
  .tool-card-preview span {
    font-family: Consolas, monospace;
    font-size: 11px;
  }
  .tool-card-preview-orange span { color: rgba(255, 114, 63, 0.4); }
  .tool-card-preview-amber span { color: rgba(251, 196, 52, 0.4); }
  .tool-card-body { padding: 16px 18px; }
  .tool-card-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .tool-card-title h4 {
    color: #DCD9D4;
    font-size: 14px;
    font-weight: 700;
    margin: 0;
  }
  .tool-card-body p {
    color: #9B9385;
    font-size: 13px;
    line-height: 1.6;
    margin: 0;
  }

  /* Language tags */
  .lang-tags {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 16px;
  }
  .lang-tag {
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    border: 1px solid #80776A;
  }
  .lang-tag-active {
    background: rgba(189, 80, 5, 0.08);
    color: #FA7F2A;
  }
  .lang-tag-inactive {
    background: transparent;
    color: #9B9385;
  }

  /* Numbered list */
  .num-list {
    list-style: none;
    padding: 0;
    margin: 20px 0 0;
    counter-reset: none;
  }
  .num-list li {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    color: #DCD9D4;
    font-size: 14px;
    line-height: 1.65;
    padding: 9px 0;
  }
  .num-circle {
    width: 22px;
    height: 22px;
    border-radius: 11px;
    background: rgba(189, 80, 5, 0.1);
    border: 1px solid rgba(169, 72, 4, 0.33);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #FA7F2A;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .inline-code {
    background: #061733;
    border: 1px solid #7D7467;
    border-radius: 4px;
    padding: 1px 6px;
    font-family: Consolas, monospace;
    font-size: 12px;
    color: #FA7F2A;
  }

  /* Thanks */
  .thanks-list {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 20px;
  }
  .thanks-item {
    display: flex;
    align-items: center;
    gap: 12px;
    background: #282B2D;
    border: 1px solid #7D7467;
    border-radius: 8px;
    padding: 14px 18px;
  }
  .thanks-item a {
    color: #FFAA50;
    font-size: 14px;
    font-weight: 700;
    text-decoration: none;
  }
  .thanks-item .sep { color: #CBC7C0; font-size: 16px; }
  .thanks-item .desc { color: #9B9385; font-size: 13px; line-height: 1.5; }

  /* Footer */
  .footer {
    text-align: center;
    padding: 56px 0 8px;
  }
  .footer p {
    color: #BDB7AE;
    font-size: 13px;
    line-height: 1.5;
    margin: 0;
  }
  .footer p:first-child { font-size: 13px; }
  .footer p:last-child {
    font-size: 12px;
    margin-top: 8px;
  }
</style>

<div class="resplat-root">

  <!-- Hero -->
  <div class="hero">
    <div class="hero-tag">3D 高斯点云编辑器</div>
    <h1>ReSplat</h1>
    <div class="hero-sub">基于 SuperSplat 重构 · 完全运行于浏览器 · 无需安装</div>
    <div class="hero-buttons">
      <a class="btn-primary" href="#">
        <img src="static/images/icon-14.svg" width="14" height="14" /> 在线使用
      </a>
      <a class="btn-secondary" href="#">
        <img src="static/images/icon-14.svg" width="14" height="14" /> 用户文档
      </a>
      <a class="btn-secondary" href="#">
        <img src="static/images/icon-14.svg" width="14" height="14" /> 问题反馈
      </a>
    </div>
  </div>

  <!-- Content -->
  <div class="content">

    <!-- Badges row -->
    <div class="badges-row">
      <div class="badges">
        <div class="badge">
          <span class="badge-label">release</span>
          <span class="badge-value-orange">latest</span>
        </div>
        <div class="badge">
          <span class="badge-label">license</span>
          <span class="badge-value-green">MIT</span>
        </div>
      </div>
      <div class="powered-by">Powered by <span>supersplat-2.27.0</span></div>
    </div>

    <hr class="divider" />

    <!-- Intro -->
    <div class="section">
      <div class="intro-block">
        <p>ReSplat 是一款基于 <strong>SuperSplat</strong> 重构的 <strong>3D 高斯点云编辑器</strong>，完全运行在浏览器中，无需安装任何软件即可使用。</p>
      </div>
      <p class="intro-secondary">本项目在 SuperSplat 的基础上 <strong>重新设计了操作逻辑</strong>，吸取了 <strong>Blender</strong> 与 <strong>Unreal Engine</strong> 的交互优点，使高斯点云的编辑体验更加直观高效。</p>
      <div class="warning-box">
        <span class="warn-icon">⚠</span>
        <div class="warn-text">
          <strong>语言说明：</strong><span class="muted">开发者母语为中文，中文界面经过完整审核与优化。其他语言均为机器翻译、未经人工校对，欢迎社区贡献翻译改进。</span>
        </div>
      </div>
    </div>

    <hr class="divider" />

    <!-- Improvements -->
    <div class="section">
      <div class="section-heading">
        <h2 class="section-title">相比 SuperSplat 的改进</h2>
      </div>
      <p class="section-desc">在原版基础上针对 DCC 用户重新打磨的三项核心优化</p>
      <div class="cards-row">
        <div class="card">
          <div class="card-icon card-icon-orange">
            <img src="static/images/icon-18.svg" width="18" height="18" />
          </div>
          <h4>操作逻辑优化</h4>
          <p>更符合 DCC 软件用户的操作习惯，降低上手门槛，让新用户快速融入工作流</p>
        </div>
        <div class="card">
          <div class="card-icon card-icon-amber">
            <img src="static/images/icon-18.svg" width="18" height="18" />
          </div>
          <h4>滚轮修复</h4>
          <p>解决了网页缩放导致滚轮失效的 Bug，确保视口操作稳定流畅</p>
        </div>
        <div class="card">
          <div class="card-icon card-icon-red">
            <img src="static/images/icon-18.svg" width="18" height="18" />
          </div>
          <h4>深度视图</h4>
          <p>新增深度视图模式，方便查看场景纵深信息，辅助精确定位点云</p>
        </div>
      </div>
    </div>

    <hr class="divider" />

    <!-- Features -->
    <div class="section">
      <div class="section-heading">
        <h2 class="section-title section-title-lg">特色功能</h2>
      </div>
      <p class="section-desc">ReSplat 在 SuperSplat 基础上新增或重构的核心能力</p>

      <!-- Wrapper System -->
      <div style="margin-top: 40px;">
        <div class="section-heading">
          <img src="static/images/icon-18.svg" width="18" height="18" />
          <h3 class="section-title">包裹体系统</h3>
        </div>
        <div class="wrapper-img-container">
          <img src="static/images/wrapper-system.png" alt="Wrapper System" />
          <div class="wrapper-img-overlay">
            <span class="wrapper-img-label">Wrapper System</span>
          </div>
        </div>
        <p class="section-desc" style="margin-top: 20px;">
          ReSplat 重构了原版的选择球与选择盒，并新增了阻挡平面，三者统一称为 <strong style="color: #DCD9D4;">包裹体（Wrapper）</strong>。包裹体可以像 Mesh 一样进行移动、旋转、缩放变换，为点云选择提供灵活的空间约束能力。
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 90px;">包裹体</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="name-orange">包裹球</td>
              <td>球形包裹体，选择球内的高斯点云。吸管工具、填充工具、透明度选择工具、尺寸选择工具均可限定为仅操作包裹球内的点云。例如可以在大场景中精确处理树叶内部的白色噪点。</td>
            </tr>
            <tr>
              <td class="name-amber">包裹盒</td>
              <td>盒形包裹体，功能同包裹球，形状为立方体，适合处理规则区域内的点云。</td>
            </tr>
            <tr>
              <td class="name-red">阻挡平面</td>
              <td>无限延伸的平面，可以阻挡框选工具、套索工具、多边形选择工具、画笔工具选择平面背后的高斯点云，实现前后遮挡关系下的精确选择。</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Point Cloud Group -->
      <div style="margin-top: 52px;">
        <div class="section-heading">
          <img src="static/images/icon-18.svg" width="18" height="18" />
          <h3 class="section-title">点云组</h3>
        </div>
        <p class="section-desc" style="margin-top: 20px;">
          类似于 Blender 的 <strong style="color: #DCD9D4;">顶点组（Vertex Group）</strong> 概念：
        </p>
        <ul class="feature-list">
          <li><span class="dot-orange"></span>可以将当前选择的点云保存为点云组，方便后续快速重新选择</li>
          <li><span class="dot-orange"></span>支持对点云组内的点云进行独立移动、旋转、缩放等变换操作</li>
          <li><span class="dot-orange"></span>适用于需要反复编辑同一区域点云的工作流程</li>
        </ul>
      </div>

      <!-- Copy / Separate / Merge -->
      <div style="margin-top: 52px;">
        <div class="section-heading">
          <img src="static/images/icon-18.svg" width="18" height="18" />
          <h3 class="section-title">复制、分离、合并</h3>
        </div>
        <p class="section-desc" style="margin-top: 20px;">
          为更便捷地 <strong style="color: #DCD9D4;">拼接高斯点云</strong> 而制作的全新功能，突破了 SuperSplat 原版中深度排序对操作的限制：
        </p>
        <div class="feature-cards">
          <div class="feature-card">
            <div class="feature-card-icon card-icon-orange">
              <img src="static/images/icon-16.svg" width="16" height="16" />
            </div>
            <div>
              <h4>复制</h4>
              <p>复制选中的点云</p>
            </div>
          </div>
          <div class="feature-card">
            <div class="feature-card-icon card-icon-amber">
              <img src="static/images/icon-16.svg" width="16" height="16" />
            </div>
            <div>
              <h4>分离</h4>
              <p>将选中的点云从当前 Splat 中分离为独立对象</p>
            </div>
          </div>
          <div class="feature-card">
            <div class="feature-card-icon" style="background: rgba(28, 151, 92, 0.1);">
              <img src="static/images/icon-16.svg" width="16" height="16" />
            </div>
            <div>
              <h4>合并</h4>
              <p>将多个 Splat 对象合并为一个</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Selection Tools -->
      <div style="margin-top: 52px;">
        <div class="section-heading">
          <img src="static/images/icon-18.svg" width="18" height="18" />
          <h3 class="section-title">丰富的选择工具集</h3>
        </div>
        <p class="section-desc" style="margin-top: 20px;">
          横跨三大类别的 <strong style="color: #DCD9D4;">14 种工具</strong>，覆盖选择、变换与测量的完整工作流：
        </p>
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 100px;">类别</th>
              <th>工具</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="category">选择</td>
              <td>框选 · 套索 · 多边形 · 画笔 · 填充 · 包裹球 · 包裹盒 · 吸管 · 透明度选择 · 尺寸选择</td>
            </tr>
            <tr>
              <td class="category category-amber">变换</td>
              <td>移动 · 旋转 · 缩放</td>
            </tr>
            <tr>
              <td class="category category-red">测量</td>
              <td>距离</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Opacity & Size Tools -->
      <div style="margin-top: 52px;">
        <div class="section-heading">
          <img src="static/images/icon-18.svg" width="18" height="18" />
          <h3 class="section-title">透明度选择工具 &amp; 尺寸选择工具</h3>
        </div>
        <p class="section-desc" style="margin-top: 20px;">
          基于 <span style="color: #FFAA50;">GaussianSplatEditor</span> 分支的源码，进行了功能衍生与增强：
        </p>
        <div class="tool-cards">
          <div class="tool-card">
            <div class="tool-card-preview tool-card-preview-orange">
              <img src="static/images/icon-22.svg" width="22" height="22" style="opacity: 0.4;" />
              <span style="position: absolute; bottom: 8px; left: 16px;">透明度选择.gif</span>
            </div>
            <div class="tool-card-body">
              <div class="tool-card-title">
                <img src="static/images/icon-15.svg" width="15" height="15" />
                <h4>透明度选择工具</h4>
              </div>
              <p>根据高斯点的透明度属性进行范围选择，快速筛选出半透明或低不透明度的点云</p>
            </div>
          </div>
          <div class="tool-card">
            <div class="tool-card-preview tool-card-preview-amber">
              <img src="static/images/icon-22.svg" width="22" height="22" style="opacity: 0.4;" />
              <span style="position: absolute; bottom: 8px; left: 16px;">尺寸选择.gif</span>
            </div>
            <div class="tool-card-body">
              <div class="tool-card-title">
                <img src="static/images/icon-15.svg" width="15" height="15" />
                <h4>尺寸选择工具</h4>
              </div>
              <p>根据高斯点的尺寸属性进行范围选择，定位过大或过小的异常点云</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Low Precision Fix -->
      <div style="margin-top: 52px;">
        <div class="section-heading">
          <img src="static/images/icon-18.svg" width="18" height="18" />
          <h3 class="section-title">低精度高斯修复</h3>
        </div>
        <p class="section-desc" style="margin-top: 20px;">针对特定场景的修复功能：</p>
        <ul class="feature-list">
          <li><span class="dot-green"></span>适用于因空三（空中三角测量）受到 GPS 屏蔽器影响而导致坐标精度丢失的高斯文件</li>
          <li><span class="dot-green"></span>修复低浮点精度的高斯点在渲染时出现的闪烁问题</li>
          <li><span class="dot-green"></span>自动检测并修正精度异常的坐标数据</li>
        </ul>
      </div>

      <!-- Animation & Timeline -->
      <div style="margin-top: 52px;">
        <div class="section-heading">
          <img src="static/images/icon-18.svg" width="18" height="18" />
          <h3 class="section-title">动画与时间线</h3>
        </div>
        <ul class="feature-list">
          <li><span class="dot-green"></span>内置时间线面板，支持关键帧动画编辑</li>
          <li><span class="dot-green"></span>相机轨迹动画，创建平滑的飞越路径</li>
          <li><span class="dot-green"></span>支持播放、暂停与逐帧控制</li>
        </ul>
      </div>

      <!-- Import / Export -->
      <div style="margin-top: 52px;">
        <div class="section-heading">
          <img src="static/images/icon-18.svg" width="18" height="18" />
          <h3 class="section-title">多格式导入导出</h3>
        </div>
        <table class="data-table" style="margin-top: 20px;">
          <thead>
            <tr>
              <th>格式</th>
              <th style="width: 124px; text-align: center;">导入</th>
              <th style="width: 124px; text-align: center;">导出</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>PLY（标准 / 压缩）</td>
              <td class="check">✓</td>
              <td class="check">✓</td>
            </tr>
            <tr>
              <td>Splat</td>
              <td class="check">✓</td>
              <td class="check">✓</td>
            </tr>
            <tr>
              <td>SOG</td>
              <td class="check">✓</td>
              <td class="check">✓</td>
            </tr>
            <tr>
              <td>SSPROJ（项目文件）</td>
              <td class="check">✓</td>
              <td class="check">✓</td>
            </tr>
            <tr>
              <td>图像（PNG / WebP）</td>
              <td class="dash">—</td>
              <td class="check">✓</td>
            </tr>
            <tr>
              <td>视频（MP4 / WebM / MOV / MKV）</td>
              <td class="dash">—</td>
              <td class="check">✓</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Multi-language -->
      <div style="margin-top: 52px;">
        <div class="section-heading">
          <img src="static/images/icon-18.svg" width="18" height="18" />
          <h3 class="section-title">多语言支持</h3>
        </div>
        <p class="section-desc" style="margin-top: 20px;">基于 i18next 的国际化系统，支持 9 种语言：</p>
        <div class="lang-tags">
          <span class="lang-tag lang-tag-active">中文（简体）</span>
          <span class="lang-tag lang-tag-inactive">English</span>
          <span class="lang-tag lang-tag-inactive">日本語</span>
          <span class="lang-tag lang-tag-inactive">한국어</span>
          <span class="lang-tag lang-tag-inactive">Français</span>
          <span class="lang-tag lang-tag-inactive">Deutsch</span>
          <span class="lang-tag lang-tag-inactive">Español</span>
          <span class="lang-tag lang-tag-inactive">Português</span>
          <span class="lang-tag lang-tag-inactive">Русский</span>
        </div>
      </div>
    </div>

    <hr class="divider" />

    <!-- i18n Contribution -->
    <div class="section">
      <h2 class="section-title section-title-lg" style="padding-left: 18px; border-left: 3px solid #A94804;">国际化贡献</h2>
      <p class="section-desc" style="margin-top: 16px;">欢迎帮助改进翻译质量！</p>
      <ol class="num-list">
        <li>
          <span class="num-circle">1</span>
          <span>在 <span class="inline-code">static/locales/</span> 目录下找到对应语言的 JSON 文件</span>
        </li>
        <li>
          <span class="num-circle">2</span>
          <span>修改或补充翻译内容</span>
        </li>
        <li>
          <span class="num-circle">3</span>
          <span>如需新增语言，在 <span class="inline-code">static/locales/</span> 中添加 <span class="inline-code" style="color: #FA7F2A;">&lt;locale&gt;.json</span> 文件，并在 <span class="inline-code">src/ui/localization.ts</span> 中注册</span>
        </li>
      </ol>
      <p class="section-desc" style="margin-top: 20px;">
        测试翻译：启动开发服务器后访问 <span class="inline-code">http://localhost:3000/?lng=&lt;locale&gt;</span>（如 <span class="inline-code" style="color: #FA7F2A;">?lng=zh-CN</span>）
      </p>
    </div>

    <hr class="divider" />

    <!-- Thanks -->
    <div class="section">
      <h2 class="section-title section-title-lg" style="padding-left: 18px; border-left: 3px solid #A94804;">致谢</h2>
      <div class="thanks-list">
        <div class="thanks-item">
          <img src="static/images/icon-14.svg" width="14" height="14" />
          <a href="https://github.com/playcanvas/super-splat">SuperSplat</a>
          <span class="sep">—</span>
          <span class="desc">原始项目，提供了强大的高斯点云编辑基础</span>
        </div>
        <div class="thanks-item">
          <img src="static/images/icon-14.svg" width="14" height="14" />
          <a href="https://github.com/Shachaf-zz/GaussianSplatEditor">GaussianSplatEditor</a>
          <span class="sep">—</span>
          <span class="desc">透明度 / 尺寸选择工具的源码参考</span>
        </div>
        <div class="thanks-item">
          <img src="static/images/icon-14.svg" width="14" height="14" />
          <a href="https://playcanvas.com">PlayCanvas</a>
          <span class="sep">—</span>
          <span class="desc">优秀的 WebGL 游戏引擎</span>
        </div>
      </div>
    </div>

    <hr class="divider" />

    <!-- Footer -->
    <div class="footer">
      <p>本项目基于 <strong>MIT License</strong> 开源发布</p>
      <p>A fork of SuperSplat · Powered by PlayCanvas</p>
    </div>

  </div>
</div>
