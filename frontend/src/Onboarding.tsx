import { useEffect, useState } from "react";
import { api, post } from "./api";
import { readPreferences } from "./preferences";
import { Dialog, ErrorMessage } from "./ui";
import type { Content } from "./types";
import "./onboarding.css";

type Capability = { id: string; label: string; state: string; detail: string };
type Setup = { capabilities: Capability[]; bundled: string; gitInstalled: boolean };
export function SetupDialog({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState<{ available: boolean; reason: string; image?: string } | null>(null);
  async function refresh() {
    setBusy(true); setError(""); setRuntime(null);
    try {
      const provider = readPreferences().planningAgent.provider;
      const query = new URLSearchParams({ provider, refresh: "1", ...(projectId ? { projectId } : {}) });
      setSetup(await api<Setup>(`/setup?${query}`));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, [projectId]);
  return <Dialog title="Setup capabilities" onClose={onClose} className="onboarding-dialog">
    <p>Start with visual planning. Enable each additional capability when you need it.</p>
    <ErrorMessage message={error} />
    {busy && <p role="status">Checking local capabilities…</p>}
    <dl className="capability-list">
      {setup?.capabilities.map(item => <div key={item.id}>
        <dt>{item.label} <span>{item.state.replaceAll("_", " ")}</span></dt>
        <dd>{item.detail}</dd>
      </div>)}
    </dl>
    <p>{setup?.bundled}</p>
    <details>
      <summary>Check the native-provider command runtime</summary>
      <p>This explicitly runs a short probe inside your configured, existing Docker image. It does not download or install software, attach a repository, or run project code.</p>
      <button disabled={busy} onClick={async () => {
        setBusy(true); setError("");
        try { setRuntime(await post("/setup/runtime", { confirmed: true })); }
        catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
      }}>Check isolated runtime</button>
      {runtime && <p role="status"><strong>{runtime.available ? "Probe passed" : "Setup required"}.</strong> {runtime.reason} {runtime.image ?? ""}</p>}
    </details>
    <div className="dialog-actions"><button disabled={busy} onClick={() => void refresh()}>Retry checks</button><button onClick={onClose}>Close</button></div>
  </Dialog>;
}

type Demo = {
  schemaVersion: number; label: string; request: string; content: Content;
  proposal: { title: string; before: string[]; after: string[]; decision: string; alternative: string };
  change: { file: string; diff: string };
  evidence: { state: string; command: string; output: string; candidate: string; uncertainty: string };
};
const steps = ["Feature request", "Review a proposal", "Implementation task", "Review the result", "Application boundary"];
export function GuidedExample({ onClose, onLoadExample }: { onClose: () => void; onLoadExample: () => Promise<unknown> }) {
  const [demo, setDemo] = useState<Demo | null>(null);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { api<Demo>("/onboarding/example").then(setDemo).catch(e => setError(e.message)); }, []);
  const task = demo?.content.buildTasks?.[0];
  return <Dialog title="Guided offline example" onClose={onClose} className="onboarding-dialog">
    <p className="demo-label"><strong>Demonstration data.</strong> {demo?.label ?? "No provider, repository or runtime is needed."}</p>
    <ErrorMessage message={error} />
    <nav className="demo-steps" aria-label="Example steps">{steps.map((label, i) => <button key={label} aria-current={step === i ? "step" : undefined} disabled={i > step} onClick={() => setStep(i)}>{i + 1}. {label}</button>)}</nav>
    {demo && <section className="demo-stage" aria-label={steps[step]}>
      <h3>{steps[step]}</h3>
      {step === 0 && <>
        <p><strong>Request:</strong> {demo.request}</p>
        <dl><dt>Brief goal</dt><dd>{demo.content.brief?.goal}</dd><dt>Constraints</dt><dd>{demo.content.brief?.constraints}</dd><dt>Out of scope</dt><dd>{demo.content.brief?.outOfScope}</dd></dl>
        <p>The brief captures intent before the agent proposes a change.</p>
      </>}
      {step === 1 && <>
        <h4>Before</h4><ol className="demo-flow">{demo.proposal.before.map(x => <li key={x}>{x}</li>)}</ol>
        <h4>Proposed: {demo.proposal.title}</h4><ol className="demo-flow">{demo.proposal.after.map(x => <li key={x}>{x}</li>)}</ol>
        <p>{demo.proposal.decision}</p><details><summary>Alternative considered</summary>{demo.proposal.alternative}</details>
        <button className="primary" onClick={() => setSelected(true)}>{selected ? "Proposal selected for this example" : "Select this proposal"}</button>
        <p>Approving intent is separate from authorizing a coding run.</p>
      </>}
      {step === 2 && task && <>
        <h4>{task.title}</h4><p>{task.deliverable}</p><p>Relevant diagram element: {task.nodeLinks[0]?.title}</p>
        <h4>Acceptance criteria</h4><ul>{task.acceptanceChecks.map(c => <li key={c.id}>{c.text}</li>)}</ul>
        <p>Expected files: {task.expectedFiles.join(", ")}. A real Run would separately preview the repository revision, provider, permissions and limits.</p>
      </>}
      {step === 3 && <>
        <h4>Sample change · {demo.change.file}</h4><pre tabIndex={0} aria-label="Example diff">{demo.change.diff}</pre>
        <h4>{demo.evidence.state}</h4><p>Candidate: {demo.evidence.candidate}</p><pre tabIndex={0}>{demo.evidence.command + "\n" + demo.evidence.output}</pre>
        <p>{demo.evidence.uncertainty}</p><button onClick={() => setAccepted(true)}>{accepted ? "Sample result reviewed" : "Record sample review"}</button>
        <p>This choice is confined to this walkthrough. It creates no approval, execution grant or evidence record.</p>
      </>}
      {step === 4 && <>
        <p><strong>The sample is reviewed; your checkout has not changed.</strong></p>
        <ol><li>Accept a real result after inspecting its diff and evidence.</li><li>Complete the task when its criteria have been reviewed.</li><li>Apply explicitly after PlanBranch checks for source drift and conflicting edits.</li><li>Review and commit in your usual Git tool before running a dependent task.</li></ol>
        <p>Open a fresh example project to explore the actual diagram, brief and two dependent Build tasks. It has no attached source, approval, execution or check results.</p>
        <button className="primary" disabled={loading} onClick={async () => {
          setLoading(true); setError("");
          try { await onLoadExample(); onClose(); }
          catch(e) { setError((e as Error).message); }
          finally { setLoading(false); }
        }}>Open example project</button>
      </>}
    </section>}
    <div className="dialog-actions"><button onClick={() => { setStep(0); setSelected(false); setAccepted(false); }}>Reset walkthrough</button>
      {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
      {step < 4 && <button className="primary" disabled={!demo || (step === 1 && !selected) || (step === 3 && !accepted)} onClick={() => setStep(step + 1)}>Next</button>}
      <button onClick={onClose}>Close</button>
    </div>
  </Dialog>;
}
