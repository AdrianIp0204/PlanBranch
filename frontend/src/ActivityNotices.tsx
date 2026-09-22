import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { OperationNotice } from "./operationNotifications";
import "./activity-notices.css";

export default function ActivityNotices({ notices, dismiss, open }: {
  notices: OperationNotice[];
  dismiss: (id: string) => void;
  open: (notice: OperationNotice) => void | Promise<void>;
}) {
  const host = useRef<HTMLElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const [top, setTop] = useState(76);
  useEffect(() => {
    const toolbar = document.querySelector(".workspace > .topbar");
    if (!toolbar) return;
    const measure = () => setTop(Math.max(8, Math.ceil(toolbar.getBoundingClientRect().bottom) + 8));
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(toolbar);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  useEffect(() => {
    const remember = () => {
      if (document.activeElement instanceof HTMLElement && !host.current?.contains(document.activeElement)) priorFocus.current = document.activeElement;
    };
    remember();
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);
  if (!notices.length) return null;
  return <aside ref={host} className="activity-notices" aria-label="Activity notifications" style={{ "--activity-top": `${top}px` } as CSSProperties}>
    {notices.map((notice) => <article key={notice.id} className={`activity-notice ${notice.severity}`}>
      <div className="activity-notice-heading"><div role="status"><strong>{notice.title}</strong></div><button className="icon-button" aria-label={`Dismiss ${notice.title}`} onClick={() => { dismiss(notice.id); if (priorFocus.current?.isConnected) priorFocus.current.focus({ preventScroll: true }); }}>×</button></div>
      <p>{notice.detail}</p>
      {notice.navigationError && <p role="alert">{notice.navigationError}</p>}
      <button onClick={() => void open(notice)} aria-label={`Open ${notice.title}`}>Open result</button>
    </article>)}
  </aside>;
}
