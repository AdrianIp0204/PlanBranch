import BuildTasksEditor from "./BuildTasksEditor";
import { useProject } from "./store";
import { emptyBrief } from "./types";
import "./build-view.css";

export default function BuildView({
  selectedId,
  onSelect,
  onRevealNode,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRevealNode: (diagramId: string, nodeId: string) => void;
}) {
  const { session, change, commit } = useProject();
  return (
    <section className="build-view" aria-label="Build tasks">
      <div className="build-view-heading">
        <h1 id="build-title" tabIndex={-1}>
          Build tasks
        </h1>
        <p>Implementation work, separate from program flow.</p>
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
    </section>
  );
}
