import { useRef, useState } from "react";
import type {
  PlanningQuestion,
  QuestionAnswer,
  QuestionDraft,
  QuestionSet,
} from "./planning";
export const emptyQuestionDraft = (): QuestionDraft => ({
  choice: null,
  custom: false,
  text: "",
});
function readQuestionDraft(
  drafts: Record<string, QuestionDraft>,
  id: string,
): QuestionDraft {
  return Object.hasOwn(drafts, id) ? drafts[id] : emptyQuestionDraft();
}
export function answersFromDrafts(
  questions: PlanningQuestion[],
  drafts: Record<string, QuestionDraft>,
): QuestionAnswer[] | null {
  const answers: QuestionAnswer[] = [];
  for (const question of questions) {
    const draft = readQuestionDraft(drafts, question.id);
    if (question.kind === "text" || draft.custom) {
      if (!draft.text.trim() || draft.text.trim().length > 2000) return null;
      answers.push({
        questionId: question.id,
        optionId: null,
        text: draft.text.trim(),
      });
    } else {
      if (!question.options.some((option) => option.id === draft.choice))
        return null;
      answers.push({
        questionId: question.id,
        optionId: draft.choice,
        text: null,
      });
    }
  }
  return answers;
}
export default function QuestionCard({
  set,
  drafts,
  onDraft,
  onSubmit,
  onAskAgain,
  stale,
  busy,
  blocked,
}: {
  set: QuestionSet;
  drafts: Record<string, QuestionDraft>;
  onDraft: (questionId: string, draft: QuestionDraft) => void;
  onSubmit: (answers: QuestionAnswer[]) => void;
  onAskAgain: () => void;
  stale: boolean;
  busy: boolean;
  blocked: string;
}) {
  const [page, setPage] = useState(0);
  const [error, setError] = useState("");
  const heading = useRef<HTMLParagraphElement>(null);
  const question = set.questions[Math.min(page, set.questions.length - 1)];
  if (!question) return null;
  const draft = readQuestionDraft(drafts, question.id);
  function navigate(next: number) {
    setError("");
    setPage(next);
    requestAnimationFrame(() => heading.current?.focus());
  }
  function continueAnswer() {
    if (!answersFromDrafts([question], drafts)) {
      setError(
        question.kind === "text" || draft.custom
          ? "Enter your answer to continue."
          : "Choose an option or write your own answer.",
      );
      return;
    }
    if (page < set.questions.length - 1) {
      navigate(page + 1);
      return;
    }
    const answers = answersFromDrafts(set.questions, drafts);
    if (!answers) {
      setError("Answer each question before continuing.");
      return;
    }
    onSubmit(answers);
  }
  if (set.state === "answered")
    return (
      <section
        className="planning-question-summary"
        aria-label="Answered questions"
        id={`question-set-${set.id}`}
      >
        <strong>Answers submitted</strong>
        <dl>
          {set.questions.map((item) => {
            const answer = set.answers?.find(
              (value) => value.questionId === item.id,
            );
            return (
              <div key={item.id}>
                <dt>{item.prompt}</dt>
                <dd>
                  {answer?.optionId
                    ? item.options.find(
                        (option) => option.id === answer.optionId,
                      )?.label || answer.optionId
                    : answer?.text || "Answer unavailable"}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>
    );
  if (set.state === "superseded")
    return (
      <details
        className="planning-question-summary"
        id={`question-set-${set.id}`}
      >
        <summary>Earlier questions replaced</summary>
        <dl>
          {set.questions.map((item) => {
            const value = readQuestionDraft(drafts, item.id);
            return (
              <div key={item.id}>
                <dt>{item.prompt}</dt>
                <dd>
                  {value?.custom || item.kind === "text"
                    ? value?.text || "No draft answer"
                    : item.options.find((option) => option.id === value?.choice)
                        ?.label || "No draft answer"}
                </dd>
              </div>
            );
          })}
        </dl>
      </details>
    );
  return (
    <section
      className="planning-question-card"
      aria-label="Clarification questions"
      id={`question-set-${set.id}`}
    >
      <p className="planning-question-progress" ref={heading} tabIndex={-1}>
        Question {page + 1} of {set.questions.length}
      </p>
      {stale ? (
        <div className="planning-question-outdated">
          <strong>Plan changed</strong>
          <p>
            These questions refer to an earlier plan. Your draft answers are
            kept.
          </p>
          <button disabled={busy} onClick={onAskAgain}>
            Ask again using this plan
          </button>
          {Object.values(drafts).some(
            (value) => value.choice || value.text,
          ) && (
            <details className="planning-question-summary">
              <summary>Saved draft answers</summary>
              <dl>
                {set.questions.map((item) => {
                  const value = readQuestionDraft(drafts, item.id);
                  return (
                    <div key={item.id}>
                      <dt>{item.prompt}</dt>
                      <dd>
                        {value?.custom || item.kind === "text"
                          ? value?.text || "No draft answer"
                          : item.options.find(
                              (option) => option.id === value?.choice,
                            )?.label || "No draft answer"}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </details>
          )}
        </div>
      ) : null}
      <fieldset disabled={busy || stale}>
        <legend>{question.prompt}</legend>
        {question.kind === "choice" && (
          <div className="planning-question-options">
            {question.options.map((option) => (
              <label key={option.id} className="planning-question-option">
                <input
                  type="radio"
                  name={`question-${set.id}-${question.id}`}
                  checked={!draft.custom && draft.choice === option.id}
                  onChange={() => {
                    setError("");
                    onDraft(question.id, {
                      ...draft,
                      choice: option.id,
                      custom: false,
                    });
                  }}
                />
                <span>
                  <strong>{option.label}</strong>
                  {question.recommendedOptionId === option.id && (
                    <small className="planning-recommended">Recommended</small>
                  )}
                  {option.description && <small>{option.description}</small>}
                </span>
              </label>
            ))}
            <label className="planning-question-option">
              <input
                type="radio"
                name={`question-${set.id}-${question.id}`}
                checked={draft.custom}
                onChange={() => {
                  setError("");
                  onDraft(question.id, { ...draft, custom: true });
                }}
              />
              <span>Something else</span>
            </label>
          </div>
        )}
        {(question.kind === "text" || draft.custom) && (
          <label className="planning-question-text">
            Your answer
            <textarea
              aria-label="Your answer"
              value={draft.text}
              maxLength={2000}
              rows={3}
              onChange={(event) => {
                setError("");
                onDraft(question.id, { ...draft, text: event.target.value });
              }}
            />
          </label>
        )}
      </fieldset>
      {error && (
        <p className="planning-question-error" role="alert">
          {error}
        </p>
      )}
      {!stale && (
        <div className="planning-question-actions">
          {page > 0 && (
            <button disabled={busy} onClick={() => navigate(page - 1)}>
              Back
            </button>
          )}
          <button
            className="primary"
            disabled={
              busy || (page === set.questions.length - 1 && Boolean(blocked))
            }
            onClick={continueAnswer}
          >
            {page === set.questions.length - 1 ? "Continue" : "Next"}
          </button>
        </div>
      )}
      {blocked && !stale && (
        <p className="planning-question-error">{blocked}</p>
      )}
    </section>
  );
}
