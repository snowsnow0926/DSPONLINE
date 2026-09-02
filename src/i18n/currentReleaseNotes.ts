import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-09-02-v1.2.7",
    date: english ? "September 2, 2026" : "2026年9月2日",
    version: "1.2.7",
    title: english ? "Windows Native Performance Integration and Large-save Memory Improvements" : "Windows 原生性能整合与大存档内存优化",
    summary: english
      ? "Version 1.2.7 uses the week-long Windows/Rust native worktree as its baseline and keeps all 1.2.6 endgame settlement and planet-factory reset behavior. The 1.2.6 code, tests, and compatibility fixes are integrated into the native candidate rather than rebuilding the Web edition. Windows remains an unsigned local candidate; GameState v47, save envelope v2, cloud schema v8, and SQLite layout v3 remain compatible."
      : "1.2.7 以已经完成一周开发的 Windows/Rust 原生工作树为基线，完整保留 1.2.6 的终局直结和星球工厂重置；同时把 1.2.6 的代码、测试和兼容性修复合入原生候选，不重新开发网页版本。Windows 仍是未签名本地候选，GameState v47、存档 envelope v2、cloud schema v8 与 SQLite layout v3 保持兼容。",
    items: [
      {
        id: "v127-126-native-integration",
        title: english ? "1.2.6 behavior is retained in the native candidate" : "1.2.6 功能原样进入原生候选",
        description: english
          ? "Rate replication still settles only white-matrix research and per-system Dyson outcomes, while the star-map reset keeps its three confirmations and preserves natural resources and global progress. No player save is silently rewritten or numerically reduced."
          : "产率复制仍只直结白矩阵科研和逐恒星系戴森成果；星图重置仍要求三次确认并保留天然资源与全局进度。没有静默修改玩家存档或降低历史数值。",
      },
      {
        id: "v127-native-boundaries",
        title: english ? "The Rust native candidate keeps deterministic boundaries" : "Rust 原生候选继续使用确定性边界",
        description: english
          ? "The native worktree continues to provide authoritative state, incremental persistence, event-driven logistics, thin-UI projections, and streaming v47 export on Windows. It is not presented as a stable authoritative build before multi-hardware and long-run gates pass."
          : "Windows 的权威状态、增量保存、事件物流、薄 UI 投影和 v47 流式导出继续由原生工作树提供；未经多硬件和长时门禁前不会宣称为稳定权威版本。",
      },
      {
        id: "v127-bounded-thread-stack",
        title: english ? "Concurrent tests and Workers use bounded stacks" : "并发测试与 Worker 线程使用有界栈",
        description: english
          ? "Deep save parsing could hit access violations on Windows with small default thread stacks. Native Rayon and reclaimer threads now use a bounded 4 MiB stack while retaining deterministic commit order and gameplay rules."
          : "Windows 默认线程栈较小时，深层存档解析可能导致访问冲突；原生 Rayon 与回收线程统一使用 4 MiB 有界栈，并保留确定性提交顺序，不改变游戏规则。",
      },
      {
        id: "v127-transferable-save-inspection",
        title: english ? "Large-save inspection uses transferable bytes" : "大存档检查改用可转移字节",
        description: english
          ? "Local JSON or gzip saves now reach the inspection Worker as bounded UTF-8 bytes. The successful path no longer keeps a full UTF-16 payload on the UI thread; length or hash mismatches fall back to the original file without overwriting it."
          : "本地 JSON 或 gzip 存档先以有界 UTF-8 字节交给检查 Worker，成功路径不再在界面线程保留一份完整 UTF-16 正文；长度和哈希不匹配会回退到原始文件，不覆盖玩家文件。",
      },
      {
        id: "v127-compatibility-boundary",
        title: english ? "Protocol and save boundaries remain compatible" : "协议与存档边界保持兼容",
        description: english
          ? "This candidate does not upgrade GameState, the envelope, cloud schema, or SQLite layout. The 1.2.6 online stable release and production services are unaffected by this development tree."
          : "本候选不升级 GameState、envelope、云 schema 或 SQLite layout；1.2.6 的线上稳定版和生产服务不受这棵开发树影响。",
      },
    ],
  } as const;
}
