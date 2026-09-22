import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { OperationNotice } from "./operationNotifications";
import "./activity-notices.css";

type Placement = { top: number; left: number; width: number; height: number; compact: boolean; area: string };
const observedSelectors = ".workspace, .topbar, .planning-pane, .planning-heading, .planning-tabs, .planning-tab-content, .planning-scroll, .message-composer, .canvas-column, .build-view, .build-view-heading";
function visibleBounds(element: Element | null) {
  if (!(element instanceof HTMLElement) || !element.getClientRects().length || getComputedStyle(element).visibility === "hidden") return null;
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
  return right - left > 100 && bottom - top > 24 ? { left, top, right, bottom } : null;
}
function noticePlacement(): Placement {
  const history = [...document.querySelectorAll(".planning-tab-content:not([hidden]) .planning-scroll")].map(visibleBounds).find(Boolean);
  const canvas = visibleBounds(document.querySelector('[data-testid="diagram-canvas"] .react-flow'));
  const build = visibleBounds(document.querySelector(".build-view"));
  const buildHeading = visibleBounds(document.querySelector(".build-view-heading"));
  if (build && buildHeading) build.top = Math.max(build.top, buildHeading.bottom);
  const toolbar = visibleBounds(document.querySelector(".workspace > .topbar"));
  const rect = history ?? canvas ?? build ?? { left: 0, top: toolbar?.bottom ?? 0, right: innerWidth, bottom: innerHeight };
  const available = Math.max(24, rect.bottom - rect.top);
  const gap = available < 90 ? 2 : 8;
  const width = Math.min(360, rect.right - rect.left - gap * 2);
  const height = Math.min(280, Math.max(64, available * .48), available - gap * 2);
  return { left: rect.right - width - gap, top: rect.top + gap, width, height, compact: height < 130, area: history ? "chat" : canvas ? "canvas" : build ? "build" : "workspace" };
}

export default function ActivityNotices({ notices, dismiss, open }: {
  notices: OperationNotice[];
  dismiss: (id: string) => void;
  open: (notice: OperationNotice) => void | Promise<void>;
}) {
  const host = useRef<HTMLElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const visible = notices.length > 0;
  useLayoutEffect(() => {
    if (!visible) return;
    let frame = 0;
    const observed = new Set<Element>();
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    const measure = () => {
      frame = 0;
      const current = new Set(document.querySelectorAll(observedSelectors));
      for (const element of observed) if (!current.has(element)) { resize?.unobserve(element); observed.delete(element); }
      for (const element of current) if (!observed.has(element)) { resize?.observe(element); observed.add(element); }
      const next = noticePlacement();
      setPlacement(previous => previous && Object.keys(next).every(key => previous[key as keyof Placement] === next[key as keyof Placement]) ? previous : next);
    };
    const mutations = new MutationObserver(records => {
      if (records.some(record => !host.current?.contains(record.target))) schedule();
    });
    const workspace = document.querySelector(".workspace");
    if (workspace) mutations.observe(workspace, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    measure();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => { cancelAnimationFrame(frame); resize?.disconnect(); mutations.disconnect(); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); };
  }, [visible]);
  useEffect(() => {
    const remember = () => {
      if (document.activeElement instanceof HTMLElement && !host.current?.contains(document.activeElement)) priorFocus.current = document.activeElement;
    };
    remember();
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);
  if (!visible) return null;
  const style = placement ? { "--activity-top": `${placement.top}px`, "--activity-left": `${placement.left}px`, "--activity-width": `${placement.width}px`, "--activity-height": `${placement.height}px` } as CSSProperties : { visibility: "hidden" } as CSSProperties;
  return <aside ref={host} className={`activity-notices${placement?.compact ? " is-compact" : ""}`} aria-label="Activity notifications" data-placement={placement?.area} style={style}>
    {notices.map((notice) => <article key={notice.id} className={`activity-notice ${notice.severity}`}>
      <div className="activity-notice-heading"><div role="status"><strong>{notice.title}</strong></div><button className="icon-button" aria-label={`Dismiss ${notice.title}`} onClick={() => { dismiss(notice.id); if (priorFocus.current?.isConnected) priorFocus.current.focus({ preventScroll: true }); }}>×</button></div>
      <p>{notice.detail}</p>
      {notice.navigationError && <p role="alert">{notice.navigationError}</p>}
      <button onClick={() => void open(notice)} aria-label={`Open ${notice.title}`}>Open result</button>
    </article>)}
  </aside>;
}
