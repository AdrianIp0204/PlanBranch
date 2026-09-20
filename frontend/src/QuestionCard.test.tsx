import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import QuestionCard, { answersFromDrafts } from "./QuestionCard";
import type { QuestionDraft, QuestionSet } from "./planning";
afterEach(cleanup);
export const questionSet: QuestionSet = {
  id: "questions",
  requestId: "request",
  messageId: "message",
  diagramId: "diagram",
  nodeId: null,
  baseHash: "base",
  state: "open",
  createdAt: "2026-09-20T00:00:00Z",
  answeredAt: null,
  continuationRequestId: null,
  answers: null,
  questions: [
    {
      id: "storage",
      kind: "choice",
      prompt: "Where should records live?",
      options: [
        { id: "json", label: "JSON file", description: "Small local store" },
        {
          id: "sqlite",
          label: "SQLite",
          description: "Structured local storage",
        },
      ],
      recommendedOptionId: "sqlite",
    },
    {
      id: "audience",
      kind: "choice",
      prompt: "Who will use it?",
      options: [
        { id: "personal", label: "Just me", description: "One person" },
        { id: "team", label: "A team", description: "Shared workflow" },
      ],
      recommendedOptionId: "team",
    },
  ],
};
it("keeps recommendations unselected, validates and preserves choices while navigating", () => {
  const submit = vi.fn();
  function Harness() {
    const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
    return (
      <QuestionCard
        set={questionSet}
        drafts={drafts}
        onDraft={(id, value) =>
          setDrafts((previous) => ({ ...previous, [id]: value }))
        }
        onSubmit={submit}
        onAskAgain={vi.fn()}
        stale={false}
        busy={false}
        blocked=""
      />
    );
  }
  render(<Harness />);
  expect(
    screen
      .getAllByRole("radio")
      .every((input) => !(input as HTMLInputElement).checked),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("alert").textContent).toMatch(/Choose an option/);
  fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("radio", { name: "Something else" }));
  fireEvent.change(screen.getByLabelText("Your answer"), {
    target: { value: "A class of five" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(
    (screen.getByRole("radio", { name: /SQLite/ }) as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(
    (screen.getByLabelText("Your answer") as HTMLTextAreaElement).value,
  ).toBe("A class of five");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(submit).toHaveBeenCalledWith([
    { questionId: "storage", optionId: "sqlite", text: null },
    { questionId: "audience", optionId: null, text: "A class of five" },
  ]);
});
it("supports genuinely free text and rejects incomplete or overlong answers", () => {
  const question = {
    id: "target",
    kind: "text" as const,
    prompt: "Which device?",
    options: [],
    recommendedOptionId: null,
  };
  expect(answersFromDrafts([question], {})).toBeNull();
  expect(
    answersFromDrafts([question], {
      target: { choice: null, custom: false, text: "x".repeat(2001) },
    }),
  ).toBeNull();
  expect(
    answersFromDrafts([question], {
      target: { choice: null, custom: false, text: "  Raspberry Pi  " },
    }),
  ).toEqual([{ questionId: "target", optionId: null, text: "Raspberry Pi" }]);
});
it("renders durable submitted answers as inert summaries with no input controls", () => {
  render(
    <QuestionCard
      set={{
        ...questionSet,
        state: "answered",
        answers: [
          { questionId: "storage", optionId: "sqlite", text: null },
          {
            questionId: "audience",
            optionId: null,
            text: "<script>keep as text</script>",
          },
        ],
      }}
      drafts={{}}
      onDraft={vi.fn()}
      onSubmit={vi.fn()}
      onAskAgain={vi.fn()}
      stale={false}
      busy={false}
      blocked=""
    />,
  );
  expect(screen.queryAllByRole("radio")).toHaveLength(0);
  expect(screen.getByText("SQLite")).toBeTruthy();
  expect(screen.getByText("<script>keep as text</script>")).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
});
it("keeps superseded draft answers recoverable without presenting them as submitted", () => {
  render(
    <QuestionCard
      set={{ ...questionSet, state: "superseded" }}
      drafts={{ storage: { choice: "json", custom: false, text: "" } }}
      onDraft={vi.fn()}
      onSubmit={vi.fn()}
      onAskAgain={vi.fn()}
      stale={false}
      busy={false}
      blocked=""
    />,
  );
  expect(screen.getByText("Earlier questions replaced")).toBeTruthy();
  expect(screen.getByText("JSON file")).toBeTruthy();
  expect(screen.queryByText("Answers submitted")).toBeNull();
});

it.each(["constructor", "__proto__"])(
  "treats %s as an ordinary question ID without reading inherited values",
  (id) => {
    const question = {
      id,
      kind: "text" as const,
      prompt: "Which device?",
      options: [],
      recommendedOptionId: null,
    };
    const submit = vi.fn();
    function Harness() {
      const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
      return (
        <QuestionCard
          set={{ ...questionSet, questions: [question] }}
          drafts={drafts}
          onDraft={(key, value) =>
            setDrafts((current) => ({ ...current, [key]: value }))
          }
          onSubmit={submit}
          onAskAgain={vi.fn()}
          stale={false}
          busy={false}
          blocked=""
        />
      );
    }
    expect(answersFromDrafts([question], {})).toBeNull();
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter your answer to continue.",
    );
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "A local device" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(submit).toHaveBeenCalledWith([
      { questionId: id, optionId: null, text: "A local device" },
    ]);
    expect(Object.hasOwn(Object.prototype, "text")).toBe(false);
  },
);
it.each(["constructor", "__proto__"])(
  "ignores inherited drafts named %s in restored summaries",
  (id) => {
    const inherited = Object.create({
      [id]: { choice: null, custom: true, text: "Inherited, not authored" },
    }) as Record<string, QuestionDraft>;
    const question = {
      id,
      kind: "text" as const,
      prompt: "Which device?",
      options: [],
      recommendedOptionId: null,
    };
    expect(answersFromDrafts([question], inherited)).toBeNull();
    render(
      <QuestionCard
        set={{ ...questionSet, state: "superseded", questions: [question] }}
        drafts={inherited}
        onDraft={vi.fn()}
        onSubmit={vi.fn()}
        onAskAgain={vi.fn()}
        stale={false}
        busy={false}
        blocked=""
      />,
    );
    expect(screen.getByText("No draft answer")).toBeTruthy();
    expect(screen.queryByText("Inherited, not authored")).toBeNull();
  },
);
