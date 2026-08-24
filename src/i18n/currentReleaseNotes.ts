import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-24-v1.1.6",
    date: english ? "August 24, 2026" : "2026年8月24日",
    version: "1.1.6",
    title: english ? "Belt Port Alignment and Productive Pure Idle" : "传送带端口对齐与纯挂机高倍率修复",
    summary: english
      ? "Version 1.1.6 fixes dense-canvas belt lines that were inferred from card centres and therefore missed multi-input and multi-output ports. Batched Canvas belts now reuse React Flow's measured handle geometry and avoid rebuilding the topology when runtime flow observations refresh. The 1.1.5 endgame pure-idle fix remains included: eligible high-multiplier saves advance production and research through a bounded cumulative contract without bypassing finite-resource or safety boundaries. GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain unchanged."
      : "1.1.6 修复高密度画布中传送带线按卡片中心推算、导致多输入/多输出建筑端口错位的问题；批量 Canvas 线路现在复用 React Flow 已测量的真实端口几何，并在拓扑稳定时避免被运行时流量刷新反复重建。1.1.5 的终局纯挂机保守模式修复继续保留：合法高倍率存档按有界累计合同推进生产和科研，不绕过有限资源与安全边界。GameState v47、存档 envelope v2、cloud schema v8、SQLite layout v3 不变。",
    items: [
      {
        id: "measured-belt-endpoints",
        title: english ? "Belt lines connect to measured ports" : "传送带线精确连接真实端口",
        description: english
          ? "Multi-input, multi-output, and special logistics ports use React Flow's measured handle coordinates. Zoom, pan, low-detail cards, and batched Canvas rendering share the same endpoints; an unmounted handle safely falls back to the card edge without changing belt data."
          : "多输入、多输出和特殊物流端口使用 React Flow 实际测量的 handle 坐标，缩放、平移、低细节卡片与批量 Canvas 渲染保持同一端点；未挂载端口只安全回退到卡片边缘，不写入或改变线路数据。",
      },
      {
        id: "stable-dense-belt-topology",
        title: english ? "Dense belt topology stays stable across flow refreshes" : "高密度线路拓扑不随流量重建",
        description: english
          ? "The packed line batch rebuilds only when topology, node layout, or handle geometry changes. Production flow, hover, and runtime diagnostics no longer recreate the full line index while hit testing and interaction boundaries remain intact."
          : "线路批次只在拓扑、节点布局或端口几何变化时重新打包；生产流量、悬停和运行时诊断刷新不会反复创建整张线路索引，保留命中测试与交互边界。",
      },
      {
        id: "productive-pure-idle",
        title: english ? "Endgame pure idle remains productive at high multipliers" : "终局纯挂机继续按高倍率结算",
        description: english
          ? "Large endgame saves run a bounded exact prefix, then apply whitelisted cumulative rates with an 80% safety haircut while research advances. Finite resources, transient logistics, and unsafe integer boundaries remain fail-closed."
          : "超大终局存档先做有界精确前缀，再以 80% 安全折扣应用白名单累计速率并推进科研；有限资源、瞬时物流和安全整数边界继续 fail-closed。",
      },
      {
        id: "dense-belt-regression",
        title: english ? "Multi-port dense canvases are regression-gated" : "多端口与密集画布加入回归门禁",
        description: english
          ? "Regression coverage adds a 200-belt multi-input target plus zoom, pan, and low-detail rendering checks; the endgame pure-idle fixture continues to verify 15x long windows, reloadability, and an unchanged source save."
          : "新增 200 条线路、多输入目标、缩放/平移和低细节渲染回归；纯挂机终局夹具继续验证 15x 长窗口、可重载和源存档不变。",
      },
      {
        id: "version-upgrade",
        title: english ? "Save and server protocols remain compatible" : "存档与服务端协议保持兼容",
        description: english
          ? "This release does not upgrade GameState, the save envelope, cloud schema, SQLite layout, or belt data format. Existing saves, cloud revisions, backups, and native apps continue to use the established contracts."
          : "本版不升级 GameState、存档封装、云 schema、SQLite layout 或线路数据格式；旧存档、云修订、备份和原生应用继续按既有合同读取。",
      },
    ],
  } as const;
}
