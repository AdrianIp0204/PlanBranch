import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { ProjectProvider, useProject } from "./store";
import Inspector from "./Inspector";
import { api } from "./api";
import { copy, createNode, type Envelope, type Content } from "./types";
vi.mock("./api", () => ({ api: vi.fn() }));
function envelope(): Envelope {
  const node = createNode("process", { x: 10, y: 20 });
  node.checklist = [{ id: "item", text: "Test invariant", checked: false }];
  const content: Content = {
    schemaVersion: 1,
    name: "Test",
    notes: "",
    diagrams: [{ id: "diagram", name: "Main", nodes: [node], edges: [] }],
    variables: [],
    nodeLinks: [],
    matches: [],
  };
  return {
    id: "project",
    revision: 1,
    savedAt: "2026-09-10T00:00:00Z",
    content,
    history: [{ id: "baseline", label: "Created", content: copy(content) }],
    cursor: "baseline",
    views: {},
  };
}
function Harness() {
  const { session, change, commit, flush, saveStatus } = useProject();
  return (
    <>
      <label>
        Editable notes
        <input
          value={session.content.notes}
          onChange={(e) =>
            change(
              (c) => {
                c.notes = e.target.value;
              },
              "Edit notes",
              undefined,
              true,
            )
          }
          onBlur={commit}
        />
      </label>
      <button onClick={() => void flush()}>Save now</button>
      <output data-testid="history-count">{session.history.length}</output>
      <output data-testid="save-status">{saveStatus}</output>
      <output data-testid="task-status">
        {session.content.diagrams[0].nodes[0].status}
      </output>
    </>
  );
}
function InspectorHarness() {
  const { session } = useProject();
  return (
    <Inspector
      diagram={session.content.diagrams[0]}
      selected={session.content.diagrams[0].nodes[0].id}
      symbols={[]}
      onSelect={() => {}}
      onVariable={() => {}}
    />
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api).mockImplementation(async (_path, options) => {
    const body = JSON.parse(String(options?.body));
    return {
      revision: body.baseRevision + 1,
      savedAt: "2026-09-10T01:00:00Z",
      historyIds: [
        body.anchorId,
        ...body.append.map((h: { id: string }) => h.id),
      ],
    };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});
describe("editor autosave and controls", () => {
  it("groups fast input until idle and saves one durable checkpoint", async () => {
    render(
      <ProjectProvider envelope={envelope()}>
        <Harness />
      </ProjectProvider>,
    );
    const field = screen.getByLabelText("Editable notes");
    fireEvent.change(field, { target: { value: "a" } });
    fireEvent.change(field, { target: { value: "ab" } });
    fireEvent.change(field, { target: { value: "abc" } });
    expect(screen.getByTestId("history-count").textContent).toBe("1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(599);
    });
    expect(api).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body));
    expect(body.append).toHaveLength(1);
    expect(body.append[0].content.notes).toBe("abc");
    expect(screen.getByTestId("history-count").textContent).toBe("2");
    expect(screen.getByTestId("save-status").textContent).toBe("saved");
  });
  it("explicit save commits pending text before the debounce expires", async () => {
    render(
      <ProjectProvider envelope={envelope()}>
        <Harness />
      </ProjectProvider>,
    );
    fireEvent.change(screen.getByLabelText("Editable notes"), {
      target: { value: "Save immediately" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save now" }));
    });
    expect(api).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("history-count").textContent).toBe("2");
  });
  it("keeps save failures visible and supports an explicit retry", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Disk unavailable"));
    render(
      <ProjectProvider envelope={envelope()}>
        <Harness />
      </ProjectProvider>,
    );
    fireEvent.change(screen.getByLabelText("Editable notes"), {
      target: { value: "Keep this" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.getByTestId("save-status").textContent).toBe("failed");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(api).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save now" }));
    });
    expect(screen.getByTestId("save-status").textContent).toBe("saved");
    const calls = vi.mocked(api).mock.calls;
    expect(calls[0][1]?.body).toBe(calls[1][1]?.body);
  });
  it("keeps checklist completion separate from implementation status", () => {
    render(
      <ProjectProvider envelope={envelope()}>
        <InspectorHarness />
        <Harness />
      </ProjectProvider>,
    );
    fireEvent.click(screen.getByLabelText("Complete Test invariant"));
    expect(
      (screen.getByLabelText("Complete Test invariant") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.getByTestId("task-status").textContent).toBe("not_started");
  });
  it("keeps one rename action while typing a new node title", () => {
    render(
      <ProjectProvider envelope={envelope()}>
        <InspectorHarness />
        <Harness />
      </ProjectProvider>,
    );
    const input = screen.getByLabelText("Title");
    fireEvent.change(input, { target: { value: "F" } });
    fireEvent.change(input, { target: { value: "Fi" } });
    fireEvent.change(input, { target: { value: "Finished" } });
    fireEvent.blur(input);
    expect(screen.getByTestId("history-count").textContent).toBe("2");
  });
});
