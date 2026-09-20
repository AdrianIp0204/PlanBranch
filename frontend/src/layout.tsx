import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";

export const LAYOUT_KEY = "flowdesk.layout.v1";
export type Layout = {
  navigationOpen: boolean;
  inspectorOpen: boolean;
  catalogueOpen: boolean;
  sidePanel: "inspector" | "planning";
  inspectorWidth: number;
  chatWidth: number;
  composerHeight: number;
  catalogueHeight: number;
};
export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
export function defaultLayout(width = window.innerWidth): Layout {
  return {
    navigationOpen: width > 1050,
    inspectorOpen: true,
    catalogueOpen: false,
    sidePanel: "inspector",
    inspectorWidth: 340,
    chatWidth: 400,
    composerHeight: 150,
    catalogueHeight: 300,
  };
}
export function readLayout(): Layout {
  const defaults = defaultLayout();
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return defaults;
    if (saved.sidePanel === "planning" || saved.sidePanel === "inspector")
      defaults.sidePanel = saved.sidePanel;
    for (const key of [
      "navigationOpen",
      "inspectorOpen",
      "catalogueOpen",
    ] as const)
      if (typeof saved[key] === "boolean") defaults[key] = saved[key];
    for (const [key, min, max] of [
      ["inspectorWidth", 280, 520],
      ["catalogueHeight", 230, 600],
      ["chatWidth", 300, 680],
      ["composerHeight", 100, 600],
    ] as const)
      if (typeof saved[key] === "number" && Number.isFinite(saved[key]))
        defaults[key] = clamp(saved[key], min, max);
    return defaults;
  } catch {
    return defaults;
  }
}
export function useLayout() {
  const [layout, setLayout] = useState(readLayout);
  const [windowSize, setWindowSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* Layout works when storage is unavailable. */
    }
  }, [layout]);
  useEffect(() => {
    const resize = () =>
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const preference = useCallback(
    <K extends keyof Layout>(
      key: K,
      value: Layout[K] | ((previous: Layout[K]) => Layout[K]),
    ) => {
      setLayout((previous) => ({
        ...previous,
        [key]: typeof value === "function" ? value(previous[key]) : value,
      }));
    },
    [],
  );
  return {
    layout,
    preference,
    reset: () => setLayout(defaultLayout()),
    windowSize,
  };
}

/** Both panes sit after their divider, so left/up grows the controlled pane. */
export function ResizeHandle({
  label,
  controls,
  orientation,
  value,
  min,
  max,
  onChange,
  onCollapse,
}: {
  label: string;
  controls: string;
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCollapse?: () => void;
}) {
  const drag = useRef<{
    origin: number;
    size: number;
    pointerId: number;
  } | null>(null);
  const coordinate = (event: PointerEvent) =>
    orientation === "vertical" ? event.clientX : event.clientY;
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      className={`pane-resizer resize-${orientation}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-controls={controls}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${Math.round(value)} pixels`}
      aria-describedby={onCollapse ? "resize-help" : "composer-resize-help"}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
        drag.current = {
          origin: coordinate(event),
          size: value,
          pointerId: event.pointerId,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current || drag.current.pointerId !== event.pointerId) return;
        onChange(
          clamp(
            drag.current.size + drag.current.origin - coordinate(event),
            min,
            max,
          ),
        );
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        const grow = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
        const shrink = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
        if (![grow, shrink, "Home", "End", "Enter"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") {
          onCollapse?.();
          return;
        }
        const step = event.shiftKey ? 40 : 16;
        onChange(
          event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : clamp(value + (event.key === grow ? step : -step), min, max),
        );
      }}
    >
      <span aria-hidden="true" />
    </div>
  );
}

export function focusAfterLayout(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}
