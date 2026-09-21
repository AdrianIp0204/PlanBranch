import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import ProposalWorkspace, {
  type ProposalDetail,
  type ProposalLeaveGuard,
  type ProposalWorkspaceProps,
} from "./ProposalWorkspace";
import { api } from "./api";
import type { DraftDetail } from "./durableDrafts";
import { copy, createNode, type Content } from "./types";
import {
  diagramMarks,
  proposalDraftKey,
  ProposalDraftProvider,
  readProposalDraft,
  validDraftDiagram,
} from "./proposalDraft";
import { useProject } from "./store";

const { fitView } = vi.hoisted(() => ({ fitView: vi.fn(async () => true) }));
vi.mock("./api", () => ({ api: vi.fn() }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xyflow/react")>();
  const { useLayoutEffect } = await import("react");
  return {
    ...original,
    ReactFlow: (props: any) => {
      useLayoutEffect(() => {
        props.onInit?.({
          fitView,
          screenToFlowPosition: (position: unknown) => position,
        });
      }, []);
      return (
        <div data-testid="graph">
          {props.nodes.map((n: any) => (
            <button
              key={n.id}
              data-mark={n.data.changeMark}
              data-selected={n.selected ? "true" : "false"}
              onClick={() => props.onNodeClick?.({}, n)}
              onDoubleClick={() => props.onNodeDoubleClick?.({}, n)}
            >
              {n.data.task.title}
            </button>
          ))}
          {props.edges.map((edge: any) => (
            <button
              key={edge.id}
              aria-label={`Graph connection ${edge.id}`}
              data-selected={edge.selected ? "true" : "false"}
              onClick={() => props.onEdgeClick?.({}, edge)}
            >
              Connection
            </button>
          ))}
        </div>
      );
    },
  };
});

function detail(): ProposalDetail {
  const keep = createNode("process", { x: 80, y: 120 });
  keep.id = "keep";
  keep.title = "Original task";
  keep.notes = "Keep the notes";
  keep.checklist = [{ id: "check", text: "Keep this check", checked: true }];
  const removed = createNode("process", { x: 360, y: 120 });
  removed.id = "removed";
  removed.title = "Removed task";
  const before: Content = {
    schemaVersion: 1,
    name: "Saved project",
    notes: "Project notes",
    diagrams: [
      {
        id: "main",
        name: "Main flow",
        nodes: [keep, removed],
        edges: [
          {
            id: "edge",
            source: "keep",
            target: "removed",
            label: "Old connection",
          },
        ],
      },
      { id: "other", name: "Other", nodes: [], edges: [] },
    ],
    variables: [],
    nodeLinks: [],
    matches: [],
  };
  const content = copy(before);
  content.diagrams[0].nodes[0].title = "Proposed task";
  content.diagrams[0].nodes.pop();
  const added = createNode("decision", { x: 360, y: 160 });
  added.id = "added";
  added.title = "Added decision";
  content.diagrams[0].nodes.push(added);
  content.diagrams[0].edges[0].target = "added";
  return {
    content,
    baseContent: before,
    contentHash: "candidate-hash",
    proposal: {
      id: "proposal",
      title: "Refine the flow",
      summary: "A refined plan",
      diagramId: "main",
      baseRevision: 2,
      baseCursor: "cursor",
      baseHash: "base",
      state: "pending",
      createdAt: "2026-09-20",
      changes: [],
    },
  };
}
async function setup(overrides: Partial<ProposalWorkspaceProps> = {}) {
  const props: ProposalWorkspaceProps = {
    detail: detail(),
    projectId: "project",
    onApply: vi.fn(async () => {}),
    onRevise: vi.fn(),
    onDiscard: vi.fn(async () => {}),
    onClose: vi.fn(),
    stale: false,
    ...overrides,
  };
  const result = render(<ProposalWorkspace {...props} />);
  await screen.findByRole("region", { name: "Proposed changes workspace" });
  return { ...result, props };
}
function editTitle(value = "My manual title") {
  fireEvent.click(screen.getByRole("button", { name: "Edit manually" }));
  fireEvent.doubleClick(screen.getByRole("button", { name: "Proposed task" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value } });
  fireEvent.blur(screen.getByLabelText("Title"));
}
const savedDrafts = new Map<string, DraftDetail>();
let failSaves = false;
async function mockDraftApi(path: string, options: RequestInit = {}) {
  if (path.endsWith("/symbols")) return { symbols: [] };
  if (path.endsWith("/drafts")) {
    const drafts = [...savedDrafts.values()];
    return { drafts, defaultDraftId: drafts.at(-1)?.id ?? null };
  }
  if (path.includes("/drafts/")) {
    const id = path.split("/").at(-1)!;
    if (options.method === "PUT") {
      if (failSaves) throw new Error("Draft storage unavailable.");
      const body = JSON.parse(options.body as string);
      const candidate = detail().content;
      candidate.diagrams[0] = body.diagram;
      const draft: DraftDetail = {
        id,
        proposalId: "proposal",
        diagramId: "main",
        candidate,
        draftRevision: (savedDrafts.get(id)?.draftRevision ?? 0) + 1,
        state: "active",
        createdAt: "2026-09-21T08:00:00Z",
        updatedAt: "2026-09-21T08:01:00Z",
        baseRevision: 2,
        baseHash: "base",
        proposalHash: "candidate-hash",
        conflictOf: null,
        stale: false,
        appliedCursor: null,
        applyRequest: null,
      };
      savedDrafts.set(id, copy(draft));
      return { draft };
    }
    return { draft: copy(savedDrafts.get(id)!) };
  }
  return {};
}
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  savedDrafts.clear();
  failSaves = false;
  vi.mocked(api).mockImplementation(mockDraftApi as typeof api);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("proposal canvas review", async () => {
  it("shows candidate graph, then its immutable before snapshot, including removed nodes", async () => {
    const { props } = await setup();
    expect(
      screen
        .getByRole("button", { name: "Added decision" })
        .getAttribute("data-mark"),
    ).toBe("Added");
    expect(
      screen
        .getByRole("button", { name: "Proposed task" })
        .getAttribute("data-mark"),
    ).toBe("Changed");
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    expect(
      screen
        .getByRole("button", { name: "Removed task" })
        .getAttribute("data-mark"),
    ).toBe("Removed");
    expect(screen.getByRole("button", { name: "Original task" })).toBeTruthy();
    expect(props.detail.baseContent!.diagrams[0].nodes[0].title).toBe(
      "Original task",
    );
    expect(
      vi
        .mocked(api)
        .mock.calls.some(([, options]) => options?.method === "PUT"),
    ).toBe(false);
  });
  it("isolates manual edits, preserves IDs and metadata, and applies only the edited diagram", async () => {
    const { props } = await setup();
    editTitle();
    fireEvent.click(screen.getByRole("button", { name: "Undo manual edit" }));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Proposed task",
    );
    fireEvent.click(screen.getByRole("button", { name: "Redo manual edit" }));
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "My manual title",
    );
    expect(props.detail.content.diagrams[0].nodes[0].title).toBe(
      "Proposed task",
    );
    expect(
      vi
        .mocked(api)
        .mock.calls.some(([, options]) => options?.method === "PUT"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalledTimes(1));
    const candidate = vi.mocked(props.onApply).mock.calls[0][0]!;
    expect(candidate.nodes[0]).toMatchObject({
      id: "keep",
      title: "My manual title",
      notes: "Keep the notes",
      checklist: [{ id: "check", text: "Keep this check", checked: true }],
    });
    expect(candidate.edges[0]).toEqual(
      props.detail.content.diagrams[0].edges[0],
    );
    expect(
      sessionStorage.getItem(
        proposalDraftKey("project", "proposal", "candidate-hash"),
      ),
    ).toBeNull();
  });
  it("retains a failed apply draft, recovers it on remount, and never changes project history", async () => {
    const onApply = vi.fn(async () => {
      throw new Error("Project changed. Refresh the proposal.");
    });
    const { unmount } = await setup({ onApply });
    editTitle();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await screen.findByText("Project changed. Refresh the proposal.");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "My manual title",
    );
    unmount();
    const recovered = await setup();
    expect(
      screen.getByRole("button", { name: "My manual title" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask Codex" }));
    expect(
      vi.mocked(recovered.props.onRevise).mock.calls[0][0].nodes[0].title,
    ).toBe("My manual title");
    expect(savedDrafts.size).toBe(1);
  });
  it("requires discard confirmation and clears recovery only after success", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { props } = await setup();
    editTitle();
    const key = proposalDraftKey("project", "proposal", "candidate-hash");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "My manual title" }),
    ).toBeTruthy();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(props.onDiscard).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it("prevents stale apply while allowing an explicit request for a revised proposal", async () => {
    const { props } = await setup({ stale: true });
    expect(
      (
        screen.getByRole("button", {
          name: "Apply changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Ask Codex" }));
    expect(props.onRevise).toHaveBeenCalledWith(
      props.detail.content.diagrams[0],
    );
  });
  it("keeps browser native text undo and confines canvas undo to the draft", async () => {
    const parentKey = vi.fn();
    const props: ProposalWorkspaceProps = {
      detail: detail(),
      projectId: "project",
      onApply: vi.fn(),
      onRevise: vi.fn(),
      onDiscard: vi.fn(),
      onClose: vi.fn(),
      stale: false,
    };
    render(
      <div onKeyDown={parentKey}>
        <ProposalWorkspace {...props} />
      </div>,
    );
    await screen.findByRole("region", { name: "Proposed changes workspace" });
    editTitle();
    const title = screen.getByLabelText("Title");
    fireEvent.keyDown(title, { key: "z", ctrlKey: true });
    expect((title as HTMLInputElement).value).toBe("My manual title");
    parentKey.mockClear();
    fireEvent.keyDown(
      screen.getByRole("region", { name: "Proposed changes workspace" }),
      { key: "z", ctrlKey: true },
    );
    expect((title as HTMLInputElement).value).toBe("Proposed task");
    expect(parentKey).not.toHaveBeenCalled();
  });
  it("reports failed database saves and guards leaving and browser close", async () => {
    const { props } = await setup();
    failSaves = true;
    editTitle();
    fireEvent.click(screen.getByRole("button", { name: "Back to plan" }));
    await screen.findByText("Draft storage unavailable.");
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();
    failSaves = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry draft save" }));
    await waitFor(() =>
      expect(screen.getByTestId("proposal-draft-state").textContent).toContain(
        "Draft saved",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to plan" }));
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
  });
});

describe("proposal recovery and keyboard details", async () => {
  it("offers explicit Apply retry while allowing navigation with a durable receipt", async () => {
    const onApply = vi.fn(async () => {
      throw new Error("Connection lost");
    });
    const { props, rerender } = await setup({ onApply });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await screen.findByText("Connection lost");
    rerender(<ProposalWorkspace {...props} retryingApply stale />);
    const back = screen.getByRole("button", {
      name: "Back to plan",
    }) as HTMLButtonElement;
    const retry = screen.getByRole("button", {
      name: "Retry apply",
    }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(retry.disabled).toBe(false);
    expect(retry.getAttribute("aria-describedby")).toBe(
      "proposal-apply-recovery",
    );
    fireEvent.click(retry);
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));
  });
  it("moves keyboard focus into Details and restores it on Escape and Close", async () => {
    await setup();
    const toggle = screen.getByRole("button", { name: "Details" });
    toggle.focus();
    fireEvent.click(toggle, { detail: 0 });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close details" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle, { detail: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
  it("restores focus when the details separator collapses the panel", async () => {
    await setup();
    const toggle = screen.getByRole("button", { name: "Details" });
    fireEvent.click(toggle);
    const separator = screen.getByRole("separator", {
      name: "Resize proposal details",
    });
    separator.focus();
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
  it("keeps an unblurred manual edit when Escape closes its details", async () => {
    const { props } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit manually" }));
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "Proposed task" }),
    );
    const title = screen.getByLabelText("Title");
    title.focus();
    fireEvent.change(title, { target: { value: "Keep this edit" } });
    fireEvent.keyDown(title, { key: "Escape" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Details" }),
    );
    expect(screen.getByRole("button", { name: "Keep this edit" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalledOnce());
    expect(vi.mocked(props.onApply).mock.calls[0][0]?.nodes[0].title).toBe(
      "Keep this edit",
    );
  });
});

describe("registered proposal leave guard", () => {
  it("flushes the latest unblurred field and stays when saving fails", async () => {
    let guard: ProposalLeaveGuard | null = null;
    const { unmount } = await setup({
      onRegisterLeaveGuard: (value) => {
        guard = value;
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit manually" }));
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "Proposed task" }),
    );
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Still typing" },
    });
    failSaves = true;
    await act(async () => {
      expect(await guard!()).toBe(false);
    });
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Still typing",
    );
    failSaves = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry draft save" }));
    await waitFor(() =>
      expect(screen.getByTestId("proposal-draft-state").textContent).toContain(
        "Draft saved",
      ),
    );
    await act(async () => {
      expect(await guard!()).toBe(true);
    });
    expect(
      [...savedDrafts.values()][0].candidate.diagrams[0].nodes[0].title,
    ).toBe("Still typing");
    unmount();
    expect(guard).toBeNull();
  });
  it("prevents replacement during Apply then retains durable recovery when leaving", async () => {
    let rejectApply!: (reason: Error) => void;
    const pending = new Promise<void>((_, reject) => {
      rejectApply = reject;
    });
    let guard: ProposalLeaveGuard | null = null;
    const onApply = vi.fn(() => pending);
    const { props, rerender } = await setup({
      onApply,
      onRegisterLeaveGuard: (value) => {
        guard = value;
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(await guard!()).toBe(false);
    await act(async () => rejectApply(new Error("Connection lost")));
    await screen.findByText("Connection lost");
    rerender(<ProposalWorkspace {...props} retryingApply />);
    expect(await guard!()).toBe(true);
    expect(savedDrafts.size).toBe(1);
  });
});

describe("local draft boundaries", () => {
  it.each([
    [5000, 0],
    [2, 10000],
  ])(
    "restores drafts at the server limits (%i nodes, %i edges)",
    async (nodeCount, edgeCount) => {
      const fixture = detail();
      const original = fixture.content.diagrams[0];
      const draft = copy(original);
      const template = createNode("process", { x: 0, y: 0 });
      draft.nodes = Array.from({ length: nodeCount }, (_, index) => ({
        ...copy(template),
        id: `node-${index}`,
      }));
      draft.edges = Array.from({ length: edgeCount }, (_, index) => ({
        id: `edge-${index}`,
        source: "node-0",
        target: "node-1",
        label: "",
      }));
      const key = proposalDraftKey("p", "proposal", "large");
      sessionStorage.setItem(key, JSON.stringify(draft));
      function DraftCount() {
        const { session } = useProject();
        const graph = session.content.diagrams[0];
        return (
          <output>
            {graph.nodes.length}:{graph.edges.length}
          </output>
        );
      }
      render(
        <ProposalDraftProvider
          proposalId="proposal"
          contentHash="candidate-hash"
          projectId="p"
          content={fixture.content}
          diagramId={original.id}
          storageKey={key}
        >
          <DraftCount />
        </ProposalDraftProvider>,
      );
      await screen.findByText(`${nodeCount}:${edgeCount}`);
      expect(readProposalDraft(key, original)?.nodes.length).toBe(nodeCount);
      expect(readProposalDraft(key, original)?.edges.length).toBe(edgeCount);
      const tooLarge = copy(draft);
      if (nodeCount === 5000)
        tooLarge.nodes.push({ ...copy(template), id: "over-limit" });
      else
        tooLarge.edges.push({
          id: "over-limit",
          source: "node-0",
          target: "node-1",
          label: "",
        });
      expect(validDraftDiagram(tooLarge, original)).toBe(false);
    },
  );
  it("retains backend-valid IDs of 128 characters in recovered manual edits", async () => {
    const original = detail().content.diagrams[0];
    const draft = copy(original);
    draft.nodes[0].id = "n".repeat(128);
    draft.nodes[0].checklist[0].id = "c".repeat(128);
    draft.edges[0].id = "e".repeat(128);
    draft.edges[0].source = draft.nodes[0].id;
    const key = proposalDraftKey("p", "proposal", "long-ids");
    sessionStorage.setItem(key, JSON.stringify(draft));
    expect(readProposalDraft(key, original)).toEqual(draft);
    draft.nodes[0].checklist[0].id += "x";
    expect(validDraftDiagram(draft, original)).toBe(false);
  });

  it("ignores damaged drafts and a draft from another candidate", async () => {
    const original = detail().content.diagrams[0];
    const key = proposalDraftKey("p", "proposal", "hash");
    sessionStorage.setItem(
      key,
      JSON.stringify({
        ...original,
        edges: [{ id: "e", source: "missing", target: "keep", label: "" }],
      }),
    );
    expect(readProposalDraft(key, original)).toBeNull();
    sessionStorage.setItem(key, JSON.stringify(original));
    expect(
      readProposalDraft(
        proposalDraftKey("p", "proposal", "different"),
        original,
      ),
    ).toBeNull();
    expect(
      validDraftDiagram(
        {
          ...original,
          nodes: [{ ...original.nodes[0], position: { x: null, y: 0 } }],
        },
        original,
      ),
    ).toBe(false);
  });
  it("tracks reordered and changed connections by stable ID", async () => {
    const fixture = detail();
    const result = diagramMarks(
      fixture.baseContent!.diagrams[0],
      fixture.content.diagrams[0],
    );
    expect(result.edges.after.edge).toBe("Changed");
    expect(result.nodes.before.removed).toBe("Removed");
  });
  it("ignores edits outside the candidate diagram", async () => {
    function Harness() {
      const { change, session } = useProject();
      return (
        <>
          <button
            onClick={() =>
              change(
                (content) => {
                  content.name = "Wrong";
                  content.notes = "Wrong";
                  content.diagrams[1].name = "Wrong";
                  content.diagrams[0].nodes[0].title = "Allowed";
                  content.nodeLinks.push({
                    id: "bad",
                    nodeId: "keep",
                    variableId: "bad",
                    origin: "planned",
                    relationship: "reads",
                  });
                },
                "Edit",
                "main",
              )
            }
          >
            Try edits
          </button>
          <output>{JSON.stringify(session.content)}</output>
        </>
      );
    }
    const fixture = detail();
    render(
      <ProposalDraftProvider
        proposalId="proposal"
        contentHash="candidate-hash"
        projectId="p"
        content={fixture.content}
        diagramId="main"
        storageKey="test"
      >
        <Harness />
      </ProposalDraftProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Try edits" }));
    const value = JSON.parse(
      screen.getByRole("status").textContent!,
    ) as Content;
    expect(value.name).toBe("Saved project");
    expect(value.notes).toBe("Project notes");
    expect(value.diagrams[1].name).toBe("Other");
    expect(value.nodeLinks).toEqual([]);
    expect(value.diagrams[0].nodes[0].title).toBe("Allowed");
  });
});

describe("change navigation and advisory review", () => {
  it("routes removed nodes to Before and changed edges to Proposed, selecting and fitting their targets", async () => {
    await setup();
    expect(screen.getByTestId("review-change-counts").textContent).toBe(
      "1 added2 changed1 removed",
    );
    expect(screen.getByTestId("review-change-position").textContent).toBe(
      "0 of 4",
    );
    fireEvent.change(screen.getByLabelText("Review change"), {
      target: { value: "node:removed" },
    });
    expect(
      screen
        .getByRole("button", { name: "Before" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Removed task" })
        .getAttribute("data-selected"),
    ).toBe("true");
    await waitFor(() =>
      expect(fitView).toHaveBeenLastCalledWith(
        expect.objectContaining({ nodes: [{ id: "removed" }], duration: 0 }),
      ),
    );
    fireEvent.change(screen.getByLabelText("Review change"), {
      target: { value: "edge:edge" },
    });
    expect(
      screen
        .getByRole("button", { name: "Proposed" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Graph connection edge" })
        .getAttribute("data-selected"),
    ).toBe("true");
    await waitFor(() =>
      expect(fitView).toHaveBeenLastCalledWith(
        expect.objectContaining({ nodes: [{ id: "keep" }, { id: "added" }] }),
      ),
    );
    expect(
      vi
        .mocked(api)
        .mock.calls.some(([, options]) => options?.method === "PUT"),
    ).toBe(false);
  });
  it("supports scoped keyboard navigation and leaves native select and text keys alone", async () => {
    await setup();
    const next = screen.getByRole("button", { name: "Next change" });
    next.focus();
    fireEvent.click(next);
    const chooser = screen.getByLabelText("Review change") as HTMLSelectElement;
    expect(chooser.value).toBe("node:keep");
    fireEvent.keyDown(next, { key: "End" });
    expect(chooser.value).toBe("edge:edge");
    expect(document.activeElement).toBe(next);
    fireEvent.keyDown(next, { key: "ArrowRight" });
    expect(chooser.value).toBe("node:keep");
    fireEvent.keyDown(next, { key: "ArrowLeft" });
    expect(chooser.value).toBe("edge:edge");
    fireEvent.keyDown(next, { key: "Home" });
    expect(chooser.value).toBe("node:keep");
    fireEvent.keyDown(chooser, { key: "End" });
    expect(chooser.value).toBe("node:keep");
    editTitle("Typing while reviewing");
    const title = screen.getByLabelText("Title");
    title.focus();
    fireEvent.keyDown(title, { key: "ArrowRight" });
    expect(chooser.value).toBe("node:keep");
    expect(document.activeElement).toBe(title);
  });
  it("keeps a changed entity selected through edits and adjusts its index without stealing focus when the change disappears", async () => {
    await setup();
    fireEvent.change(screen.getByLabelText("Review change"), {
      target: { value: "node:keep" },
    });
    await waitFor(() => expect(fitView).toHaveBeenCalled());
    editTitle("Edited title");
    const chooser = screen.getByLabelText("Review change") as HTMLSelectElement;
    const title = screen.getByLabelText("Title");
    title.focus();
    expect(chooser.value).toBe("node:keep");
    fitView.mockClear();
    fireEvent.change(title, { target: { value: "Original task" } });
    expect(chooser.value).toBe("node:added");
    expect(document.activeElement).toBe(title);
    expect(screen.getByTestId("review-change-position").textContent).toBe(
      "1 of 3",
    );
    expect(fitView).not.toHaveBeenCalled();
  });
  it("keeps hints optional, navigable, dismissible and nonblocking", async () => {
    await setup();
    const disclosure = screen.getByText("Review hints (1)").closest("details")!;
    expect(disclosure.open).toBe(false);
    disclosure.open = true;
    fireEvent.click(screen.getByRole("button", { name: "Before" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add acceptance criteria: Added decision",
      }),
    );
    expect(
      screen
        .getByRole("button", { name: "Proposed" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Added decision" })
        .getAttribute("data-selected"),
    ).toBe("true");
    expect(disclosure.open).toBe(false);
    expect(document.activeElement).toBe(disclosure.querySelector("summary"));
    expect(
      (
        screen.getByRole("button", {
          name: "Apply changes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    disclosure.open = true;
    fireEvent.keyDown(
      screen.getByRole("button", {
        name: "Add acceptance criteria: Added decision",
      }),
      { key: "Escape" },
    );
    expect(disclosure.open).toBe(false);
    expect(document.activeElement).toBe(disclosure.querySelector("summary"));
  });
});
