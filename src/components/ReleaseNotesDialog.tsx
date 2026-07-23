import {
  BookOpen,
  Check,
  Database,
  Factory,
  Gauge,
  Info,
  MessageCircle,
  Orbit,
  Route,
  Smartphone,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";

export const RELEASE_NOTES_SEEN_KEY = "dsp-idle-network.release-notes.seen.v1";

export const CURRENT_RELEASE_NOTES = {
  id: "2026-07-23-v0.7.0",
  date: "2026年7月23日",
  version: "0.7.0",
  title: "双向物流与工厂管理更新",
  summary: "本次更新补齐供给端送货与需求端取货，加入逐行星视角、亮色主题、递归建筑制造和堆叠容量，并统一主工作区的再次点击关闭行为。现有存档会自动迁移到 v31，库存、线路、科研和戴森进度保持不变。",
  items: [
    {
      id: "bidirectional-logistics",
      title: "供需双向物流调度",
      description: "行星与星际物流站现在都能由供给端主动送货或需求端主动取货。载具归属、占用、返航、供电和翘曲器消耗按真实所属站结算，不会重复派遣或重复预留货物。",
    },
    {
      id: "planet-viewports",
      title: "每颗行星记住画布视角",
      description: "离开行星时会分别保存画布中心和缩放，返回后恢复上次观察位置。书签、设备定位和线路诊断仍会优先跳到明确目标。",
    },
    {
      id: "light-theme",
      title: "亮色与跟随系统主题",
      description: "设置新增深色、亮色和跟随系统模式，覆盖工厂画布、建筑、线路标签、科技树、统计、弹窗、手机界面和原生表单。已有玩家继续默认使用深色主题。",
    },
    {
      id: "construction-recursion",
      title: "建筑制造中心递归生产",
      description: "制造建筑时会自动加工缺少的可制造中间材料，原矿仍需玩家提供。界面会显示当前加工阶段、进度、预计时间与具体缺料原因。",
    },
    {
      id: "sorter-retirement",
      title: "传送带直接承担物流等级",
      description: "移除没有实际摆放作用的分拣器施工件、制造项和图鉴入口。旧存档中的分拣器库存会等量转换为对应等级传送带，已有线路不会被删除。",
    },
    {
      id: "technology-layout",
      title: "科技树标准与精简布局",
      description: "科技树可切换标准或精简模式，在保留名称、状态、矩阵成本和前置关系的同时展示更多科技。手机端继续保证关闭按钮和滚动区域可用。",
    },
    {
      id: "workspace-toggle",
      title: "主工作区再次点击即可关闭",
      description: "设置、星图、科技、资料库、统计、银河、任务等入口再次点击当前按钮会返回工厂画布；蓝图、戴森规划、网络和新版手机导航使用相同规则。",
    },
    {
      id: "stacked-capacity",
      title: "堆叠建筑容量同步增长",
      description: "生产、仓储和物流建筑的输入、输出、燃料、物流槽、载具与翘曲器容量会随堆叠数量增长。减少堆叠时保留已有超额库存并暂停继续输入。",
    },
    {
      id: "station-auto-slots",
      title: "物流塔后续空槽自动识别",
      description: "后续传送带会优先复用相同物品槽，否则依次使用第一个空槽，不覆盖玩家手动配置。空槽已满、物品冲突或方向错误时会显示具体原因。",
    },
  ],
} as const;

const RELEASE_NOTE_ICONS: Record<(typeof CURRENT_RELEASE_NOTES.items)[number]["id"], LucideIcon> = {
  "bidirectional-logistics": Route,
  "planet-viewports": Orbit,
  "light-theme": Gauge,
  "construction-recursion": Factory,
  "sorter-retirement": Check,
  "technology-layout": BookOpen,
  "workspace-toggle": Smartphone,
  "stacked-capacity": Database,
  "station-auto-slots": Route,
};

export function hasSeenCurrentReleaseNotes(): boolean {
  try {
    return window.localStorage.getItem(RELEASE_NOTES_SEEN_KEY) === CURRENT_RELEASE_NOTES.id;
  } catch {
    try { return window.sessionStorage.getItem(RELEASE_NOTES_SEEN_KEY) === CURRENT_RELEASE_NOTES.id; } catch { return false; }
  }
}

export function markCurrentReleaseNotesSeen(): void {
  try {
    window.localStorage.setItem(RELEASE_NOTES_SEEN_KEY, CURRENT_RELEASE_NOTES.id);
  } catch {
    try { window.sessionStorage.setItem(RELEASE_NOTES_SEEN_KEY, CURRENT_RELEASE_NOTES.id); } catch { /* optional preference */ }
  }
}

export function ReleaseNotesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    const syncVisualViewport = () => {
      const viewport = window.visualViewport;
      const height = Math.max(240, viewport?.height ?? window.innerHeight);
      backdropRef.current?.style.setProperty("--release-notes-viewport-height", `${Math.round(height)}px`);
    };
    syncVisualViewport();
    window.addEventListener("resize", syncVisualViewport);
    window.visualViewport?.addEventListener("resize", syncVisualViewport);
    window.visualViewport?.addEventListener("scroll", syncVisualViewport);
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", syncVisualViewport);
      window.visualViewport?.removeEventListener("resize", syncVisualViewport);
      window.visualViewport?.removeEventListener("scroll", syncVisualViewport);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div ref={backdropRef} className="release-notes-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="release-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="release-notes-title">
        <header className="release-notes-header">
          <span className="release-notes-version"><small>VERSION</small><strong>{CURRENT_RELEASE_NOTES.version}</strong></span>
          <div><small>{CURRENT_RELEASE_NOTES.date} · 公开测试版</small><h2 id="release-notes-title">{CURRENT_RELEASE_NOTES.title}</h2></div>
          <button ref={closeButtonRef} type="button" onClick={onClose} title="关闭版本更新记录" aria-label="关闭版本更新记录"><X size={18} /></button>
        </header>
        <p className="release-notes-summary"><Info size={16} /><span>{CURRENT_RELEASE_NOTES.summary}</span></p>
        <div className="release-notes-scroll">
          <ol>
            {CURRENT_RELEASE_NOTES.items.map((item, index) => {
              const Icon = RELEASE_NOTE_ICONS[item.id];
              return (
                <li key={item.id}>
                  <i><Icon size={18} /><em>{String(index + 1).padStart(2, "0")}</em></i>
                  <span><strong>{item.title}</strong><p>{item.description}</p></span>
                </li>
              );
            })}
          </ol>
        </div>
        <footer className="release-notes-footer">
          <span><MessageCircle size={15} /><small>QQ 交流群</small><strong>1076757280</strong></span>
          <button type="button" onClick={onClose}><Check size={16} />我知道了</button>
        </footer>
      </section>
    </div>
  );
}
