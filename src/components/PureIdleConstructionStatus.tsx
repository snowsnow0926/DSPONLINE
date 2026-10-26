import type { PureIdleConstructionSummary } from "../game/pureIdleMacro";

const COPY: Record<PureIdleConstructionSummary["state"], [string, string]> = {
  disabled: ["未开启", "建筑制造已关闭，终局产率仍按所选模式结算。"],
  "missing-center": ["等待制造中心", "仍有制造目标，需要部署建筑制造巨构后才能生产。"],
  complete: ["目标已满足", "当前没有待完成的制造目标。"],
  working: ["正在制造", "制造消耗真实材料，并受当前供电和配送额度限制。"],
  materials: ["等待材料", "可用原料不足；产率复制不会生成制造所需的原料。"],
  power: ["等待供电", "当前没有足够的、已验证的制造供电额度。"],
  quantum: ["等待量子配送", "量子库有材料，正在等待可用配送额度；其他中心的预留不能重复使用。"],
  compute: ["制造计算分段中", "本段已达到制造计算预算，终局产率与制造进度分别显示。"],
};

export function PureIdleConstructionStatus({ summary }: { summary?: PureIdleConstructionSummary }) {
  const [label, explanation] = summary ? COPY[summary.state] : ["等待初始化", "正在确认制造中心的材料与供电状态。"];
  return <section className="time-warp-construction" aria-label="建筑制造状态">
    <header><strong>建筑制造巨构</strong><span>{label}</span></header>
    {summary && <p>本段完成 {summary.completedLastBucket.toLocaleString("zh-CN")} · 累计完成 {summary.totalCrafted.toLocaleString("zh-CN")} · 参与中心 {summary.centerCount}</p>}
    <p>{explanation}</p>
    {summary && summary.waitingMaterials + summary.waitingPower + summary.waitingQuantum > 0 &&
      <p>等待材料 {summary.waitingMaterials} · 等待供电 {summary.waitingPower} · 等待配送 {summary.waitingQuantum}</p>}
  </section>;
}
