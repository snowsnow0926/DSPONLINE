import type { AppLocale } from "./locale";

/**
 * The start menu only needs the current release summary. Keep it in a small
 * eager module so the historical release archive stays behind the dialog's
 * lazy boundary and does not inflate the first menu render.
 */
export function getCurrentReleaseNotes(locale: AppLocale) {
  const english = locale === "en";
  return {
    id: "2026-08-27-v1.2.1",
    date: english ? "August 27, 2026" : "2026年8月27日",
    version: "1.2.1",
    title: english ? "Windows Large-save Performance Optimization" : "Windows 大型存档性能优化",
    summary: english
      ? "Version 1.2.1 improves large-save cold start, state summaries, and transactional memory in the Windows native core, and lets repeated incremental saves of the same authoritative revision reuse verified chunks. Windows packaging rejects Android build residue. JavaScript remains authoritative; existing v47 / envelope v2 saves remain compatible."
      : "1.2.1 优化 Windows 原生核心的大型存档冷启动、状态摘要与事务内存，并让同一权威 revision 的重复增量保存直接复用已验证区块。Windows 打包会拒绝混入 Android 构建残留；JavaScript 仍是权威，旧版 v47 / envelope v2 存档继续兼容。",
    items: [
      {
        id: "native-large-save-open",
        title: english ? "Native large-save cold start avoids repeated parsing" : "大型存档原生冷启动减少重复解析",
        description: english
          ? "Native recovery checks the newest valid generation first and validates chunks in batches. Parsed entity and belt records are reused for indexes and route preparation, reducing startup CPU and peak memory."
          : "原生存档恢复按最新有效代际优先读取，并批量校验区块；实体、线路解析结果直接复用于索引和路由准备，减少启动 CPU 与峰值内存。",
      },
      {
        id: "native-summary-cache",
        title: english ? "Native state summaries use one fused scan" : "原生状态摘要合并为单次扫描",
        description: english
          ? "Canonical hashes, component hashes, field counts, and diagnostics share one entity/belt pass and are cached by revision, so repeated diagnostics no longer rescan the whole factory."
          : "规范哈希、组件哈希、字段计数与诊断摘要共享一次实体/线路遍历，并按 revision 缓存结果；重复诊断不再反复扫描整个工厂。",
      },
      {
        id: "native-transaction-memory",
        title: english ? "Transactional commands share unchanged native records" : "事务命令共享未变化的原生记录",
        description: english
          ? "Native candidate states share immutable records and allocate only changed entries. Top-level-only commands such as pause no longer rebuild every index."
          : "原生候选状态使用不可变共享记录，只有实际变化的条目才分配新内存；仅修改顶层状态的暂停等命令不再重建全部索引。",
      },
      {
        id: "unchanged-save-reuse",
        title: english ? "Unchanged revisions reuse verified save chunks" : "未变化 revision 的保存复用已验证区块",
        description: english
          ? "When the authoritative Worker revision, record counts, and committed manifest match exactly, a repeated checkpoint writes only the top-level manifest. New active-simulation revisions still use the full deterministic chunked-save path."
          : "当 Worker 权威 revision、记录数量与已提交清单完全一致时，重复检查点只提交顶层清单；活跃模拟产生的新 revision 仍走完整的确定性分块保存。",
      },
      {
        id: "windows-package-hygiene",
        title: english ? "Windows packages reject Android build residue" : "Windows 包拒绝 Android 构建残留",
        description: english
          ? "Desktop packaging explicitly excludes Capacitor Android Gradle output and validates both asar and unpacked content, preventing cross-platform build order from inflating Windows packages."
          : "桌面打包显式排除 Capacitor Android 的 Gradle 输出，并在生成后检查 asar 与解包目录，避免跨平台构建顺序让 Windows 安装包无故膨胀。",
      },
      {
        id: "native-authority-boundary",
        title: english ? "Native authority cutover remains disabled" : "原生接管仍保持关闭",
        description: english
          ? "JavaScript remains the sole authority and the native core stays in shadow validation. Existing saves are not rewritten, and the multi-hardware 24-hour Gate C is not claimed complete."
          : "本版继续以 JavaScript 为唯一权威，原生核心只做影子校验；没有改写旧存档，也没有宣称完成多硬件 24 小时 Gate C。",
      },
    ],
  } as const;
}
