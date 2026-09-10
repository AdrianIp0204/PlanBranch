import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { NodeChange } from "@xyflow/react";
import Canvas, { type FlowNode } from "./Canvas";
import { ProjectProvider, useProject } from "./store";
import { api } from "./api";
import { copy, createNode, type Content, type Envelope } from "./types";

const rendered = vi.hoisted(() => ({ props: null as any }));
vi.mock("./api", () => ({ api: vi.fn() }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...original,
    ReactFlow: (props: unknown) => {
      rendered.props = props;
      return null;
    },
  };
});

function initial(): Envelope {
  const nodes = [
    createNode("process", { x: 100, y: 100 }),
    createNode("process", { x: 400, y: 100 }),
  ];
  nodes[0].id = "first";
  nodes[1].id = "second";
  const content: Content = {
    schemaVersion: 1,
    name: "Movement",
    notes: "",
    diagrams: [{ id: "diagram", name: "Main", nodes, edges: [] }],
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
  const { session, commit } = useProject();
  const [selected, setSelected] = useState<string | null>("first");
  return (
    <>
      <Canvas
        diagram={session.content.diagrams[0]}
        selected={selected}
        onSelect={(id) => {
          commit();
          setSelected(id);
        }}
        filter="all"
        onInstance={() => {}}
        connectRequest={false}
        onConnected={() => {}}
      />
      <output data-testid="positions">
        {JSON.stringify(
          session.content.diagrams[0].nodes.map((n) => n.position),
        )}
      </output>
      <output data-testid="history-count">{session.history.length}</output>
    </>
  );
}
function positions() {
  return JSON.parse(screen.getByTestId("positions").textContent!);
}
function changes(events: NodeChange<FlowNode>[]) {
  act(() => rendered.props.onNodesChange(events));
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
        ...body.append.map((entry: { id: string }) => entry.id),
      ],
    };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("canonical node movement", () => {
  it("persists completed keyboard positions and groups a continuous nudge burst", async () => {
    render(
      <ProjectProvider envelope={initial()}>
        <Harness />
      </ProjectProvider>,
    );
    for (let x = 110; x <= 190; x += 10) {
      changes([
        {
          id: "first",
          type: "position",
          position: { x, y: 100 },
          dragging: false,
        },
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    expect(positions()).toEqual([
      { x: 190, y: 100 },
      { x: 400, y: 100 },
    ]);
    expect(screen.getByTestId("history-count").textContent).toBe("1");
    expect(api).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(api).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("history-count").textContent).toBe("2");
    const body = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body));
    expect(body.append).toHaveLength(1);
    expect(body.append[0].content.diagrams[0].nodes[0].position).toEqual({
      x: 190,
      y: 100,
    });
  });

  it("keeps a long mouse drag transient until completion and creates one checkpoint", async () => {
    render(
      <ProjectProvider envelope={initial()}>
        <Harness />
      </ProjectProvider>,
    );
    act(() => rendered.props.onNodeDragStart());
    changes([
      {
        id: "first",
        type: "position",
        position: { x: 130, y: 140 },
        dragging: true,
      },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    changes([
      {
        id: "first",
        type: "position",
        position: { x: 160, y: 180 },
        dragging: false,
      },
    ]);
    expect(positions()[0]).toEqual({ x: 100, y: 100 });
    expect(api).not.toHaveBeenCalled();
    act(() =>
      rendered.props.onNodeDragStop(null, null, [rendered.props.nodes[0]]),
    );
    expect(positions()[0]).toEqual({ x: 160, y: 180 });
    expect(screen.getByTestId("history-count").textContent).toBe("2");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("retains multi-selection through keyboard movement and commits selection drags together", async () => {
    render(
      <ProjectProvider envelope={initial()}>
        <Harness />
      </ProjectProvider>,
    );
    changes([{ id: "second", type: "select", selected: true }]);
    act(() => rendered.props.onNodeClick(null, { id: "second" }));
    expect(
      rendered.props.nodes
        .filter((n: FlowNode) => n.selected)
        .map((n: FlowNode) => n.id),
    ).toEqual(["first", "second"]);
    changes([
      {
        id: "first",
        type: "position",
        position: { x: 110, y: 100 },
        dragging: false,
      },
      {
        id: "second",
        type: "position",
        position: { x: 410, y: 100 },
        dragging: false,
      },
    ]);
    expect(
      rendered.props.nodes.filter((n: FlowNode) => n.selected),
    ).toHaveLength(2);
    act(() => rendered.props.onSelectionDragStart());
    changes([
      {
        id: "first",
        type: "position",
        position: { x: 140, y: 120 },
        dragging: true,
      },
      {
        id: "second",
        type: "position",
        position: { x: 440, y: 120 },
        dragging: true,
      },
    ]);
    act(() => rendered.props.onSelectionDragStop(null, rendered.props.nodes));
    expect(positions()).toEqual([
      { x: 140, y: 120 },
      { x: 440, y: 120 },
    ]);
    expect(screen.getByTestId("history-count").textContent).toBe("3");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    const body = JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body));
    expect(body.append).toHaveLength(2);
  });

  it("does not save selection or measurement changes as movement", async () => {
    render(
      <ProjectProvider envelope={initial()}>
        <Harness />
      </ProjectProvider>,
    );
    changes([
      { id: "first", type: "select", selected: false },
      { id: "second", type: "select", selected: true },
      {
        id: "first",
        type: "dimensions",
        dimensions: { width: 220, height: 112 },
      },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(api).not.toHaveBeenCalled();
    expect(screen.getByTestId("history-count").textContent).toBe("1");
    expect(positions()).toEqual([
      { x: 100, y: 100 },
      { x: 400, y: 100 },
    ]);
  });
});
