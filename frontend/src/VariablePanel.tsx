import { useEffect, useMemo, useRef, useState } from "react";
import "./catalogue.css";
import { api } from "./api";
import { evidenceState, planState, symbolDescription } from "./catalogue";
export { planState } from "./catalogue";
import { useProject } from "./store";
import { Field, StatusMark, ErrorMessage } from "./ui";
import {
  statuses,
  uid,
  type DetectedSymbol,
  type PlannedVariable,
  type NodeLink,
  type Reconciliation,
} from "./types";
export default function VariablePanel({
  symbols,
  focus,
  setFocus,
  onReveal,
  onClose,
  onAttachSource,
  reconciliation,
}: {
  symbols: DetectedSymbol[];
  focus: string | null;
  setFocus: (id: string | null) => void;
  onReveal: (id: string) => void;
  onClose: () => void;
  onAttachSource?: () => void;
  reconciliation: Reconciliation;
}) {
  const { session, change, commit } = useProject();
  const c = session.content;
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState("all");
  const [status, setStatus] = useState("all");
  const [linked, setLinked] = useState("all");
  const [preview, setPreview] = useState<{
    text: string;
    stale: boolean;
    file: string;
    line: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [linkNode, setLinkNode] = useState("");
  const [matchChoice, setMatchChoice] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRequest = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const detailScroll = useRef<HTMLDivElement>(null);
  const detailsSection = useRef<HTMLElement>(null);
  const linksSection = useRef<HTMLElement>(null);
  const reviewSection = useRef<HTMLElement>(null);
  const plan = c.variables.find((v) => v.id === focus);
  const symbol = symbols.find((v) => v.id === focus);
  const record = plan ?? symbol;
  useEffect(() => {
    previewRequest.current += 1;
    setPreview(null);
    setError("");
    setLinkNode("");
    setMatchChoice("");
    setPreviewLoading(false);
  }, [focus, symbol?.hash, symbol?.state]);
  const rows = useMemo(
    () =>
      [
        ...c.variables.map((v) => ({
          id: v.id,
          name: v.name,
          file: v.intendedFile,
          scope: v.scope,
          origin: "planned",
          status: v.status,
          state: planState(v, c.matches, symbols),
          type: v.intendedType,
          line: null as number | null,
        })),
        ...symbols.map((v) => ({
          id: v.id,
          name: v.name,
          file: v.file,
          scope: v.scope,
          origin: "detected",
          status: v.state,
          state: evidenceState(v),
          type: v.annotation || "unknown",
          line: v.locations[0]?.line ?? null,
        })),
      ].filter(
        (v) =>
          (origin === "all" || v.origin === origin) &&
          (status === "all" || v.status === status) &&
          (linked === "all" ||
            c.nodeLinks.some(
              (l) =>
                l.variableId === v.id &&
                l.origin === v.origin &&
                c.diagrams
                  .find((d) => d.id === linked)
                  ?.nodes.some((n) => n.id === l.nodeId),
            )) &&
          `${v.name} ${v.file} ${v.scope}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      ),
    [c, symbols, origin, status, linked, search],
  );
  const clearFilters = () => {
    setSearch("");
    setOrigin("all");
    setStatus("all");
    setLinked("all");
  };
  const filtersActive =
    !!search || origin !== "all" || status !== "all" || linked !== "all";
  const selectRecord = (id: string) => {
    commit();
    setFocus(id);
    requestAnimationFrame(() => {
      const selectedRow = rowButtons.current.get(id);
      if (!selectedRow?.getClientRects().length)
        document.getElementById("variable-detail-heading")?.focus();
    });
  };
  const closeDetail = () => {
    commit();
    const previous = focus;
    setFocus(null);
    requestAnimationFrame(() => {
      const button = previous ? rowButtons.current.get(previous) : undefined;
      (button ?? searchInput.current)?.focus();
    });
  };
  const jumpTo = (section: HTMLElement | null) => {
    if (!section || !detailScroll.current) return;
    const header = detailScroll.current.querySelector(
      ".variable-detail-header",
    );
    const stickyHeight =
      header && getComputedStyle(header).position === "sticky"
        ? header.getBoundingClientRect().height
        : 0;
    detailScroll.current.scrollTop +=
      section.getBoundingClientRect().top -
      detailScroll.current.getBoundingClientRect().top -
      stickyHeight -
      12;
    section.focus({ preventScroll: true });
  };
  const addPlan = () => {
    const v: PlannedVariable = {
      id: uid(),
      name: "new_variable",
      description: "",
      intendedType: "",
      intendedFile: "",
      scopeKind: "unknown",
      scope: "",
      initialExpression: "",
      notes: "",
      status: "not_started",
    };
    change((d) => {
      d.variables.push(v);
    }, "Add planned variable");
    clearFilters();
    setFocus(v.id);
    requestAnimationFrame(() =>
      document.getElementById("variable-detail-heading")?.focus(),
    );
  };
  useEffect(() => {
    // A node inspector can reveal a variable hidden by a previous filter.
    if (focus && (plan || symbol) && !rows.some((row) => row.id === focus)) {
      setSearch("");
      setOrigin("all");
      setStatus("all");
      setLinked("all");
    }
  }, [focus]);
  const edit = (key: keyof PlannedVariable, value: string, group = true) =>
    change(
      (d) => {
        Object.assign(
          d.variables.find((v) => v.id === plan!.id)!,
          { [key]: value },
        );
      },
      `Edit variable ${key}`,
      undefined,
      group,
    );
  const text = (
    label: string,
    key: keyof PlannedVariable,
    multi = false,
    hint?: string,
  ) => (
    <Field label={label} hint={hint}>
      {multi ? (
        <textarea
          value={String(plan![key])}
          onChange={(e) => edit(key, e.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          className={
            [
              "name",
              "intendedType",
              "intendedFile",
              "scope",
              "initialExpression",
            ].includes(key)
              ? "mono"
              : ""
          }
          value={String(plan![key])}
          onChange={(e) => edit(key, e.target.value)}
          onBlur={commit}
        />
      )}
    </Field>
  );
  const links = c.nodeLinks.filter(
    (l) =>
      l.variableId === focus && l.origin === (plan ? "planned" : "detected"),
  );
  const proposals = reconciliation.suggestions
    .filter((s) => s.plannedId === focus || s.symbolId === focus)
    .filter(
      (s) =>
        !c.matches.some(
          (m) => m.plannedId === s.plannedId && m.symbolId === s.symbolId,
        ),
    );
  const decisions = c.matches.filter(
    (m) => m.plannedId === focus || m.symbolId === focus,
  );
  const chosenSymbol = symbols.find((s) => s.id === matchChoice);
  const explanation = symbol
    ? ["historical", "unverified"].includes(symbol.state)
      ? "Imported evidence has not been verified here. Attach a source folder, scan, then review and link the fresh observations."
      : symbol.state === "not_detected"
        ? "A successful check no longer found this binding. Its history and your links are kept for review."
        : symbol.state === "stale"
          ? "This file was not checked successfully. These are the last observations; rescan before relying on their locations."
          : symbol.ambiguousIdentity
            ? "More than one binding shares this scope. Use the file and source line to review the exact binding before linking."
            : "Found in the latest successful scan. Detection does not establish correctness or completion."
    : "Your intended name, type and status remain separate from code observations.";
  const decide = (
    plannedId: string,
    symbolId: string,
    decision: "confirmed" | "rejected",
  ) =>
    change(
      (d) => {
        d.matches = d.matches.filter(
          (m) => m.plannedId !== plannedId || m.symbolId !== symbolId,
        );
        d.matches.push({ id: uid(), plannedId, symbolId, decision });
      },
      `${decision === "confirmed" ? "Confirm" : "Reject"} symbol match`,
    );
  return (
    <section
      id="variable-catalogue"
      className={`variable-panel${record ? " has-detail" : ""}`}
      aria-label="Variable catalogue"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        if (e.target instanceof HTMLSelectElement) return;
        e.preventDefault();
        e.stopPropagation();
        if (record) closeDetail();
        else {
          commit();
          onClose();
        }
      }}
    >
      <div className="drawer-bar">
        <div>
          <strong>Variable catalogue</strong>
          <span className="muted">
            {c.variables.length} planned · {symbols.length} detected
          </span>
        </div>
        <button className="quiet" onClick={addPlan}>
          + Plan variable
        </button>
        <button
          className="icon-button"
          aria-label="Close variable panel"
          onClick={() => {
            commit();
            onClose();
          }}
        >
          ⌄
        </button>
      </div>
      <div className="variable-body">
        <div className="variable-list">
          <div className="catalogue-filters">
            <label className="catalogue-search">
              Find variable
              <input
                ref={searchInput}
                id="catalogue-search"
                aria-label="Search variables"
                placeholder="Search name, file, scope…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label>
              Origin
              <select
                aria-label="Variable origin"
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
              >
                <option value="all">All origins</option>
                <option value="planned">Planned</option>
                <option value="detected">Detected</option>
              </select>
            </label>
            <label>
              Status
              <select
                aria-label="Variable status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="all">All statuses</option>
                <optgroup label="Planned status">
                  {Object.entries(statuses).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Detected evidence">
                  {["current", "stale", "not_detected", "historical"].map(
                    (k) => (
                      <option key={k} value={k}>
                        {k === "historical"
                          ? "Historical / unverified"
                          : k.replaceAll("_", " ")}
                      </option>
                    ),
                  )}
                </optgroup>
              </select>
            </label>
            <label>
              Linked diagram
              <select
                aria-label="Diagram link filter"
                value={linked}
                onChange={(e) => setLinked(e.target.value)}
              >
                <option value="all">All diagrams</option>
                {c.diagrams.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="catalogue-results">
            <span role="status" aria-live="polite">
              {rows.length} of {c.variables.length + symbols.length} results
              {filtersActive ? " · Filters active" : ""}
            </span>
            {filtersActive ? (
              <button
                className="quiet"
                onClick={() => {
                  clearFilters();
                  searchInput.current?.focus();
                }}
              >
                Clear filters
              </button>
            ) : (
              <span className="catalogue-key-hint">↑ ↓ to choose</span>
            )}
          </div>
          <div className="table-scroll">
            <table aria-label="Variables and code evidence">
              <thead>
                <tr>
                  <th>Variable / location</th>
                  <th>Origin / status</th>
                  <th>Type / evidence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v, index) => (
                  <tr
                    data-variable-id={v.id}
                    data-origin={v.origin}
                    key={v.id}
                    className={focus === v.id ? "selected" : ""}
                    onClick={() => {
                      selectRecord(v.id);
                      rowButtons.current.get(v.id)?.focus();
                    }}
                  >
                    <td>
                      <button
                        className="table-name mono"
                        ref={(element) => {
                          if (element) rowButtons.current.set(v.id, element);
                          else rowButtons.current.delete(v.id);
                        }}
                        tabIndex={
                          focus === v.id ||
                          (!rows.some((row) => row.id === focus) && index === 0)
                            ? 0
                            : -1
                        }
                        aria-pressed={focus === v.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          selectRecord(v.id);
                        }}
                        onKeyDown={(e) => {
                          if (
                            !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                              e.key,
                            )
                          )
                            return;
                          e.preventDefault();
                          e.stopPropagation();
                          const next =
                            e.key === "Home"
                              ? 0
                              : e.key === "End"
                                ? rows.length - 1
                                : Math.max(
                                    0,
                                    Math.min(
                                      rows.length - 1,
                                      index + (e.key === "ArrowDown" ? 1 : -1),
                                    ),
                                  );
                          selectRecord(rows[next].id);
                          rowButtons.current.get(rows[next].id)?.focus();
                        }}
                      >
                        {v.name || "Untitled variable"}
                      </button>
                      <small className="mono">
                        {v.file || "File not specified"}
                      </small>
                      <small className="mono">
                        {v.scope ||
                          (v.origin === "detected"
                            ? "Module scope"
                            : "Scope not specified")}
                        {v.line !== null ? ` · line ${v.line}` : ""}
                      </small>
                    </td>
                    <td>
                      <span className={`origin-label ${v.origin}`}>
                        {v.origin === "planned" ? "Planned" : "Detected"}
                      </span>
                      <small className="catalogue-row-status">
                        <StatusMark status={v.status} />
                        {v.origin === "planned"
                          ? statuses[v.status as keyof typeof statuses]
                          : v.state}
                      </small>
                    </td>
                    <td>
                      <span className="mono">{v.type || "Undecided"}</span>
                      <small>
                        {v.origin === "planned"
                          ? v.state
                          : "Written annotation"}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <div className="small-empty">
                <strong>
                  {filtersActive
                    ? "No variables match these filters."
                    : "No variables yet."}
                </strong>
                <p>
                  {filtersActive
                    ? "Clear the filters to see the full catalogue, or plan a new variable."
                    : "Plan a variable before its file exists, or attach Python source to inspect code evidence."}
                </p>
                <div className="catalogue-empty-actions">
                  {filtersActive && (
                    <button
                      onClick={() => {
                        clearFilters();
                        searchInput.current?.focus();
                      }}
                    >
                      Show all variables
                    </button>
                  )}
                  <button onClick={addPlan}>Plan a variable</button>
                  {!symbols.length && onAttachSource && (
                    <button onClick={onAttachSource}>
                      Attach source folder
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        {record && (
          <div className="variable-detail" key={record.id} ref={detailScroll}>
            <div className="variable-detail-header">
              <div className="section-heading">
                <h3 id="variable-detail-heading" tabIndex={-1}>
                  {plan ? "Variable plan" : "Code observation"}
                </h3>
                <button
                  className="quiet catalogue-back"
                  aria-label="Close variable details"
                  onClick={closeDetail}
                >
                  ← List
                </button>
              </div>
              <p className="selected-variable-name mono">
                {record.name || "Untitled variable"}
              </p>
              <nav
                className="variable-detail-nav"
                aria-label="Variable detail sections"
              >
                <button
                  className="quiet"
                  onClick={() => jumpTo(detailsSection.current)}
                >
                  {plan ? "Plan details" : "Evidence"}
                </button>
                <button
                  className="quiet"
                  onClick={() => jumpTo(linksSection.current)}
                >
                  Node links ({links.length})
                </button>
                <button
                  className="quiet"
                  onClick={() => jumpTo(reviewSection.current)}
                >
                  Code review ({decisions.length + proposals.length})
                </button>
              </nav>
            </div>
            <section
              className="variable-record-section"
              aria-label={plan ? "Plan details" : "Evidence details"}
              ref={detailsSection}
              tabIndex={-1}
            >
              {symbol && <p className="catalogue-explanation">{explanation}</p>}
              {plan ? (
                <>
                  {text(
                    "Name",
                    "name",
                    false,
                    plan.name && !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(plan.name)
                      ? "This is not a conventional Python identifier. Your idea can still be saved."
                      : undefined,
                  )}
                  {text("Purpose", "description", true)}
                  <Field label="Implementation status">
                    <select
                      value={plan.status}
                      onChange={(e) => edit("status", e.target.value, false)}
                    >
                      {Object.entries(statuses).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {text("Intended type", "intendedType")}
                  {text(
                    "Intended file",
                    "intendedFile",
                    false,
                    "Relative path; the file does not need to exist.",
                  )}
                  <Field label="Intended scope kind">
                    <select
                      value={plan.scopeKind}
                      onChange={(e) => edit("scopeKind", e.target.value, false)}
                    >
                      {[
                        "unknown",
                        "module",
                        "function",
                        "class",
                        "comprehension",
                      ].map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                  </Field>
                  {text("Qualified function / class", "scope")}
                  {text(
                    "Initial expression",
                    "initialExpression",
                    false,
                    "Stored as text; never evaluated.",
                  )}
                  {text("Implementation notes", "notes", true)}
                  <p className="review-state">
                    {planState(plan, c.matches, symbols)}
                  </p>
                  {reconciliation.reviews
                    .filter((r) => r.plannedId === plan.id)
                    .flatMap((r) => r.differences)
                    .map((d, i) => (
                      <p className="review-note" key={i}>
                        Review: {d}
                      </p>
                    ))}
                </>
              ) : (
                <>
                  <h3 className="mono">{symbol!.name}</h3>
                  <dl className="symbol-facts">
                    <dt>Kind</dt>
                    <dd>
                      {symbol!.kind}
                      {symbol!.heuristic ? " (heuristic)" : ""}
                    </dd>
                    <dt>File</dt>
                    <dd className="mono">{symbol!.file}</dd>
                    <dt>Scope</dt>
                    <dd className="mono">
                      {symbol!.scope || "Module"} · {symbol!.scopeKind}
                    </dd>
                    <dt>Written annotation</dt>
                    <dd className="mono">{symbol!.annotation || "unknown"}</dd>
                    <dt>Binding locations</dt>
                    <dd>
                      {symbol!.locations
                        .map((l) => `Line ${l.line}:${l.column}`)
                        .join(", ") || "Unavailable"}
                    </dd>
                    <dt>Declarations</dt>
                    <dd>
                      {symbol!.declarations.length
                        ? JSON.stringify(symbol!.declarations)
                        : "None"}
                    </dd>
                    <dt>Evidence</dt>
                    <dd>
                      {evidenceState(symbol!)} ·{" "}
                      {symbol!.scanTime
                        ? new Date(symbol!.scanTime).toLocaleString()
                        : "Imported"}
                    </dd>
                    {symbol!.ambiguousIdentity && (
                      <>
                        <dt>Identity review</dt>
                        <dd>
                          {symbol!.identityNote ||
                            "Repeated or anonymous scope. Inspect the source line before confirming a match."}
                        </dd>
                      </>
                    )}
                    {symbol!.freshnessReason && (
                      <>
                        <dt>Freshness</dt>
                        <dd>{symbol!.freshnessReason}</dd>
                      </>
                    )}
                  </dl>
                  <button
                    disabled={previewLoading}
                    onClick={async () => {
                      const request = ++previewRequest.current;
                      setError("");
                      setPreviewLoading(true);
                      try {
                        const result = await api<{
                          text: string;
                          stale: boolean;
                          file: string;
                          line: number;
                        }>(
                          `/projects/${session.id}/symbols/${symbol!.id}/preview`,
                        );
                        if (request === previewRequest.current)
                          setPreview(result);
                      } catch (e) {
                        if (request === previewRequest.current)
                          setError((e as Error).message);
                      } finally {
                        if (request === previewRequest.current)
                          setPreviewLoading(false);
                      }
                    }}
                  >
                    Read source preview
                  </button>
                  {previewLoading && (
                    <span role="status">Loading source preview…</span>
                  )}
                  <ErrorMessage message={error} />
                  {preview && (
                    <>
                      <small>
                        {preview.stale
                          ? "Source changed: this location may be stale."
                          : "Read-only source preview"}
                      </small>
                      <pre className="source-preview">{preview.text}</pre>
                    </>
                  )}
                </>
              )}
            </section>
            <section
              className="inspector-section"
              aria-label="Linked nodes"
              ref={linksSection}
              tabIndex={-1}
            >
              <div className="section-heading">
                Linked nodes <span>{links.length}</span>
              </div>
              {!links.length && (
                <p className="catalogue-explanation">
                  Choose a node below to connect this{" "}
                  {plan ? "plan" : "observation"} to your diagram.
                </p>
              )}
              {links.map((l) => {
                const d = c.diagrams.find((d) =>
                  d.nodes.some((n) => n.id === l.nodeId),
                );
                const n = d?.nodes.find((n) => n.id === l.nodeId);
                return (
                  <div className="linked-variable" key={l.id}>
                    <button
                      className="quiet"
                      onClick={() => {
                        commit();
                        onReveal(l.nodeId);
                      }}
                    >
                      {n?.title ?? "Missing node"}
                    </button>
                    <small>{d?.name}</small>
                    <select
                      aria-label="Planned relationship"
                      value={l.relationship}
                      onChange={(e) =>
                        change((d) => {
                          d.nodeLinks.find((x) => x.id === l.id)!.relationship =
                            e.target.value as NodeLink["relationship"];
                        }, "Edit variable relationship")
                      }
                    >
                      {["unspecified", "reads", "writes", "creates"].map(
                        (k) => (
                          <option key={k}>{k}</option>
                        ),
                      )}
                    </select>
                    <button
                      className="icon-button"
                      aria-label="Unlink node"
                      onClick={() =>
                        change((d) => {
                          d.nodeLinks = d.nodeLinks.filter(
                            (x) => x.id !== l.id,
                          );
                        }, "Unlink node")
                      }
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <div className="field-row">
                <select
                  value={linkNode}
                  aria-label="Node to link"
                  onChange={(e) => setLinkNode(e.target.value)}
                >
                  <option value="">Choose node…</option>
                  {c.diagrams.map((d) => (
                    <optgroup key={d.id} label={d.name}>
                      {d.nodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.title}
                          {links.some((l) => l.nodeId === n.id)
                            ? " · linked"
                            : ""}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  disabled={!linkNode}
                  title={
                    !linkNode ? "Choose a node to enable linking" : undefined
                  }
                  onClick={() => {
                    if (!links.some((l) => l.nodeId === linkNode))
                      change((d) => {
                        d.nodeLinks.push({
                          id: uid(),
                          nodeId: linkNode,
                          variableId: record.id,
                          origin: plan ? "planned" : "detected",
                          relationship: "unspecified",
                        });
                      }, "Link node");
                    setLinkNode("");
                  }}
                >
                  Link
                </button>
              </div>
              <small>Relationships are user-authored plans.</small>
            </section>
            <section
              className="inspector-section"
              aria-label="Plan and code matches"
              ref={reviewSection}
              tabIndex={-1}
            >
              <div className="section-heading">Plan and code matches</div>
              <p className="catalogue-explanation">
                Confirm an exact binding, or reject a suggestion. To relink,
                confirm its replacement and remove the old decision.
              </p>
              {!decisions.length && !proposals.length && (
                <p className="catalogue-explanation">
                  No matches yet.{" "}
                  {plan
                    ? "Choose detected evidence below, or scan Python source for suggestions."
                    : "Choose a planned variable to connect this observation to your intent."}
                </p>
              )}
              {decisions.map((m) => (
                <div className="match-row" key={m.id} data-match-id={m.id}>
                  <button
                    className="quiet match-record mono"
                    onClick={() =>
                      selectRecord(plan ? m.symbolId : m.plannedId)
                    }
                  >
                    {plan
                      ? (symbols.find((s) => s.id === m.symbolId)?.name ??
                        "Missing symbol")
                      : (c.variables.find((p) => p.id === m.plannedId)?.name ??
                        "Missing plan")}
                  </button>
                  <small>
                    {(() => {
                      const evidence = symbols.find(
                        (item) => item.id === m.symbolId,
                      );
                      return evidence
                        ? symbolDescription(evidence)
                        : "Missing observation";
                    })()}
                  </small>
                  <span>{m.decision}</span>
                  <button
                    className="quiet"
                    onClick={() =>
                      change((d) => {
                        d.matches = d.matches.filter((x) => x.id !== m.id);
                      }, "Remove match decision")
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
              {proposals.map((p) => (
                <div
                  className="match-row"
                  key={`${p.plannedId}:${p.symbolId}`}
                  data-symbol-id={p.symbolId}
                >
                  <strong className="mono">
                    {plan
                      ? symbols.find((s) => s.id === p.symbolId)?.name
                      : c.variables.find((v) => v.id === p.plannedId)?.name}
                  </strong>
                  <small>
                    {(() => {
                      const evidence = symbols.find(
                        (item) => item.id === p.symbolId,
                      );
                      return evidence
                        ? symbolDescription(evidence)
                        : "Missing observation";
                    })()}
                  </small>
                  <small>{p.reasons.join(" · ")}</small>
                  <button
                    onClick={() => decide(p.plannedId, p.symbolId, "confirmed")}
                  >
                    Confirm
                  </button>
                  <button
                    className="quiet"
                    onClick={() => decide(p.plannedId, p.symbolId, "rejected")}
                  >
                    Reject
                  </button>
                </div>
              ))}
              {plan && (
                <>
                  <Field label="Link a detected symbol">
                    <select
                      value={matchChoice}
                      onChange={(e) => setMatchChoice(e.target.value)}
                    >
                      <option value="">Choose exact binding…</option>
                      {symbols.map((s) => (
                        <option key={s.id} value={s.id}>
                          {symbolDescription(s)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {chosenSymbol && (
                    <p className="selected-binding-context mono">
                      {symbolDescription(chosenSymbol)}
                    </p>
                  )}
                  <button
                    disabled={!matchChoice}
                    onClick={() => {
                      if (matchChoice)
                        decide(plan.id, matchChoice, "confirmed");
                      setMatchChoice("");
                    }}
                  >
                    Confirm match
                  </button>
                  {!symbols.length && onAttachSource && (
                    <button className="quiet" onClick={onAttachSource}>
                      Attach source folder
                    </button>
                  )}
                </>
              )}
              <small>
                Detection does not mark a task or variable complete.
              </small>
            </section>
            {plan && (
              <button
                className="quiet danger"
                onClick={() => {
                  if (
                    window.confirm(
                      `Delete planned variable “${plan.name}” and its links?`,
                    )
                  ) {
                    change((d) => {
                      d.variables = d.variables.filter((v) => v.id !== plan.id);
                      d.nodeLinks = d.nodeLinks.filter(
                        (l) =>
                          !(l.origin === "planned" && l.variableId === plan.id),
                      );
                      d.matches = d.matches.filter(
                        (m) => m.plannedId !== plan.id,
                      );
                    }, "Delete planned variable");
                    setFocus(null);
                  }
                }}
              >
                Delete planned variable
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
