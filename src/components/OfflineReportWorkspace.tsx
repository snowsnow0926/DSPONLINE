import { CheckCircle2, Clock3, Factory, FlaskConical, Gift, Orbit, Send, Sparkles, X } from "lucide-react";
import { getItem, getTechnology } from "../game/content";
import type { OfflineReport } from "../game/storage";
import { ItemGlyph, ItemHoverCard } from "./ItemReference";
import { QuantityValue } from "./QuantityValue";
import { useAppLocale } from "../i18n/locale";

function formatDuration(seconds: number, locale: "zh-CN" | "en"): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (locale === "en") {
    if (hours > 0) return `${hours} h ${minutes} min`;
    if (minutes > 0) return `${minutes} min ${remainingSeconds} sec`;
    return `${remainingSeconds} sec`;
  }
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟 ${remainingSeconds} 秒`;
  return `${remainingSeconds} 秒`;
}

export function OfflineReportWorkspace({ report, onClose }: { report: OfflineReport | null; onClose: () => void }) {
  const { locale } = useAppLocale();
  if (!report) return null;
  const infiniteResearchLevels = report.infiniteResearchLevels ?? [];
  const exported = report.exported ?? [];
  const galacticCreditsAdded = report.galacticCreditsAdded ?? 0;
  const returningReward = report.returningReward ?? [];
  const settlement = report.settlement;
  const hasChanges = report.produced.length > 0 || report.completedTechIds.length > 0 ||
    report.structurePointsAdded > 0 || report.shellSailsAdded > 0 || infiniteResearchLevels.length > 0 ||
    exported.length > 0 || galacticCreditsAdded > 0 || returningReward.length > 0;
  return (
    <section className="offline-report" role="dialog" aria-modal="true" aria-label="离线结算报告">
      <header>
        <div><i><Clock3 size={19} /></i><span><small>离线生产协议</small><strong>结算报告</strong></span></div>
        <button type="button" onClick={onClose} title="关闭离线结算报告" aria-label="关闭离线结算报告"><X size={18} /></button>
      </header>
      <div className="offline-runtime">
        <div>
          <span>{locale === "en" ? "Offline duration" : "离线时长"} · {locale === "en" ? settlement?.mode === "approximate" ? "Approximate settlement (experimental)" : "Exact settlement" : settlement?.mode === "approximate" ? "近似结算（实验）" : "精确结算"}</span>
          {settlement ? <small>
            {locale === "en" ? "Calibration" : "校准"} 2 × {settlement.calibrationWindowSeconds || 0} {locale === "en" ? "sec" : "秒"} ·
            {locale === "en" ? " Approximate coverage" : " 近似覆盖"} {formatDuration(settlement.approximateSeconds, locale)} ·
            {locale === "en" ? " Max estimated error" : " 最大估计误差"} {(settlement.maximumEstimatedError * 100).toFixed(2)}% ·
            {locale === "en" ? settlement.conservationVerified ? " Conservation verified" : " Conservation failed" : ` 守恒${settlement.conservationVerified ? "已验证" : "未通过"}`} ·
            {locale === "en" ? " Compute" : " 计算"} {(settlement.calculationMs / 1000).toFixed(2)} {locale === "en" ? "sec" : "秒"}
          </small> : null}
          {settlement?.fellBack ? <em>{locale === "en" ? "Approximation did not meet the safety conditions. Exact settlement was used automatically" : "本次近似未满足安全条件，已自动使用精确结算"}：{settlement.fallbackReason ?? (locale === "en" ? "Safety preflight failed" : "安全检查未通过")}</em> : null}
          {settlement?.incomplete ? <em>{locale === "en" ? "Calculation is incomplete; unsettled time was not committed" : "本次计算未完成，未提交未结算时间"}</em> : null}
        </div>
        <strong>{formatDuration(report.seconds, locale)}</strong>
      </div>
      {hasChanges ? (
        <div className="offline-report-body">
          {report.produced.length > 0 ? <section>
            <header><Factory size={15} /><span>生产入库</span><strong><QuantityValue value={report.produced.reduce((sum, item) => sum + item.amount, 0)} /></strong></header>
            <div className="offline-production-list">
              {report.produced.map(({ itemId, amount }) => {
                const item = getItem(itemId);
                return (
                  <div key={itemId}>
                    <ItemHoverCard itemId={itemId}><ItemGlyph itemId={itemId} /></ItemHoverCard>
                    <span>{item.name}</span><strong>+<QuantityValue value={amount} /></strong>
                  </div>
                );
              })}
            </div>
          </section> : null}
          {report.completedTechIds.length > 0 ? <section>
            <header><FlaskConical size={15} /><span>科研完成</span><strong>{report.completedTechIds.length}</strong></header>
            <div className="offline-tech-list">
              {report.completedTechIds.map((techId) => (
                <span key={techId}><CheckCircle2 size={13} />{getTechnology(techId)?.name ?? techId}</span>
              ))}
            </div>
          </section> : null}
          {report.structurePointsAdded > 0 || report.shellSailsAdded > 0 ? <section>
            <header><Orbit size={15} /><span>戴森工程</span></header>
            <dl>
              <div><dt>永久结构点</dt><dd>+<QuantityValue value={report.structurePointsAdded} /></dd></div>
              <div><dt>壳面吸附帆</dt><dd>+<QuantityValue value={report.shellSailsAdded} /></dd></div>
            </dl>
          </section> : null}
          {infiniteResearchLevels.length > 0 ? <section>
            <header><Sparkles size={15} /><span>无限科研</span><strong>{infiniteResearchLevels.length}</strong></header>
            <div className="offline-tech-list">
              {infiniteResearchLevels.map(({ id, level }) => <span key={id}><CheckCircle2 size={13} />{id} +{level} 级</span>)}
            </div>
          </section> : null}
          {exported.length > 0 || galacticCreditsAdded > 0 ? <section>
            <header><Send size={15} /><span>银河出口</span><strong><QuantityValue value={galacticCreditsAdded} unit="信用" /></strong></header>
            <div className="offline-tech-list">
              {exported.map(({ projectId, amount }) => <span key={projectId}><Send size={13} />{projectId} +<QuantityValue value={amount} /></span>)}
            </div>
          </section> : null}
          {returningReward.length > 0 ? <section className="offline-returning-reward">
            <header><Gift size={15} /><span>回归补给</span><strong>72h+</strong></header>
            <div className="offline-production-list">{returningReward.map(({ itemId, amount }) => <div key={itemId}><ItemHoverCard itemId={itemId}><ItemGlyph itemId={itemId} /></ItemHoverCard><span>{getItem(itemId).name}</span><strong>+<QuantityValue value={amount} /></strong></div>)}</div>
          </section> : null}
        </div>
      ) : (
        <div className="offline-report-empty"><CheckCircle2 size={26} /><strong>离线期间网络保持稳定</strong><span>没有新增物资、科技或戴森结构</span></div>
      )}
      <footer><button type="button" onClick={onClose}><CheckCircle2 size={15} />确认结算</button></footer>
    </section>
  );
}
