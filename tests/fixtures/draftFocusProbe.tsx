import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccessibleDialog } from "../../src/components/AccessibleDialog";
import { CanvasRegionEditor } from "../../src/components/BlueprintWorkspace";
import { StableTextArea, StableTextInput, clearStableTextDraft, readStableTextDraft } from "../../src/components/StableTextInput";
import type { CanvasRegion } from "../../src/game/types";
import "../../src/styles.css";
import "../../src/theme.css";

function DraftFocusProbe() {
  const [narrow, setNarrow] = useState(innerWidth < 600);
  const [selected, setSelected] = useState("a");
  const [names, setNames] = useState({ a: "同名区域", b: "同名区域" });
  const [commits, setCommits] = useState<{ id: string; name: string }[]>([]);
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(true);
  const [sensitive, setSensitive] = useState(true);
  const [outerOpen, setOuterOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  const outerRef = useRef<HTMLButtonElement>(null);
  const innerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const resize = () => setNarrow(innerWidth < 600);
    addEventListener("resize", resize);
    return () => removeEventListener("resize", resize);
  }, []);
  // Test-only controls model background selection/layout changes without a
  // pointer blur concealing a stale IME event. No production globals are added.
  Object.assign(window, { __draftFocusReview: {
    select: setSelected, setSensitive, setNotesOpen, closeOuter: () => setOuterOpen(false),
    readNotes: () => readStableTextDraft("review-notes"),
    readPrivate: () => readStableTextDraft("review-private"),
    clearNotes: () => { clearStableTextDraft("review-notes"); setNotesOpen(false); },
  } });
  const region: CanvasRegion = { id: selected, name: names[selected as "a" | "b"], planetId: "home", x: 0, y: 0, width: 400, height: 300, fillColor: "#102a22", borderColor: "#408070" };
  const fields = <>
    <CanvasRegionEditor region={region} onChange={(change) => {
      if (change.name === undefined) return;
      setNames((previous) => ({ ...previous, [selected]: change.name! }));
      setCommits((previous) => [...previous, { id: selected, name: change.name! }]);
    }} onRemove={() => undefined} onClose={() => undefined} />
    {notesOpen && <label>备注<StableTextArea aria-label="备注" draftId="review-notes" value={notes} onValueChange={setNotes} /></label>}
    <label>隐私字段<StableTextInput aria-label="隐私字段" draftId="review-private" sensitive={sensitive} value="" onValueChange={() => undefined} /></label>
    <button ref={outerRef} type="button" onClick={() => setOuterOpen(true)}>打开焦点弹窗</button>
  </>;
  return <main style={{ padding: 16, maxWidth: 650 }}>
    <style>{`.canvas-region-editor{position:static;transform:none;width:100%;max-width:100%;flex-wrap:wrap}main>section,main>aside{display:grid;gap:16px}label{display:grid;gap:5px}input,textarea,button{min-height:44px}textarea{width:100%;min-height:90px}pre{white-space:pre-wrap}`}</style>
    <h1>草稿和焦点验证</h1>
    {narrow ? <aside data-testid="responsive-fields">{fields}</aside> : <section data-testid="responsive-fields">{fields}</section>}
    <output data-testid="selected">{selected}</output><pre data-testid="commits">{JSON.stringify(commits)}</pre>
    <AccessibleDialog open={outerOpen} title="父弹窗" returnFocusRef={outerRef} onRequestClose={() => setOuterOpen(false)}>
      <button ref={innerRef} type="button" onClick={() => setInnerOpen(true)}>打开子弹窗</button>
      <button type="button" onClick={() => setOuterOpen(false)}>关闭父弹窗</button>
    </AccessibleDialog>
    <AccessibleDialog open={innerOpen} title="子弹窗" returnFocusRef={innerRef} onRequestClose={() => setInnerOpen(false)}>
      <button type="button" onClick={() => setInnerOpen(false)}>关闭子弹窗</button>
    </AccessibleDialog>
  </main>;
}

export function mountDraftFocusProbe() {
  createRoot(document.getElementById("root")!).render(<DraftFocusProbe />);
}
