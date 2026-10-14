import { useEffect, useState } from "react";
import { api, post } from "./api";
import { useProject } from "./store";
import { type Envelope, uid } from "./types";
import { Dialog, ErrorMessage, Field } from "./ui";
import "./plan-handoff.css";

type Snapshot = { id: string; alternativeId: string | null; kind: string; name: string; explanation: string; createdAt: string; historicalApprovalId: string | null };
type Alternative = { id: string; parentId: string | null; name: string; snapshotId: string };
type PlanState = { selectedAlternativeId: string | null; epoch: number; snapshots: Snapshot[]; alternatives: Alternative[]; decisions: { id: string; action: string; note: string; createdAt: string }[] };
type Comparison = { snapshotId: string; changes: { section: string; before: unknown; after: unknown }[] };

export default function PlanLibrary({ onClose }: { onClose: () => void }) {
  const { session, commit, flush, synchronize } = useProject();
  const [state, setState] = useState<PlanState | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [inspected, setInspected] = useState<{ name: string; content: unknown; sourceReferences: unknown[]; authority: string } | null>(null);
  const path = `/projects/${session.id}/plans`;
  const refresh = async () => setState(await api<PlanState>(path));
  useEffect(() => { void refresh().catch((cause: Error) => setError(cause.message)); }, [path]);

  async function mutate(action: string, targetId?: string) {
    setBusy(true); setError(""); setMessage(""); commit();
    try {
      await synchronize(async (snapshot) => {
        const result = await post<{ project: Envelope }>(`${path}/${action}`, { mutationId: uid(), baseRevision: snapshot.revision, name, explanation: note, note, ...(targetId ? { targetId } : {}) });
        return result.project;
      });
      await refresh(); setComparison(null); setInspected(null);
      setMessage(action === "duplicate" ? "Alternative saved. Select it when you are ready to edit it." : action === "checkpoint" ? "Named checkpoint saved." : "Plan loaded. Your previous work is saved as a recovery checkpoint. Review and approve this plan before execution.");
      if (action === "checkpoint" || action === "duplicate") setName("");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  async function inspect(id: string, compare: boolean) {
    setBusy(true); setError(""); commit();
    try {
      if (!(await flush())) throw new Error("Save or recover your current work before comparing plans.");
      if (compare) { setComparison(await api<Comparison>(`${path}/snapshots/${id}/compare`)); setInspected(null); }
      else { setInspected(await api(`${path}/snapshots/${id}`)); setComparison(null); }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog title="Checkpoints and alternative plans" onClose={onClose} className="plan-library-modal">
    <div className="plan-library">
      <p>Save an important design, explore another, and deliberately select the plan you want to build. Alternatives are logical plans, separate from Git branches.</p>
      <ErrorMessage message={error} />
      {message && <p role="status">{message}</p>}
      <Field label="Checkpoint or alternative name"><input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></Field>
      <Field label="Explanation or decision note"><textarea value={note} maxLength={8000} onChange={(event) => setNote(event.target.value)} placeholder="Why preserve or choose this design?" /></Field>
      <div className="plan-handoff-actions">
        <button disabled={busy || !name.trim()} onClick={() => void mutate("checkpoint")}>Save named checkpoint</button>
        <button disabled={busy || !name.trim()} onClick={() => void mutate("duplicate")}>Duplicate as alternative</button>
      </div>
      <h3>Alternatives</h3>
      {!state?.alternatives.length && <p>The first checkpoint creates your original plan baseline.</p>}
      <ul className="plan-records">{state?.alternatives.map((alternative) => <li key={alternative.id}>
        <div><strong>{alternative.name}</strong>{alternative.id === state.selectedAlternativeId && <span> · Selected</span>}
          {alternative.parentId && <small>Based on {state.alternatives.find((item) => item.id === alternative.parentId)?.name ?? "an earlier plan"}</small>}</div>
        <div className="plan-handoff-actions">
          <button disabled={busy} onClick={() => void inspect(alternative.snapshotId, true)}>Compare with current</button>
          <button disabled={busy || alternative.id === state.selectedAlternativeId} onClick={() => void mutate("select", alternative.id)}>Select alternative</button>
        </div>
      </li>)}</ul>
      <p className="muted">Selecting or restoring saves a recovery checkpoint, resets progress, and requires fresh approval. Historical runs and evidence remain available as history.</p>
      <h3>Named and recovery checkpoints</h3>
      <ul className="plan-records">{state?.snapshots.filter((snapshot) => snapshot.kind !== "alternative").map((snapshot) => <li key={snapshot.id}>
        <div><strong>{snapshot.name}</strong><small>{snapshot.kind} · {new Date(snapshot.createdAt).toLocaleString()}</small>{snapshot.explanation && <p>{snapshot.explanation}</p>}</div>
        <div className="plan-handoff-actions">
          <button disabled={busy} onClick={() => void inspect(snapshot.id, false)}>Inspect</button>
          <button disabled={busy} onClick={() => void inspect(snapshot.id, true)}>Compare</button>
          <button disabled={busy} onClick={() => void mutate("restore", snapshot.id)}>Restore checkpoint</button>
        </div>
      </li>)}</ul>
      {comparison && <section aria-label="Semantic plan comparison"><h3>Saved plan → current plan</h3>
        {!comparison.changes.length ? <p>No semantic differences. Layout and progress do not affect this comparison.</p> : comparison.changes.map((change) => <details key={change.section} open><summary>{change.section}</summary><div className="plan-comparison"><div><h4>Saved</h4><pre tabIndex={0}>{JSON.stringify(change.before, null, 2)}</pre></div><div><h4>Current</h4><pre tabIndex={0}>{JSON.stringify(change.after, null, 2)}</pre></div></div></details>)}
      </section>}
      {inspected && <section aria-label="Saved checkpoint"><h3>{inspected.name}</h3><p>{inspected.authority}</p><pre tabIndex={0}>{JSON.stringify(inspected.content, null, 2)}</pre>{!!inspected.sourceReferences?.length && <details><summary>Historical repository inspection references · no source or consent</summary><pre tabIndex={0}>{JSON.stringify(inspected.sourceReferences, null, 2)}</pre></details>}</section>}
      {!!state?.decisions.length && <details><summary>Decision history</summary><ul>{state.decisions.map((decision) => <li key={decision.id}>{decision.action} · {new Date(decision.createdAt).toLocaleString()}{decision.note && <p>{decision.note}</p>}</li>)}</ul></details>}
    </div>
  </Dialog>;
}
