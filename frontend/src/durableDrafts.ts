import {
  copy,
  uid,
  emptyBrief,
  type Content,
  type Diagram,
  type ProjectBrief,
  type BuildTask,
} from "./types";
import type { Session } from "./history";

export type AcceptanceRequest = {
  baseRevision: number;
  mutationId: string;
  contentHash: string;
  draftId: string;
  draftRevision: number;
};
export type DraftSummary = {
  id: string;
  proposalId: string;
  diagramId: string;
  draftRevision: number;
  state: "active" | "applying" | "applied" | "discarded";
  createdAt: string;
  updatedAt: string;
  baseRevision: number;
  baseHash: string;
  proposalHash: string;
  conflictOf: string | null;
  stale: boolean;
  appliedCursor: string | null;
};
export type DraftDetail = DraftSummary & {
  candidate: Content;
  applyRequest: AcceptanceRequest | null;
};
export type DraftReference = { draftId: string; draftRevision: number };
export type DraftList = {
  drafts: DraftSummary[];
  defaultDraftId: string | null;
};
export type DraftStatus =
  "loading" | "saved" | "dirty" | "saving" | "failed" | "conflict";
export type DraftConflict = {
  latestDraft: DraftSummary | null;
  recoveryDraft: DraftSummary | null;
};
export type DraftSection = "diagram" | "brief" | "buildTasks";
export type DraftCandidateValues = {
  diagram?: Diagram;
  brief?: ProjectBrief;
  buildTasks?: BuildTask[];
};
export function draftCandidateValues(
  content: Content,
  diagramId: string,
  sections: readonly DraftSection[],
): DraftCandidateValues {
  const values: DraftCandidateValues = {};
  if (sections.includes("diagram")) {
    const diagram = content.diagrams.find((item) => item.id === diagramId);
    if (!diagram) throw new Error("The proposed diagram is unavailable.");
    values.diagram = copy(diagram);
  }
  if (sections.includes("brief")) {
    const brief = emptyBrief();
    for (const field of Object.keys(brief) as (keyof ProjectBrief)[])
      brief[field] = content.brief?.[field] ?? "";
    values.brief = brief;
  }
  if (sections.includes("buildTasks"))
    values.buildTasks = (content.buildTasks ?? []).map((task) => ({
      id: task.id,
      title: task.title,
      deliverable: task.deliverable,
      nodeLinks: task.nodeLinks.map((link) => ({
        nodeId: link.nodeId,
        diagramId: link.diagramId,
        title: link.title,
        missing: link.missing,
      })),
      prerequisiteIds: [...task.prerequisiteIds],
      expectedFiles: [...task.expectedFiles],
      acceptanceChecks: task.acceptanceChecks.map((check) => ({
        id: check.id,
        text: check.text,
      })),
      status: task.status,
    }));
  return values;
}
export type DraftSaveBody = DraftCandidateValues & {
  baseDraftRevision: number;
  mutationId: string;
  contentHash: string;
};
export type DraftBatch = {
  draftId: string;
  body: DraftSaveBody;
  generation: number;
};
const messageOf = (reason: unknown) =>
  reason instanceof Error
    ? reason.message
    : "The draft could not be saved. Try again.";

/** One immutable request at a time. Only save bookkeeping changes on acknowledgement. */
export class DraftSaveQueue {
  private running: Promise<boolean> | null = null;
  private batch: DraftBatch | null = null;
  private failed = false;
  private disposed = false;
  public conflict: DraftConflict | null = null;
  constructor(
    private get: () => Session,
    private metadata: DraftSummary,
    private request: (
      id: string,
      body: DraftSaveBody,
    ) => Promise<{ draft: DraftSummary }>,
    private acknowledge: (
      summary: DraftSummary,
      generation: number,
      candidate: DraftCandidateValues,
    ) => void,
    private report: (
      status: DraftStatus,
      error?: string,
      conflict?: DraftConflict | null,
    ) => void,
    private sections: readonly DraftSection[] = ["diagram"],
  ) {}
  summary() {
    return this.metadata;
  }
  pending() {
    return !!this.batch || this.get().generation !== this.get().savedGeneration;
  }
  reference(): DraftReference | null {
    return this.metadata.draftRevision > 0
      ? {
          draftId: this.metadata.id,
          draftRevision: this.metadata.draftRevision,
        }
      : null;
  }
  activate() {
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
  }
  updateSummary(summary: DraftSummary) {
    this.metadata = summary;
  }
  noticeConflict(latest: DraftSummary, message: string) {
    this.conflict = { latestDraft: latest, recoveryDraft: null };
    this.report("conflict", message, this.conflict);
  }
  async preserveConflictCopy(): Promise<boolean> {
    if (!this.conflict || this.conflict.recoveryDraft)
      return !!this.conflict?.recoveryDraft;
    if (this.metadata.state !== "active") return false;
    const session = this.get();
    const values = draftCandidateValues(
      session.content,
      this.metadata.diagramId,
      this.sections,
    );
    this.batch = {
      draftId: this.metadata.id,
      generation: session.generation,
      body: {
        baseDraftRevision: this.metadata.draftRevision,
        mutationId: uid(),
        contentHash: this.metadata.proposalHash,
        ...values,
      },
    };
    this.conflict = null;
    this.failed = false;
    await this.flush(true);
    return !!(this.conflict as DraftConflict | null)?.recoveryDraft;
  }
  flush(retry = false): Promise<boolean> {
    if (this.running) return this.running;
    if (this.disposed || this.conflict || (this.failed && !retry))
      return Promise.resolve(false);
    if (this.metadata.state !== "active")
      return Promise.resolve(!this.pending());
    this.failed = false;
    this.running = this.save().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async save(): Promise<boolean> {
    while (
      !this.disposed &&
      (this.pending() || this.metadata.draftRevision === 0)
    ) {
      if (!this.batch) {
        const session = this.get();
        let values: DraftCandidateValues;
        try {
          values = draftCandidateValues(
            session.content,
            this.metadata.diagramId,
            this.sections,
          );
        } catch (reason) {
          this.report("failed", messageOf(reason));
          return false;
        }
        this.batch = {
          draftId: this.metadata.id,
          generation: session.generation,
          body: {
            baseDraftRevision: this.metadata.draftRevision,
            mutationId: uid(),
            contentHash: this.metadata.proposalHash,
            ...values,
          },
        };
      }
      const batch = this.batch;
      this.report("saving");
      try {
        const { draft } = await this.request(batch.draftId, batch.body);
        if (this.disposed) return false;
        this.metadata = draft;
        this.batch = null;
        this.acknowledge(draft, batch.generation, batch.body);
      } catch (reason) {
        if (this.disposed) return false;
        const error = reason as {
          status?: number;
          data?: Record<string, unknown>;
        };
        if (error?.status === 409) {
          const data = error.data ?? {};
          this.conflict = {
            latestDraft: (data.latestDraft as DraftSummary | undefined) ?? null,
            recoveryDraft:
              (data.recoveryDraft as DraftSummary | undefined) ?? null,
          };
          this.report("conflict", messageOf(reason), this.conflict);
        } else {
          this.failed = true;
          this.report("failed", messageOf(reason));
        }
        return false;
      }
    }
    if (this.disposed) return false;
    this.report("saved");
    return true;
  }
  /** The conflict copy already contains the captured batch, not necessarily newer local edits. */
  adoptRecovery(draft: DraftDetail): boolean {
    if (!this.batch || draft.id !== this.conflict?.recoveryDraft?.id)
      return false;
    const savedBatch = this.batch;
    this.metadata = draft;
    this.batch = null;
    this.conflict = null;
    this.failed = false;
    this.acknowledge(draft, savedBatch.generation, savedBatch.body);
    this.report(this.pending() ? "dirty" : "saved");
    return true;
  }
}
