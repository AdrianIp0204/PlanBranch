import { useState } from "react";
import { Dialog } from "./ui";
import type { Content } from "./types";
import type { PlanningState } from "./planning";
import type useWritingDrafts from "./useWritingDrafts";
import type { WritingPayload } from "./writingDrafts";
import "./writing-drafts.css";
export function writingText(value: WritingPayload) {
  return [
    value.message,
    ...Object.entries(value.comments)
      .filter(([, text]) => text)
      .map(([id, text]) => `Comment (${id})\n${text}`),
    ...Object.entries(value.questionDrafts).map(
      ([id, answers]) =>
        `Answers (${id})\n` +
        Object.values(answers)
          .map((answer) => answer.text || answer.choice || "")
          .filter(Boolean)
          .join("\n"),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}
export default function WritingRecovery({
  writing,
  content,
  planning,
}: {
  writing: ReturnType<typeof useWritingDrafts>;
  content: Content;
  planning: PlanningState | null;
}) {
  const [open, setOpen] = useState(false),
    [notice, setNotice] = useState("");
  const nodes = new Set(
    content.diagrams.flatMap((diagram) => diagram.nodes.map((node) => node.id)),
  );
  const orphanComments = Object.entries(writing.value.comments).filter(
    ([id, text]) => text && !nodes.has(id),
  );
  const orphanQuestions = Object.entries(writing.value.questionDrafts).filter(
    ([id]) =>
      planning &&
      !planning.questionSets?.some(
        (set) => set.id === id && set.state === "open",
      ),
  );
  const ctx = writing.value.context;
  const orphanMessage =
    !!writing.value.message &&
    !!ctx &&
    (!content.diagrams.some((d) => d.id === ctx.diagramId) ||
      (ctx.nodeId !== null && !nodes.has(ctx.nodeId)));
  const orphanRevision =
    !!writing.value.revision &&
    !!planning &&
    !planning.proposals.some(
      (p) =>
        p.id === writing.value.revision!.proposalId && p.state === "pending",
    );
  const needsAttention =
    writing.status === "failed" ||
    writing.status === "conflict" ||
    writing.copies.length > 0 ||
    orphanComments.length > 0 ||
    orphanQuestions.length > 0 ||
    orphanMessage ||
    orphanRevision;
  const label =
    writing.status === "loading"
      ? "Loading writing…"
      : writing.status === "saving"
        ? "Saving writing…"
        : writing.status === "dirty"
          ? "Writing not saved"
          : needsAttention
            ? "Recover writing"
            : "Writing saved";
  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied writing.");
    } catch {
      setNotice("Select the text below and copy it.");
    }
  }
  return (
    <>
      <button
        type="button"
        className={`writing-state ${needsAttention ? "needs-attention" : ""}`}
        onClick={() => setOpen(true)}
        aria-label={`Unsent writing: ${label}`}
        data-testid="writing-save-state"
      >
        {label}
        {writing.copies.length > 0
          ? ` · ${writing.copies.length} saved ${writing.copies.length === 1 ? "copy" : "copies"}`
          : ""}
      </button>
      {open && (
        <Dialog
          title="Unsent writing"
          className="writing-dialog"
          onClose={() => setOpen(false)}
        >
          <p>
            Saved on this computer, separate from the plan. Recovery never sends
            a message.
          </p>
          <p role="status">{notice || label}</p>
          {writing.error && <p role="alert">{writing.error}</p>}
          {writing.status === "failed" && (
            <button onClick={() => void writing.retry()}>
              Retry writing save
            </button>
          )}
          {writing.conflict && (
            <div className="writing-actions">
              <button
                disabled={!writing.ready}
                onClick={() => void writing.useMine()}
              >
                Use my writing
              </button>
              <button
                disabled={!writing.ready}
                onClick={() => void writing.loadOther()}
              >
                Load other writing
              </button>
            </div>
          )}
          {(orphanMessage || orphanRevision) && (
            <section aria-label="Unavailable message context">
              <h3>Message context is no longer available</h3>
              <p>
                Copy this writing before discarding it, or return to its
                original proposal if it is still under review.
              </p>
              <textarea
                aria-label="Orphaned message"
                readOnly
                value={writing.value.message}
              />
              <div className="writing-actions">
                <button onClick={() => void copyText(writing.value.message)}>
                  Copy message
                </button>
                <button
                  disabled={!writing.ready}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Discard this unsent message and its unavailable context?",
                      )
                    ) {
                      writing.set("message", "");
                      writing.set("context", null);
                      writing.set("revision", null);
                      writing.set("failedPrompt", null);
                    }
                  }}
                >
                  Discard orphaned message
                </button>
              </div>
            </section>
          )}
          {orphanComments.map(([id, text]) => (
            <section key={id} aria-label={`Comment for removed node ${id}`}>
              <h3>Comment for a removed node</h3>
              <textarea aria-label="Orphaned comment" readOnly value={text} />
              <div className="writing-actions">
                <button onClick={() => void copyText(text)}>
                  Copy comment
                </button>
                <button
                  disabled={!writing.ready}
                  onClick={() => {
                    if (window.confirm("Discard this unsent comment?"))
                      writing.set("comments", (current) => {
                        delete current[id];
                        return current;
                      });
                  }}
                >
                  Discard orphaned comment
                </button>
              </div>
            </section>
          ))}
          {orphanQuestions.map(([id, answers]) => {
            const set = planning?.questionSets?.find((item) => item.id === id);
            const text = Object.entries(answers)
              .map(([questionId, answer]) => {
                const question = set?.questions.find(
                  (item) => item.id === questionId,
                );
                const response =
                  answer.text ||
                  question?.options.find((item) => item.id === answer.choice)
                    ?.label ||
                  answer.choice ||
                  "";
                return question ? `${question.prompt}: ${response}` : response;
              })
              .join("\n");
            return (
              <section
                key={id}
                aria-label={`Answers for unavailable questions ${id}`}
              >
                <h3>Answers for earlier questions</h3>
                <textarea
                  aria-label="Earlier unsent answers"
                  readOnly
                  value={text}
                />
                <div className="writing-actions">
                  <button onClick={() => void copyText(text)}>
                    Copy answers
                  </button>
                  <button
                    disabled={!writing.ready}
                    onClick={() => {
                      if (window.confirm("Discard these unsent answers?"))
                        writing.set("questionDrafts", (current) => {
                          delete current[id];
                          return current;
                        });
                    }}
                  >
                    Discard earlier answers
                  </button>
                </div>
              </section>
            );
          })}
          <details>
            <summary>Current writing</summary>
            <textarea
              aria-label="Current unsent writing"
              value={writingText(writing.value)}
              readOnly
            />
            <button onClick={() => void copyText(writingText(writing.value))}>
              Copy current writing
            </button>
          </details>
          {writing.copies.map((saved) => (
            <section
              key={saved.id}
              aria-label={`Saved writing copy ${saved.id}`}
            >
              <h3>
                Saved copy
                {saved.updatedAt
                  ? ` · ${new Date(saved.updatedAt).toLocaleString()}`
                  : ""}
              </h3>
              <textarea
                aria-label="Saved writing copy"
                readOnly
                value={writingText(saved.payload)}
              />
              <div className="writing-actions">
                <button
                  disabled={!writing.ready}
                  onClick={() => void writing.select(saved)}
                >
                  Use this copy
                </button>
                <button
                  onClick={() => void copyText(writingText(saved.payload))}
                >
                  Copy saved writing
                </button>
                <button
                  disabled={!writing.ready}
                  onClick={() => {
                    if (window.confirm("Discard this saved writing copy?"))
                      void writing.discard(saved);
                  }}
                >
                  Discard copy
                </button>
              </div>
            </section>
          ))}
        </Dialog>
      )}
    </>
  );
}
