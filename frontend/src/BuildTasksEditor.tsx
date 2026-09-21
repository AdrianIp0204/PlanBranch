import { useLayoutEffect, useRef, useState } from "react";
import {
  createBuildTask,
  nodeChoices,
  wouldCreateTaskCycle,
} from "./buildTasks";
import { statuses, uid, type BuildTask, type Diagram } from "./types";
import { Field } from "./ui";
import "./build-tasks.css";

export type BuildTasksEditorProps = {
  tasks: BuildTask[];
  diagrams: Diagram[];
  readOnly?: boolean;
  disabled?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onChange?: (
    edit: (tasks: BuildTask[]) => void,
    label: string,
    group?: boolean,
  ) => void;
  onCommit?: () => void;
  onRevealNode?: (diagramId: string, nodeId: string) => void;
};
export default function BuildTasksEditor({
  tasks,
  diagrams,
  readOnly = false,
  disabled = false,
  selectedId,
  onSelect,
  onChange,
  onCommit,
  onRevealNode,
}: BuildTasksEditorProps) {
  const [localId, setLocalId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [linkChoice, setLinkChoice] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);
  const focusNew = useRef<string | null>(null);
  const requested = selectedId === undefined ? localId : selectedId;
  const task = tasks.find((item) => item.id === requested) ?? tasks[0];
  const index = task ? tasks.findIndex((item) => item.id === task.id) : -1;
  const choices = nodeChoices(diagrams);
  const locked = readOnly || disabled || !onChange;
  useLayoutEffect(() => {
    if (task?.id === focusNew.current) {
      focusNew.current = null;
      titleInput.current?.focus();
      titleInput.current?.select();
    }
  }, [task?.id]);
  const select = (id: string | null) => {
    onCommit?.();
    setError("");
    setLinkChoice("");
    setLocalId(id);
    onSelect?.(id);
  };
  const update = (
    edit: (draft: BuildTask, all: BuildTask[]) => void,
    label: string,
    group = false,
  ) => {
    if (!task || locked) return;
    onChange?.(
      (all) => {
        const current = all.find((item) => item.id === task.id);
        if (current) edit(current, all);
      },
      label,
      group,
    );
  };
  const move = (offset: number) => {
    if (!task || locked) return;
    select(task.id);
    update((current, all) => {
      const from = all.findIndex((item) => item.id === current.id),
        to = from + offset;
      if (to < 0 || to >= all.length) return;
      all.splice(to, 0, all.splice(from, 1)[0]);
    }, "Reorder build tasks");
  };
  const add = () => {
    if (locked || tasks.length >= 1000) return;
    const next = createBuildTask();
    focusNew.current = next.id;
    onCommit?.();
    onChange?.((all) => all.push(next), "Add build task");
    select(next.id);
  };
  const remove = () => {
    if (!task || locked) return;
    const dependants = tasks.filter((item) =>
      item.prerequisiteIds.includes(task.id),
    ).length;
    if (
      !window.confirm(
        `Delete “${task.title || "Untitled task"}”?${dependants ? ` It will also be removed from ${dependants} prerequisite ${dependants === 1 ? "list" : "lists"}.` : ""}`,
      )
    )
      return;
    const nextId = tasks[index + 1]?.id ?? tasks[index - 1]?.id ?? null;
    onCommit?.();
    onChange?.((all) => {
      const position = all.findIndex((item) => item.id === task.id);
      if (position < 0) return;
      all.splice(position, 1);
      for (const item of all)
        item.prerequisiteIds = item.prerequisiteIds.filter(
          (id) => id !== task.id,
        );
    }, "Delete build task");
    select(nextId);
  };
  const chooseLink = (nodeId: string, replaceId?: string) => {
    const chosen = choices.find((item) => item.nodeId === nodeId);
    if (!chosen) return;
    update(
      (current) => {
        if (
          current.nodeLinks.some(
            (link) => link.nodeId === nodeId && link.nodeId !== replaceId,
          )
        )
          return;
        const link = {
          nodeId: chosen.nodeId,
          diagramId: chosen.diagramId,
          title: chosen.title,
          missing: false,
        };
        if (replaceId)
          current.nodeLinks = current.nodeLinks.map((item) =>
            item.nodeId === replaceId ? link : item,
          );
        else if (current.nodeLinks.length < 500) current.nodeLinks.push(link);
      },
      replaceId ? "Relink build task node" : "Link build task node",
    );
    setLinkChoice("");
  };
  return (
    <section className="build-tasks-editor" aria-label="Build tasks editor">
      <aside className="build-task-list" aria-label="Build task list">
        <div className="build-task-list-heading">
          <strong>
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
          </strong>
          {!readOnly && (
            <button onClick={add} disabled={disabled || tasks.length >= 1000}>
              New task
            </button>
          )}
        </div>
        {tasks.length ? (
          <ol>
            {tasks.map((item, position) => (
              <li key={item.id}>
                <button
                  className="build-task-choice"
                  aria-label={`Task: ${item.title || "Untitled task"}`}
                  aria-pressed={task?.id === item.id}
                  onClick={() => select(item.id)}
                >
                  <span className="build-task-number">{position + 1}</span>
                  <span className="build-task-title">
                    {item.title || "Untitled task"}
                  </span>
                  <span className="build-task-status">
                    {statuses[item.status]}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">
            {readOnly
              ? "No build tasks in this version."
              : "Add a task with a clear deliverable."}
          </p>
        )}
      </aside>
      {task ? (
        <div className="build-task-detail" key={task.id}>
          <div className="build-task-heading">
            <h2>{task.title || "Untitled task"}</h2>
            {!readOnly && (
              <div className="build-task-actions">
                <button
                  aria-label="Move task up"
                  disabled={disabled || index === 0}
                  onClick={() => move(-1)}
                >
                  ↑
                </button>
                <button
                  aria-label="Move task down"
                  disabled={disabled || index === tasks.length - 1}
                  onClick={() => move(1)}
                >
                  ↓
                </button>
                <button
                  className="quiet danger"
                  disabled={disabled}
                  onClick={remove}
                >
                  Delete task
                </button>
              </div>
            )}
          </div>
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
          <fieldset disabled={disabled} className="build-task-fields">
            <div className="build-task-basics">
              <Field label="Task title">
                <input
                  ref={titleInput}
                  value={task.title}
                  readOnly={readOnly}
                  maxLength={500}
                  onChange={(event) =>
                    update(
                      (current) => {
                        current.title = event.target.value;
                      },
                      "Edit task title",
                      true,
                    )
                  }
                  onBlur={onCommit}
                />
              </Field>
              <Field label="Task status">
                <select
                  value={task.status}
                  disabled={readOnly}
                  onChange={(event) =>
                    update((current) => {
                      current.status = event.target
                        .value as BuildTask["status"];
                    }, "Set task status")
                  }
                >
                  {Object.entries(statuses).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Deliverable">
              <textarea
                value={task.deliverable}
                readOnly={readOnly}
                maxLength={32768}
                rows={3}
                onChange={(event) =>
                  update(
                    (current) => {
                      current.deliverable = event.target.value;
                    },
                    "Edit task deliverable",
                    true,
                  )
                }
                onBlur={onCommit}
              />
            </Field>
            <section
              className="build-task-section"
              aria-label="Acceptance checks"
            >
              <div className="build-task-section-heading">
                <h3>Acceptance checks</h3>
                {!readOnly && (
                  <button
                    disabled={task.acceptanceChecks.length >= 500}
                    onClick={() =>
                      update(
                        (current) =>
                          current.acceptanceChecks.push({
                            id: uid(),
                            text: "",
                          }),
                        "Add acceptance check",
                      )
                    }
                  >
                    Add acceptance check
                  </button>
                )}
              </div>
              {!task.acceptanceChecks.length && (
                <p className="muted">No checks specified.</p>
              )}
              {task.acceptanceChecks.map((check, row) => (
                <div className="build-task-input-row" key={check.id}>
                  <Field label={`Acceptance check ${row + 1}`}>
                    <input
                      value={check.text}
                      readOnly={readOnly}
                      maxLength={4000}
                      onChange={(event) =>
                        update(
                          (current) => {
                            const value = current.acceptanceChecks.find(
                              (item) => item.id === check.id,
                            );
                            if (value) value.text = event.target.value;
                          },
                          "Edit acceptance check",
                          true,
                        )
                      }
                      onBlur={onCommit}
                    />
                  </Field>
                  {!readOnly && (
                    <button
                      aria-label={`Remove acceptance check ${row + 1}`}
                      onClick={() =>
                        update((current) => {
                          current.acceptanceChecks =
                            current.acceptanceChecks.filter(
                              (item) => item.id !== check.id,
                            );
                        }, "Remove acceptance check")
                      }
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </section>
            <details
              className="build-task-section"
              open={
                task.nodeLinks.some((link) => link.missing) ? true : undefined
              }
            >
              <summary>
                Linked nodes ({task.nodeLinks.length})
                {task.nodeLinks.some((link) => link.missing)
                  ? " · missing links"
                  : ""}
              </summary>
              {!task.nodeLinks.length && (
                <p className="muted">No linked nodes.</p>
              )}
              {task.nodeLinks.map((link) => (
                <div className="build-task-link" key={link.nodeId}>
                  <div>
                    {link.missing ? (
                      <span>
                        {link.title || "Untitled node"}{" "}
                        <strong className="build-task-missing">
                          Missing node
                        </strong>
                      </span>
                    ) : (
                      <button
                        className="quiet"
                        disabled={!onRevealNode}
                        onClick={() => {
                          onCommit?.();
                          onRevealNode?.(link.diagramId, link.nodeId);
                        }}
                      >
                        {link.title || "Untitled node"}
                      </button>
                    )}
                    <small>
                      {diagrams.find((diagram) => diagram.id === link.diagramId)
                        ?.name ?? "Removed diagram"}
                    </small>
                  </div>
                  {!readOnly && (
                    <>
                      {link.missing && (
                        <select
                          aria-label={`Relink ${link.title || "missing node"}`}
                          value=""
                          onChange={(event) =>
                            chooseLink(event.target.value, link.nodeId)
                          }
                        >
                          <option value="">Relink to…</option>
                          {choices
                            .filter(
                              (choice) =>
                                !task.nodeLinks.some(
                                  (item) => item.nodeId === choice.nodeId,
                                ),
                            )
                            .map((choice) => (
                              <option key={choice.nodeId} value={choice.nodeId}>
                                {choice.label}
                              </option>
                            ))}
                        </select>
                      )}
                      <button
                        aria-label={`Remove link to ${link.title || "untitled node"}`}
                        onClick={() =>
                          update((current) => {
                            current.nodeLinks = current.nodeLinks.filter(
                              (item) => item.nodeId !== link.nodeId,
                            );
                          }, "Remove task node link")
                        }
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              ))}
              {!readOnly && (
                <div className="build-task-link-add">
                  <select
                    aria-label="Link node"
                    value={linkChoice}
                    onChange={(event) => setLinkChoice(event.target.value)}
                    disabled={task.nodeLinks.length >= 500}
                  >
                    <option value="">Choose a node…</option>
                    {choices
                      .filter(
                        (choice) =>
                          !task.nodeLinks.some(
                            (link) => link.nodeId === choice.nodeId,
                          ),
                      )
                      .map((choice) => (
                        <option key={choice.nodeId} value={choice.nodeId}>
                          {choice.label}
                        </option>
                      ))}
                  </select>
                  <button
                    disabled={!linkChoice || task.nodeLinks.length >= 500}
                    onClick={() => chooseLink(linkChoice)}
                  >
                    Link node
                  </button>
                </div>
              )}
            </details>
            <details className="build-task-section">
              <summary>Prerequisites ({task.prerequisiteIds.length})</summary>
              {tasks.length < 2 && (
                <p className="muted">Add another task to set a prerequisite.</p>
              )}
              {tasks
                .filter((item) => item.id !== task.id)
                .map((other) => {
                  const checked = task.prerequisiteIds.includes(other.id),
                    cycle =
                      !checked &&
                      wouldCreateTaskCycle(tasks, task.id, other.id);
                  return (
                    <label className="build-task-prerequisite" key={other.id}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={readOnly || cycle}
                        onChange={(event) => {
                          const next = event.target.checked;
                          update((current, all) => {
                            if (
                              next &&
                              wouldCreateTaskCycle(all, current.id, other.id)
                            ) {
                              setError(
                                "This prerequisite would create a cycle.",
                              );
                              return;
                            }
                            setError("");
                            current.prerequisiteIds = next
                              ? [
                                  ...new Set([
                                    ...current.prerequisiteIds,
                                    other.id,
                                  ]),
                                ]
                              : current.prerequisiteIds.filter(
                                  (id) => id !== other.id,
                                );
                          }, "Change task prerequisites");
                        }}
                      />
                      <span>
                        {other.title || "Untitled task"}
                        {cycle && <small>Would create a cycle</small>}
                      </span>
                    </label>
                  );
                })}
            </details>
            <details className="build-task-section">
              <summary>Expected files ({task.expectedFiles.length})</summary>
              {task.expectedFiles.map((file, row) => (
                <div className="build-task-input-row" key={row}>
                  <Field label={`Expected file ${row + 1}`}>
                    <input
                      value={file}
                      readOnly={readOnly}
                      maxLength={2048}
                      onChange={(event) =>
                        update(
                          (current) => {
                            current.expectedFiles[row] = event.target.value;
                          },
                          "Edit expected file",
                          true,
                        )
                      }
                      onBlur={onCommit}
                    />
                  </Field>
                  {!readOnly && (
                    <button
                      aria-label={`Remove expected file ${row + 1}`}
                      onClick={() =>
                        update((current) => {
                          current.expectedFiles.splice(row, 1);
                        }, "Remove expected file")
                      }
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {!readOnly && (
                <button
                  disabled={task.expectedFiles.length >= 200}
                  onClick={() =>
                    update(
                      (current) => current.expectedFiles.push(""),
                      "Add expected file",
                    )
                  }
                >
                  Add expected file
                </button>
              )}
              {readOnly && !task.expectedFiles.length && (
                <p className="muted">No expected files specified.</p>
              )}
            </details>
          </fieldset>
        </div>
      ) : (
        <div className="build-task-empty">
          <h2>{readOnly ? "No build tasks" : "Plan the work"}</h2>
          <p>
            {readOnly
              ? "This version has no build tasks to review."
              : "Tasks describe what to build and how to check it."}
          </p>
          {!readOnly && (
            <button className="primary" onClick={add} disabled={disabled}>
              Add first task
            </button>
          )}
        </div>
      )}
    </section>
  );
}
