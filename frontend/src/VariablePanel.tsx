import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
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
export function planState(
  v: PlannedVariable,
  matches: { plannedId: string; symbolId: string; decision: string }[],
  symbols: DetectedSymbol[],
) {
  const linked = matches.filter(
    (m) => m.plannedId === v.id && m.decision === "confirmed",
  );
  if (!linked.length) return "Planned only";
  const found = linked.map((m) => symbols.find((s) => s.id === m.symbolId));
  if (
    found.some(
      (s) => !s || ["stale", "unverified", "historical"].includes(s.state),
    )
  )
    return "Stale scan";
  if (found.some((s) => s?.state === "not_detected"))
    return "Linked, not detected";
  return "Linked and detected";
}
export default function VariablePanel({
  symbols,
  focus,
  setFocus,
  onReveal,
  onClose,
  reconciliation,
}: {
  symbols: DetectedSymbol[];
  focus: string | null;
  setFocus: (id: string | null) => void;
  onReveal: (id: string) => void;
  onClose: () => void;
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
  const plan = c.variables.find((v) => v.id === focus);
  const symbol = symbols.find((v) => v.id === focus);
  const record = plan ?? symbol;
  useEffect(() => {
    setPreview(null);
    setError("");
  }, [focus]);
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
        })),
        ...symbols.map((v) => ({
          id: v.id,
          name: v.name,
          file: v.file,
          scope: v.scope,
          origin: "detected",
          status: v.state,
          state: v.state.replaceAll("_", " "),
          type: v.annotation || "unknown",
        })),
      ].filter(
        (v) =>
          (origin === "all" || v.origin === origin) &&
          (status === "all" || v.status === status) &&
          (linked === "all" ||
            c.nodeLinks.some(
              (l) =>
                l.variableId === v.id &&
                c.diagrams
                  .find((d) => d.id === linked)
                  ?.nodes.some((n) => n.id === l.nodeId),
            )) &&
          `${v.name} ${v.file} ${v.scope}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [c, symbols, origin, status, linked, search],
  );
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
  const links = c.nodeLinks.filter((l) => l.variableId === focus);
  const proposals = reconciliation.suggestions
    .filter((s) => s.plannedId === focus || s.symbolId === focus)
    .filter(
      (s) =>
        !c.matches.some(
          (m) => m.plannedId === s.plannedId && m.symbolId === s.symbolId,
        ),
    );
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
    <section className="variable-panel" aria-label="Variable catalogue">
      <div className="drawer-bar">
        <div>
          <strong>Variable catalogue</strong>
          <span className="muted">
            {c.variables.length} planned · {symbols.length} detected
          </span>
        </div>
        <button
          className="quiet"
          onClick={() => {
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
            setFocus(v.id);
          }}
        >
          + Plan variable
        </button>
        <button
          className="icon-button"
          aria-label="Close variable panel"
          onClick={onClose}
        >
          ⌄
        </button>
      </div>
      <div className="variable-body">
        <div className="variable-list">
          <div className="catalogue-filters">
            <input
              aria-label="Search variables"
              placeholder="Search name, file, scope…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Variable origin"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
            >
              <option value="all">All origins</option>
              <option value="planned">Planned</option>
              <option value="detected">Detected</option>
            </select>
            <select
              aria-label="Variable status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">All statuses</option>
              {Object.entries(statuses).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
              {["current", "stale", "not_detected", "historical"].map((k) => (
                <option key={k} value={k}>
                  {k === "historical"
                    ? "Historical / unverified"
                    : k.replaceAll("_", " ")}
                </option>
              ))}
            </select>
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
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name / scope</th>
                  <th>Origin</th>
                  <th>File</th>
                  <th>Type / annotation</th>
                  <th>Plan vs code</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr
                    key={v.id}
                    className={focus === v.id ? "selected" : ""}
                    onClick={() => {
                      commit();
                      setFocus(v.id);
                    }}
                  >
                    <td>
                      <button
                        className="table-name mono"
                        onClick={() => {
                          commit();
                          setFocus(v.id);
                        }}
                      >
                        {v.name || "Untitled variable"}
                      </button>
                      <small className="mono">
                        {v.scope || "Scope not specified"}
                      </small>
                    </td>
                    <td>
                      <span className={`origin-label ${v.origin}`}>
                        {v.origin === "planned" ? "Planned" : "Detected"}
                      </span>
                    </td>
                    <td className="mono" title={v.file}>
                      {v.file || "—"}
                    </td>
                    <td className="mono">{v.type || "Undecided"}</td>
                    <td>
                      <StatusMark status={v.status} />
                      {v.state}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <div className="small-empty">
                {search
                  ? "No matching variables."
                  : "Plan a variable now, even before its file exists. Scan Python code to add separate observations."}
              </div>
            )}
          </div>
        </div>
        {record && (
          <div className="variable-detail">
            <div className="section-heading">
              {plan ? "Variable plan" : "Code observation"}
              <button
                className="icon-button"
                aria-label="Close variable details"
                onClick={() => setFocus(null)}
              >
                ×
              </button>
            </div>
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
                    {symbol!.state.replaceAll("_", " ")} ·{" "}
                    {symbol!.scanTime
                      ? new Date(symbol!.scanTime).toLocaleString()
                      : "Imported"}
                  </dd>
                </dl>
                <button
                  onClick={async () => {
                    try {
                      setPreview(
                        await api(
                          `/projects/${session.id}/symbols/${symbol!.id}/preview`,
                        ),
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Read source preview
                </button>
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
            <div className="inspector-section">
              <div className="section-heading">Linked nodes</div>
              {links.map((l) => {
                const d = c.diagrams.find((d) =>
                  d.nodes.some((n) => n.id === l.nodeId),
                );
                const n = d?.nodes.find((n) => n.id === l.nodeId);
                return (
                  <div className="linked-variable" key={l.id}>
                    <button
                      className="quiet"
                      onClick={() => onReveal(l.nodeId)}
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
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  disabled={!linkNode}
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
            </div>
            <div className="inspector-section">
              <div className="section-heading">Plan and code matches</div>
              {c.matches
                .filter((m) => m.plannedId === focus || m.symbolId === focus)
                .map((m) => (
                  <div className="match-row" key={m.id}>
                    <strong className="mono">
                      {plan
                        ? (symbols.find((s) => s.id === m.symbolId)?.name ??
                          "Missing symbol")
                        : (c.variables.find((p) => p.id === m.plannedId)
                            ?.name ?? "Missing plan")}
                    </strong>
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
                <div className="match-row" key={`${p.plannedId}:${p.symbolId}`}>
                  <strong className="mono">
                    {plan
                      ? symbols.find((s) => s.id === p.symbolId)?.name
                      : c.variables.find((v) => v.id === p.plannedId)?.name}
                  </strong>
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
                <Field label="Link a detected symbol">
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value)
                        decide(plan.id, e.target.value, "confirmed");
                    }}
                  >
                    <option value="">Choose exact binding…</option>
                    {symbols.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.file} · {s.scope || "module"}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <small>
                Detection does not mark a task or variable complete.
              </small>
            </div>
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
