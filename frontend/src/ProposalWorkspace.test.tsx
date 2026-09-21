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
import { copy, createNode, type Content } from "./types";
import {
  diagramMarks,
  proposalDraftKey,
  ProposalDraftProvider,
  readProposalDraft,
  validDraftDiagram,
} from "./proposalDraft";
import { useProject } from "./store";

vi.mock("./api", () => ({ api: vi.fn() }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...original,
    ReactFlow: (props: any) => (
      <div data-testid="graph">
        {props.nodes.map((n: any) => (
          <button
            key={n.id}
            data-mark={n.data.changeMark}
            onClick={() => props.onNodeClick?.({}, n)}
            onDoubleClick={() => props.onNodeDoubleClick?.({}, n)}
          >
            {n.data.task.title}
          </button>
        ))}
      </div>
    ),
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
function setup(overrides: Partial<ProposalWorkspaceProps> = {}) {
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
  return { ...result, props };
}
function editTitle(value = "My manual title") {
  fireEvent.click(screen.getByRole("button", { name: "Edit manually" }));
  fireEvent.doubleClick(screen.getByRole("button", { name: "Proposed task" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value } });
  fireEvent.blur(screen.getByLabelText("Title"));
}
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("proposal canvas review", () => {
  it("shows candidate graph, then its immutable before snapshot, including removed nodes", () => {
    const { props } = setup();
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
    expect(api).not.toHaveBeenCalled();
  });
  it("isolates manual edits, preserves IDs and metadata, and applies only the edited diagram", async () => {
    const { props } = setup();
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
    expect(api).not.toHaveBeenCalled();
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
    const { unmount } = setup({ onApply });
    editTitle();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await screen.findByText("Project changed. Refresh the proposal.");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "My manual title",
    );
    unmount();
    const recovered = setup();
    expect(
      screen.getByRole("button", { name: "My manual title" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask Codex" }));
    expect(
      vi.mocked(recovered.props.onRevise).mock.calls[0][0].nodes[0].title,
    ).toBe("My manual title");
    expect(api).not.toHaveBeenCalled();
  });
  it("requires discard confirmation and clears recovery only after success", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { props } = setup();
    editTitle();
    const key = proposalDraftKey("project", "proposal", "candidate-hash");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).not.toBeNull();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(props.onDiscard).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it("prevents stale apply while allowing an explicit request for a revised proposal", () => {
    const { props } = setup({ stale: true });
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
  it("keeps browser native text undo and confines canvas undo to the draft", () => {
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
  it("reports unavailable draft storage and guards leaving and browser close", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage full");
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { props } = setup();
    editTitle();
    await screen.findByText(/Manual edits could not be kept/);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to plan" }));
    expect(confirm).toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

describe("proposal recovery and keyboard details", () => {
  it("makes blocked navigation explicit and offers an actionable Apply retry", async () => {
    const { props } = setup({ retryingApply: true, stale: true });
    const back = screen.getByRole("button", {
      name: "Back to plan",
    }) as HTMLButtonElement;
    const retry = screen.getByRole("button", {
      name: "Retry apply",
    }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(retry.disabled).toBe(false);
    expect(back.getAttribute("aria-describedby")).toBe(
      "proposal-apply-recovery",
    );
    expect(retry.getAttribute("aria-describedby")).toBe(
      "proposal-apply-recovery",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Editing and navigation stay paused",
    );
    fireEvent.click(back);
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(props.onApply).toHaveBeenCalledOnce());
  });
  it("moves keyboard focus into Details and restores it on Escape and Close", () => {
    setup();
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
  it("restores focus when the details separator collapses the panel", () => {
    setup();
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
    const { props } = setup();
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
  it("consults the latest unsaved field edit and unregisters on close", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage full");
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    let guard: ProposalLeaveGuard | null = null;
    const { unmount } = setup({
      onRegisterLeaveGuard: (value) => {
        guard = value;
      },
    });
    expect(guard!()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Edit manually" }));
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "Proposed task" }),
    );
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Still typing" },
    });
    await screen.findByText(/Manual edits could not be kept/);
    expect(guard!()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Still typing",
    );
    confirm.mockReturnValue(true);
    expect(guard!()).toBe(true);
    unmount();
    expect(guard).toBeNull();
  });
  it("allows switching when a manual draft was kept successfully", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    let guard: ProposalLeaveGuard | null = null;
    setup({
      onRegisterLeaveGuard: (value) => {
        guard = value;
      },
    });
    editTitle();
    expect(guard!()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(
      sessionStorage.getItem(
        proposalDraftKey("project", "proposal", "candidate-hash"),
      ),
    ).toContain("My manual title");
  });
  it("prevents replacement during Apply and while its outcome is uncertain", async () => {
    let rejectApply!: (reason: Error) => void;
    const pending = new Promise<void>((_, reject) => {
      rejectApply = reject;
    });
    let guard: ProposalLeaveGuard | null = null;
    const register = (value: ProposalLeaveGuard | null) => {
      guard = value;
    };
    const { props, rerender } = setup({
      onApply: () => pending,
      onRegisterLeaveGuard: register,
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(guard!()).toBe(false);
    await act(async () => {
      rejectApply(new Error("Connection lost"));
    });
    await screen.findByText("Connection lost");
    rerender(<ProposalWorkspace {...props} retryingApply />);
    expect(guard!()).toBe(false);
    rerender(<ProposalWorkspace {...props} retryingApply={false} />);
    expect(guard!()).toBe(true);
  });
});

describe("local draft boundaries", () => {
  it.each([
    [5000, 0],
    [2, 10000],
  ])(
    "restores drafts at the server limits (%i nodes, %i edges)",
    (nodeCount, edgeCount) => {
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
          projectId="p"
          content={fixture.content}
          diagramId={original.id}
          storageKey={key}
        >
          <DraftCount />
        </ProposalDraftProvider>,
      );
      expect(screen.getByRole("status").textContent).toBe(
        `${nodeCount}:${edgeCount}`,
      );
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
  it("retains backend-valid IDs of 128 characters in recovered manual edits", () => {
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

  it("ignores damaged drafts and a draft from another candidate", () => {
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
  it("tracks reordered and changed connections by stable ID", () => {
    const fixture = detail();
    const result = diagramMarks(
      fixture.baseContent!.diagrams[0],
      fixture.content.diagrams[0],
    );
    expect(result.edges.after.edge).toBe("Changed");
    expect(result.nodes.before.removed).toBe("Removed");
  });
  it("ignores edits outside the candidate diagram", () => {
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
        projectId="p"
        content={fixture.content}
        diagramId="main"
        storageKey="test"
      >
        <Harness />
      </ProposalDraftProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try edits" }));
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
