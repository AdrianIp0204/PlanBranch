import BriefFields, { briefLabels } from "./BriefFields";
import { emptyBrief } from "./types";
import { useProject } from "./store";
import { Dialog } from "./ui";
export default function ProjectBriefDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const { session, change, commit, saveStatus, saveError, flush } =
    useProject();
  const close = () => {
    commit();
    onClose();
  };
  return (
    <Dialog title="Project brief" onClose={close} className="project-brief-modal">
      <div className="project-brief-dialog">
        <p className="muted">
          Shared with Codex for planning. Keep agreed decisions separate from
          assumptions.
        </p>
        <BriefFields
          value={session.content.brief ?? emptyBrief()}
          onCommit={commit}
          onChange={(field, value) =>
            change(
              (content) => {
                content.brief = {
                  ...(content.brief ?? emptyBrief()),
                  [field]: value,
                };
                content.schemaVersion = 3;
                content.buildTasks ??= [];
              },
              `Edit brief: ${briefLabels[field]}`,
              undefined,
              true,
            )
          }
        />
        {saveError && (
          <p role="alert" className="error-message">
            {saveError}
          </p>
        )}
        <div className="brief-actions">
          <span role="status">
            {saveStatus === "saved"
              ? session.generation === session.savedGeneration
                ? "Saved"
                : "Unsaved changes"
              : saveStatus === "saving"
                ? "Saving…"
                : saveStatus === "failed"
                  ? "Save failed"
                  : saveStatus === "conflict"
                    ? "Save conflict"
                    : "Changes save automatically"}
          </span>
          {saveStatus === "failed" && (
            <button onClick={() => void flush()}>Retry save</button>
          )}
          <button className="primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}
