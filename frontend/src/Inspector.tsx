import { useState } from "react";
import { useProject } from "./store";
import { Field, StatusMark } from "./ui";
import {
  nodeKinds,
  statuses,
  uid,
  type Diagram,
  type TaskNode,
  type DetectedSymbol,
  type Status,
  type NodeKind,
  type NodeLink,
} from "./types";
export default function Inspector({
  diagram,
  selected,
  symbols,
  onSelect,
  onVariable,
}: {
  diagram: Diagram;
  selected: string | null;
  symbols: DetectedSymbol[];
  onSelect: (id: string | null) => void;
  onVariable: (id: string) => void;
}) {
  const { session, change, commit } = useProject();
  const content = session.content;
  const node = diagram.nodes.find((n) => n.id === selected);
  const edge = diagram.edges.find((e) => e.id === selected);
  const [linkChoice, setLinkChoice] = useState("");
  const editNode = (key: keyof TaskNode, value: unknown, group = true) => {
    if (node)
      change(
        (c) => {
          const n = c.diagrams
            .find((d) => d.id === diagram.id)!
            .nodes.find((n) => n.id === node.id)!;
          Object.assign(n, { [key]: value });
          if (key === "type" && value !== "decision") {
            for (const edge of c.diagrams.find((d) => d.id === diagram.id)!
              .edges) {
              if (
                edge.source === n.id &&
                ["yes", "no"].includes(edge.sourceHandle ?? "")
              )
                edge.sourceHandle = "out";
            }
          }
        },
        `Edit node ${key}`,
        diagram.id,
        group,
      );
  };
  const deleteSelected = () => {
    if (
      !window.confirm(
        `Delete this ${node ? "node and its connections" : "connection"}?`,
      )
    )
      return;
    change(
      (c) => {
        const d = c.diagrams.find((d) => d.id === diagram.id)!;
        if (node) {
          d.nodes = d.nodes.filter((n) => n.id !== node.id);
          d.edges = d.edges.filter(
            (e) => e.source !== node.id && e.target !== node.id,
          );
          c.nodeLinks = c.nodeLinks.filter((l) => l.nodeId !== node.id);
        } else d.edges = d.edges.filter((e) => e.id !== edge!.id);
      },
      `Delete ${node?.title ?? "connection"}`,
      diagram.id,
    );
    onSelect(null);
  };
  if (!node && !edge)
    return (
      <aside className="inspector">
        <div className="section-heading">Project notes</div>
        <p className="muted">Select a node or connection to inspect it.</p>
        <Field label="Project name">
          <input
            value={content.name}
            onChange={(e) =>
              change(
                (c) => {
                  c.name = e.target.value;
                },
                "Rename project",
                undefined,
                true,
              )
            }
            onBlur={commit}
          />
        </Field>
        <Field label="Notes">
          <textarea
            className="project-notes"
            value={content.notes}
            placeholder="Ideas, constraints, things to come back to…"
            onChange={(e) =>
              change(
                (c) => {
                  c.notes = e.target.value;
                },
                "Edit project notes",
                undefined,
                true,
              )
            }
            onBlur={commit}
          />
        </Field>
        <div className="inspector-tip">
          <strong>Your plan, at your pace.</strong>
          <p>
            Notes and task status are yours to record. Code scans keep their
            observations separate.
          </p>
        </div>
      </aside>
    );
  if (edge)
    return (
      <aside className="inspector">
        <div className="section-heading">Connection</div>
        <Field label="Branch label">
          <input
            autoFocus
            value={edge.label}
            placeholder="Yes, No, or a condition"
            onChange={(e) =>
              change(
                (c) => {
                  c.diagrams
                    .find((d) => d.id === diagram.id)!
                    .edges.find((x) => x.id === edge.id)!.label =
                    e.target.value;
                },
                "Edit connection label",
                diagram.id,
                true,
              )
            }
            onBlur={commit}
          />
        </Field>
        <p className="muted">
          {diagram.nodes.find((n) => n.id === edge.source)?.title} →{" "}
          {diagram.nodes.find((n) => n.id === edge.target)?.title}
        </p>
        <p className="muted">
          Drag either connection endpoint on the canvas to reconnect it.
        </p>
        <button className="danger quiet" onClick={deleteSelected}>
          Delete connection
        </button>
      </aside>
    );
  const n = node!;
  const links = content.nodeLinks.filter((l) => l.nodeId === n.id);
  const textField = (
    label: string,
    key: keyof TaskNode,
    multiline = false,
    mono = false,
  ) => (
    <Field label={label}>
      {multiline ? (
        <textarea
          className={mono ? "mono" : ""}
          value={String(n[key])}
          onChange={(e) => editNode(key, e.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          className={mono ? "mono" : ""}
          value={String(n[key])}
          onChange={(e) => editNode(key, e.target.value)}
          onBlur={commit}
        />
      )}
    </Field>
  );
  return (
    <aside className="inspector">
      <div className="section-heading">
        Node details <span>{nodeKinds[n.type]}</span>
      </div>
      {textField("Title", "title")}
      <div className="field-row">
        <Field label="Shape">
          <select
            value={n.type}
            onChange={(e) =>
              editNode("type", e.target.value as NodeKind, false)
            }
          >
            {Object.entries(nodeKinds).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            value={n.status}
            onChange={(e) =>
              editNode("status", e.target.value as Status, false)
            }
          >
            {Object.entries(statuses).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {n.status === "blocked" &&
        textField("What is blocking this?", "blocker", true)}
      {textField("Description", "description", true)}
      <div className="inspector-section">
        <div className="section-heading">
          Checklist{" "}
          <span>
            {n.checklist.filter((i) => i.checked).length}/{n.checklist.length}
          </span>
        </div>
        {n.checklist.map((item) => (
          <div className="checklist-item" key={item.id}>
            <input
              type="checkbox"
              aria-label={`Complete ${item.text || "checklist item"}`}
              checked={item.checked}
              onChange={(e) =>
                editNode(
                  "checklist",
                  n.checklist.map((x) =>
                    x.id === item.id ? { ...x, checked: e.target.checked } : x,
                  ),
                  false,
                )
              }
            />
            <input
              aria-label="Checklist text"
              value={item.text}
              onChange={(e) =>
                editNode(
                  "checklist",
                  n.checklist.map((x) =>
                    x.id === item.id ? { ...x, text: e.target.value } : x,
                  ),
                )
              }
              onBlur={commit}
            />
            <button
              className="icon-button"
              aria-label="Delete checklist item"
              onClick={() => {
                if (window.confirm("Delete this checklist item?"))
                  editNode(
                    "checklist",
                    n.checklist.filter((x) => x.id !== item.id),
                    false,
                  );
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button
          className="quiet add-item"
          onClick={() =>
            editNode(
              "checklist",
              [...n.checklist, { id: uid(), text: "", checked: false }],
              false,
            )
          }
        >
          + Add checklist item
        </button>
        <small>Checking items does not change task status.</small>
      </div>
      {textField("Notes", "notes", true)}
      {textField("Pseudocode", "pseudocode", true, true)}
      {n.type === "decision" && (
        <>
          {textField("Why this choice?", "why", true)}
          {textField("Alternatives considered", "alternatives", true)}
        </>
      )}
      {textField("Target file", "targetFile", false, true)}
      {textField("Function / scope", "targetScope", false, true)}
      <div className="inspector-section">
        <div className="section-heading">
          Linked variables <span>{links.length}</span>
        </div>
        {links.map((link) => {
          const variable =
            link.origin === "planned"
              ? content.variables.find((v) => v.id === link.variableId)
              : symbols.find((v) => v.id === link.variableId);
          return (
            <div className="linked-variable" key={link.id}>
              <button
                className="quiet mono"
                onClick={() => onVariable(link.variableId)}
              >
                {variable?.name ?? "Unavailable symbol"}
              </button>
              <small>{link.origin}</small>
              <select
                aria-label={`Relationship for ${variable?.name}`}
                value={link.relationship}
                onChange={(e) =>
                  change(
                    (c) => {
                      c.nodeLinks.find((l) => l.id === link.id)!.relationship =
                        e.target.value as NodeLink["relationship"];
                    },
                    "Edit variable relationship",
                    diagram.id,
                  )
                }
              >
                {["unspecified", "reads", "writes", "creates"].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
              <button
                className="icon-button"
                aria-label="Unlink variable"
                onClick={() =>
                  change(
                    (c) => {
                      c.nodeLinks = c.nodeLinks.filter((l) => l.id !== link.id);
                    },
                    "Unlink variable",
                    diagram.id,
                  )
                }
              >
                ×
              </button>
            </div>
          );
        })}
        <div className="field-row">
          <select
            aria-label="Variable to link"
            value={linkChoice}
            onChange={(e) => setLinkChoice(e.target.value)}
          >
            <option value="">Choose variable…</option>
            <optgroup label="Planned">
              {content.variables.map((v) => (
                <option key={v.id} value={`planned:${v.id}`}>
                  {v.name || "Untitled variable"}
                </option>
              ))}
            </optgroup>
            <optgroup label="Detected">
              {symbols.map((v) => (
                <option key={v.id} value={`detected:${v.id}`}>
                  {v.name} · {v.scope || "module"}
                </option>
              ))}
            </optgroup>
          </select>
          <button
            disabled={!linkChoice}
            onClick={() => {
              const [origin, variableId] = linkChoice.split(":");
              if (
                !links.some(
                  (l) => l.variableId === variableId && l.origin === origin,
                )
              )
                change(
                  (c) => {
                    c.nodeLinks.push({
                      id: uid(),
                      nodeId: n.id,
                      variableId,
                      origin: origin as NodeLink["origin"],
                      relationship: "unspecified",
                    });
                  },
                  "Link variable",
                  diagram.id,
                );
              setLinkChoice("");
            }}
          >
            Link
          </button>
        </div>
        <small>Relationships are user-authored plans.</small>
      </div>
      <div className="inspector-actions">
        <button
          onClick={() => {
            const duplicate = structuredClone(n);
            duplicate.id = uid();
            duplicate.title = `${n.title} copy`;
            duplicate.position = { x: n.position.x + 40, y: n.position.y + 40 };
            duplicate.checklist = duplicate.checklist.map((i) => ({
              ...i,
              id: uid(),
            }));
            change(
              (c) => {
                c.diagrams
                  .find((d) => d.id === diagram.id)!
                  .nodes.push(duplicate);
                c.nodeLinks.push(
                  ...links.map((l) => ({
                    ...l,
                    id: uid(),
                    nodeId: duplicate.id,
                  })),
                );
              },
              `Duplicate ${n.title}`,
              diagram.id,
            );
            onSelect(duplicate.id);
          }}
        >
          Duplicate node
        </button>
        <button className="danger quiet" onClick={deleteSelected}>
          Delete node
        </button>
      </div>
    </aside>
  );
}
