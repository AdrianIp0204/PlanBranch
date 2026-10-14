import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { ExecutionRun } from "./execution";

const active = (run: ExecutionRun | null) =>
  !!run && ["queued", "running", "cancelling"].includes(run.state);

// Owns status reads only. Starting a check always remains an explicit action.
export function useRunObservation(projectId: string) {
  const [observation, setObservation] = useState<{
    projectId: string;
    run: ExecutionRun;
  } | null>(null);
  const [problem, setProblem] = useState<{
    projectId: string;
    message: string;
  } | null>(null);
  const run = observation?.projectId === projectId ? observation.run : null;
  const error = problem?.projectId === projectId ? problem.message : "";
  const [generation, setGeneration] = useState(0);
  const current = useRef(run);
  current.current = run;
  const cancel = useRef<(() => void) | null>(null);
  const read = useRef<(() => void) | null>(null);
  const observe = useCallback(
    (next: ExecutionRun) => {
      cancel.current?.();
      current.current = next;
      setObservation({ projectId, run: next });
      setProblem(null);
      setGeneration((value) => value + 1);
    },
    [projectId],
  );
  const refresh = useCallback(() => read.current?.(), []);
  const runId = run?.id;

  useEffect(() => {
    setObservation((value) => (value?.projectId === projectId ? value : null));
    setProblem((value) => (value?.projectId === projectId ? value : null));
  }, [projectId]);

  useEffect(() => {
    if (!runId) return;
    let live = true;
    let sequence = 0;
    let failures = 0;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    function cancelRead() {
      ++sequence;
      window.clearTimeout(timer);
      controller?.abort();
    }
    function schedule(delay: number) {
      timer = window.setTimeout(() => void request(), delay);
    }
    async function request(manual = false) {
      cancelRead();
      if (!live) return;
      if (manual) failures = 0;
      const ticket = sequence;
      const requestController = new AbortController();
      controller = requestController;
      const isCurrent = () =>
        live && ticket === sequence && !requestController.signal.aborted;
      try {
        const next = await api<{ run: ExecutionRun }>(
          `/projects/${projectId}/execution/runs/${runId}`,
          { signal: requestController.signal },
        );
        if (!isCurrent()) return;
        current.current = next.run;
        setObservation({ projectId, run: next.run });
        setProblem(null);
        failures = 0;
        if (active(next.run)) schedule(1000);
      } catch (cause) {
        if (!isCurrent()) return;
        const retryable =
          !(cause instanceof ApiError) ||
          [408, 429].includes(cause.status) ||
          cause.status >= 500;
        const retry = retryable && active(current.current);
        const message = cause instanceof Error ? cause.message : String(cause);
        setProblem({
          projectId,
          message: `${message} ${
            retry
              ? "Retrying local observation automatically."
              : "Automatic updates stopped. Refresh local observation to retry or reopen the task."
          }`,
        });
        if (retry) {
          ++failures;
          schedule(Math.min(1000 * 2 ** Math.min(failures - 1, 3), 8000));
        }
      }
    }
    cancel.current = cancelRead;
    read.current = () => void request(true);
    if (active(current.current)) schedule(1000);
    return () => {
      live = false;
      cancelRead();
      cancel.current = null;
      read.current = null;
    };
  }, [projectId, runId, generation]);

  return { run, error, observe, refresh };
}
