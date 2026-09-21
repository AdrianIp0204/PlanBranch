import { useState } from "react";
import BuildTasksEditor from "./BuildTasksEditor";
import ExecutionDialog from "./ExecutionDialog";
import { useProject } from "./store";
import { emptyBrief } from "./types";
import "./build-view.css";

export default function BuildView({
  selectedId,
  onSelect,
  onRevealNode,
  onPlanning,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRevealNode: (diagramId: string, nodeId: string) => void;
  onPlanning?: () => void;
}) {
  const { session, change, commit } = useProject();
  const [executionOpen, setExecutionOpen] = useState(false);
  const [executionHistory, setExecutionHistory] = useState(false);
  const selectedTask =
    session.content.buildTasks?.find((task) => task.id === selectedId) ??
    session.content.buildTasks?.[0];
  return (
    <section className="build-view" aria-label="Build tasks">
      <div className="build-view-heading">
        <h1 id="build-title" tabIndex={-1}>
          Build tasks
        </h1>
        <p>Implementation work, separate from program flow.</p>
        <div className="build-execution-actions">
          <button
            className="primary"
            disabled={!selectedTask}
            onClick={() => {
              commit();
              setExecutionHistory(false);
              setExecutionOpen(true);
            }}
          >
            Run step
          </button>
          <button
            onClick={() => {
              commit();
              setExecutionHistory(true);
              setExecutionOpen(true);
            }}
          >
            Execution history
          </button>
          {selectedTask && <span>{selectedTask.title || "Untitled task"}</span>}
        </div>
      </div>
      <BuildTasksEditor
        tasks={session.content.buildTasks ?? []}
        diagrams={session.content.diagrams}
        selectedId={selectedId}
        onSelect={onSelect}
        onCommit={commit}
        onRevealNode={onRevealNode}
        onChange={(edit, label, group) =>
          change(
            (content) => {
              content.schemaVersion = 3;
              content.brief ??= emptyBrief();
              content.buildTasks ??= [];
              edit(content.buildTasks);
            },
            label,
            undefined,
            group,
          )
        }
      />
      {executionOpen && (
        <ExecutionDialog
          taskId={selectedTask?.id ?? null}
          initialHistory={executionHistory}
          onClose={() => setExecutionOpen(false)}
          onPlanning={
            onPlanning
              ? () => {
                  setExecutionOpen(false);
                  onPlanning();
                }
              : undefined
          }
        />
      )}
    </section>
  );
}
