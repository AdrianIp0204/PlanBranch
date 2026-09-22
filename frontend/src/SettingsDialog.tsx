import { useEffect, useState } from "react";
import { api, post } from "./api";
import { Dialog, ErrorMessage, Field } from "./ui";
import { usePreferences } from "./preferences";
import ModelControls, { useModelSelection } from "./ModelControls";
import CodexConnection from "./CodexConnection";
import { resetLayout } from "./layout";
import "./settings.css";

const sections = ["Appearance", "Editor", "Agent", "Data & About"] as const;
export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<typeof sections[number]>("Appearance");
  const { preferences: p, updatePreferences: update, storageUnavailable } = usePreferences();
  const model = useModelSelection(section === "Agent");
  const [info, setInfo] = useState<{ version: string; dataDirectory: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    api<{ version: string; dataDirectory: string }>("/settings/info")
      .then((value) => { if (alive) setInfo(value); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  return <Dialog title="Settings" className="settings-dialog" onClose={onClose}>
    <p className="muted">Preferences stay in this browser. Project content is unchanged.</p>
    {storageUnavailable && <p role="status">Browser storage is unavailable. Preferences work until this window closes.</p>}
    <nav className="settings-tabs" aria-label="Settings sections">
      {sections.map((name) => <button key={name} aria-pressed={section === name} onClick={() => setSection(name)}>{name}</button>)}
    </nav>
    <section className="settings-content" aria-label={section}>
      {section === "Appearance" && <>
        <Field label="Theme"><select value={p.theme} onChange={(e) => update({ theme: e.target.value as typeof p.theme })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></Field>
        <Field label="Text size" hint="Canvas node sizes stay stable."><select value={p.textSize} onChange={(e) => update({ textSize: e.target.value as typeof p.textSize })}><option value="default">Default · 14 px</option><option value="large">Larger · 16 px</option></select></Field>
        <Field label="Density"><select value={p.density} onChange={(e) => update({ density: e.target.value as typeof p.density })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></Field>
      </>}
      {section === "Editor" && <>
        <label className="settings-check"><input type="checkbox" checked={p.grid} onChange={(e) => update({ grid: e.target.checked })} />Show grid</label>
        <label className="settings-check"><input type="checkbox" checked={p.minimap} onChange={(e) => update({ minimap: e.target.checked })} />Show minimap</label>
        <label className="settings-check"><input type="checkbox" checked={p.snap} onChange={(e) => update({ snap: e.target.checked })} />Snap to grid</label>
        <p className="muted">Snapping affects future moves; existing positions stay unchanged.</p>
        <Field label="Startup"><select value={p.startup} onChange={(e) => update({ startup: e.target.value as typeof p.startup })}><option value="resume">Reopen last workspace</option><option value="projects">Show projects</option></select></Field>
        <button onClick={() => { resetLayout(); setNotice("Default layout restored."); }}>Restore default layout</button>
      </>}
      {section === "Agent" && <>
        <h3>Planning defaults</h3>
        <ModelControls selection={model.selection} capabilities={model.capabilities} onChange={model.setSelection} problemId="settings-model-problem" />
        {model.problem && <p id="settings-model-problem" role="status">{model.problem}</p>}
        <p className="muted">Used for new requests. Existing requests and retries keep their captured settings.</p>
        <button disabled={model.refreshing} onClick={() => void model.refresh()}>{model.refreshing ? "Refreshing…" : "Refresh models"}</button>
        <CodexConnection />
      </>}
      {section === "Data & About" && <>
        <h3>PlanBranch {info?.version ?? ""}</h3>
        <Field label="Data location"><input readOnly value={info?.dataDirectory ?? "Loading…"} /></Field>
        <p className="muted">The database backup includes plans and drafts. For coding-work recovery, also preserve the worktrees in this data folder.</p>
        <button disabled={busy} onClick={async () => { setBusy(true); setError(""); try { const result = await post<{ filename: string }>("/backup"); setNotice(`Backup saved: ${result.filename}`); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? "Backing up…" : "Back up database"}</button>
        <p className="muted">Local connection: {window.location.host}. Codex connection diagnostics are in Agent.</p>
      </>}
    </section>
    <ErrorMessage message={error} />
    {notice && <p role="status">{notice}</p>}
    <div className="dialog-actions"><button onClick={onClose}>Done</button></div>
  </Dialog>;
}
