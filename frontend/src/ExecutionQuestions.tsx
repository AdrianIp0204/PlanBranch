import { useState } from "react";
import QuestionCard from "./QuestionCard";
import type { ExecutionRun } from "./execution";
import type { QuestionAnswer, QuestionDraft, QuestionSet } from "./planning";

export default function ExecutionQuestions({
  run,
  busy,
  onSubmit,
}: {
  run: ExecutionRun;
  busy: boolean;
  onSubmit: (answers: QuestionAnswer[]) => void;
}) {
  const question = run.question!;
  const key = `planbranch.execution-question.v1.${run.id}.${question.id}`;
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) ?? "{}");
      if (!value || typeof value !== "object") return {};
      return Object.fromEntries(
        question.questions
          .filter((item) => Object.hasOwn(value, item.id))
          .flatMap((item) => {
            const draft = value[item.id];
            return draft &&
              (draft.choice === null || typeof draft.choice === "string") &&
              typeof draft.custom === "boolean" &&
              typeof draft.text === "string" &&
              draft.text.length <= 2000
              ? [[item.id, draft]]
              : [];
          }),
      );
    } catch {
      return {};
    }
  });
  const set: QuestionSet = {
    id: question.id,
    requestId: run.id,
    messageId: run.id,
    diagramId: "",
    nodeId: null,
    baseHash: "",
    state: "open",
    questions: question.questions,
    answers: null,
    createdAt: question.createdAt,
    answeredAt: null,
    continuationRequestId: null,
  };
  return (
    <section
      className="execution-section execution-questions"
      aria-label="Execution questions"
    >
      <h3>Input needed</h3>
      <p>
        Continue resumes this run with its original provider, model, and
        worktree. Review any changes below first.
      </p>
      <QuestionCard
        set={set}
        drafts={drafts}
        stale={false}
        busy={busy}
        blocked={
          run.planStale || run.sourceStale
            ? "The plan or repository baseline changed. Restore the reviewed state before continuing."
            : !run.artifact
              ? "Refresh results before answering."
              : ""
        }
        onAskAgain={() => {}}
        onSubmit={onSubmit}
        onDraft={(id, value) => {
          setDrafts((current) => {
            const next = { ...current, [id]: value };
            try {
              sessionStorage.setItem(key, JSON.stringify(next));
            } catch {
              /* Keep the current window usable. */
            }
            return next;
          });
        }}
      />
    </section>
  );
}
