import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import PlanningPanel from "./PlanningPanel";
import { api } from "./api";
import { createNode, copy, type Content } from "./types";
import type { Session } from "./history";
import {
  samePlan,
  PLANNING_DRAFT_PREFIX,
  reviewNames,
  reviewValueText,
  type PlanProposal,
  type PlanningState,
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
    fireEvent.click(screen.getByRole("tab", { name: "Review (1)" }));
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
    expect(screen.getByText("Plan approved")).toBeTruthy();
    session = {
      ...session,
      generation: 1,
      views: { diagram: { x: 20, y: 5, zoom: 0.5 } },
    };
    result.rerender(<PlanningPanel {...props()} />);
    expect(screen.getByText("Plan approved")).toBeTruthy();
    session = {
      ...session,
      content: { ...session.content, notes: "A new constraint" },
    };
    result.rerender(<PlanningPanel {...props()} />);
    expect(screen.getByText("Plan needs review")).toBeTruthy();
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
    const conversation = screen.getByRole("tab", { name: "Conversation" });
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
    fireEvent.click(screen.getByRole("tab", { name: "Review" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "Review (1)" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "Review (1)" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "Review (1)" }));
    expect(
      screen.getByRole("heading", {
        name: "Add connection: Validate the input → Is the input valid? · Valid",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("step → opaque-added-node")).toBeNull();
  });
});
