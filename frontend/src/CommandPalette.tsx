import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Content, DetectedSymbol, ProjectSummary } from "./types";
import { Dialog, ErrorMessage } from "./ui";
import {
  buildCommandIndex,
  searchCommands,
  type CommandAction,
  type CommandEntry,
  type CommandResult,
} from "./commandSearch";
import "./command-palette.css";

export type CommandPaletteProps = {
  projects: ProjectSummary[];
  content: Content | null;
  symbols?: DetectedSymbol[];
  actions: CommandAction[];
  onChoose: (result: CommandResult) => Promise<void> | void;
  onClose: () => void;
};
export default function CommandPalette({
  projects,
  content,
  symbols,
  actions,
  onChoose,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const composing = useRef(false);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const index = useMemo(
    () => buildCommandIndex({ projects, content, symbols, actions }),
    [projects, content, symbols, actions],
  );
  const matches = useMemo(() => searchCommands(index, query), [index, query]);
  const found = matches.entries.findIndex((entry) => entry.key === activeKey);
  const activeIndex = found >= 0 ? found : 0;
  const active = matches.entries[activeIndex];
  const optionId = (entry: CommandEntry) =>
    `${id}-option-${matches.entries.indexOf(entry)}`;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active?.key]);
  const close = () => {
    if (!busyRef.current) onClose();
  };
  const choose = async (entry: CommandEntry) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onChoose(entry.result);
      if (alive.current) onClose();
    } catch (reason) {
      if (alive.current) {
        setError(
          reason instanceof Error
            ? reason.message
            : "That item could not be opened. Try again.",
        );
        input.current?.focus({ preventScroll: true });
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Dialog title="Quick jump" className="command-palette" onClose={close}>
      <label className="sr-only" htmlFor={`${id}-search`}>
        Search projects, items, and actions
      </label>
      <input
        ref={input}
        id={`${id}-search`}
        role="combobox"
        autoComplete="off"
        autoFocus
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded="true"
        aria-controls={`${id}-results`}
        aria-activedescendant={active ? optionId(active) : undefined}
        aria-describedby={`${id}-help`}
        placeholder="Search projects, items, or actions…"
        value={query}
        maxLength={240}
        readOnly={busy}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveKey(null);
          setError("");
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
          }
          if (busy) return;
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            if (!matches.entries.length) return;
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? matches.entries.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        matches.entries.length - 1,
                        activeIndex + (event.key === "ArrowDown" ? 1 : -1),
                      ),
                    );
            setActiveKey(matches.entries[next].key);
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (active) void choose(active);
          }
        }}
      />
      <p id={`${id}-help`} className="command-palette-help">
        ↑↓ to choose · Enter to open · Esc to close
      </p>
      <ErrorMessage message={error} />
      <div
        ref={list}
        id={`${id}-results`}
        role="listbox"
        aria-label="Search results"
        aria-busy={busy}
        className="command-palette-results"
      >
        {matches.groups.map((group) => (
          <div
            role="group"
            aria-label={group.name}
            key={group.name}
            className="command-palette-group"
          >
            <div className="command-palette-heading" aria-hidden="true">
              {group.name}
              <span>
                {group.total > group.entries.length
                  ? `${group.entries.length} of ${group.total}`
                  : group.total}
              </span>
            </div>
            {group.entries.map((entry) => (
              <div
                key={entry.key}
                id={optionId(entry)}
                role="option"
                aria-selected={entry.key === active?.key}
                className="command-palette-option"
                onPointerMove={() => {
                  if (!busyRef.current) setActiveKey(entry.key);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void choose(entry)}
              >
                <span>{entry.title}</span>
                <small>{entry.detail}</small>
              </div>
            ))}
          </div>
        ))}
      </div>
      {!matches.entries.length && (
        <div className="command-palette-empty">
          <p>No matching items.</p>
          <button
            onClick={() => {
              setQuery("");
              setActiveKey(null);
              input.current?.focus();
            }}
          >
            Clear search
          </button>
        </div>
      )}
      <p className="command-palette-count" role="status">
        {busy
          ? "Opening…"
          : `${matches.entries.length === matches.total ? matches.total : `${matches.entries.length} of ${matches.total}`} results${content ? " · Items in this project" : ""}`}
      </p>
    </Dialog>
  );
}
