import { useEffect, useState } from "react";
import { api, post } from "./api";
import { Dialog, ErrorMessage, Field } from "./ui";
import { usePreferences } from "./preferences";
import ModelControls, { useModelSelection } from "./ModelControls";
import AgentConnections from "./AgentConnections";
import { resetLayout } from "./layout";
import {
  desktopNotificationPermission,
  prepareNotificationSound,
  requestDesktopNotificationPermission,
} from "./operationNotifications";
import "./settings.css";
const sections = ["Appearance", "Editor", "Agent", "Data & About"] as const;
export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] =
    useState<(typeof sections)[number]>("Appearance");
  const {
    preferences: p,
    updatePreferences: update,
    storageUnavailable,
  } = usePreferences();
  const [purpose, setPurpose] = useState<"planning" | "coding">("planning");
  const model = useModelSelection(section === "Agent", purpose);
  const [info, setInfo] = useState<{
    version: string;
    dataDirectory: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [desktopPermission, setDesktopPermission] = useState(
    desktopNotificationPermission,
  );
  const [soundBusy, setSoundBusy] = useState(false);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [notificationNotice, setNotificationNotice] = useState("");
  useEffect(() => {
    const refreshPermission = () =>
      setDesktopPermission(desktopNotificationPermission());
    refreshPermission();
    window.addEventListener("focus", refreshPermission);
    return () => window.removeEventListener("focus", refreshPermission);
  }, [section]);
  useEffect(() => {
    let alive = true;
    api<{ version: string; dataDirectory: string }>("/settings/info")
      .then((value) => {
        if (alive) setInfo(value);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Dialog title="Settings" className="settings-dialog" onClose={onClose}>
      <p className="muted">
        Preferences stay in this browser. Project content is unchanged.
      </p>
      {storageUnavailable && (
        <p role="status">
          Browser storage is unavailable. Preferences work until this window
          closes.
        </p>
      )}
      <nav className="settings-tabs" aria-label="Settings sections">
        {sections.map((name) => (
          <button
            key={name}
            aria-pressed={section === name}
            onClick={() => setSection(name)}
          >
            {name}
          </button>
        ))}
      </nav>
      <section className="settings-content" aria-label={section}>
        {section === "Appearance" && (
          <>
            <Field label="Theme">
              <select
                value={p.theme}
                onChange={(e) =>
                  update({ theme: e.target.value as typeof p.theme })
                }
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </Field>
            <Field label="Text size" hint="Canvas node sizes stay stable.">
              <select
                value={p.textSize}
                onChange={(e) =>
                  update({ textSize: e.target.value as typeof p.textSize })
                }
              >
                <option value="default">Default · 14 px</option>
                <option value="large">Larger · 16 px</option>
              </select>
            </Field>
            <Field label="Density">
              <select
                value={p.density}
                onChange={(e) =>
                  update({ density: e.target.value as typeof p.density })
                }
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </Field>
          </>
        )}
        {section === "Editor" && (
          <>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={p.grid}
                onChange={(e) => update({ grid: e.target.checked })}
              />
              Show grid
            </label>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={p.minimap}
                onChange={(e) => update({ minimap: e.target.checked })}
              />
              Show minimap
            </label>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={p.snap}
                onChange={(e) => update({ snap: e.target.checked })}
              />
              Snap to grid
            </label>
            <p className="muted">
              Snapping affects future moves; existing positions stay unchanged.
            </p>
            <Field label="Startup">
              <select
                value={p.startup}
                onChange={(e) =>
                  update({ startup: e.target.value as typeof p.startup })
                }
              >
                <option value="resume">Reopen last workspace</option>
                <option value="projects">Show projects</option>
              </select>
            </Field>
            <button
              onClick={() => {
                resetLayout();
                setNotice("Default layout restored.");
              }}
            >
              Restore default layout
            </button>
          </>
        )}
        {section === "Agent" && (
          <>
            <h3>Model defaults</h3>
            <Field label="Use for">
              <select
                value={purpose}
                onChange={(event) =>
                  setPurpose(event.target.value as "planning" | "coding")
                }
              >
                <option value="planning">Planning chat</option>
                <option value="coding">Coding steps</option>
              </select>
            </Field>
            <ModelControls
              selection={model.selection}
              capabilities={model.capabilities}
              onChange={model.setSelection}
              onProviderChange={model.setProvider}
              problemId="settings-model-problem"
            />
            {model.problem && (
              <p id="settings-model-problem" role="status">
                {model.problem}
              </p>
            )}
            <p className="muted">
              Used for new requests. Existing requests and retries keep their
              captured settings.
            </p>
            <button
              disabled={model.refreshing}
              onClick={() => void model.refresh()}
            >
              {model.refreshing ? "Refreshing…" : "Refresh models"}
            </button>
            <AgentConnections />
            <h3>Notifications</h3>
            <p className="muted">
              Quiet in-app notices report results for the open project. They
              never approve changes or run another step.
            </p>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={p.sound}
                disabled={soundBusy}
                onChange={async (event) => {
                  setNotificationNotice("");
                  if (!event.target.checked) {
                    update({ sound: false });
                    return;
                  }
                  setSoundBusy(true);
                  const available = await prepareNotificationSound();
                  update({ sound: available });
                  if (!available)
                    setNotificationNotice(
                      "Sound is unavailable in this browser. In-app notices remain enabled.",
                    );
                  setSoundBusy(false);
                }}
              />
              Play a short sound
            </label>
            <p className="muted">
              Desktop notifications:{" "}
              {desktopPermission === "unsupported"
                ? "unavailable in this browser"
                : desktopPermission === "denied"
                  ? "blocked by the browser"
                  : p.desktop && desktopPermission === "granted"
                    ? "on"
                    : "off"}
              .
            </p>
            {desktopPermission === "denied" && (
              <p className="muted">
                Allow notifications in this site's browser permissions, then
                retry.
              </p>
            )}
            {(p.desktop || desktopPermission !== "unsupported") && (
              <button
                disabled={desktopBusy}
                onClick={async () => {
                  setNotificationNotice("");
                  if (p.desktop) {
                    update({ desktop: false });
                    return;
                  }
                  setDesktopBusy(true);
                  const permission =
                    desktopNotificationPermission() === "granted"
                      ? "granted"
                      : await requestDesktopNotificationPermission();
                  setDesktopPermission(permission);
                  update({ desktop: permission === "granted" });
                  if (permission === "default")
                    setNotificationNotice(
                      "Desktop notifications stay off until permission is granted.",
                    );
                  setDesktopBusy(false);
                }}
              >
                {desktopBusy
                  ? "Checking permission…"
                  : p.desktop
                    ? "Disable desktop notifications"
                    : desktopPermission === "denied"
                      ? "Retry desktop notifications"
                      : "Enable desktop notifications"}
              </button>
            )}
            {notificationNotice && <p role="status">{notificationNotice}</p>}
          </>
        )}
        {section === "Data & About" && (
          <>
            <h3>PlanBranch {info?.version ?? ""}</h3>
            <Field label="Data location">
              <input readOnly value={info?.dataDirectory ?? "Loading…"} />
            </Field>
            <p className="muted">
              The database backup includes plans and drafts. For coding-work
              recovery, also preserve the worktrees in this data folder.
            </p>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const result = await post<{ filename: string }>("/backup");
                  setNotice(`Backup saved: ${result.filename}`);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Backing up…" : "Back up database"}
            </button>
            <p className="muted">
              Local connection: {window.location.host}. Provider connections are
              in Agent.
            </p>
          </>
        )}
      </section>
      <ErrorMessage message={error} />
      {notice && <p role="status">{notice}</p>}
      <div className="dialog-actions">
        <button onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}
