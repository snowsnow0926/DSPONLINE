import { Cpu } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  getDesktopBridge,
  type DesktopBridge,
  type DesktopNativeCoreThreadSetting,
  type DesktopNativePerformanceMode,
  type DesktopNativePerformancePolicy,
  type DesktopNativePerformancePolicyStatus,
} from "../desktop";
import { useAppLocale, type AppLocale } from "../i18n/locale";

const MODES: DesktopNativePerformanceMode[] = ["quiet", "balanced", "performance", "custom"];
const THREAD_SETTINGS: DesktopNativeCoreThreadSetting[] = ["auto", 1, 2, 4, 8];

export function nativePerformancePolicyCopy(locale: AppLocale) {
  if (locale === "en") return {
    title: "Windows native core thread policy",
    loading: "Loading device policy",
    unavailable: "Policy status unavailable",
    save: "Save policy",
    saving: "Saving…",
    saved: "Policy saved",
    loadFailed: "Could not read the Windows native thread policy",
    saveFailed: "Could not save the Windows native thread policy",
    modeGroup: "Native core performance policy",
    customGroup: "Custom native core threads",
    logicalCpu: "Available logical CPUs",
    effective: "Current actual setting",
    requested: "Requested policy",
    configuration: "Configuration",
    configurationStates: {
      default: "Default",
      loaded: "Loaded",
      invalid: "Damaged · safe fallback",
      saved: "Saved",
    },
    invalid: "The policy file was damaged or contained unsupported fields. This launch safely uses Balanced / auto; saving creates a clean versioned policy.",
    restart: "Saved for the next full app restart. The current native host will not restart and the current session will not roll back.",
    noRestart: "The requested thread setting already matches the current native host.",
    help: "Changes take effect only after a full app restart. Saving never restarts the current native host, switches checkpoints, or rolls back the current session.",
    modes: {
      quiet: "Quiet",
      balanced: "Balanced",
      performance: "Performance",
      custom: "Custom",
    },
  } as const;
  return {
    title: "Windows 原生核心线程策略",
    loading: "正在读取本机策略",
    unavailable: "无法读取策略状态",
    save: "保存策略",
    saving: "正在保存…",
    saved: "策略已保存",
    loadFailed: "无法读取 Windows 原生线程策略",
    saveFailed: "无法保存 Windows 原生线程策略",
    modeGroup: "原生核心性能策略",
    customGroup: "自定义原生核心线程",
    logicalCpu: "可用逻辑 CPU",
    effective: "当前实际设置",
    requested: "请求策略",
    configuration: "配置状态",
    configurationStates: {
      default: "默认值",
      loaded: "已读取",
      invalid: "配置损坏 · 已安全回退",
      saved: "已保存",
    },
    invalid: "策略文件损坏或包含不支持的字段。本次启动已安全回退到“平衡 / auto”；保存后会生成干净的版本化策略。",
    restart: "已保存，等待下次完整重启应用生效。当前原生服务不会重启，当前会话也不会回档。",
    noRestart: "请求的线程设置已经与当前原生服务一致。",
    help: "修改只会在下次完整重启应用后生效。保存不会重启当前原生服务、切换检查点或回退当前会话。",
    modes: {
      quiet: "安静",
      balanced: "平衡",
      performance: "性能",
      custom: "自定义",
    },
  } as const;
}

function supportedPolicyBridge(bridge: DesktopBridge | null): bridge is DesktopBridge {
  return Boolean(bridge && typeof bridge.getReleaseInfo === "function" &&
    typeof bridge.getNativePerformancePolicy === "function" &&
    typeof bridge.setNativePerformancePolicy === "function");
}

function policyLabel(
  policy: DesktopNativePerformancePolicy,
  modes: Record<DesktopNativePerformanceMode, string>,
): string {
  return policy.mode === "custom"
    ? `${modes.custom} / ${policy.customThreads}`
    : modes[policy.mode];
}

export function WindowsNativePerformancePolicySetting() {
  const { locale } = useAppLocale();
  const copy = useMemo(() => nativePerformancePolicyCopy(locale), [locale]);
  const bridge = getDesktopBridge();
  const supported = supportedPolicyBridge(bridge);
  const [status, setStatus] = useState<DesktopNativePerformancePolicyStatus | null>(null);
  const [windowsDesktop, setWindowsDesktop] = useState(false);
  const [draft, setDraft] = useState<DesktopNativePerformancePolicy>({ mode: "balanced" });
  const [pending, setPending] = useState<"loading" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let active = true;
    setPending("loading");
    setError(null);
    void bridge.getReleaseInfo().then((releaseInfo) => {
      if (!active || releaseInfo.platform !== "win32") return null;
      setWindowsDesktop(true);
      return bridge.getNativePerformancePolicy();
    }).then((next) => {
      if (next === null) {
        if (active) setPending(null);
        return;
      }
      if (!active) return;
      setStatus(next);
      setDraft(next.requestedPolicy);
      setPending(null);
    }).catch((loadError: unknown) => {
      if (!active) return;
      setError(`${copy.loadFailed}：${loadError instanceof Error ? loadError.message : copy.unavailable}`);
      setPending(null);
    });
    return () => { active = false; };
  }, [bridge, copy.loadFailed, copy.unavailable, supported]);

  if (!supported || !windowsDesktop) return null;

  const selectMode = (mode: DesktopNativePerformanceMode) => {
    setSaved(false);
    setError(null);
    setDraft(mode === "custom" ? { mode: "custom", customThreads: "auto" } : { mode });
  };
  const save = async () => {
    setPending("saving");
    setSaved(false);
    setError(null);
    try {
      const next = await bridge.setNativePerformancePolicy(draft);
      setStatus(next);
      setDraft(next.requestedPolicy);
      setSaved(true);
    } catch (saveError) {
      setError(`${copy.saveFailed}：${saveError instanceof Error ? saveError.message : copy.unavailable}`);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="settings-panel settings-native-performance-policy-panel">
      <section className="settings-group settings-native-performance-policy" data-settings-category="performance">
        <header>
          <Cpu size={14} />
          <span>{copy.title}</span>
          <small>{pending === "loading" ? copy.loading : status ? copy.configurationStates[status.configurationState] : copy.unavailable}</small>
        </header>
        <div className="settings-native-policy-controls">
          <div className="settings-segmented" role="radiogroup" aria-label={copy.modeGroup}>
            {MODES.map((mode) => <button
              type="button"
              key={mode}
              className={draft.mode === mode ? "active" : ""}
              aria-pressed={draft.mode === mode}
              data-policy-mode={mode}
              onClick={() => selectMode(mode)}
            >{copy.modes[mode]}</button>)}
          </div>
          {draft.mode === "custom" ? <div className="settings-segmented" role="radiogroup" aria-label={copy.customGroup}>
            {THREAD_SETTINGS.map((threadSetting) => <button
              type="button"
              key={threadSetting}
              className={draft.customThreads === threadSetting ? "active" : ""}
              aria-pressed={draft.customThreads === threadSetting}
              data-policy-threads={threadSetting}
              onClick={() => { setSaved(false); setError(null); setDraft({ mode: "custom", customThreads: threadSetting }); }}
            >{threadSetting}</button>)}
          </div> : null}
          {status ? <div className="settings-native-policy-status" aria-live="polite">
            <span><small>{copy.logicalCpu}</small><strong>{status.logicalCpuCount}</strong></span>
            <span data-effective-thread-setting={status.effectivePolicy.threadSetting}><small>{copy.effective}</small><strong>{status.effectivePolicy.threadSetting}</strong></span>
            <span><small>{copy.requested}</small><strong>{policyLabel(status.requestedPolicy, copy.modes)}</strong></span>
            <span><small>{copy.configuration}</small><strong>{copy.configurationStates[status.configurationState]}</strong></span>
          </div> : null}
          <button
            className="settings-native-policy-save"
            type="button"
            disabled={!status || pending !== null}
            onClick={() => void save()}
          >{pending === "saving" ? copy.saving : copy.save}</button>
        </div>
        {status?.configurationState === "invalid" ? <p className="settings-warning" role="alert">{copy.invalid}</p> : null}
        {saved && status ? <p className={status.restartRequired ? "settings-warning" : "settings-help"} role="status">
          {status.restartRequired ? copy.restart : copy.noRestart}
        </p> : null}
        {error ? <p className="settings-buffer-error" role="alert">{error}</p> : null}
        <p className="settings-help">{copy.help}</p>
      </section>
    </div>
  );
}
