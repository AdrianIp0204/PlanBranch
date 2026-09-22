import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { OperationNotice } from "./operationNotifications";
import "./activity-notices.css";

export default function ActivityNotices({ notices, dismiss, open }: {
  notices: OperationNotice[];
  dismiss: (id: string) => void;
  open: (notice: OperationNotice) => void | Promise<void>;
}) {
  const host = useRef<HTMLElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const priorFocus = useRef<HTMLElement | null>(null);
  const resultsId = useId();
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const element = results.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [notices.length]);
  useEffect(() => {
    const remember = () => {
      if (document.activeElement instanceof HTMLElement && !host.current?.contains(document.activeElement)) priorFocus.current = document.activeElement;
    };
    remember();
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);
  if (!notices.length) return null;
  return <aside ref={host} className="activity-notices" aria-label="Activity notifications" data-placement="rail">
    <div className="activity-rail-heading">
      <strong>Activity <span>{notices.length}</span></strong>
      {overflow && <div className="activity-scroll-controls">
        <button className="icon-button" aria-label="Scroll to earlier activity" aria-controls={resultsId} onClick={() => results.current?.scrollBy({ left: -results.current.clientWidth * .8, behavior: "instant" })}>←</button>
        <button className="icon-button" aria-label="Scroll to later activity" aria-controls={resultsId} onClick={() => results.current?.scrollBy({ left: results.current.clientWidth * .8, behavior: "instant" })}>→</button>
      </div>}
    </div>
    <div ref={results} id={resultsId} className="activity-results">
      {notices.map((notice) => <article key={notice.id} className={`activity-notice ${notice.severity}`}>
        <div className="activity-notice-heading"><div role="status"><strong>{notice.title}</strong></div><button className="icon-button" aria-label={`Dismiss ${notice.title}`} onClick={() => { dismiss(notice.id); if (priorFocus.current?.isConnected) priorFocus.current.focus({ preventScroll: true }); }}>×</button></div>
        <p className="sr-only" id={`${resultsId}-${notice.id}`}>{notice.detail}</p>
        {notice.navigationError && <p role="alert" tabIndex={0}>{notice.navigationError}</p>}
        <button onClick={() => void open(notice)} aria-label={`Open ${notice.title}`} aria-describedby={`${resultsId}-${notice.id}`}>Open result</button>
      </article>)}
    </div>
  </aside>;
}
