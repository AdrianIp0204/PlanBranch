import { useEffect, useState } from "react";
import { api } from "./api";
import { useProject } from "./store";

type Workflow = {
  stage: string;
  nextAction: string;
  action: string;
  runId?: string;
  approvalCurrent: boolean;
  blockers: { code: string; taskId?: string; runId?: string; message: string; action?: string; actionLabel?: string }[];
  boundaryNote: string;
};

export default function TaskWorkflowSummary({
  taskId,
  refreshKey,
  onRun,
  onReview,
  onPlanning,
  onSelect,
}: {
  taskId: string;
  refreshKey: boolean;
  onRun: () => void;
  onReview: (taskId?: string, runId?: string) => void;
  onPlanning?: () => void;
  onSelect: (id: string) => void;
}) {
  const { session } = useProject();
  const [state, setState] = useState<Workflow | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setState(null);
    setError("");
    void api<Workflow>(`/projects/${session.id}/tasks/${taskId}/workflow`)
      .then((value) => {
        if (live) setState(value);
      })
      .catch((reason) => {
        if (live)
          setError(
            reason instanceof Error
              ? reason.message
              : "Task guidance is unavailable. Preview run to check readiness.",
          );
      });
    return () => {
      live = false;
    };
  }, [session.id, session.revision, taskId, refreshKey]);
  return (
    <section className="task-workflow" aria-label="Task workflow">
      <h2>{state?.stage ?? "Plan"}</h2>
      <p>{state?.nextAction ?? (error || "Loading saved task readiness…")}</p>
      {state && (
        <>
          <p className="muted">
            Task intent:{" "}
            {state.approvalCurrent ? "approved" : "review required"}. A run
            preview checks current source and runtime permissions.
          </p>
          {state.blockers.length > 0 && (
            <ul>
              {state.blockers.map((blocker, index) => (
                <li key={`${blocker.code}:${blocker.taskId ?? index}`} data-issue-code={blocker.code}>
                  <p>{blocker.message}</p>
                  {["review_result", "finish_task", "apply_changes", "commit_changes", "refresh_evidence"].includes(blocker.action ?? "") ? (
                    <button className="quiet" onClick={() => onReview(blocker.taskId, blocker.runId)}>
                      {blocker.actionLabel ?? "Review prerequisite result"}
                    </button>
                  ) : blocker.action === "preview_run" ? (
                    <button className="quiet" onClick={onRun}>{blocker.actionLabel ?? "Review run authorization"}</button>
                  ) : blocker.action === "review_plan" ? (
                    onPlanning && <button className="quiet" onClick={onPlanning}>{blocker.actionLabel ?? "Review task intent"}</button>
                  ) : blocker.taskId ? (
                    <button
                      className="quiet"
                      onClick={() => onSelect(blocker.taskId!)}
                    >
                      {blocker.actionLabel ?? "Open prerequisite task"}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <div className="execution-actions">
            {state.action === "review_result" ? (
              <button className="primary" onClick={() => onReview(taskId, state.runId)}>
                Review task result
              </button>
            ) : state.action === "preview_run" ? (
              <button className="primary" onClick={onRun}>
                Review run authorization
              </button>
            ) : state.action === "open_task" ? (
              <button className="primary" onClick={() => onSelect(taskId)}>Edit task progress</button>
            ) : state.action === "review_plan" ? (
              onPlanning && (
                <button className="primary" onClick={onPlanning}>
                  Review task intent
                </button>
              )
            ) : null}
          </div>
          <details>
            <summary>Approval and application boundaries</summary>
            <p>{state.boundaryNote}</p>
          </details>
        </>
      )}
    </section>
  );
}
