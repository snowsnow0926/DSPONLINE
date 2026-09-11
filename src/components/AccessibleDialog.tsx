import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import "../styles/accessible-dialog.css";

export type AccessibleDialogRole = "dialog" | "alertdialog";
export type AccessibleDialogRiskPolicy = "dismissible" | "explicit";
export type AccessibleDialogCloseReason = "escape" | "backdrop" | "external";

export type AccessibleDialogBackgroundResolver = (
  portalBoundary: HTMLElement,
) => Iterable<HTMLElement>;

export interface AccessibleDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  role?: AccessibleDialogRole;
  /**
   * `dismissible` lets Escape request a safe close. `explicit` consumes Escape
   * without closing, for flows that must end through a visible action.
   */
  riskPolicy?: AccessibleDialogRiskPolicy;
  /** Defaults to true only for a dismissible dialog. */
  dismissOnBackdrop?: boolean;
  onRequestClose: (reason: AccessibleDialogCloseReason) => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Defaults to document.body. A dedicated overlay root is also supported. */
  portalTarget?: HTMLElement | null;
  /**
   * Overrides the default portal-sibling walk used to make the background
   * inert. Use collectAccessibleDialogBackgroundElements() to compose extras.
   */
  getBackgroundElements?: AccessibleDialogBackgroundResolver;
  /** Optional platform event (for example a native back action) that requests a safe close. */
  externalCloseEventName?: string;
  id?: string;
  className?: string;
  backdropClassName?: string;
  /**
   * `bare` keeps a consumer's established internal layout while retaining the
   * modal, focus and inert-background contract supplied by this component.
   */
  layout?: "structured" | "bare";
  /** Required by bare layouts because no generated heading is rendered. */
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
}

export interface AccessibleModalSurfaceOptions {
  open: boolean;
  boundaryRef: RefObject<HTMLElement | null>;
  surfaceRef: RefObject<HTMLElement | null>;
  riskPolicy?: AccessibleDialogRiskPolicy;
  onRequestClose: (reason: AccessibleDialogCloseReason) => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  getBackgroundElements?: AccessibleDialogBackgroundResolver;
  /** Extra chrome that belongs to the modal interaction even when it is not a DOM child. */
  getAdditionalFocusRoots?: (surface: HTMLElement) => Iterable<HTMLElement>;
  externalCloseEventName?: string;
  /** Rebuilds the lifecycle when an inline host or portal target changes. */
  lifecycleKey?: unknown;
}

interface InertSnapshot {
  count: number;
  inertAttribute: string | null;
  inertProperty: boolean;
  ariaHiddenAttribute: string | null;
}

interface ModalStackEntry {
  token: symbol;
  ownerDocument: Document;
  surface: HTMLElement;
  backgroundElements: () => HTMLElement[];
  interactionRoots: () => HTMLElement[];
  returnTarget: HTMLElement | null;
  sequence: number;
}

interface ScrollLockSnapshot {
  count: number;
  bodyOverflow: string;
  rootOverflow: string;
  bodyOverscrollBehavior: string;
  rootOverscrollBehavior: string;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "[contenteditable='true']",
  "[tabindex]",
].join(",");

const inertSnapshots = new WeakMap<HTMLElement, InertSnapshot>();
const documentInertElements = new WeakMap<Document, HTMLElement[]>();
const scrollLockSnapshots = new WeakMap<Document, ScrollLockSnapshot>();
const modalStack: ModalStackEntry[] = [];
let modalSequence = 0;

function isDisabled(element: HTMLElement): boolean {
  if (element.getAttribute("aria-disabled") === "true") return true;
  return "disabled" in element && Boolean((element as HTMLButtonElement).disabled);
}

function isHiddenOrInert(element: HTMLElement): boolean {
  if (element.closest("[hidden], [inert], [aria-hidden='true']")) return true;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(element);
  return style.display === "none" || style.visibility === "hidden";
}

function canReceiveProgrammaticFocus(element: HTMLElement): boolean {
  if (!element.isConnected || isDisabled(element) || isHiddenOrInert(element)) return false;
  if (element.tabIndex >= 0 || element.hasAttribute("tabindex")) return true;
  return element.matches("a[href], area[href], button, input, select, textarea, iframe, object, embed, [contenteditable='true']");
}

function isTabbable(element: HTMLElement): boolean {
  return canReceiveProgrammaticFocus(element) && element.tabIndex >= 0;
}

function getTabbableElements(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .map((element, documentIndex) => ({ element, documentIndex }))
    .filter(({ element }) => isTabbable(element))
    .sort((left, right) => {
      const leftPositive = left.element.tabIndex > 0;
      const rightPositive = right.element.tabIndex > 0;
      if (leftPositive && rightPositive && left.element.tabIndex !== right.element.tabIndex) {
        return left.element.tabIndex - right.element.tabIndex;
      }
      if (leftPositive !== rightPositive) return leftPositive ? -1 : 1;
      return left.documentIndex - right.documentIndex;
    })
    .map(({ element }) => element);
}

function focusWithoutScrolling(element: HTMLElement | null): boolean {
  if (!element || !canReceiveProgrammaticFocus(element)) return false;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
  return element.ownerDocument.activeElement === element;
}

function acquireInert(element: HTMLElement): void {
  const current = inertSnapshots.get(element);
  if (current) {
    current.count += 1;
  } else {
    inertSnapshots.set(element, {
      count: 1,
      inertAttribute: element.getAttribute("inert"),
      inertProperty: element.inert,
      ariaHiddenAttribute: element.getAttribute("aria-hidden"),
    });
  }
  element.inert = true;
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
}

function releaseInert(element: HTMLElement): void {
  const snapshot = inertSnapshots.get(element);
  if (!snapshot) return;
  snapshot.count -= 1;
  if (snapshot.count > 0) return;
  inertSnapshots.delete(element);

  element.inert = snapshot.inertProperty;
  if (snapshot.inertAttribute === null) element.removeAttribute("inert");
  else element.setAttribute("inert", snapshot.inertAttribute);
  if (snapshot.ariaHiddenAttribute === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", snapshot.ariaHiddenAttribute);
}

function lockDocumentScroll(ownerDocument: Document): void {
  const current = scrollLockSnapshots.get(ownerDocument);
  if (current) {
    current.count += 1;
    return;
  }
  const body = ownerDocument.body;
  const root = ownerDocument.documentElement;
  scrollLockSnapshots.set(ownerDocument, {
    count: 1,
    bodyOverflow: body.style.overflow,
    rootOverflow: root.style.overflow,
    bodyOverscrollBehavior: body.style.overscrollBehavior,
    rootOverscrollBehavior: root.style.overscrollBehavior,
  });
  body.style.overflow = "hidden";
  root.style.overflow = "hidden";
  body.style.overscrollBehavior = "none";
  root.style.overscrollBehavior = "none";
}

function unlockDocumentScroll(ownerDocument: Document): void {
  const snapshot = scrollLockSnapshots.get(ownerDocument);
  if (!snapshot) return;
  snapshot.count -= 1;
  if (snapshot.count > 0) return;
  scrollLockSnapshots.delete(ownerDocument);
  ownerDocument.body.style.overflow = snapshot.bodyOverflow;
  ownerDocument.documentElement.style.overflow = snapshot.rootOverflow;
  ownerDocument.body.style.overscrollBehavior = snapshot.bodyOverscrollBehavior;
  ownerDocument.documentElement.style.overscrollBehavior = snapshot.rootOverscrollBehavior;
}

function topModal(ownerDocument: Document, closingToken?: symbol): ModalStackEntry | null {
  let top: ModalStackEntry | null = null;
  for (const entry of modalStack) {
    if (entry.ownerDocument !== ownerDocument || (!entry.surface.isConnected && entry.token !== closingToken)) continue;
    if (!top || entry.sequence > top.sequence) top = entry;
  }
  return top;
}

/** Only the current top surface owns isolation; lower surfaces cannot inert it. */
function refreshDocumentIsolation(ownerDocument: Document): void {
  const top = topModal(ownerDocument);
  const next = new Set<HTMLElement>();
  if (top) {
    const roots = top.interactionRoots();
    const isolate = (element: HTMLElement): void => {
      if (roots.some((root) => root === element || root.contains(element))) return;
      if (roots.some((root) => element.contains(root))) {
        // An external focus root exempts its own branch, not its whole parent.
        for (const child of Array.from(element.children)) {
          if (child instanceof HTMLElement) isolate(child);
        }
      } else {
        next.add(element);
      }
    };
    for (const entry of modalStack) {
      if (entry.ownerDocument === ownerDocument && entry.surface.isConnected) {
        for (const element of entry.backgroundElements()) isolate(element);
      }
    }
  }
  for (const element of (documentInertElements.get(ownerDocument) ?? []).reverse()) releaseInert(element);
  for (const element of next) acquireInert(element);
  if (next.size) documentInertElements.set(ownerDocument, [...next]);
  else documentInertElements.delete(ownerDocument);
}

function registerModal(entry: Omit<ModalStackEntry, "sequence">): ModalStackEntry {
  const registered = { ...entry, sequence: ++modalSequence };
  modalStack.push(registered);
  refreshDocumentIsolation(entry.ownerDocument);
  return registered;
}

function unregisterModal(token: symbol): void {
  const index = modalStack.findIndex((entry) => entry.token === token);
  if (index < 0) return;
  const [entry] = modalStack.splice(index, 1);
  for (const remaining of modalStack) {
    if (remaining.ownerDocument === entry.ownerDocument && remaining.returnTarget && entry.surface.contains(remaining.returnTarget)) {
      remaining.returnTarget = entry.returnTarget;
    }
  }
  refreshDocumentIsolation(entry.ownerDocument);
}

function isTopModal(token: symbol, ownerDocument: Document): boolean {
  return topModal(ownerDocument)?.token === token;
}

/**
 * Returns every sibling outside the portal branch, at each ancestor level.
 * This keeps a dialog operable even when its portal target is nested rather
 * than being a direct child of document.body.
 */
export function collectAccessibleDialogBackgroundElements(portalBoundary: HTMLElement): HTMLElement[] {
  const elements = new Set<HTMLElement>();
  let branch: HTMLElement = portalBoundary;
  let parent = branch.parentElement;
  while (parent) {
    for (const child of Array.from(parent.children)) {
      if (child !== branch && child instanceof HTMLElement) elements.add(child);
    }
    if (parent === portalBoundary.ownerDocument.body) break;
    branch = parent;
    parent = parent.parentElement;
  }
  return [...elements];
}

function resolveBackgroundElements(
  boundary: HTMLElement,
  resolver: AccessibleDialogBackgroundResolver | undefined,
): HTMLElement[] {
  const candidates = resolver
    ? Array.from(resolver(boundary))
    : collectAccessibleDialogBackgroundElements(boundary);
  const ownerDocument = boundary.ownerDocument;
  return [...new Set(candidates)].filter((element) => (
    element instanceof HTMLElement
    && element.ownerDocument === ownerDocument
    && element !== ownerDocument.body
    && element !== ownerDocument.documentElement
    && element !== boundary
    && !element.contains(boundary)
    && !boundary.contains(element)
  ));
}

function sanitizedReactId(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized || "dialog";
}

export function useAccessibleModalSurface({
  open,
  boundaryRef,
  surfaceRef,
  riskPolicy = "dismissible",
  onRequestClose,
  initialFocusRef,
  returnFocusRef,
  getBackgroundElements,
  getAdditionalFocusRoots,
  externalCloseEventName,
  lifecycleKey,
}: AccessibleModalSurfaceOptions): void {
  const lastFocusedInsideRef = useRef<HTMLElement | null>(null);
  const modalTokenRef = useRef(Symbol("accessible-modal-surface"));
  const latestRef = useRef({
    getBackgroundElements,
    getAdditionalFocusRoots,
    initialFocusRef,
    onRequestClose,
    returnFocusRef,
    riskPolicy,
  });
  latestRef.current = {
    getBackgroundElements,
    getAdditionalFocusRoots,
    initialFocusRef,
    onRequestClose,
    returnFocusRef,
    riskPolicy,
  };

  useLayoutEffect(() => {
    const boundary = boundaryRef.current;
    const surface = surfaceRef.current;
    if (!open || !boundary || !surface) return;

    const ownerDocument = boundary.ownerDocument;
    const token = modalTokenRef.current;
    const activeElement = ownerDocument.activeElement instanceof HTMLElement
      ? ownerDocument.activeElement
      : null;
    const explicitReturnTarget = latestRef.current.returnFocusRef?.current ?? null;
    const returnTarget = explicitReturnTarget ?? activeElement;
    const resolveAdditionalFocusRoots = (): HTMLElement[] => [...new Set(
      latestRef.current.getAdditionalFocusRoots
        ? Array.from(latestRef.current.getAdditionalFocusRoots(surface))
        : [],
    )].filter((element) => (
      element instanceof HTMLElement
      && element.ownerDocument === ownerDocument
      && element.isConnected
      && element !== surface
      && !surface.contains(element)
    ));
    const modalContains = (element: HTMLElement | null): boolean => Boolean(
      element && (surface.contains(element) || resolveAdditionalFocusRoots().some((root) => root.contains(element))),
    );
    const modalTabbables = (): HTMLElement[] => [surface, ...resolveAdditionalFocusRoots()]
      .flatMap((root) => getTabbableElements(root))
      .sort((left, right) => {
        if (left === right) return 0;
        return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    let redirectingFocus = false;
    let escapeRequested = false;

    const stackEntry = registerModal({
      token,
      ownerDocument,
      surface,
      backgroundElements: () => resolveBackgroundElements(boundary, latestRef.current.getBackgroundElements),
      interactionRoots: () => [boundary, surface, ...resolveAdditionalFocusRoots()],
      returnTarget,
    });
    lockDocumentScroll(ownerDocument);

    const preferredInitialFocus = latestRef.current.initialFocusRef?.current ?? null;
    const autoFocusTarget = surface.querySelector<HTMLElement>("[autofocus], [data-dialog-autofocus]");
    const firstTabbable = getTabbableElements(surface)[0] ?? null;
    const initialTarget = preferredInitialFocus && surface.contains(preferredInitialFocus)
      ? preferredInitialFocus
      : autoFocusTarget ?? firstTabbable ?? surface;
    if (!focusWithoutScrolling(initialTarget)) focusWithoutScrolling(surface);
    lastFocusedInsideRef.current = ownerDocument.activeElement instanceof HTMLElement
      && surface.contains(ownerDocument.activeElement)
      ? ownerDocument.activeElement
      : surface;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopModal(token, ownerDocument)) return;
      if (event.key === "Escape") {
        if (event.isComposing) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (latestRef.current.riskPolicy === "dismissible" && !event.repeat && !escapeRequested) {
          escapeRequested = true;
          latestRef.current.onRequestClose("escape");
        }
        return;
      }
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;

      const tabbable = modalTabbables();
      if (tabbable.length === 0) {
        event.preventDefault();
        event.stopPropagation();
        focusWithoutScrolling(surface);
        return;
      }

      const active = ownerDocument.activeElement instanceof HTMLElement
        ? ownerDocument.activeElement
        : null;
      const activeIndex = active ? tabbable.indexOf(active) : -1;
      const shouldWrapBackward = event.shiftKey && activeIndex <= 0;
      const shouldWrapForward = !event.shiftKey && (activeIndex < 0 || activeIndex === tabbable.length - 1);
      if (!shouldWrapBackward && !shouldWrapForward) return;
      event.preventDefault();
      event.stopPropagation();
      focusWithoutScrolling(shouldWrapBackward ? tabbable[tabbable.length - 1] : tabbable[0]);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") escapeRequested = false;
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!isTopModal(token, ownerDocument) || redirectingFocus) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (modalContains(target)) {
        lastFocusedInsideRef.current = target;
        return;
      }
      redirectingFocus = true;
      const lastFocused = lastFocusedInsideRef.current;
      if (!lastFocused || !modalContains(lastFocused) || !focusWithoutScrolling(lastFocused)) {
        focusWithoutScrolling(getTabbableElements(surface)[0] ?? surface);
      }
      redirectingFocus = false;
    };

    const onExternalClose = (event: Event) => {
      if (!isTopModal(token, ownerDocument)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (latestRef.current.riskPolicy === "dismissible") latestRef.current.onRequestClose("external");
    };

    ownerDocument.addEventListener("keydown", onKeyDown, true);
    ownerDocument.addEventListener("keyup", onKeyUp, true);
    ownerDocument.addEventListener("focusin", onFocusIn, true);
    if (externalCloseEventName) ownerDocument.defaultView?.addEventListener(externalCloseEventName, onExternalClose, true);

    return () => {
      ownerDocument.removeEventListener("keydown", onKeyDown, true);
      ownerDocument.removeEventListener("keyup", onKeyUp, true);
      ownerDocument.removeEventListener("focusin", onFocusIn, true);
      if (externalCloseEventName) ownerDocument.defaultView?.removeEventListener(externalCloseEventName, onExternalClose, true);
      // React may remove the portal DOM before running this layout cleanup.
      const wasTop = topModal(ownerDocument, token)?.token === token;
      unregisterModal(token);
      unlockDocumentScroll(ownerDocument);
      lastFocusedInsideRef.current = null;
      const restoredReturnTarget = stackEntry.returnTarget;
      if (wasTop && !focusWithoutScrolling(restoredReturnTarget)) {
        const remaining = topModal(ownerDocument);
        if (remaining) focusWithoutScrolling(getTabbableElements(remaining.surface)[0] ?? remaining.surface);
      }
    };
  }, [boundaryRef, externalCloseEventName, lifecycleKey, open, surfaceRef]);
}

export function AccessibleDialog({
  open,
  title,
  description,
  children,
  actions,
  role = "dialog",
  riskPolicy = "dismissible",
  dismissOnBackdrop,
  onRequestClose,
  initialFocusRef,
  returnFocusRef,
  portalTarget,
  getBackgroundElements,
  externalCloseEventName,
  id,
  className = "",
  backdropClassName = "",
  layout = "structured",
  ariaLabel,
  ariaLabelledBy,
  ariaDescribedBy,
}: AccessibleDialogProps) {
  const generatedId = useId();
  const boundaryRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLElement>(null);
  const backdropGestureRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const requestRef = useRef({
    dismissOnBackdrop,
    onRequestClose,
    riskPolicy,
  });
  requestRef.current = {
    dismissOnBackdrop,
    onRequestClose,
    riskPolicy,
  };

  const resolvedId = id ?? `accessible-dialog-${sanitizedReactId(generatedId)}`;
  const titleId = `${resolvedId}-title`;
  const descriptionId = `${resolvedId}-description`;
  const isBareLayout = layout === "bare";
  const canUseDom = typeof document !== "undefined";
  const resolvedPortalTarget = canUseDom ? (portalTarget ?? document.body) : null;

  useAccessibleModalSurface({
    open,
    boundaryRef,
    surfaceRef,
    riskPolicy,
    onRequestClose,
    initialFocusRef,
    returnFocusRef,
    getBackgroundElements,
    externalCloseEventName,
    lifecycleKey: resolvedPortalTarget,
  });

  if (!open || !resolvedPortalTarget) return null;

  const shouldDismissOnBackdrop = dismissOnBackdrop ?? riskPolicy === "dismissible";
  const requestBackdropClose = () => {
    if (shouldDismissOnBackdrop) requestRef.current.onRequestClose("backdrop");
  };

  return createPortal(
    <div
      ref={boundaryRef}
      className="accessible-dialog-portal"
      data-accessible-dialog-boundary="true"
    >
      <div
        className={`accessible-dialog__backdrop${backdropClassName ? ` ${backdropClassName}` : ""}`}
        role="presentation"
        onPointerDown={(event) => {
          if (
            event.target !== event.currentTarget
            || event.button !== 0
            || !shouldDismissOnBackdrop
          ) return;
          backdropGestureRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          };
        }}
        onPointerUp={(event) => {
          const gesture = backdropGestureRef.current;
          backdropGestureRef.current = null;
          if (
            !gesture
            || gesture.pointerId !== event.pointerId
            || event.target !== event.currentTarget
          ) return;
          const moved = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
          if (moved <= 10) requestBackdropClose();
        }}
        onPointerCancel={() => {
          backdropGestureRef.current = null;
        }}
      >
        <section
          ref={surfaceRef}
          id={resolvedId}
          className={`accessible-dialog__surface${className ? ` ${className}` : ""}`}
          role={role}
          aria-modal="true"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy ?? (isBareLayout ? undefined : titleId)}
          aria-describedby={ariaDescribedBy ?? (isBareLayout || description === undefined ? undefined : descriptionId)}
          data-risk-policy={riskPolicy}
          tabIndex={-1}
        >
          {isBareLayout ? children : <>
            <header className="accessible-dialog__header">
              <h2 id={titleId}>{title}</h2>
              {description === undefined
                ? null
                : <p id={descriptionId}>{description}</p>}
            </header>
            {children === undefined ? null : <div className="accessible-dialog__body">{children}</div>}
            {actions === undefined ? null : <footer className="accessible-dialog__actions">{actions}</footer>}
          </>}
        </section>
      </div>
    </div>,
    resolvedPortalTarget,
  );
}
