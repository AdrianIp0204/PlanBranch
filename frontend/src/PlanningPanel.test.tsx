import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import PlanningPanel from "./PlanningPanel";
import { MODEL_PREFERENCE_KEY, PLANNING_SERVER_RESTART } from "./ModelControls";
import { api } from "./api";
import { createBuildTask } from "./buildTasks";
import { createNode, copy, emptyBrief, type Content } from "./types";
import type { Session } from "./history";
import {
  samePlan,
  PLANNING_DRAFT_PREFIX,
  reviewNames,
  reviewValueText,
  type PlanProposal,
  type PlanningState,
  type QuestionSet,
} from "./planning";

vi.mock("./api", () => ({ api: vi.fn() }));
const flush = vi.fn<() => Promise<boolean>>();
let session: Session;
vi.mock("./store", () => ({
  useProject: () => ({ session, flush, getSnapshot: () => session }),
}));
const apply =
  vi.fn<(proposalId: string, mutationId: string) => Promise<void>>();
const reveal = vi.fn();
const close = vi.fn();
let state: PlanningState;
function baseState(): PlanningState {
  return {
    agent: { available: true, label: "Codex CLI" },
    messages: [],
    comments: [],
    proposals: [],
    approval: null,
    request: null,
  };
}
function props() {
  return {
    diagramId: "diagram",
    nodeId: "step",
    onReveal: reveal,
    onApply: apply,
    onClose: close,
  };
}
async function mount() {
  const result = render(<PlanningPanel {...props()} />);
  await screen.findByText("What should this plan accomplish?");
  return result;
}
function posts(path: string) {
  return vi
    .mocked(api)
    .mock.calls.filter(
      ([url, options]) => url.endsWith(path) && options?.method === "POST",
    );
}
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  flush.mockResolvedValue(true);
  apply.mockResolvedValue();
  const node = {
    ...createNode("process", { x: 0, y: 0 }),
    id: "step",
    title: "Validate the input",
  };
  const content: Content = {
    schemaVersion: 1,
    name: "Planning",
    notes: "",
    diagrams: [{ id: "diagram", name: "Main", nodes: [node], edges: [] }],
    variables: [],
    nodeLinks: [],
    matches: [],
  };
  session = {
    id: "project",
    content,
    history: [{ id: "first", label: "Created", content: copy(content) }],
    cursor: "first",
    views: {},
    revision: 3,
    savedAt: "2026-09-20T00:00:00Z",
    generation: 0,
    savedGeneration: 0,
  };
  state = baseState();
  vi.mocked(api).mockImplementation(async () => copy(state));
});
afterEach(cleanup);

it("sends the reviewed candidate and retains its exact revision context after an uncertain response and reload", async () => {
  let calls = 0;
  withModels((path, options) => {
    if (
      path.endsWith("/messages") &&
      options?.method === "POST" &&
      ++calls === 1
    )
      throw new Error("Reply connection lost");
    return copy(state);
  });
  const diagram = copy(session.content.diagrams[0]);
  diagram.nodes[0].title = "Manual candidate";
  const revision = {
    proposalId: "proposal",
    title: "Candidate plan",
    diagram,
    brief: { ...emptyBrief(), goal: "Manually reviewed brief" },
    editableSections: ["diagram", "brief"] as ("diagram" | "brief")[],
    nonce: "revision-1",
  };
  const view = render(
    <PlanningPanel {...props()} revisionRequest={revision} />,
  );
  await screen.findByText("Candidate plan");
  fireEvent.change(screen.getByLabelText("Message Codex"), {
    target: { value: "Keep my title and refine the description" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Reply connection lost");
  const captured = JSON.parse(posts("/messages")[0][1]!.body as string);
  expect(captured).toMatchObject({
    proposalId: "proposal",
    proposalDiagram: diagram,
    proposalBrief: revision.brief,
    nodeId: null,
  });
  expect(session.content.diagrams[0].nodes[0].title).toBe("Validate the input");
  view.unmount();
  render(<PlanningPanel {...props()} />);
  await screen.findByText("Candidate plan");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(2));
  expect(JSON.parse(posts("/messages")[1][1]!.body as string)).toEqual(
    captured,
  );
});

it("keeps a failed revision candidate when trying another model with a fresh request", async () => {
  withModels();
  const candidate = copy(session.content.diagrams[0]);
  candidate.nodes[0].title = "My manually refined candidate";
  candidate.nodes[0].notes = "Keep the changes from the preview";
  state.request = {
    id: "failed-revision",
    status: "failed",
    text: "Clarify the next step",
    diagramId: "diagram",
    payload: {
      mutationId: "failed-revision",
      text: "Clarify the next step",
      diagramId: "diagram",
      nodeId: null,
      selection: { mode: "explicit", model: "quick", reasoningEffort: "low" },
      proposalId: "original-proposal",
      proposalDiagram: candidate,
      proposalBrief: { ...emptyBrief(), goal: "Keep the reviewed brief" },
    },
  };
  await mount();
  await screen.findByRole("option", { name: "Careful planner" });
  fireEvent.click(
    screen.getByRole("button", { name: "Try with another model" }),
  );
  expect(screen.getByText("Reviewed proposal")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "careful" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(1));
  const request = JSON.parse(posts("/messages")[0][1]!.body as string);
  expect(request).toMatchObject({
    text: "Clarify the next step",
    proposalId: "original-proposal",
    proposalDiagram: candidate,
    proposalBrief: { ...emptyBrief(), goal: "Keep the reviewed brief" },
    nodeId: null,
    selection: { mode: "explicit", model: "careful", reasoningEffort: "high" },
  });
  expect(request.mutationId).not.toBe("failed-revision");
  expect(session.content.diagrams[0].nodes[0].title).toBe("Validate the input");
});

it("cancels proposal context without deleting the user's message", async () => {
  withModels();
  render(
    <PlanningPanel
      {...props()}
      revisionRequest={{
        proposalId: "proposal",
        title: "Candidate plan",
        diagram: copy(session.content.diagrams[0]),
        nonce: "revision-2",
      }}
    />,
  );
  await screen.findByText("Candidate plan");
  fireEvent.change(screen.getByLabelText("Message Codex"), {
    target: { value: "A different direction" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Cancel proposal revision" }),
  );
  expect(
    (screen.getByLabelText("Message Codex") as HTMLTextAreaElement).value,
  ).toBe("A different direction");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(1));
  expect(
    JSON.parse(posts("/messages")[0][1]!.body as string).proposalId,
  ).toBeUndefined();
});

describe("planning conversation", () => {
  it("preserves unsent text when saving fails and uses a fresh saved revision for approval", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "Add a validation branch" },
    });
    flush.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/Save your changes before continuing/);
    expect(posts("/messages")).toHaveLength(0);
    expect(
      (screen.getByLabelText("Message Codex") as HTMLTextAreaElement).value,
    ).toBe("Add a validation branch");
    flush.mockImplementationOnce(async () => {
      session.revision = 9;
      return true;
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await waitFor(() => expect(posts("/approve")).toHaveLength(1));
    expect(
      JSON.parse(posts("/approve")[0][1]!.body as string).baseRevision,
    ).toBe(9);
  });

  it("retries uncertain message delivery with the same identity and retains the draft", async () => {
    await mount();
    let attempts = 0;
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (
        path.endsWith("/messages") &&
        options?.method === "POST" &&
        attempts++ === 0
      )
        throw new Error("Connection interrupted");
      return copy(state);
    });
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "Check my plan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Connection interrupted");
    expect(
      (screen.getByLabelText("Message Codex") as HTMLTextAreaElement).value,
    ).toBe("Check my plan");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts("/messages")).toHaveLength(2));
    expect(posts("/messages")[0][1]!.body).toBe(posts("/messages")[1][1]!.body);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Message Codex") as HTMLTextAreaElement).value,
      ).toBe(""),
    );
  });

  it("shows field changes as inert text and applies only after explicit acceptance", async () => {
    state.proposals = [
      {
        id: "proposal",
        title: "Clarify validation",
        summary: "Add a precise input check.",
        diagramId: "diagram",
        baseRevision: 3,
        baseCursor: "first",
        baseHash: "hash",
        state: "pending",
        createdAt: "2026-09-20T00:00:00Z",
        changes: [
          {
            kind: "update_node",
            nodeId: "step",
            label: "Validate the input",
            field: "description",
            before: "Check input",
            after: "<script>alert('x')</script>",
          },
        ],
      },
    ];
    await mount();
    expect(
      (
        screen.getByRole("button", {
          name: "Approve plan",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Changes (1)" }));
    expect(screen.getByText("Check input")).toBeTruthy();
    expect(screen.getByText("<script>alert('x')</script>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Accept changes" }));
    await waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(apply.mock.calls[0][0]).toBe("proposal");
  });

  it("keeps approval for viewport changes but revokes it immediately for a manual edit", async () => {
    state.approval = {
      id: "approval",
      revision: 3,
      cursor: "first",
      contentHash: "hash",
      createdAt: "2026-09-20T00:00:00Z",
      current: true,
      snapshot: copy(session.content),
    };
    const result = await mount();
    expect(screen.getByText("Approved")).toBeTruthy();
    session = {
      ...session,
      generation: 1,
      views: { diagram: { x: 20, y: 5, zoom: 0.5 } },
    };
    result.rerender(<PlanningPanel {...props()} />);
    expect(screen.getByText("Approved")).toBeTruthy();
    session = {
      ...session,
      content: { ...session.content, notes: "A new constraint" },
    };
    result.rerender(<PlanningPanel {...props()} />);
    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reopen plan" })).toBeNull();
    expect(samePlan({ b: 1, a: [2] }, { a: [2], b: 1 })).toBe(true);
  });

  it("anchors comments, retains deleted-node discussion, and resolves explicitly", async () => {
    state.comments = [
      {
        id: "comment",
        nodeId: "step",
        nodeTitle: "Old title",
        diagramId: "diagram",
        text: "Handle empty input",
        createdAt: "2026-09-20T00:00:00Z",
        resolved: false,
      },
      {
        id: "deleted",
        nodeId: "gone",
        nodeTitle: "Removed task",
        diagramId: "diagram",
        text: "Keep this constraint",
        createdAt: "2026-09-20T00:00:00Z",
        resolved: false,
      },
    ];
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Comments (2)" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show node Validate the input in diagram Main",
      }),
    );
    expect(reveal).toHaveBeenCalledWith("step");
    expect(screen.getByText("Node unavailable in this plan")).toBeTruthy();
    const item = screen.getByText("Keep this constraint").closest("li")!;
    fireEvent.click(
      within(item).getByRole("button", { name: "Resolve comment" }),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(api)
          .mock.calls.some(
            ([path, options]) =>
              path.endsWith("/comments/deleted") &&
              options?.method === "PATCH" &&
              options.body === '{"resolved":true}',
          ),
      ).toBe(true),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Approve plan",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("keeps per-node comment drafts and supports keyboard tab navigation", async () => {
    const result = await mount();
    const conversation = screen.getByRole("tab", { name: "Chat" });
    conversation.focus();
    fireEvent.keyDown(conversation, { key: "ArrowRight" });
    const field = screen.getByLabelText("Comment on: Validate the input");
    fireEvent.change(field, { target: { value: "Use a strict schema" } });
    result.rerender(<PlanningPanel {...props()} nodeId={null} />);
    expect(
      screen.getByText("Select a node in the diagram to add a comment."),
    ).toBeTruthy();
    result.rerender(<PlanningPanel {...props()} />);
    expect(
      (
        screen.getByLabelText(
          "Comment on: Validate the input",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Use a strict schema");
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await waitFor(() => expect(posts("/comments")).toHaveLength(1));
    expect(JSON.parse(posts("/comments")[0][1]!.body as string)).toMatchObject({
      nodeId: "step",
      diagramId: "diagram",
      text: "Use a strict schema",
    });
  });

  it("disables sending when Codex is unavailable while leaving comments usable", async () => {
    state.agent = {
      available: false,
      label: "Codex CLI",
      reason: "Run codex login, then recheck.",
    };
    await mount();
    expect(screen.getByText("Run codex login, then recheck.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "Hello" },
    });
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Comments" }));
    fireEvent.change(screen.getByLabelText("Comment on: Validate the input"), {
      target: { value: "Review this step" },
    });
    expect(
      (screen.getByRole("button", { name: "Add comment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("does not offer acceptance for stale proposals and makes regeneration explicit", async () => {
    state.proposals = [
      {
        id: "stale",
        title: "Earlier suggestion",
        summary: "A previous revision.",
        diagramId: "diagram",
        baseRevision: 1,
        baseCursor: "old",
        baseHash: "old",
        state: "stale",
        createdAt: "2026-09-20T00:00:00Z",
        changes: [],
      },
    ];
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Changes" }));
    expect(screen.queryByRole("button", { name: "Accept changes" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Request updated proposal" }),
    );
    expect(
      (screen.getByLabelText("Message Codex") as HTMLTextAreaElement).value,
    ).toContain("reflect the current plan");
    expect(posts("/messages")).toHaveLength(0);
  });

  it("recovers unsent conversation and node drafts after switching away", async () => {
    const first = await mount();
    fireEvent.change(screen.getByLabelText("Message Codex"), {
      target: { value: "Keep my unsent request" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Comments" }));
    fireEvent.change(screen.getByLabelText("Comment on: Validate the input"), {
      target: { value: "Keep this node constraint" },
    });
    first.unmount();
    await mount();
    expect(
      (screen.getByLabelText("Message Codex") as HTMLTextAreaElement).value,
    ).toBe("Keep my unsent request");
    fireEvent.click(screen.getByRole("tab", { name: "Comments" }));
    expect(
      (
        screen.getByLabelText(
          "Comment on: Validate the input",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep this node constraint");
    const stored = JSON.parse(
      sessionStorage.getItem(PLANNING_DRAFT_PREFIX + session.id)!,
    );
    expect(stored.comments.step).toBe("Keep this node constraint");
  });

  it("reuses the acceptance receipt after an uncertain committed response", async () => {
    state.proposals = [
      {
        id: "proposal",
        title: "Refine the step",
        summary: "A clarification.",
        diagramId: "diagram",
        baseRevision: 3,
        baseCursor: "first",
        baseHash: "hash",
        state: "pending",
        createdAt: "2026-09-20T00:00:00Z",
        changes: [],
      },
    ];
    apply.mockRejectedValueOnce(new Error("Response lost"));
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Changes (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept changes" }));
    await screen.findByText("Response lost");
    const fetchesBeforeFocus = vi.mocked(api).mock.calls.length;
    fireEvent.focus(window);
    expect(vi.mocked(api).mock.calls.length).toBe(fetchesBeforeFocus);
    expect(screen.getByRole("button", { name: "Accept changes" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept changes" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls[1]).toEqual(apply.mock.calls[0]);
  });

  it("creates a fresh approval receipt after reopening the same saved revision", async () => {
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (options?.method === "POST" && path.endsWith("/approve"))
        state.approval = {
          id: "approval",
          revision: session.revision,
          cursor: session.cursor,
          contentHash: "hash",
          createdAt: "2026-09-20T00:00:00Z",
          current: true,
          snapshot: copy(session.content),
        };
      if (options?.method === "POST" && path.endsWith("/reopen"))
        state.approval!.current = false;
      return copy(state);
    });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await screen.findByRole("button", { name: "Reopen plan" });
    fireEvent.click(screen.getByRole("button", { name: "Reopen plan" }));
    await screen.findByRole("button", { name: "Approve plan" });
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    await waitFor(() => expect(posts("/approve")).toHaveLength(2));
    const [first, second] = posts("/approve").map(([, options]) =>
      JSON.parse(options!.body as string),
    );
    expect(first.baseRevision).toBe(second.baseRevision);
    expect(first.mutationId).not.toBe(second.mutationId);
  });

  it("refreshes review state after a confirmed acceptance conflict without changing local content", async () => {
    state.proposals = [
      {
        id: "proposal",
        title: "Earlier proposal",
        summary: "A clarification.",
        diagramId: "diagram",
        baseRevision: 3,
        baseCursor: "first",
        baseHash: "hash",
        state: "pending",
        createdAt: "2026-09-20T00:00:00Z",
        changes: [],
      },
    ];
    const content = copy(session.content);
    apply.mockImplementationOnce(async () => {
      state.proposals[0].state = "stale";
      throw Object.assign(
        new Error("The plan has changed. Review the latest version."),
        { status: 409 },
      );
    });
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Changes (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept changes" }));
    await screen.findByText("The plan has changed. Review the latest version.");
    expect(
      screen.getByRole("button", { name: "Request updated proposal" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept changes" })).toBeNull();
    expect(session.content).toEqual(content);
  });

  it("describes complete node and edge edits without exposing opaque IDs or burying metadata", async () => {
    const node = {
      ...createNode("decision", { x: 80, y: 160 }),
      id: "opaque-added-node",
      title: "Is the input valid?",
      status: "blocked",
      blocker: "Need a schema",
      targetFile: "validator.py",
      checklist: [
        { id: "opaque-checklist", text: "Reject missing names", checked: true },
      ],
    };
    const proposal: PlanProposal = {
      id: "proposal",
      title: "Branch on validation",
      summary: "Add a decision",
      diagramId: "diagram",
      baseRevision: 3,
      baseCursor: "first",
      baseHash: "hash",
      state: "pending",
      createdAt: "2026-09-20T00:00:00Z",
      changes: [
        {
          kind: "add_node",
          nodeId: node.id,
          label: "Add a decision",
          before: null,
          after: node,
        },
        {
          kind: "add_edge",
          edgeId: "opaque-edge",
          label: "Connect validation",
          before: null,
          after: {
            id: "opaque-edge",
            source: "step",
            target: node.id,
            label: "Valid",
            sourceHandle: "yes",
            targetHandle: "in",
          },
        },
      ],
    };
    const names = reviewNames(session.content, proposal, "after");
    const nodeText = reviewValueText(proposal.changes[0], node, names);
    expect(nodeText).toContain("Node type: Decision");
    expect(nodeText).toContain("Status: Blocked");
    expect(nodeText).toContain("Position: x: 80, y: 160");
    expect(nodeText).toContain("Checklist: [x] Reject missing names");
    expect(nodeText).toContain("Target file: validator.py");
    expect(nodeText).toContain("Blocker: Need a schema");
    expect(nodeText).not.toContain("opaque-");
    expect(nodeText).not.toContain("Notes:");
    const edgeText = reviewValueText(
      proposal.changes[1],
      proposal.changes[1].after,
      names,
    );
    expect(edgeText).toContain("From: Validate the input");
    expect(edgeText).toContain("To: Is the input valid?");
    expect(edgeText).toContain("Source connection: Yes branch");
    expect(edgeText).toContain("Target connection: Input");
    expect(edgeText).not.toContain("opaque-");
    proposal.changes[1].label = "step → opaque-added-node";
    state.proposals = [proposal];
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "Changes (1)" }));
    expect(
      screen.getByRole("heading", {
        name: "Add connection: Validate the input → Is the input valid? · Valid",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("step → opaque-added-node")).toBeNull();
  });
});

it("keeps a reader's position and draft when new messages arrive until Jump to latest", async () => {
  const { container } = await mount();
  const input = screen.getByLabelText("Message Codex") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Unsent idea" } });
  input.focus();
  const transcript = container.querySelector(
    "#planning-view-conversation .planning-scroll",
  ) as HTMLElement;
  Object.defineProperties(transcript, {
    scrollHeight: { value: 900, configurable: true },
    clientHeight: { value: 300, configurable: true },
  });
  transcript.scrollTop = 40;
  fireEvent.scroll(transcript);
  expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeTruthy();
  state.messages.push({
    id: "new-reply",
    role: "assistant",
    text: "A new reply while you read.",
    createdAt: "2026-09-20T00:00:00Z",
    diagramId: "diagram",
    nodeId: null,
    nodeTitle: null,
    proposalId: null,
  });
  fireEvent.focus(window);
  await screen.findByText("A new reply while you read.");
  expect(transcript.scrollTop).toBe(40);
  expect(input.value).toBe("Unsent idea");
  expect(document.activeElement).toBe(input);
  fireEvent.click(screen.getByRole("button", { name: /Jump to latest/ }));
  expect(transcript.scrollTop).toBe(900);
  expect(input.value).toBe("Unsent idea");
});

const modelCatalogue = {
  status: "ready",
  source: "cli_catalogue",
  cliVersion: "test-cli",
  fetchedAt: "2026-09-20T00:00:00Z",
  models: [
    {
      id: "quick",
      label: "Quick planner",
      description: "",
      defaultReasoningEffort: "low",
      reasoningEfforts: [
        { id: "low", description: "" },
        { id: "medium", description: "" },
      ],
      isDefault: true,
    },
    {
      id: "careful",
      label: "Careful planner",
      description: "",
      defaultReasoningEffort: "high",
      reasoningEfforts: [{ id: "high", description: "" }],
      isDefault: false,
    },
  ],
};
function withModels(
  handler?: (path: string, options?: RequestInit) => unknown,
) {
  vi.mocked(api).mockImplementation(async (path, options) =>
    path.startsWith("/planning/capabilities")
      ? copy(modelCatalogue)
      : handler
        ? handler(path, options)
        : copy(state),
  );
}
it("freezes settings for an uncertain retry and permits an explicit new request", async () => {
  withModels((path, options) => {
    if (path.endsWith("/messages") && options?.method === "POST")
      throw new Error("Response lost");
    return copy(state);
  });
  await mount();
  await screen.findByRole("option", { name: "Quick planner" });
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "quick" },
  });
  expect(
    (screen.getByLabelText("Reasoning effort") as HTMLSelectElement).value,
  ).toBe("low");
  fireEvent.change(screen.getByLabelText("Message Codex"), {
    target: { value: "Use one validation loop" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Response lost");
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "careful" },
  });
  expect(
    (screen.getByLabelText("Reasoning effort") as HTMLSelectElement).value,
  ).toBe("high");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(2));
  expect(posts("/messages")[0][1]?.body).toBe(posts("/messages")[1][1]?.body);
  const old = JSON.parse(posts("/messages")[0][1]!.body as string);
  expect(old.selection).toEqual({
    mode: "explicit",
    model: "quick",
    reasoningEffort: "low",
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Send as new request",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Send as new request" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(3));
  const fresh = JSON.parse(posts("/messages")[2][1]!.body as string);
  expect(fresh.mutationId).not.toBe(old.mutationId);
  expect(fresh.selection).toEqual({
    mode: "explicit",
    model: "careful",
    reasoningEffort: "high",
  });
});
it("blocks stale saved selections without silently replacing them and keeps CLI default available", async () => {
  localStorage.setItem(
    MODEL_PREFERENCE_KEY,
    JSON.stringify({
      mode: "explicit",
      model: "retired",
      reasoningEffort: "high",
    }),
  );
  withModels();
  await mount();
  await screen.findByText(/Your saved model is no longer listed/);
  fireEvent.change(screen.getByLabelText("Message Codex"), {
    target: { value: "Review the plan" },
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Send",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe(
    "retired",
  );
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "" } });
  expect(
    (
      screen.getByRole("button", {
        name: "Send",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    (screen.getByLabelText("Reasoning effort") as HTMLSelectElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(1));
  expect(
    JSON.parse(posts("/messages")[0][1]!.body as string).selection,
  ).toEqual({ mode: "default" });
});
it("restores frozen uncertain-request settings after a tab reload", async () => {
  withModels((path, options) => {
    if (path.endsWith("/messages") && options?.method === "POST")
      throw new Error("Lost acknowledgement");
    return copy(state);
  });
  const first = await mount();
  await screen.findByRole("option", { name: "Quick planner" });
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "quick" },
  });
  fireEvent.change(screen.getByLabelText("Message Codex"), {
    target: { value: "Keep the loop" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Lost acknowledgement");
  const original = posts("/messages")[0][1]!.body;
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "careful" },
  });
  first.unmount();
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(2));
  expect(posts("/messages")[1][1]!.body).toBe(original);
});
it("known failed replies retry their stored payload after the model menu changes", async () => {
  state.request = {
    id: "existing-request",
    status: "failed",
    text: "Review this saved plan",
    diagramId: "diagram",
    nodeId: null,
    selection: { mode: "explicit", model: "quick", reasoningEffort: "low" },
    payload: {
      mutationId: "existing-request",
      text: "Review this saved plan",
      diagramId: "diagram",
      nodeId: null,
      selection: { mode: "explicit", model: "quick", reasoningEffort: "low" },
    },
  };
  withModels();
  await mount();
  await screen.findByRole("option", { name: "Careful planner" });
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "careful" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry agent reply" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(1));
  expect(JSON.parse(posts("/messages")[0][1]!.body as string)).toEqual(
    state.request!.payload,
  );
});

function openQuestions(): QuestionSet {
  return {
    id: "question-set",
    requestId: "question-request",
    messageId: "question-message",
    diagramId: "diagram",
    nodeId: null,
    baseHash: "hash",
    baseSnapshot: copy(session.content),
    state: "open",
    questions: [
      {
        id: "storage",
        kind: "choice",
        prompt: "Choose storage for the first version",
        options: [
          { id: "json", label: "JSON file", description: "Simple" },
          { id: "sqlite", label: "SQLite", description: "Structured" },
        ],
        recommendedOptionId: "sqlite",
      },
    ],
    answers: null,
    createdAt: "2026-09-20T00:00:00Z",
    answeredAt: null,
    continuationRequestId: null,
  };
}

it("explains an old server inline and preserves the draft and settings through recovery", async () => {
  const selected = {
    mode: "explicit",
    model: "quick",
    reasoningEffort: "medium",
  };
  localStorage.setItem(MODEL_PREFERENCE_KEY, JSON.stringify(selected));
  let restarted = false;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.startsWith("/planning/capabilities")) {
      if (!restarted)
        throw Object.assign(new Error("Unknown API route."), { status: 404 });
      return copy(modelCatalogue);
    }
    return copy(state);
  });
  await mount();
  await screen.findByText(PLANNING_SERVER_RESTART);
  const composer = screen.getByLabelText("Message Codex");
  fireEvent.change(composer, { target: { value: "Keep this unsent plan" } });
  expect(
    (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
  expect(posts("/messages")).toHaveLength(0);
  expect(flush).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(MODEL_PREFERENCE_KEY)!)).toEqual(
    selected,
  );
  restarted = true;
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await screen.findByRole("option", { name: "Quick planner" });
  expect(screen.queryByText(PLANNING_SERVER_RESTART)).toBeNull();
  expect((composer as HTMLTextAreaElement).value).toBe("Keep this unsent plan");
  expect(
    (screen.getByLabelText("Reasoning effort") as HTMLSelectElement).value,
  ).toBe("medium");
  expect(posts("/messages")).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "careful" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(1));
  expect(
    JSON.parse(posts("/messages")[0][1]!.body as string).selection,
  ).toEqual({
    mode: "explicit",
    model: "careful",
    reasoningEffort: "high",
  });
});

it("handles a legacy selection rejection without dropping settings or retrying automatically", async () => {
  withModels((path, options) => {
    if (path.endsWith("/messages") && options?.method === "POST")
      throw Object.assign(
        new Error("Unexpected fields in planning message: selection."),
        { status: 400 },
      );
    return copy(state);
  });
  await mount();
  await screen.findByRole("option", { name: "Quick planner" });
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "quick" },
  });
  const composer = screen.getByLabelText("Message Codex");
  fireEvent.change(composer, { target: { value: "Keep my message" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText(PLANNING_SERVER_RESTART);
  expect((composer as HTMLTextAreaElement).value).toBe("Keep my message");
  expect(screen.queryByText(/Retry keeps the original settings/)).toBeNull();
  expect(screen.queryByText(/Unexpected fields/)).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
  expect(posts("/messages")).toHaveLength(1);
  expect(
    JSON.parse(posts("/messages")[0][1]!.body as string).selection,
  ).toEqual({
    mode: "explicit",
    model: "quick",
    reasoningEffort: "low",
  });
  expect(
    JSON.parse(sessionStorage.getItem(PLANNING_DRAFT_PREFIX + session.id)!)
      .failedPrompt,
  ).toBeNull();
});

it("blocks failed reply retries and new question answers against an old server", async () => {
  state.request = {
    id: "failed-request",
    status: "failed",
    text: "Make a plan",
    diagramId: "diagram",
    nodeId: null,
    selection: { mode: "default" },
  };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.startsWith("/planning/capabilities"))
      throw Object.assign(new Error("Unknown API route."), { status: 404 });
    return copy(state);
  });
  await mountQuestions();
  await screen.findAllByText(PLANNING_SERVER_RESTART);
  expect(
    (
      screen.getByRole("button", {
        name: "Retry agent reply",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
  expect(
    (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(posts("/messages")).toHaveLength(0);
  expect(posts("/answers")).toHaveLength(0);
  expect(
    (screen.getByRole("radio", { name: /SQLite/ }) as HTMLInputElement).checked,
  ).toBe(true);
});

it("retains an uncertain answer receipt while a mismatched server blocks its retry", async () => {
  withModels((path, options) => {
    if (path.endsWith("/answers") && options?.method === "POST")
      throw new Error("Answer acknowledgement lost");
    return copy(state);
  });
  const view = await mountQuestions();
  fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("Answer acknowledgement lost");
  const original = posts("/answers")[0][1]!.body;
  view.unmount();
  let restarted = false;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path.startsWith("/planning/capabilities")) {
      if (!restarted)
        throw Object.assign(new Error("Unknown API route."), { status: 404 });
      return copy(modelCatalogue);
    }
    return copy(state);
  });
  render(<PlanningPanel {...props()} />);
  await screen.findAllByText(PLANNING_SERVER_RESTART);
  const retry = screen.getByRole("button", { name: "Retry answers" });
  expect((retry as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(retry);
  expect(posts("/answers")).toHaveLength(1);
  restarted = true;
  fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
  await waitFor(() =>
    expect((retry as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(retry);
  await waitFor(() => expect(posts("/answers")).toHaveLength(2));
  expect(posts("/answers")[1][1]!.body).toBe(original);
});
async function mountQuestions() {
  state.questionSets = [openQuestions()];
  const view = render(<PlanningPanel {...props()} />);
  await screen.findByRole("group", {
    name: "Choose storage for the first version",
  });
  return view;
}
it("submits clarification exactly once without editing the graph or approving it", async () => {
  withModels((path, options) => {
    if (path.endsWith("/answers") && options?.method === "POST") {
      const answer = JSON.parse(options.body as string);
      state.questionSets![0].state = "answered";
      state.questionSets![0].answers = answer.answers;
    }
    return copy(state);
  });
  const original = copy(session.content);
  await mountQuestions();
  expect(
    (screen.getByRole("button", { name: "Approve plan" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("Answers submitted");
  expect(posts("/answers")).toHaveLength(1);
  expect(JSON.parse(posts("/answers")[0][1]!.body as string)).toMatchObject({
    baseRevision: 3,
    answers: [{ questionId: "storage", optionId: "sqlite", text: null }],
    selection: { mode: "default" },
  });
  expect(posts("/messages")).toHaveLength(0);
  expect(posts("/approve")).toHaveLength(0);
  expect(session.content).toEqual(original);
});
it("preserves answer drafts across reload and repeats lost acknowledgements with the exact body", async () => {
  let attempts = 0;
  withModels((path, options) => {
    if (
      path.endsWith("/answers") &&
      options?.method === "POST" &&
      attempts++ === 0
    )
      throw new Error("Answer acknowledgement lost");
    return copy(state);
  });
  let view = await mountQuestions();
  fireEvent.click(screen.getByRole("radio", { name: "Something else" }));
  fireEvent.change(screen.getByLabelText("Your answer"), {
    target: { value: "An in-memory store" },
  });
  view.unmount();
  view = render(<PlanningPanel {...props()} />);
  await screen.findByLabelText("Your answer");
  expect(
    (screen.getByLabelText("Your answer") as HTMLTextAreaElement).value,
  ).toBe("An in-memory store");
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("Answer acknowledgement lost");
  const original = posts("/answers")[0][1]!.body;
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "careful" },
  });
  view.unmount();
  render(<PlanningPanel {...props()} />);
  await screen.findByRole("button", { name: "Retry answers" });
  session.revision = 12;
  session.content.notes = "A newer manual requirement";
  flush.mockResolvedValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry answers" }));
  await waitFor(() => expect(posts("/answers")).toHaveLength(2));
  expect(posts("/answers")[1][1]!.body).toBe(original);
});
it("marks manual changes outdated but ignores viewport and composer layout changes", async () => {
  withModels();
  const view = await mountQuestions();
  fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
  session.views = { diagram: { x: 50, y: 20, zoom: 1.5 } };
  view.rerender(<PlanningPanel {...props()} composerHeight={250} />);
  expect(screen.queryByText("Plan changed")).toBeNull();
  session.content.notes = "A changed requirement";
  view.rerender(<PlanningPanel {...props()} composerHeight={200} />);
  await screen.findByText("Plan changed");
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Ask again using this plan" }),
  );
  await waitFor(() => expect(posts("/messages")).toHaveLength(1));
  const persisted = JSON.parse(
    sessionStorage.getItem(PLANNING_DRAFT_PREFIX + session.id)!,
  );
  expect(persisted.questionDrafts["question-set"].storage.choice).toBe(
    "sqlite",
  );
  expect(posts("/answers")).toHaveLength(0);
});
it("lets a normal message explicitly change direction while questions are pending", async () => {
  withModels();
  await mountQuestions();
  fireEvent.change(screen.getByLabelText("Message Codex"), {
    target: { value: "Use SQLite and focus on export first." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Change direction" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(1));
  expect(JSON.parse(posts("/messages")[0][1]!.body as string).text).toBe(
    "Use SQLite and focus on export first.",
  );
  expect(posts("/answers")).toHaveLength(0);
});

it("unlocks an outdated question draft after a confirmed conflict without retaining an uncertain receipt", async () => {
  withModels((path, options) => {
    if (path.endsWith("/answers") && options?.method === "POST") {
      state.questionSets![0].state = "stale";
      throw Object.assign(new Error("The plan changed in another tab"), {
        status: 409,
      });
    }
    return copy(state);
  });
  await mountQuestions();
  fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("The plan changed in another tab");
  expect(screen.queryByRole("button", { name: "Retry answers" })).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "Ask again using this plan",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(screen.getByText("Saved draft answers")).toBeTruthy();
});

it.each(["constructor", "__proto__"])(
  "stores a legal question-set and question ID named %s as own draft keys",
  async (id) => {
    withModels();
    const questions = openQuestions();
    questions.id = id;
    questions.questions = [
      {
        id,
        kind: "text",
        prompt: "Name the runtime",
        options: [],
        recommendedOptionId: null,
      },
    ];
    state.questionSets = [questions];
    render(<PlanningPanel {...props()} />);
    const input = await screen.findByLabelText("Your answer");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      await screen.findByText("Enter your answer to continue."),
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "Python" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(posts("/answers")).toHaveLength(1));
    expect(JSON.parse(posts("/answers")[0][1]!.body as string).answers).toEqual(
      [{ questionId: id, optionId: null, text: "Python" }],
    );
    const stored = JSON.parse(
      sessionStorage.getItem(PLANNING_DRAFT_PREFIX + session.id)!,
    );
    expect(Object.hasOwn(stored.questionDrafts, id)).toBe(true);
    expect(Object.hasOwn(stored.questionDrafts[id], id)).toBe(true);
  },
);

it.each(["constructor", "__proto__"])(
  "starts an empty comment draft and submits for a legal node ID named %s",
  async (id) => {
    session.content.diagrams[0].nodes[0].id = id;
    render(<PlanningPanel {...props()} nodeId={id} />);
    await screen.findByText("What should this plan accomplish?");
    fireEvent.click(screen.getByRole("tab", { name: "Comments" }));
    const input = screen.getByLabelText(
      "Comment on: Validate the input",
    ) as HTMLTextAreaElement;
    expect(input.value).toBe("");
    expect(
      (screen.getByRole("button", { name: "Add comment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(input, { target: { value: "Keep validation explicit" } });
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
    await waitFor(() => expect(posts("/comments")).toHaveLength(1));
    expect(JSON.parse(posts("/comments")[0][1]!.body as string)).toMatchObject({
      nodeId: id,
      text: "Keep validation explicit",
    });
    await waitFor(() => expect(input.value).toBe(""));
  },
);

it.each(["messages", "answers"])(
  "does not steal focus after a delayed %s acknowledgement when the user moved elsewhere",
  async (endpoint) => {
    let acknowledge!: (value: PlanningState) => void;
    const response = new Promise<PlanningState>((resolve) => {
      acknowledge = resolve;
    });
    withModels((path, options) =>
      path.endsWith("/" + endpoint) && options?.method === "POST"
        ? response
        : copy(state),
    );
    if (endpoint === "answers") state.questionSets = [openQuestions()];
    render(
      <>
        <button>Workspace menu</button>
        <PlanningPanel {...props()} />
      </>,
    );
    await screen.findByRole("option", { name: "Quick planner" });
    if (endpoint === "answers") {
      fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
      const submit = screen.getByRole("button", { name: "Continue" });
      submit.focus();
      fireEvent.click(submit);
    } else {
      const input = screen.getByLabelText("Message Codex");
      input.focus();
      fireEvent.change(input, { target: { value: "Plan the import" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    }
    await waitFor(() => expect(posts("/" + endpoint)).toHaveLength(1));
    const menu = screen.getByRole("button", { name: "Workspace menu" });
    menu.focus();
    await act(async () => acknowledge(copy(state)));
    expect(document.activeElement).toBe(menu);
  },
);

it("restores composer focus after answers only while the original interaction still owns it", async () => {
  let acknowledge!: (value: PlanningState) => void;
  const response = new Promise<PlanningState>((resolve) => {
    acknowledge = resolve;
  });
  withModels((path, options) =>
    path.endsWith("/answers") && options?.method === "POST"
      ? response
      : copy(state),
  );
  await mountQuestions();
  fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
  const submit = screen.getByRole("button", { name: "Continue" });
  submit.focus();
  fireEvent.click(submit);
  await waitFor(() => expect(posts("/answers")).toHaveLength(1));
  state.questionSets![0].state = "answered";
  await act(async () => acknowledge(copy(state)));
  expect(document.activeElement).toBe(screen.getByLabelText("Message Codex"));
});

it("does not focus a hidden planning pane after a delayed acknowledgement", async () => {
  let acknowledge!: (value: PlanningState) => void;
  const response = new Promise<PlanningState>((resolve) => {
    acknowledge = resolve;
  });
  withModels((path, options) =>
    path.endsWith("/messages") && options?.method === "POST"
      ? response
      : copy(state),
  );
  const view = await mount();
  const input = screen.getByLabelText("Message Codex");
  input.focus();
  fireEvent.change(input, { target: { value: "Plan the import" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(1));
  view.rerender(<PlanningPanel {...props()} active={false} />);
  input.blur();
  await act(async () => acknowledge(copy(state)));
  expect(document.activeElement).not.toBe(input);
});

it("omits uneditable diagram context when sending a brief-only revision and preserves that boundary after failure", async () => {
  let calls = 0;
  withModels((path, options) => {
    if (
      path.endsWith("/messages") &&
      options?.method === "POST" &&
      ++calls === 1
    )
      throw new Error("Brief acknowledgement lost");
    return copy(state);
  });
  const brief = { ...emptyBrief(), goal: "Review this brief only" };
  const view = render(
    <PlanningPanel
      {...props()}
      revisionRequest={{
        proposalId: "brief-proposal",
        title: "Brief revision",
        diagram: copy(session.content.diagrams[0]),
        brief,
        editableSections: ["brief"],
        nonce: "brief-revision",
      }}
    />,
  );
  await screen.findByText("Brief revision");
  fireEvent.change(screen.getByLabelText("Message Codex"), {
    target: { value: "Clarify the goal" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Brief acknowledgement lost");
  const first = JSON.parse(posts("/messages")[0][1]!.body as string);
  expect(first.proposalBrief).toEqual(brief);
  expect(first).not.toHaveProperty("proposalDiagram");
  view.unmount();
  render(<PlanningPanel {...props()} />);
  await screen.findByText("Brief revision");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(2));
  expect(JSON.parse(posts("/messages")[1][1]!.body as string)).toEqual(first);
});

it("preserves explicit remove-all-tasks revision payloads through an uncertain retry and reload", async () => {
  let attempts = 0;
  withModels((path, options) => {
    if (
      path.endsWith("/messages") &&
      options?.method === "POST" &&
      ++attempts === 1
    )
      throw new Error("Task response lost");
    return copy(state);
  });
  const view = render(
    <PlanningPanel
      {...props()}
      revisionRequest={{
        proposalId: "task-proposal",
        title: "Build revision",
        diagram: copy(session.content.diagrams[0]),
        buildTasks: [],
        editableSections: ["buildTasks"],
        nonce: "task-revision",
      }}
    />,
  );
  await screen.findByText("Build revision");
  fireEvent.change(screen.getByLabelText("Message Codex"), {
    target: { value: "Start the task breakdown again" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Task response lost");
  const captured = JSON.parse(posts("/messages")[0][1]!.body as string);
  expect(captured.proposalBuildTasks).toEqual([]);
  expect(captured).not.toHaveProperty("proposalDiagram");
  expect(captured).not.toHaveProperty("proposalBrief");
  view.unmount();
  render(<PlanningPanel {...props()} />);
  await screen.findByText("Build revision");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts("/messages")).toHaveLength(2));
  expect(JSON.parse(posts("/messages")[1][1]!.body as string)).toEqual(
    captured,
  );
});

it("allows approval of a manual build-only plan without inventing flow nodes", async () => {
  const prototype = HTMLDialogElement.prototype;
  const show = Object.getOwnPropertyDescriptor(prototype, "showModal"),
    closeDialog = Object.getOwnPropertyDescriptor(prototype, "close");
  Object.defineProperty(prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
  try {
    session.content.schemaVersion = 3;
    session.content.diagrams[0].nodes = [];
    session.content.buildTasks = [
      { ...createBuildTask(), id: "manual-work", title: "My task" },
    ];
    withModels();
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /Plan status/ }));
    expect(
      (
        screen.getByRole("button", {
          name: "Approve plan",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  } finally {
    cleanup();
    if (show) Object.defineProperty(prototype, "showModal", show);
    else Reflect.deleteProperty(prototype, "showModal");
    if (closeDialog) Object.defineProperty(prototype, "close", closeDialog);
    else Reflect.deleteProperty(prototype, "close");
  }
});
