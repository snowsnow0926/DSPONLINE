import { Check, CircleDot, ClipboardCopy, ClipboardPaste, Gauge, GitBranch, Layers3, LockKeyhole, Orbit, Pause, Play, Plus, RadioTower, Rocket, Save, Sparkles, Sun, Trash2, X, Zap } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { STAR_SYSTEM_LIST, getPlanet, getStarSystem } from "../game/content";
import { createDysonLayerTemplate, getDysonEngineeringSnapshot, getDysonPlanTotals, isStarSystemUnlocked, isTechnologyCompleted, type DysonLayerTemplate } from "../game/engine";
import { getStarSystemProfile } from "../game/galaxy";
import type { DysonLayerState, DysonLaunchMode, DysonLaunchThrottle, GameState, StarSystemId } from "../game/types";
import { QuantityValue } from "./QuantityValue";
import { PowerValue } from "./PowerValue";
import { WorkspaceFrame } from "./WorkspaceFrame";
import { formatQuantityCompact, formatQuantityExact } from "../game/quantityFormat";
import type { NativeDysonWorkspaceFrame, NativeDysonWorkspaceIdentity } from "../game/nativeDysonWorkspaceStore";

const VIEW_CENTER = 300;

function pointAt(angle: number, radius: number) {
  const radians = (angle - 90) * Math.PI / 180;
  return { x: Math.cos(radians) * radius, y: Math.sin(radians) * radius };
}

function angularDistance(source: number, target: number): number {
  const direct = ((target - source) % 360 + 360) % 360;
  return direct || 360;
}

function shellPath(layer: DysonLayerState, sourceAngle: number, targetAngle: number, radius: number): string {
  const source = pointAt(sourceAngle, radius);
  const target = pointAt(targetAngle, radius);
  const distance = angularDistance(sourceAngle, targetAngle);
  return `M 0 0 L ${source.x.toFixed(2)} ${source.y.toFixed(2)} A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${distance > 180 ? 1 : 0} 1 ${target.x.toFixed(2)} ${target.y.toFixed(2)} Z`;
}

export function DysonPlannerWorkspace({
  open,
  game,
  onClose,
  onSave,
  onAddLayer,
  onAddStandardLayer,
  onSelectLayer,
  onOrbitChange,
  onRemoveLayer,
  onPasteLayer,
  onAddNode,
  onRemoveNode,
  onConnectNodes,
  onAutoConnect,
  onPlanShell,
  onClearShell,
  onLaunchModeChange,
  onLaunchThrottleChange,
  onLaunchEnabledChange,
  onAddSwarmOrbit,
  onSelectSwarmOrbit,
  onSwarmOrbitChange,
  onRemoveSwarmOrbit,
}: {
  open: boolean;
  game: GameState;
  onClose: () => void;
  onSave: () => Promise<{ success: boolean; message: string }>;
  onAddLayer: (systemId: StarSystemId) => void;
  onAddStandardLayer: (systemId: StarSystemId) => void;
  onSelectLayer: (systemId: StarSystemId, layerId: string) => void;
  onOrbitChange: (systemId: StarSystemId, layerId: string, orbit: { radius?: number; inclination?: number; longitude?: number }) => void;
  onRemoveLayer: (systemId: StarSystemId, layerId: string) => void;
  onPasteLayer: (systemId: StarSystemId, template: DysonLayerTemplate) => void;
  onAddNode: (systemId: StarSystemId, layerId: string, angle: number) => void;
  onRemoveNode: (systemId: StarSystemId, layerId: string, nodeId: string) => void;
  onConnectNodes: (systemId: StarSystemId, layerId: string, sourceNodeId: string, targetNodeId: string) => void;
  onAutoConnect: (systemId: StarSystemId, layerId: string) => void;
  onPlanShell: (systemId: StarSystemId, layerId: string) => void;
  onClearShell: (systemId: StarSystemId, layerId: string) => void;
  onLaunchModeChange: (mode: DysonLaunchMode) => void;
  onLaunchThrottleChange: (throttle: DysonLaunchThrottle) => void;
  onLaunchEnabledChange: (enabled: boolean) => void;
  onAddSwarmOrbit: (systemId: StarSystemId) => void;
  onSelectSwarmOrbit: (systemId: StarSystemId, orbitId: string) => void;
  onSwarmOrbitChange: (systemId: StarSystemId, orbitId: string, changes: { radius?: number; inclination?: number; longitude?: number }) => void;
  onRemoveSwarmOrbit: (systemId: StarSystemId, orbitId: string) => void;
}) {
  const activePlanetSystem = getPlanet(game.activePlanetId).systemId;
  const [systemId, setSystemId] = useState<StarSystemId>(activePlanetSystem);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [layerClipboard, setLayerClipboard] = useState<DysonLayerTemplate | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{ message: string; error: boolean } | null>(null);
  useEffect(() => {
    if (open) setSystemId(activePlanetSystem);
  }, [activePlanetSystem, open]);
  useEffect(() => setSelectedNodeId(null), [systemId]);
  const plan = game.dysonPlans[systemId];
  const swarmOrbits = game.dysonEngineering.orbitsBySystem[systemId] ?? [];
  const activeSwarmOrbit = swarmOrbits.find((orbit) => orbit.id === game.dysonEngineering.activeOrbitBySystem[systemId]) ?? swarmOrbits[0] ?? null;
  const engineering = getDysonEngineeringSnapshot(game, systemId);
  const starProfile = getStarSystemProfile(game, systemId);
  const activeLayer = plan.layers.find((layer) => layer.id === plan.activeLayerId) ?? plan.layers[0] ?? null;
  const totals = getDysonPlanTotals(plan);
  const programReady = isTechnologyCompleted(game, "dyson_sphere_program");
  const shellReady = isTechnologyCompleted(game, "dyson_shell");
  const maximumRadius = Math.max(50_000, ...plan.layers.map((layer) => layer.radius), ...swarmOrbits.map((orbit) => orbit.radius));
  const visualRadiusByLayer = useMemo(() => new Map(plan.layers.map((layer) => [
    layer.id,
    76 + layer.radius / maximumRadius * 190,
  ])), [maximumRadius, plan.layers]);
  const visualRadiusBySwarmOrbit = useMemo(() => new Map(swarmOrbits.map((orbit) => [
    orbit.id,
    64 + orbit.radius / maximumRadius * 176,
  ])), [maximumRadius, swarmOrbits]);

  if (!open) return null;

  const addNodeFromCanvas = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (!activeLayer || !programReady) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * 600 - VIEW_CENTER;
    const y = (event.clientY - bounds.top) / bounds.height * 600 - VIEW_CENTER;
    const angle = (Math.atan2(y, x) * 180 / Math.PI + 90 + 360) % 360;
    onAddNode(systemId, activeLayer.id, angle);
  };

  return (
    <WorkspaceFrame className="dyson-planner-workspace" ariaLabel="戴森球规划" onRequestClose={onClose}>
      <header className="dyson-planner-header">
        <div className="dyson-planner-title"><i><Orbit size={20} /></i><div><span>恒星巨构设计协议</span><strong>戴森球规划</strong></div></div>
        <div className="dyson-planner-headline">
          <span>恒星 <strong>{starProfile.starTypeName} · {starProfile.luminosity.toFixed(2)} L☉</strong></span>
          <span>结构 <strong><QuantityValue value={plan.structurePoints} /></strong></span>
          <span>壳面帆 <strong><QuantityValue value={plan.shellSails} /></strong></span>
          <span>本系功率 <strong><PowerValue valueKw={engineering.projectedGenerationKw} /></strong></span>
        </div>
        <div className="dyson-planner-commandbar" role="toolbar" aria-label="戴森球规划命令">
          <button type="button" disabled={!activeLayer} onClick={() => activeLayer && setLayerClipboard(createDysonLayerTemplate(activeLayer))} title="复制当前壳层设计" aria-label="复制当前壳层设计"><ClipboardCopy size={17} /><span>复制</span></button>
          <button type="button" disabled={!layerClipboard || !programReady || plan.layers.length >= 8} onClick={() => layerClipboard && onPasteLayer(systemId, layerClipboard)} title="粘贴壳层副本" aria-label="粘贴壳层副本"><ClipboardPaste size={17} /><span>粘贴</span></button>
          <button type="button" onClick={() => {
            void onSave().then((result) => setSaveFeedback({ message: result.message, error: !result.success }));
          }} title="保存主存档" aria-label="保存主存档"><Save size={17} /><span>保存</span></button>
          <button type="button" onClick={onClose} title="关闭戴森球规划" aria-label="关闭戴森球规划"><X size={18} /><span>关闭</span></button>
        </div>
        {saveFeedback ? <div className={`dyson-planner-save-feedback${saveFeedback.error ? " error" : ""}`} role={saveFeedback.error ? "alert" : "status"}>{saveFeedback.message}</div> : null}
      </header>

      <div className="dyson-planner-layout">
        <aside className="dyson-plan-sidebar">
          <div className="dyson-system-tabs" aria-label="戴森球恒星系">
            {STAR_SYSTEM_LIST.filter((system) => isStarSystemUnlocked(game, system.id)).map((system) => (
              <button className={systemId === system.id ? "active" : ""} type="button" key={system.id} onClick={() => setSystemId(system.id)} title={`规划${system.name}戴森球`}>
                <i style={{ color: system.color }}><Sparkles size={14} /></i><span><strong>{system.name}</strong><small>{getStarSystemProfile(game, system.id).starTypeName} · {getStarSystemProfile(game, system.id).luminosity.toFixed(2)} L☉</small></span>
              </button>
            ))}
          </div>
          <div className="dyson-layer-heading"><span>壳层</span><strong>{plan.layers.length}/8</strong></div>
          <div className="dyson-layer-list">
            {plan.layers.map((layer, index) => {
              const layerStructure = layer.nodes.reduce((sum, node) => sum + node.requiredStructurePoints, 0) + layer.frames.reduce((sum, frame) => sum + frame.requiredStructurePoints, 0);
              const completed = layer.nodes.reduce((sum, node) => sum + node.completedStructurePoints, 0) + layer.frames.reduce((sum, frame) => sum + frame.completedStructurePoints, 0);
              return (
                <button className={activeLayer?.id === layer.id ? "active" : ""} type="button" key={layer.id} onClick={() => { onSelectLayer(systemId, layer.id); setSelectedNodeId(null); }}>
                  <b>{String(index + 1).padStart(2, "0")}</b><span><strong>{layer.name}</strong><small>{layer.radius.toLocaleString("zh-CN")} m · {layer.nodes.length} 节点</small></span><em title={`${formatQuantityExact(completed)} / ${formatQuantityExact(layerStructure)}`}>{formatQuantityCompact(completed)}/{formatQuantityCompact(layerStructure)}</em>
                </button>
              );
            })}
            {plan.layers.length === 0 ? <div className="dyson-layer-empty"><Orbit size={18} /><span>尚无壳层方案</span></div> : null}
          </div>
          <div className="dyson-layer-commands">
            <button type="button" disabled={!programReady || plan.layers.length >= 8} onClick={() => onAddLayer(systemId)} title="新建空白壳层"><Plus size={14} />空白层</button>
            <button type="button" disabled={!programReady || plan.layers.length >= 8} onClick={() => onAddStandardLayer(systemId)} title="新建八节点闭合标准壳层"><Layers3 size={14} />标准层</button>
          </div>
          <div className="dyson-layer-heading dyson-swarm-heading"><span>太阳帆轨道</span><strong>{swarmOrbits.length}/8</strong></div>
          <div className="dyson-swarm-orbit-list">
            {swarmOrbits.map((orbit, index) => (
              <button className={activeSwarmOrbit?.id === orbit.id ? "active" : ""} type="button" key={orbit.id} onClick={() => onSelectSwarmOrbit(systemId, orbit.id)}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <span><strong>{orbit.name}</strong><small>{orbit.radius.toLocaleString("zh-CN")} m · {orbit.inclination}°</small></span>
                <em title={`${formatQuantityExact(orbit.sailsInOrbit)} 帆`}>{formatQuantityCompact(orbit.sailsInOrbit)} 帆</em>
              </button>
            ))}
          </div>
          <button className="dyson-add-swarm-orbit" type="button" disabled={!isTechnologyCompleted(game, "dyson_swarm") || swarmOrbits.length >= 8} onClick={() => onAddSwarmOrbit(systemId)}><Plus size={14} />新增太阳帆轨道</button>
        </aside>

        <section className="dyson-orbit-stage">
          <div className="dyson-stage-summary">
            <span><CircleDot size={13} />节点 <strong>{totals.nodeCount}</strong></span>
            <span><GitBranch size={13} />框架 <strong>{totals.frameCount}</strong></span>
            <span><Layers3 size={13} />壳面 <strong>{totals.shellCount}</strong></span>
            <span><Rocket size={13} />施工 <strong><QuantityValue value={totals.completedStructure} />/<QuantityValue value={totals.plannedStructure} /></strong></span>
            <span><Sun size={13} />在轨 <strong><QuantityValue value={engineering.orbitSails} /></strong></span>
            <span><Gauge size={13} />理论接收 <strong>{Math.round(engineering.theoreticalReceptionRate * 100)}%</strong></span>
            <span><RadioTower size={13} />接收站 <strong>{Math.round(engineering.receiverUtilization * 100)}%</strong></span>
          </div>
          <svg className="dyson-orbit-canvas" viewBox="0 0 600 600" role="img" aria-label={`${getStarSystem(systemId).name}戴森球轨道图`} onClick={addNodeFromCanvas}>
            <circle className="dyson-star-halo" cx={VIEW_CENTER} cy={VIEW_CENTER} r={Math.max(34, Math.min(58, 38 + Math.log2(Math.max(0.1, starProfile.luminosity)) * 5))} />
            <circle className="dyson-star-core" cx={VIEW_CENTER} cy={VIEW_CENTER} r={Math.max(14, Math.min(34, 22 + Math.log2(Math.max(0.1, starProfile.radiusMultiplier)) * 4))} style={{ color: getStarSystem(systemId).color }} />
            {swarmOrbits.map((orbit) => {
              const radius = visualRadiusBySwarmOrbit.get(orbit.id) ?? 90;
              const scaleY = 0.48 + Math.abs(Math.cos(orbit.inclination * Math.PI / 180)) * 0.52;
              return <ellipse className={`dyson-swarm-orbit-ring${activeSwarmOrbit?.id === orbit.id ? " active" : ""}`} cx={VIEW_CENTER} cy={VIEW_CENTER} rx={radius} ry={radius * scaleY} transform={`rotate(${orbit.longitude} ${VIEW_CENTER} ${VIEW_CENTER})`} key={orbit.id} />;
            })}
            {swarmOrbits.flatMap((orbit, orbitIndex) => {
              if (orbit.sailsInOrbit < 1) return [];
              const radius = visualRadiusBySwarmOrbit.get(orbit.id) ?? 90;
              const count = Math.min(10, Math.max(2, Math.ceil(Math.log2(orbit.sailsInOrbit + 1))));
              return Array.from({ length: count }, (_, index) => (
                <circle
                  className="dyson-swarm-particle"
                  cx={VIEW_CENTER}
                  cy={VIEW_CENTER - radius}
                  r={index % 3 === 0 ? 2.4 : 1.7}
                  style={{ animationDelay: `${-(orbitIndex * 0.31 + index * 0.43)}s`, animationDuration: `${5.4 + orbitIndex * 0.8 + index % 5 * 0.7}s` }}
                  key={`${orbit.id}-${index}`}
                />
              ));
            })}
            {plan.layers.map((layer) => {
              const radius = visualRadiusByLayer.get(layer.id) ?? 100;
              const scaleY = 0.45 + Math.abs(Math.cos(layer.inclination * Math.PI / 180)) * 0.55;
              const active = activeLayer?.id === layer.id;
              return (
                <g className={`dyson-orbit-layer${active ? " active" : ""}`} key={layer.id} transform={`translate(${VIEW_CENTER} ${VIEW_CENTER}) rotate(${layer.longitude}) scale(1 ${scaleY.toFixed(3)})`} onClick={(event) => { event.stopPropagation(); onSelectLayer(systemId, layer.id); }}>
                  {layer.shells.map((shell) => {
                    const source = layer.nodes.find((node) => node.id === shell.sourceNodeId);
                    const target = layer.nodes.find((node) => node.id === shell.targetNodeId);
                    if (!source || !target) return null;
                    const fill = shell.sailCapacity > 0 ? shell.absorbedSails / shell.sailCapacity : 0;
                    return <path className="dyson-shell-sector" d={shellPath(layer, source.angle, target.angle, radius)} style={{ opacity: 0.12 + fill * 0.48 }} key={shell.id} />;
                  })}
                  <circle className="dyson-orbit-ring" r={radius} />
                  {layer.frames.map((frame) => {
                    const source = layer.nodes.find((node) => node.id === frame.sourceNodeId);
                    const target = layer.nodes.find((node) => node.id === frame.targetNodeId);
                    if (!source || !target) return null;
                    const start = pointAt(source.angle, radius);
                    const end = pointAt(target.angle, radius);
                    const complete = frame.completedStructurePoints >= frame.requiredStructurePoints;
                    return <line className={complete ? "dyson-frame dyson-frame--complete" : "dyson-frame"} x1={start.x} y1={start.y} x2={end.x} y2={end.y} key={frame.id} />;
                  })}
                  {layer.nodes.map((node) => {
                    const point = pointAt(node.angle, radius);
                    const complete = node.completedStructurePoints >= node.requiredStructurePoints;
                    return (
                      <circle
                        className={`dyson-orbit-node${complete ? " dyson-orbit-node--complete" : ""}${selectedNodeId === node.id ? " selected" : ""}`}
                        cx={point.x}
                        cy={point.y}
                        r={selectedNodeId === node.id ? 8 : 6}
                        key={node.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (selectedNodeId && selectedNodeId !== node.id) {
                            onConnectNodes(systemId, layer.id, selectedNodeId, node.id);
                            setSelectedNodeId(null);
                          } else {
                            setSelectedNodeId(selectedNodeId === node.id ? null : node.id);
                          }
                        }}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
          {!programReady ? <div className="dyson-planner-lock"><LockKeyhole size={18} /><strong>戴森球计划尚未解锁</strong></div> : null}
        </section>

        <aside className="dyson-layer-inspector">
          {activeLayer ? (
            <>
              <header><i><Orbit size={17} /></i><div><span>当前壳层</span><strong>{activeLayer.name}</strong></div><em>{activeLayer.nodes.length} 节点</em></header>
              <label className="dyson-orbit-control"><span>轨道半径 <strong>{activeLayer.radius.toLocaleString("zh-CN")} m</strong></span><input type="range" min={5000} max={50000} step={500} value={activeLayer.radius} onChange={(event) => onOrbitChange(systemId, activeLayer.id, { radius: Number(event.target.value) })} /></label>
              <label className="dyson-orbit-control"><span>轨道倾角 <strong>{activeLayer.inclination}°</strong></span><input type="range" min={-90} max={90} step={1} value={activeLayer.inclination} onChange={(event) => onOrbitChange(systemId, activeLayer.id, { inclination: Number(event.target.value) })} /></label>
              <label className="dyson-orbit-control"><span>升交点经度 <strong>{activeLayer.longitude}°</strong></span><input type="range" min={0} max={359} step={1} value={activeLayer.longitude} onChange={(event) => onOrbitChange(systemId, activeLayer.id, { longitude: Number(event.target.value) })} /></label>
              <dl className="metric-ledger dyson-layer-ledger">
                <div><dt>节点</dt><dd>{activeLayer.nodes.filter((node) => node.completedStructurePoints >= node.requiredStructurePoints).length}/{activeLayer.nodes.length}</dd></div>
                <div><dt>框架</dt><dd>{activeLayer.frames.filter((frame) => frame.completedStructurePoints >= frame.requiredStructurePoints).length}/{activeLayer.frames.length}</dd></div>
                <div><dt>壳面容量</dt><dd><QuantityValue value={activeLayer.shells.reduce((sum, shell) => sum + shell.sailCapacity, 0)} /></dd></div>
                <div><dt>已吸附太阳帆</dt><dd><QuantityValue value={activeLayer.shells.reduce((sum, shell) => sum + shell.absorbedSails, 0)} /></dd></div>
              </dl>
              <div className="dyson-layer-actions">
                <button type="button" disabled={activeLayer.nodes.length < 3} onClick={() => onAutoConnect(systemId, activeLayer.id)}><GitBranch size={14} />闭合框架</button>
                <button type="button" disabled={!shellReady || activeLayer.nodes.length < 3} onClick={() => onPlanShell(systemId, activeLayer.id)}>{shellReady ? <Layers3 size={14} /> : <LockKeyhole size={14} />}规划壳面</button>
                <button type="button" disabled={activeLayer.shells.length === 0} onClick={() => onClearShell(systemId, activeLayer.id)}><X size={14} />清除壳面</button>
              </div>
              {selectedNodeId ? (
                <div className="dyson-node-selection"><span><CircleDot size={13} />已选节点</span><strong>{activeLayer.nodes.find((node) => node.id === selectedNodeId)?.angle.toFixed(1)}°</strong><button type="button" onClick={() => { onRemoveNode(systemId, activeLayer.id, selectedNodeId); setSelectedNodeId(null); }} title="删除已选节点" aria-label="删除已选戴森节点"><Trash2 size={13} /></button></div>
              ) : null}
              <button className="dyson-layer-remove" type="button" onClick={() => { onRemoveLayer(systemId, activeLayer.id); setSelectedNodeId(null); }}><Trash2 size={14} />删除当前壳层</button>
            </>
          ) : (
            <div className="dyson-inspector-empty"><Orbit size={24} /><strong>{getStarSystem(systemId).name}</strong><span>{programReady ? "0 个规划壳层" : "科技锁定"}</span></div>
          )}
          {activeSwarmOrbit ? (
            <section className="dyson-swarm-orbit-inspector" aria-label="太阳帆轨道参数">
              <header><i><Sun size={15} /></i><span><small>太阳帆轨道</small><strong>{activeSwarmOrbit.name}</strong></span><em><QuantityValue value={activeSwarmOrbit.sailsInOrbit} unit="帆" /></em></header>
              <label className="dyson-orbit-control"><span>轨道半径 <strong>{activeSwarmOrbit.radius.toLocaleString("zh-CN")} m</strong></span><input type="range" min={5000} max={50000} step={500} value={activeSwarmOrbit.radius} onChange={(event) => onSwarmOrbitChange(systemId, activeSwarmOrbit.id, { radius: Number(event.target.value) })} /></label>
              <label className="dyson-orbit-control"><span>轨道倾角 <strong>{activeSwarmOrbit.inclination}°</strong></span><input type="range" min={-90} max={90} step={1} value={activeSwarmOrbit.inclination} onChange={(event) => onSwarmOrbitChange(systemId, activeSwarmOrbit.id, { inclination: Number(event.target.value) })} /></label>
              <label className="dyson-orbit-control"><span>升交点经度 <strong>{activeSwarmOrbit.longitude}°</strong></span><input type="range" min={0} max={359} step={1} value={activeSwarmOrbit.longitude} onChange={(event) => onSwarmOrbitChange(systemId, activeSwarmOrbit.id, { longitude: Number(event.target.value) })} /></label>
              <div className="dyson-swarm-orbit-stats"><span>发射 <QuantityValue value={activeSwarmOrbit.totalLaunched} /></span><span>衰减 <QuantityValue value={activeSwarmOrbit.totalExpired} /></span><span><PowerValue valueKw={activeSwarmOrbit.generationKw} /></span></div>
              <button type="button" disabled={swarmOrbits.length <= 1} onClick={() => onRemoveSwarmOrbit(systemId, activeSwarmOrbit.id)} title="删除当前太阳帆轨道"><Trash2 size={13} />删除轨道</button>
            </section>
          ) : null}
          <section className="dyson-launch-console" aria-label="戴森发射调度">
            <header><span><RadioTower size={14} />发射调度</span><button type="button" className={engineering.launchEnabled ? "active" : ""} onClick={() => onLaunchEnabledChange(!engineering.launchEnabled)} aria-label={engineering.launchEnabled ? "暂停戴森发射" : "启用戴森发射"}>{engineering.launchEnabled ? <Pause size={13} /> : <Play size={13} />}</button></header>
            <div className="dyson-launch-mode" role="group" aria-label="发射优先级">
              {(["balanced", "swarm", "sphere"] as DysonLaunchMode[]).map((mode) => <button type="button" className={engineering.launchMode === mode ? "active" : ""} onClick={() => onLaunchModeChange(mode)} key={mode}>{{ balanced: "均衡", swarm: "太阳帆", sphere: "火箭" }[mode]}</button>)}
            </div>
            <div className="dyson-launch-throttle" role="group" aria-label="发射节流">
              {([0.25, 0.5, 0.75, 1] as DysonLaunchThrottle[]).map((throttle) => <button type="button" className={engineering.launchThrottle === throttle ? "active" : ""} onClick={() => onLaunchThrottleChange(throttle)} key={throttle}>{Math.round(throttle * 100)}%</button>)}
            </div>
            <dl className="metric-ledger dyson-engineering-ledger">
              <div><dt>太阳帆队列</dt><dd>{engineering.queuedSails} · {engineering.sailLaunchesPerMinute}/min</dd></div>
              <div><dt>运载火箭队列</dt><dd>{engineering.queuedRockets} · {engineering.rocketLaunchesPerMinute}/min</dd></div>
              <div><dt>发射能耗</dt><dd>{engineering.launchEnergyPerMinuteMj.toFixed(1)} MJ/min</dd></div>
              <div><dt>计划功率</dt><dd><PowerValue valueKw={engineering.projectedGenerationKw} /></dd></div>
              <div><dt>理论接收率</dt><dd>{Math.round(engineering.theoreticalReceptionRate * 100)}%</dd></div>
              <div><dt>接收站实际利用率</dt><dd>{Math.round(engineering.receiverUtilization * 100)}%</dd></div>
              <div><dt>戴森功率利用率</dt><dd>{Math.round(engineering.dysonPowerUtilization * 100)}%</dd></div>
              <div><dt>接收站状态</dt><dd>{engineering.blockedReceiverCount > 0 ? `${engineering.blockedReceiverCount}/${engineering.configuredReceiverCount} 受阻` : `${engineering.configuredReceiverCount} 台可用`}</dd></div>
              <div><dt>临界光子</dt><dd>{engineering.criticalPhotonPerMinute.toFixed(1)}/min</dd></div>
              <div><dt>反物质</dt><dd>{engineering.antimatterPerMinute.toFixed(1)}/min</dd></div>
              <div><dt>反物质回馈</dt><dd><PowerValue valueKw={engineering.feedbackGenerationKw} /></dd></div>
            </dl>
            <div className="dyson-launch-cost"><span><Zap size={12} />单次成本</span><strong>帆 {engineering.launchEnergyPerSailMj.toFixed(1)} MJ · 火箭 {engineering.launchEnergyPerRocketMj.toFixed(0)} MJ</strong></div>
          </section>
          <footer className="dyson-plan-status">
            <span>{totals.completedStructure >= totals.plannedStructure && totals.plannedStructure > 0 ? <Check size={12} /> : <Rocket size={12} />}结构点 <QuantityValue value={plan.structurePoints} /></span>
            <span><Layers3 size={12} />壳面帆 <QuantityValue value={plan.shellSails} />/<QuantityValue value={totals.sailCapacity} /></span>
          </footer>
        </aside>
      </div>
    </WorkspaceFrame>
  );
}

export type NativeDysonWorkspaceReadStatus = "empty" | "loading" | "ready" | "unavailable";

const NATIVE_DYSON_DETAIL_ROW_LIMIT = 24;

function nativeDysonLabel(value: string | null | undefined, fallback: string): string {
  const label = value?.trim();
  return label ? label : fallback;
}

function nativeDysonShellPath(sourceAngle: number, targetAngle: number, radius: number): string {
  const source = pointAt(sourceAngle, radius);
  const target = pointAt(targetAngle, radius);
  const distance = angularDistance(sourceAngle, targetAngle);
  return `M 0 0 L ${source.x.toFixed(2)} ${source.y.toFixed(2)} A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${distance > 180 ? 1 : 0} 1 ${target.x.toFixed(2)} ${target.y.toFixed(2)} Z`;
}

function nativeDysonFrameIsComplete(
  frame: NativeDysonWorkspaceFrame | null,
  status: NativeDysonWorkspaceReadStatus,
  selectedSystemId: string | null,
): frame is NativeDysonWorkspaceFrame {
  if (!frame || status !== "ready" || frame.selectedSystemId !== selectedSystemId) return false;
  const { projection } = frame;
  const selectedSystem = frame.systems.find((system) => system.systemId === selectedSystemId);
  return projection.schemaVersion === 1 && projection.projectionType === "dyson-workspace-v1" &&
    projection.stateVersion === 47 && projection.revision === frame.revision &&
    projection.registryFingerprint === frame.registryFingerprint &&
    projection.selectedSystemId === selectedSystemId && projection.request.selectedSystemId === selectedSystemId &&
    projection.request.expectedRevision === frame.revision &&
    projection.request.expectedRegistryFingerprint === frame.registryFingerprint &&
    frame.systems.length === projection.summary.systemCount &&
    frame.layers.length === projection.selectedSystem.totals.layerCount &&
    frame.orbits.length === projection.selectedSystem.orbitCount &&
    frame.nodes.length === projection.selectedSystem.totals.nodeCount &&
    frame.frames.length === projection.selectedSystem.totals.frameCount &&
    frame.shells.length === projection.selectedSystem.totals.shellCount &&
    selectedSystem?.systemId === projection.selectedSystem.systemId;
}

function NativeDysonUnavailable({
  status,
  onClose,
}: {
  status: Exclude<NativeDysonWorkspaceReadStatus, "ready">;
  onClose: () => void;
}) {
  const loading = status === "loading";
  return (
    <WorkspaceFrame
      className="dyson-planner-workspace"
      ariaLabel="原生戴森球规划"
      onRequestClose={onClose}
      data-native-dyson-read-status={status}
    >
      <header className="dyson-planner-header">
        <div className="dyson-planner-title"><i><Orbit size={20} /></i><div><span>Rust 玩家权威 · 只读投影</span><strong>戴森球规划</strong></div></div>
        <div className="dyson-planner-headline"><span>权威数据 <strong>{loading ? "同步中" : "暂不可用"}</strong></span></div>
        <div className="dyson-planner-commandbar" role="toolbar" aria-label="原生戴森球规划命令">
          <button type="button" onClick={onClose} title="关闭戴森球规划" aria-label="关闭戴森球规划"><X size={18} /><span>关闭</span></button>
        </div>
      </header>
      <div className="dyson-planner-layout">
        <section className="dyson-orbit-stage" style={{ gridColumn: "1 / -1" }}>
          <div className="dyson-planner-lock" role={loading ? "status" : "alert"}>
            {loading ? <Orbit size={18} /> : <LockKeyhole size={18} />}
            <strong>{loading ? "正在同步原生权威戴森球投影" : "原生权威戴森球投影暂不可用"}</strong>
            <span>{loading ? "完成同 revision 的全部分页后才会显示。" : "当前不会读取或显示 JavaScript 存档中的旧戴森数据。"}</span>
          </div>
        </section>
      </div>
    </WorkspaceFrame>
  );
}

/**
 * Player-authority Dyson surface. This component intentionally consumes only
 * the complete, same-revision native projection. Its launch and orbit
 * selection callbacks are revision-bound Rust commands; structural editing
 * stays unavailable here.
 */
export function NativeDysonPlannerWorkspace({
  frame: candidateFrame,
  latestIdentity,
  status,
  selectedSystemId,
  pending,
  onSelectSystem,
  onSelectLayer,
  onSelectOrbit,
  onOrbitChange,
  onLaunchModeChange,
  onLaunchThrottleChange,
  onLaunchEnabledChange,
  onClose,
}: {
  frame: NativeDysonWorkspaceFrame | null;
  latestIdentity?: NativeDysonWorkspaceIdentity | null;
  status: NativeDysonWorkspaceReadStatus;
  selectedSystemId: string | null;
  pending: boolean;
  onSelectSystem: (systemId: string) => void;
  onSelectLayer: (layerId: string) => void;
  onSelectOrbit: (orbitId: string) => void;
  onOrbitChange: (orbitId: string, changes: { radius?: number; inclination?: number; longitude?: number }) => void;
  onLaunchModeChange: (mode: DysonLaunchMode) => void;
  onLaunchThrottleChange: (throttle: DysonLaunchThrottle) => void;
  onLaunchEnabledChange: (enabled: boolean) => void;
  onClose: () => void;
}) {
  const exactFrame = nativeDysonFrameIsComplete(candidateFrame, status, selectedSystemId)
    ? candidateFrame
    : null;
  const resolvedLatestIdentity = latestIdentity === undefined
    ? exactFrame ? {
      sessionId: exactFrame.sessionId,
      runId: exactFrame.runId,
      revision: exactFrame.revision,
      registryFingerprint: exactFrame.registryFingerprint,
      selectedSystemId: exactFrame.selectedSystemId,
    } : null
    : latestIdentity;
  const [cachedFrame, setCachedFrame] = useState<NativeDysonWorkspaceFrame | null>(exactFrame);
  const cachedFrameMatchesScope = Boolean(status === "loading" && cachedFrame && resolvedLatestIdentity &&
    cachedFrame.sessionId === resolvedLatestIdentity.sessionId &&
    cachedFrame.runId === resolvedLatestIdentity.runId &&
    cachedFrame.registryFingerprint === resolvedLatestIdentity.registryFingerprint &&
    cachedFrame.selectedSystemId === resolvedLatestIdentity.selectedSystemId &&
    cachedFrame.selectedSystemId === selectedSystemId &&
    cachedFrame.revision <= resolvedLatestIdentity.revision &&
    nativeDysonFrameIsComplete(cachedFrame, "ready", selectedSystemId));
  const displayFrame = exactFrame ?? (cachedFrameMatchesScope ? cachedFrame : null);

  useEffect(() => {
    if (exactFrame) {
      setCachedFrame(exactFrame);
      return;
    }
    if (status !== "loading" || !resolvedLatestIdentity) setCachedFrame(null);
    else setCachedFrame((current) => current &&
      current.sessionId === resolvedLatestIdentity.sessionId &&
      current.runId === resolvedLatestIdentity.runId &&
      current.registryFingerprint === resolvedLatestIdentity.registryFingerprint &&
      current.selectedSystemId === resolvedLatestIdentity.selectedSystemId &&
      current.selectedSystemId === selectedSystemId &&
      current.revision <= resolvedLatestIdentity.revision &&
      nativeDysonFrameIsComplete(current, "ready", selectedSystemId)
      ? current
      : null);
  }, [
    exactFrame,
    resolvedLatestIdentity?.registryFingerprint,
    resolvedLatestIdentity?.revision,
    resolvedLatestIdentity?.runId,
    resolvedLatestIdentity?.selectedSystemId,
    resolvedLatestIdentity?.sessionId,
    selectedSystemId,
    status,
  ]);

  if (!displayFrame) {
    const unavailableStatus = status === "loading" || status === "empty" ? status : "unavailable";
    return <NativeDysonUnavailable status={unavailableStatus} onClose={onClose} />;
  }

  const frame = displayFrame;
  const commandPending = pending || exactFrame === null;
  const { projection } = frame;
  const selectedSystem = frame.systems.find((system) => system.systemId === selectedSystemId)!;
  const selectedSystemName = nativeDysonLabel(selectedSystem.displayName, selectedSystem.systemId);
  const starTypeName = selectedSystem.starProfile.available
    ? nativeDysonLabel(selectedSystem.starProfile.starTypeName, "未知恒星类型")
    : "未知 / MOD 恒星资料";
  const activeLayer = selectedSystem.activeLayerId
    ? frame.layers.find((layer) => layer.layerId === selectedSystem.activeLayerId) ?? frame.layers[0] ?? null
    : frame.layers[0] ?? null;
  const activeOrbit = selectedSystem.activeOrbitId
    ? frame.orbits.find((orbit) => orbit.orbitId === selectedSystem.activeOrbitId) ?? frame.orbits[0] ?? null
    : frame.orbits[0] ?? null;
  const maximumRadius = Math.max(
    50_000,
    ...frame.layers.map((layer) => layer.radius),
    ...frame.orbits.map((orbit) => orbit.radius),
  );
  const radiusForLayer = (radius: number) => 76 + radius / maximumRadius * 190;
  const radiusForOrbit = (radius: number) => 64 + radius / maximumRadius * 176;
  const globalGenerationKw = projection.global.sphere.generationKw + projection.global.swarm.generationKw;
  const activeNodes = activeLayer ? frame.nodesByLayerId.get(activeLayer.layerId) ?? [] : [];
  const activeFrames = activeLayer ? frame.framesByLayerId.get(activeLayer.layerId) ?? [] : [];
  const activeShells = activeLayer ? frame.shellsByLayerId.get(activeLayer.layerId) ?? [] : [];
  const launchModeLabel = { balanced: "均衡", swarm: "太阳帆", sphere: "火箭" } as const;

  return (
    <WorkspaceFrame
      className="dyson-planner-workspace"
      ariaLabel="原生戴森球规划"
      onRequestClose={onClose}
      data-native-dyson-read-status={exactFrame ? "ready" : "loading"}
      data-native-dyson-revision={frame.revision}
      data-native-dyson-display-stale={exactFrame ? undefined : "true"}
    >
      <header className="dyson-planner-header">
        <div className="dyson-planner-title"><i><Orbit size={20} /></i><div><span>Rust 玩家权威 · revision {frame.revision}</span><strong>戴森球规划</strong></div></div>
        <div className="dyson-planner-headline">
          <span>结构 <strong><QuantityValue value={projection.global.sphere.structurePoints} /></strong></span>
          <span>火箭 <strong><QuantityValue value={projection.global.sphere.totalRocketsLaunched} /></strong></span>
          <span>壳面帆 <strong><QuantityValue value={projection.global.sphere.shellSails} /></strong></span>
          <span>总功率 <strong><PowerValue valueKw={globalGenerationKw} /></strong></span>
        </div>
        <div className="dyson-planner-commandbar" role="toolbar" aria-label="原生戴森球规划命令">
          <button type="button" disabled data-native-dyson-action="design" title="设计命令尚未接入原生权威状态机"><LockKeyhole size={17} /><span>设计只读</span></button>
          <button type="button" disabled data-native-dyson-action="save" title="原生权威检查点由运行时持久化"><Save size={17} /><span>权威保存</span></button>
          <button type="button" onClick={onClose} title="关闭戴森球规划" aria-label="关闭戴森球规划"><X size={18} /><span>关闭</span></button>
        </div>
      </header>

      {!exactFrame && resolvedLatestIdentity ? <div className="dyson-planner-lock" role="status">
        <Orbit size={16} />
        <strong>正在读取 Rust revision {resolvedLatestIdentity.revision}</strong>
        <span>继续显示已验证的 revision {frame.revision}；全部权威写入已锁定。</span>
      </div> : null}

      <div className="dyson-planner-layout">
        <aside className="dyson-plan-sidebar">
          <div className="dyson-system-tabs" aria-label="原生戴森球恒星系">
            {frame.systems.map((system) => {
              const name = nativeDysonLabel(system.displayName, system.systemId);
              const type = system.starProfile.available
                ? nativeDysonLabel(system.starProfile.starTypeName, "未知恒星类型")
                : "未知 / MOD 恒星";
              return (
                <button
                  className={selectedSystemId === system.systemId ? "active" : ""}
                  type="button"
                  key={system.systemId}
                  onClick={() => onSelectSystem(system.systemId)}
                  title={`查看 ${name}（${system.systemId}）原生戴森投影`}
                  aria-label={`查看${name}戴森规划`}
                  data-native-dyson-system-id={system.systemId}
                >
                  <i><Sparkles size={14} /></i>
                  <span><strong>{name}</strong><small>{type} · {system.starProfile.luminosity.toFixed(2)} L☉{system.unlocked ? "" : " · 未解锁"}</small></span>
                </button>
              );
            })}
          </div>
          <div className="dyson-layer-heading"><span>壳层</span><strong>{frame.layers.length}/8</strong></div>
          <div className="dyson-layer-list" aria-label="原生戴森壳层列表">
            {frame.layers.map((layer, index) => (
              <button
                className={activeLayer?.layerId === layer.layerId ? "active" : ""}
                type="button"
                key={layer.layerId}
                disabled={commandPending || activeLayer?.layerId === layer.layerId}
                onClick={() => onSelectLayer(layer.layerId)}
                data-native-dyson-action="select-layer"
                title={`切换到 ${nativeDysonLabel(layer.name, layer.layerId)}（${layer.layerId}）`}
              >
                <b>{String(index + 1).padStart(2, "0")}</b>
                <span><strong>{nativeDysonLabel(layer.name, layer.layerId)}</strong><small>{layer.radius.toLocaleString("zh-CN")} m · {layer.nodeCount} 节点</small></span>
                <em title={`${formatQuantityExact(layer.completedStructurePoints)} / ${formatQuantityExact(layer.plannedStructurePoints)}`}>{formatQuantityCompact(layer.completedStructurePoints)}/{formatQuantityCompact(layer.plannedStructurePoints)}</em>
              </button>
            ))}
            {frame.layers.length === 0 ? <div className="dyson-layer-empty"><Orbit size={18} /><span>{projection.technology.programReady ? "尚无壳层方案" : "戴森球计划尚未解锁"}</span></div> : null}
          </div>
          <div className="dyson-layer-commands" aria-label="原生戴森壳层设计操作">
            <button type="button" disabled data-native-dyson-action="add-layer" title="原生戴森设计命令尚未接入"><Plus size={14} />空白层</button>
            <button type="button" disabled data-native-dyson-action="add-standard-layer" title="原生戴森设计命令尚未接入"><Layers3 size={14} />标准层</button>
          </div>
          <div className="dyson-layer-heading dyson-swarm-heading"><span>太阳帆轨道</span><strong>{frame.orbits.length}/8</strong></div>
          <div className="dyson-swarm-orbit-list" aria-label="原生太阳帆轨道列表">
            {frame.orbits.map((orbit, index) => (
              <button
                className={activeOrbit?.orbitId === orbit.orbitId ? "active" : ""}
                type="button"
                key={orbit.orbitId}
                disabled={commandPending || activeOrbit?.orbitId === orbit.orbitId}
                onClick={() => onSelectOrbit(orbit.orbitId)}
                data-native-dyson-action="select-orbit"
                title={`切换到 ${nativeDysonLabel(orbit.name, orbit.orbitId)}（${orbit.orbitId}）`}
              >
                <b>{String(index + 1).padStart(2, "0")}</b>
                <span><strong>{nativeDysonLabel(orbit.name, orbit.orbitId)}</strong><small>{orbit.radius.toLocaleString("zh-CN")} m · {orbit.inclination}°</small></span>
                <em title={`${formatQuantityExact(orbit.sailsInOrbit)} 帆`}>{formatQuantityCompact(orbit.sailsInOrbit)} 帆</em>
              </button>
            ))}
          </div>
          <button className="dyson-add-swarm-orbit" type="button" disabled data-native-dyson-action="add-orbit" title="原生太阳帆轨道命令尚未接入"><Plus size={14} />新增太阳帆轨道</button>
        </aside>

        <section className="dyson-orbit-stage">
          <div className="dyson-stage-summary">
            <span><CircleDot size={13} />节点 <strong>{selectedSystem.totals.nodeCount}</strong></span>
            <span><GitBranch size={13} />框架 <strong>{selectedSystem.totals.frameCount}</strong></span>
            <span><Layers3 size={13} />壳面 <strong>{selectedSystem.totals.shellCount}</strong></span>
            <span><Rocket size={13} />施工 <strong><QuantityValue value={selectedSystem.totals.completedStructurePoints} />/<QuantityValue value={selectedSystem.totals.plannedStructurePoints} /></strong></span>
            <span><Sun size={13} />在轨 <strong><QuantityValue value={selectedSystem.orbitSails} /></strong></span>
            <span><Gauge size={13} />理论接收 <strong>{Math.round(selectedSystem.engineering.theoreticalReceptionRate * 100)}%</strong></span>
          </div>
          <svg className="dyson-orbit-canvas" viewBox="0 0 600 600" role="img" aria-label={`${selectedSystemName}原生戴森球轨道图`} style={{ cursor: "default" }}>
            <circle className="dyson-star-halo" cx={VIEW_CENTER} cy={VIEW_CENTER} r={Math.max(34, Math.min(58, 38 + Math.log2(Math.max(0.1, selectedSystem.starProfile.luminosity)) * 5))} />
            <circle className="dyson-star-core" cx={VIEW_CENTER} cy={VIEW_CENTER} r={Math.max(14, Math.min(34, 22 + Math.log2(Math.max(0.1, selectedSystem.starProfile.radiusMultiplier)) * 4))} />
            {frame.orbits.map((orbit) => {
              const radius = radiusForOrbit(orbit.radius);
              const scaleY = 0.48 + Math.abs(Math.cos(orbit.inclination * Math.PI / 180)) * 0.52;
              return <ellipse className={`dyson-swarm-orbit-ring${activeOrbit?.orbitId === orbit.orbitId ? " active" : ""}`} cx={VIEW_CENTER} cy={VIEW_CENTER} rx={radius} ry={radius * scaleY} transform={`rotate(${orbit.longitude} ${VIEW_CENTER} ${VIEW_CENTER})`} key={orbit.orbitId} />;
            })}
            {frame.orbits.flatMap((orbit, orbitIndex) => {
              if (orbit.sailsInOrbit < 1) return [];
              const radius = radiusForOrbit(orbit.radius);
              const count = Math.min(10, Math.max(2, Math.ceil(Math.log2(orbit.sailsInOrbit + 1))));
              return Array.from({ length: count }, (_, index) => (
                <circle
                  className="dyson-swarm-particle"
                  cx={VIEW_CENTER}
                  cy={VIEW_CENTER - radius}
                  r={index % 3 === 0 ? 2.4 : 1.7}
                  style={{ animationDelay: `${-(orbitIndex * 0.31 + index * 0.43)}s`, animationDuration: `${5.4 + orbitIndex * 0.8 + index % 5 * 0.7}s` }}
                  key={`${orbit.orbitId}-${index}`}
                />
              ));
            })}
            {frame.layers.map((layer) => {
              const radius = radiusForLayer(layer.radius);
              const scaleY = 0.45 + Math.abs(Math.cos(layer.inclination * Math.PI / 180)) * 0.55;
              const layerNodes = frame.nodesByLayerId.get(layer.layerId) ?? [];
              const nodeById = new Map(layerNodes.map((node) => [node.nodeId, node]));
              return (
                <g className={`dyson-orbit-layer${activeLayer?.layerId === layer.layerId ? " active" : ""}`} key={layer.layerId} transform={`translate(${VIEW_CENTER} ${VIEW_CENTER}) rotate(${layer.longitude}) scale(1 ${scaleY.toFixed(3)})`}>
                  {(frame.shellsByLayerId.get(layer.layerId) ?? []).map((shell) => {
                    const source = nodeById.get(shell.sourceNodeId);
                    const target = nodeById.get(shell.targetNodeId);
                    if (!source || !target) return null;
                    const fill = shell.sailCapacity > 0 ? shell.absorbedSails / shell.sailCapacity : 0;
                    return <path className="dyson-shell-sector" d={nativeDysonShellPath(source.angle, target.angle, radius)} style={{ opacity: 0.12 + fill * 0.48 }} key={shell.shellId} data-native-dyson-shell-id={shell.shellId} />;
                  })}
                  <circle className="dyson-orbit-ring" r={radius} />
                  {(frame.framesByLayerId.get(layer.layerId) ?? []).map((structureFrame) => {
                    const source = nodeById.get(structureFrame.sourceNodeId);
                    const target = nodeById.get(structureFrame.targetNodeId);
                    if (!source || !target) return null;
                    const start = pointAt(source.angle, radius);
                    const end = pointAt(target.angle, radius);
                    const complete = structureFrame.completedStructurePoints >= structureFrame.requiredStructurePoints;
                    return <line className={complete ? "dyson-frame dyson-frame--complete" : "dyson-frame"} x1={start.x} y1={start.y} x2={end.x} y2={end.y} key={structureFrame.frameId} data-native-dyson-frame-id={structureFrame.frameId} />;
                  })}
                  {layerNodes.map((node) => {
                    const point = pointAt(node.angle, radius);
                    const complete = node.completedStructurePoints >= node.requiredStructurePoints;
                    return <circle className={`dyson-orbit-node${complete ? " dyson-orbit-node--complete" : ""}`} cx={point.x} cy={point.y} r={6} key={node.nodeId} style={{ pointerEvents: "none" }} data-native-dyson-node-id={node.nodeId} />;
                  })}
                </g>
              );
            })}
          </svg>
          {!projection.technology.programReady ? <div className="dyson-planner-lock"><LockKeyhole size={18} /><strong>戴森球计划尚未解锁</strong></div> : null}
        </section>

        <aside className="dyson-layer-inspector">
          {activeLayer ? (
            <>
              <header><i><Orbit size={17} /></i><div><span>当前原生壳层 · 只读</span><strong>{nativeDysonLabel(activeLayer.name, activeLayer.layerId)}</strong></div><em>{activeLayer.nodeCount} 节点</em></header>
              <label className="dyson-orbit-control"><span>轨道半径 <strong>{activeLayer.radius.toLocaleString("zh-CN")} m</strong></span><input type="range" min={0} max={Math.max(1, activeLayer.radius)} value={activeLayer.radius} disabled data-native-dyson-action="layer-radius" aria-label="原生壳层轨道半径（只读）" /></label>
              <label className="dyson-orbit-control"><span>轨道倾角 <strong>{activeLayer.inclination}°</strong></span><input type="range" min={-90} max={90} value={activeLayer.inclination} disabled data-native-dyson-action="layer-inclination" aria-label="原生壳层轨道倾角（只读）" /></label>
              <label className="dyson-orbit-control"><span>升交点经度 <strong>{activeLayer.longitude}°</strong></span><input type="range" min={0} max={359} value={activeLayer.longitude} disabled data-native-dyson-action="layer-longitude" aria-label="原生壳层升交点经度（只读）" /></label>
              <dl className="metric-ledger dyson-layer-ledger">
                <div><dt>节点</dt><dd>{activeNodes.filter((node) => node.completedStructurePoints >= node.requiredStructurePoints).length}/{activeLayer.nodeCount}</dd></div>
                <div><dt>框架</dt><dd>{activeFrames.filter((structureFrame) => structureFrame.completedStructurePoints >= structureFrame.requiredStructurePoints).length}/{activeLayer.frameCount}</dd></div>
                <div><dt>壳面容量</dt><dd><QuantityValue value={activeLayer.sailCapacity} /></dd></div>
                <div><dt>已吸附太阳帆</dt><dd><QuantityValue value={activeLayer.absorbedSails} /></dd></div>
                <div><dt>结构分配下限</dt><dd><QuantityValue value={activeLayer.structureAllocationFloor} /></dd></div>
                <div><dt>壳面分配下限</dt><dd><QuantityValue value={activeLayer.shellAllocationFloor} /></dd></div>
              </dl>
              <div className="dyson-layer-actions">
                <button type="button" disabled data-native-dyson-action="connect-frames"><GitBranch size={14} />闭合框架</button>
                <button type="button" disabled data-native-dyson-action="plan-shell"><Layers3 size={14} />规划壳面</button>
                <button type="button" disabled data-native-dyson-action="clear-shell"><X size={14} />清除壳面</button>
              </div>
              <section aria-label="原生戴森结构明细">
                <div className="dyson-layer-heading"><span>节点明细</span><strong>{activeNodes.length}</strong></div>
                <dl className="metric-ledger dyson-layer-ledger">
                  {activeNodes.slice(0, NATIVE_DYSON_DETAIL_ROW_LIMIT).map((node) => <div key={node.nodeId}><dt>节点 {nativeDysonLabel(node.nodeId, "未知节点")}</dt><dd>{formatQuantityCompact(node.completedStructurePoints)}/{formatQuantityCompact(node.requiredStructurePoints)} · {node.angle.toFixed(1)}°</dd></div>)}
                </dl>
                {activeNodes.length > NATIVE_DYSON_DETAIL_ROW_LIMIT ? <div className="dyson-layer-heading"><span>其余节点由轨道图汇总</span><strong>+{activeNodes.length - NATIVE_DYSON_DETAIL_ROW_LIMIT}</strong></div> : null}
                <div className="dyson-layer-heading"><span>框架明细</span><strong>{activeFrames.length}</strong></div>
                <dl className="metric-ledger dyson-layer-ledger">
                  {activeFrames.slice(0, NATIVE_DYSON_DETAIL_ROW_LIMIT).map((structureFrame) => <div key={structureFrame.frameId}><dt>框架 {nativeDysonLabel(structureFrame.frameId, "未知框架")}</dt><dd>{formatQuantityCompact(structureFrame.completedStructurePoints)}/{formatQuantityCompact(structureFrame.requiredStructurePoints)} · {nativeDysonLabel(structureFrame.sourceNodeId, "?")}→{nativeDysonLabel(structureFrame.targetNodeId, "?")}</dd></div>)}
                </dl>
                {activeFrames.length > NATIVE_DYSON_DETAIL_ROW_LIMIT ? <div className="dyson-layer-heading"><span>其余框架由轨道图汇总</span><strong>+{activeFrames.length - NATIVE_DYSON_DETAIL_ROW_LIMIT}</strong></div> : null}
                <div className="dyson-layer-heading"><span>壳面明细</span><strong>{activeShells.length}</strong></div>
                <dl className="metric-ledger dyson-layer-ledger">
                  {activeShells.slice(0, NATIVE_DYSON_DETAIL_ROW_LIMIT).map((shell) => <div key={shell.shellId}><dt>壳面 {nativeDysonLabel(shell.shellId, "未知壳面")}</dt><dd>{formatQuantityCompact(shell.absorbedSails)}/{formatQuantityCompact(shell.sailCapacity)} · {shell.active ? "施工中" : "待施工"}</dd></div>)}
                </dl>
                {activeShells.length > NATIVE_DYSON_DETAIL_ROW_LIMIT ? <div className="dyson-layer-heading"><span>其余壳面由轨道图汇总</span><strong>+{activeShells.length - NATIVE_DYSON_DETAIL_ROW_LIMIT}</strong></div> : null}
              </section>
              <button className="dyson-layer-remove" type="button" disabled data-native-dyson-action="remove-layer"><Trash2 size={14} />删除当前壳层</button>
            </>
          ) : (
            <div className="dyson-inspector-empty"><Orbit size={24} /><strong>{selectedSystemName}</strong><span>{projection.technology.programReady ? "0 个规划壳层" : "科技锁定"}</span></div>
          )}
          {activeOrbit ? (
            <section className="dyson-swarm-orbit-inspector" aria-label="原生太阳帆轨道参数">
              <header><i><Sun size={15} /></i><span><small>太阳帆轨道 · Rust 权威</small><strong>{nativeDysonLabel(activeOrbit.name, activeOrbit.orbitId)}</strong></span><em><QuantityValue value={activeOrbit.sailsInOrbit} unit="帆" /></em></header>
              <label className="dyson-orbit-control"><span>轨道半径 <strong>{activeOrbit.radius.toLocaleString("zh-CN")} m</strong></span><input type="range" min={5000} max={50000} step={500} value={activeOrbit.radius} disabled={commandPending} onChange={(event) => onOrbitChange(activeOrbit.orbitId, { radius: Number(event.target.value) })} data-native-dyson-action="orbit-radius" aria-label="调整原生太阳帆轨道半径" /></label>
              <label className="dyson-orbit-control"><span>轨道倾角 <strong>{activeOrbit.inclination}°</strong></span><input type="range" min={-90} max={90} step={1} value={activeOrbit.inclination} disabled={commandPending} onChange={(event) => onOrbitChange(activeOrbit.orbitId, { inclination: Number(event.target.value) })} data-native-dyson-action="orbit-inclination" aria-label="调整原生太阳帆轨道倾角" /></label>
              <label className="dyson-orbit-control"><span>升交点经度 <strong>{activeOrbit.longitude}°</strong></span><input type="range" min={0} max={359} step={1} value={activeOrbit.longitude} disabled={commandPending} onChange={(event) => onOrbitChange(activeOrbit.orbitId, { longitude: Number(event.target.value) })} data-native-dyson-action="orbit-longitude" aria-label="调整原生太阳帆轨道升交点经度" /></label>
              <div className="dyson-swarm-orbit-stats"><span>发射 <QuantityValue value={activeOrbit.totalLaunched} /></span><span>衰减 <QuantityValue value={activeOrbit.totalExpired} /></span><span><PowerValue valueKw={activeOrbit.generationKw} /></span></div>
              <button type="button" disabled data-native-dyson-action="remove-orbit"><Trash2 size={13} />删除轨道</button>
            </section>
          ) : null}
          <section className="dyson-launch-console" aria-label="原生戴森发射调度">
            <header><span><RadioTower size={14} />发射调度 · Rust 权威</span><button type="button" className={selectedSystem.engineering.launchEnabled ? "active" : ""} disabled={commandPending} onClick={() => onLaunchEnabledChange(!selectedSystem.engineering.launchEnabled)} data-native-dyson-action="launch-enabled" aria-label="切换原生戴森发射开关">{selectedSystem.engineering.launchEnabled ? <Pause size={13} /> : <Play size={13} />}</button></header>
            <div className="dyson-launch-mode" role="group" aria-label="原生发射优先级">
              {(["balanced", "swarm", "sphere"] as const).map((mode) => <button type="button" className={selectedSystem.engineering.launchMode === mode ? "active" : ""} disabled={commandPending || selectedSystem.engineering.launchMode === mode} onClick={() => onLaunchModeChange(mode)} data-native-dyson-action={`launch-mode-${mode}`} key={mode}>{launchModeLabel[mode]}</button>)}
            </div>
            <div className="dyson-launch-throttle" role="group" aria-label="原生发射节流">
              {([0.25, 0.5, 0.75, 1] as const).map((throttle) => <button type="button" className={selectedSystem.engineering.launchThrottle === throttle ? "active" : ""} disabled={commandPending || selectedSystem.engineering.launchThrottle === throttle} onClick={() => onLaunchThrottleChange(throttle)} data-native-dyson-action={`launch-throttle-${throttle}`} key={throttle}>{Math.round(throttle * 100)}%</button>)}
            </div>
            <dl className="metric-ledger dyson-engineering-ledger">
              <div><dt>太阳帆队列</dt><dd><QuantityValue value={selectedSystem.engineering.queuedSails} /> · {selectedSystem.engineering.sailLaunchesPerMinute.toLocaleString("zh-CN")}/min</dd></div>
              <div><dt>运载火箭队列</dt><dd><QuantityValue value={selectedSystem.engineering.queuedRockets} /> · {selectedSystem.engineering.rocketLaunchesPerMinute.toLocaleString("zh-CN")}/min</dd></div>
              <div><dt>发射能耗</dt><dd>{selectedSystem.engineering.launchEnergyPerMinuteMj.toLocaleString("zh-CN")} MJ/min</dd></div>
              <div><dt>计划功率</dt><dd><PowerValue valueKw={selectedSystem.engineering.projectedGenerationKw} /></dd></div>
              <div><dt>理论接收率</dt><dd>{Math.round(selectedSystem.engineering.theoreticalReceptionRate * 100)}%</dd></div>
              <div><dt>接收站实际利用率</dt><dd>{Math.round(selectedSystem.engineering.receiverUtilization * 100)}%</dd></div>
              <div><dt>戴森功率利用率</dt><dd>{Math.round(selectedSystem.engineering.dysonPowerUtilization * 100)}%</dd></div>
              <div><dt>接收站状态</dt><dd>{selectedSystem.engineering.blockedReceiverCount > 0 ? `${selectedSystem.engineering.blockedReceiverCount}/${selectedSystem.engineering.configuredReceiverCount} 受阻` : `${selectedSystem.engineering.configuredReceiverCount} 台可用`}</dd></div>
              <div><dt>临界光子</dt><dd>{selectedSystem.engineering.criticalPhotonPerMinute.toLocaleString("zh-CN")}/min</dd></div>
              <div><dt>反物质</dt><dd>{selectedSystem.engineering.antimatterPerMinute.toLocaleString("zh-CN")}/min</dd></div>
              <div><dt>反物质回馈</dt><dd><PowerValue valueKw={selectedSystem.engineering.feedbackGenerationKw} /></dd></div>
            </dl>
            <div className="dyson-launch-cost"><span><Zap size={12} />单次成本</span><strong>帆 {selectedSystem.engineering.launchEnergyPerSailMj.toLocaleString("zh-CN")} MJ · 火箭 {selectedSystem.engineering.launchEnergyPerRocketMj.toLocaleString("zh-CN")} MJ</strong></div>
          </section>
          <footer className="dyson-plan-status">
            <span><Rocket size={12} />结构点 <QuantityValue value={selectedSystem.structurePoints} /></span>
            <span><Layers3 size={12} />壳面帆 <QuantityValue value={selectedSystem.shellSails} />/<QuantityValue value={selectedSystem.totals.sailCapacity} /></span>
          </footer>
          <div className="dyson-plan-status" aria-label="原生全局戴森守恒统计">
            <span><Rocket size={12} />累计火箭 <QuantityValue value={projection.global.sphere.totalRocketsLaunched} /></span>
            <span><Sun size={12} />吸附帆 <QuantityValue value={projection.global.sphere.totalSailsAbsorbed} /></span>
            <span><Sun size={12} />在轨帆 <QuantityValue value={projection.global.swarm.sailsInOrbit} /></span>
            <span><Zap size={12} />累计能耗 {projection.global.launch.energySpentMj.toLocaleString("zh-CN")} MJ</span>
          </div>
          <div className="dyson-launch-cost"><span><LockKeyhole size={12} />原生权威边界</span><strong>{starTypeName} · {selectedSystem.starProfile.luminosity.toFixed(2)} L☉ · {selectedSystem.systemId}</strong></div>
        </aside>
      </div>
    </WorkspaceFrame>
  );
}
