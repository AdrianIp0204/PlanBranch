import { useEffect, useState } from "react";
import { api } from "./api";
import { useProject } from "./store";

type Workflow = {
  stage: string;
  nextAction: string;
  action: string;
  runId?: string;
  approvalCurrent: boolean;
  blockers: { taskId?: string; message: string; action?: string }[];
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
  onReview: () => void;
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
                <li key={index}>
                  {blocker.taskId ? (
                    <button
                      className="quiet"
                      onClick={() => onSelect(blocker.taskId!)}
                    >
                      {blocker.message}
                    </button>
                  ) : (
                    blocker.message
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="execution-actions">
            {state.action === "review_result" ? (
              <button className="primary" onClick={onReview}>
                Review task result
              </button>
            ) : state.approvalCurrent ? (
              <button className="primary" onClick={onRun}>
                Review run authorization
              </button>
            ) : (
              onPlanning && (
                <button className="primary" onClick={onPlanning}>
                  Review task intent
                </button>
              )
            )}
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
