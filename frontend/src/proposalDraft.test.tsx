import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { createBuildTask } from "./buildTasks";
import {
  ProposalDraftProvider,
  proposalDraftKey,
  useProposalDraft,
  type ProposalDraftContextValue,
} from "./proposalDraft";
import { useProject, type Store } from "./store";
import { copy, createNode, emptyBrief, type Content } from "./types";
import type { DraftDetail, DraftSummary, DraftSection } from "./durableDrafts";
vi.mock("./api", () => ({ api: vi.fn() }));
let store: Store;
let controls: ProposalDraftContextValue;
let original: Content;
let saved: DraftDetail | null;
let list: DraftSummary[];
const summary = (revision = 1, id = "draft"): DraftSummary => ({
  id,
  proposalId: "proposal",
  diagramId: "diagram",
  draftRevision: revision,
  state: "active",
  createdAt: "2026-09-21",
  updatedAt: `time-${revision}`,
  baseRevision: 1,
  baseHash: "base",
  proposalHash: "hash",
  conflictOf: null,
  stale: false,
  appliedCursor: null,
});
const key = proposalDraftKey("project", "proposal", "hash");
function Probe() {
  store = useProject();
  controls = useProposalDraft();
  return (
    <p data-testid="draft-state">
      {controls.status} {store.session.content.diagrams[0].nodes[0]?.title}
    </p>
  );
}
async function mount(readOnly = false, editableSections?: DraftSection[]) {
  const result = render(
    <ProposalDraftProvider
      projectId="project"
      proposalId="proposal"
      contentHash="hash"
      diagramId="diagram"
      content={original}
      storageKey={key}
      readOnly={readOnly}
      editableSections={editableSections}
    >
      <Probe />
    </ProposalDraftProvider>,
  );
  await screen.findByTestId("draft-state");
  return result;
}
const edits = () =>
  vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "PUT");
function edit(title: string) {
  act(() =>
    store.change(
      (content) => {
        content.diagrams[0].nodes[0].title = title;
      },
      "Edit title",
      "diagram",
      true,
    ),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  original = {
    schemaVersion: 1,
    name: "Project",
    notes: "",
    diagrams: [
      {
        id: "diagram",
        name: "Plan",
        nodes: [
          {
            ...createNode("process", { x: 0, y: 0 }),
            id: "node",
            title: "Original",
          },
        ],
        edges: [],
      },
    ],
    variables: [],
    nodeLinks: [],
    matches: [],
  };
  saved = null;
  list = [];
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === "PUT") {
      const body = JSON.parse(options.body as string);
      const candidate = copy(original);
      if (body.diagram) candidate.diagrams[0] = body.diagram;
      if (body.brief) {
        candidate.brief = body.brief;
        candidate.schemaVersion = 2;
      }
      if (body.buildTasks !== undefined) {
        candidate.buildTasks = body.buildTasks;
        candidate.schemaVersion = 3;
      }
      saved = {
        ...summary(body.baseDraftRevision + 1, path.split("/").at(-1)),
        candidate,
        applyRequest: null,
      };
      list = [saved];
      return { draft: copy(saved) };
    }
    if (path.endsWith("/drafts"))
      return { drafts: copy(list), defaultDraftId: saved?.id ?? null };
    return { draft: copy(saved) };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("durable proposal provider", () => {
  it("loads canonical content ahead of browser caches and keeps view changes outside draft saves", async () => {
    saved = { ...summary(), candidate: copy(original), applyRequest: null };
    saved.candidate.diagrams[0].nodes[0].title = "Saved manual edits";
    list = [saved];
    const legacy = copy(original.diagrams[0]);
    legacy.nodes[0].title = "Old browser edit";
    sessionStorage.setItem(key, JSON.stringify(legacy));
    await mount();
    expect(store.session.content.diagrams[0].nodes[0].title).toBe(
      "Saved manual edits",
    );
    const generation = store.session.generation;
    act(() => store.setView("diagram", { x: 20, y: 30, zoom: 0.8 }));
    expect(store.session.generation).toBe(generation);
    expect(controls.hasUnsaved()).toBe(false);
    await act(async () => {
      expect(await store.flush()).toBe(true);
    });
    expect(edits()).toHaveLength(0);
  });
  it("migrates a legacy edit only without server drafts and removes it after durable acknowledgement", async () => {
    const legacy = copy(original.diagrams[0]);
    legacy.nodes[0].title = "Recovered browser edit";
    sessionStorage.setItem(key, JSON.stringify(legacy));
    await mount();
    expect(store.session.content.diagrams[0].nodes[0].title).toBe(
      "Recovered browser edit",
    );
    expect(controls.hasUnsaved()).toBe(true);
    await act(async () => {
      expect(await controls.flush()).toBe(true);
    });
    expect(saved?.candidate.diagrams[0].nodes[0].title).toBe(
      "Recovered browser edit",
    );
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(controls.getReference()?.draftRevision).toBe(1);
  });
  it("does not implicitly resurrect a discarded candidate or legacy cache", async () => {
    list = [{ ...summary(), state: "discarded" }];
    const legacy = copy(original.diagrams[0]);
    legacy.nodes[0].title = "Discarded edit";
    sessionStorage.setItem(key, JSON.stringify(legacy));
    await mount();
    expect(store.session.content.diagrams[0].nodes[0].title).toBe("Original");
    expect(vi.mocked(api).mock.calls).toHaveLength(1);
    expect(edits()).toHaveLength(0);
  });
  it("flushes an untouched proposal for Apply but never creates historical read-only drafts", async () => {
    const view = await mount(true);
    await act(async () => {
      expect(await controls.flush()).toBe(true);
    });
    expect(edits()).toHaveLength(0);
    view.unmount();
    await mount();
    expect(edits()).toHaveLength(0);
    await act(async () => {
      expect(await controls.flush()).toBe(true);
    });
    expect(edits()).toHaveLength(1);
    expect(controls.getReference()).toEqual({
      draftId: saved!.id,
      draftRevision: 1,
    });
  });
  it("debounces content saves, commits grouped history, and retains local undo after acknowledgement", async () => {
    await mount();
    vi.useFakeTimers();
    edit("First character");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    edit("A complete title");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(599);
    });
    expect(edits()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(edits()).toHaveLength(1);
    expect(controls.status).toBe("saved");
    expect(store.session.history).toHaveLength(2);
    act(() => store.undo());
    expect(store.session.content.diagrams[0].nodes[0].title).toBe("Original");
  });
  it("preserves the active draft and warns on close when a save fails", async () => {
    await mount();
    vi.mocked(api).mockRejectedValueOnce(new Error("Disk unavailable"));
    edit("Keep this edit");
    await act(async () => {
      expect(await controls.flush()).toBe(false);
    });
    expect(controls.status).toBe("failed");
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(store.session.content.diagrams[0].nodes[0].title).toBe(
      "Keep this edit",
    );
    await act(async () => {
      expect(await controls.retry()).toBe(true);
    });
    expect(edits()).toHaveLength(2);
    expect(edits()[1][1]?.body).toBe(edits()[0][1]?.body);
  });
  it("does not advance its CAS base or replace local content when refresh sees another tab's edit", async () => {
    saved = { ...summary(), candidate: copy(original), applyRequest: null };
    list = [saved];
    await mount();
    edit("My local edit");
    saved = { ...saved, ...summary(2), candidate: copy(original) };
    saved.candidate.diagrams[0].nodes[0].title = "Other tab";
    list = [saved];
    await act(async () => {
      expect(await controls.refresh()).toBe(false);
    });
    expect(controls.getReference()?.draftRevision).toBe(1);
    expect(controls.conflict?.latestDraft?.draftRevision).toBe(2);
    expect(store.session.content.diagrams[0].nodes[0].title).toBe(
      "My local edit",
    );
    await act(async () => {
      expect(await controls.loadLatest()).toBe(true);
    });
    expect(store.session.content.diagrams[0].nodes[0].title).toBe("Other tab");
  });
});

it("exposes draft switching while loading a saved copy and blocks edits until it arrives", async () => {
  saved = { ...summary(), candidate: copy(original), applyRequest: null };
  list = [saved];
  const other = {
    ...summary(1, "other"),
    candidate: copy(original),
    applyRequest: null,
  };
  other.candidate.diagrams[0].nodes[0].title = "Other saved copy";
  let release!: (value: { draft: DraftDetail }) => void;
  const response = new Promise<{ draft: DraftDetail }>((resolve) => {
    release = resolve;
  });
  const normal = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) =>
    path.endsWith("/other") ? response : normal(path, options),
  );
  await mount();
  let switching!: Promise<boolean>;
  act(() => {
    switching = controls.selectDraft("other");
  });
  await waitFor(() => expect(controls.switching).toBe(true));
  edit("Must not replace the arriving draft");
  expect(store.session.content.diagrams[0].nodes[0].title).toBe("Original");
  await act(async () => {
    expect(await controls.flush()).toBe(false);
    release({ draft: other });
    expect(await switching).toBe(true);
  });
  expect(controls.switching).toBe(false);
  expect(store.session.content.diagrams[0].nodes[0].title).toBe(
    "Other saved copy",
  );
});

it("retries a lost cancel-apply acknowledgement with the same frozen mutation", async () => {
  saved = {
    ...summary(2),
    state: "applying",
    candidate: copy(original),
    applyRequest: {
      baseRevision: 4,
      mutationId: "apply-once",
      contentHash: "hash",
      draftId: "draft",
      draftRevision: 2,
    },
  };
  list = [saved];
  const normal = vi.mocked(api).getMockImplementation()!;
  const bodies: string[] = [];
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path.endsWith("/cancel-apply")) {
      bodies.push(options!.body as string);
      saved = { ...saved!, ...summary(3), applyRequest: null };
      list = [saved];
      if (bodies.length === 1)
        throw new Error("Cancellation acknowledgement lost");
      return { draft: copy(saved) };
    }
    return normal(path, options);
  });
  await mount();
  await act(async () => {
    expect(await controls.cancelApply()).toBe(false);
  });
  expect(controls.draft.state).toBe("applying");
  await act(async () => {
    expect(await controls.cancelApply()).toBe(true);
  });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
  expect(controls.draft.state).toBe("active");
  expect(controls.getReference()?.draftRevision).toBe(3);
  expect(
    vi.mocked(api).mock.calls.some(([path]) => path.endsWith("/accept")),
  ).toBe(false);
});

it("keeps a local copy explicitly after a refresh discovers a newer server draft", async () => {
  saved = { ...summary(), candidate: copy(original), applyRequest: null };
  list = [saved];
  await mount();
  edit("My retained work");
  saved = { ...saved, ...summary(2), candidate: copy(original) };
  saved.candidate.diagrams[0].nodes[0].title = "Other tab";
  list = [saved];
  await act(async () => {
    expect(await controls.refresh()).toBe(false);
  });
  let recovery: DraftDetail | null = null;
  const normal = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (options?.method === "PUT" && path.endsWith("/draft")) {
      const body = JSON.parse(options.body as string);
      expect(body.baseDraftRevision).toBe(1);
      const candidate = copy(original);
      candidate.diagrams[0] = body.diagram;
      recovery = {
        ...summary(1, "recovery"),
        conflictOf: "draft",
        candidate,
        applyRequest: null,
      };
      throw Object.assign(new Error("Draft conflict"), {
        status: 409,
        data: { latestDraft: saved, recoveryDraft: recovery },
      });
    }
    if (path.endsWith("/recovery")) return { draft: copy(recovery) };
    return normal(path, options);
  });
  await act(async () => {
    expect(await controls.useRecovery()).toBe(true);
  });
  expect(controls.getReference()).toEqual({
    draftId: "recovery",
    draftRevision: 1,
  });
  expect(controls.status).toBe("saved");
  expect(store.session.content.diagrams[0].nodes[0].title).toBe(
    "My retained work",
  );
  expect(saved.candidate.diagrams[0].nodes[0].title).toBe("Other tab");
});

it("retains structured API conflict metadata for draft recovery", async () => {
  const real = await vi.importActual<typeof import("./api")>("./api");
  const body = {
    error: "Draft changed",
    draftConflict: true,
    latestDraft: summary(2),
    recoveryDraft: summary(1, "recovery"),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  try {
    await expect(real.api("/draft")).rejects.toMatchObject({
      status: 409,
      data: body,
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("restricts brief-only manual edits and serializes only the authored brief", async () => {
  original.schemaVersion = 2;
  original.brief = { ...emptyBrief(), goal: "Original brief" };
  await mount(false, ["brief"]);
  act(() =>
    store.change(
      (content) => {
        content.name = "Wrong project";
        content.diagrams[0].nodes[0].title = "Wrong graph";
        content.brief = {
          ...emptyBrief(),
          goal: "My brief",
          extra: "Not an authored field",
        } as typeof content.brief;
      },
      "Edit brief",
      undefined,
      true,
    ),
  );
  expect(store.session.content.name).toBe("Project");
  expect(store.session.content.diagrams[0].nodes[0].title).toBe("Original");
  expect(store.session.content.brief).toEqual({
    ...emptyBrief(),
    goal: "My brief",
  });
  await act(async () => {
    expect(await controls.flush()).toBe(true);
  });
  const body = JSON.parse(edits()[0][1]!.body as string);
  expect(body).not.toHaveProperty("diagram");
  expect(body).toMatchObject({
    contentHash: "hash",
    brief: { ...emptyBrief(), goal: "My brief" },
  });
  act(() => store.undo());
  expect(store.session.content.brief?.goal).toBe("Original brief");
});

it("retains both authored sections after saving and a fresh provider load", async () => {
  original.schemaVersion = 2;
  original.brief = { ...emptyBrief(), goal: "Agent brief" };
  const view = await mount(false, ["diagram", "brief"]);
  act(() =>
    store.change((content) => {
      content.diagrams[0].nodes[0].title = "Manual graph";
      content.brief!.goal = "Manual goal";
    }, "Edit candidate"),
  );
  await act(async () => {
    expect(await controls.flush()).toBe(true);
  });
  expect(saved?.candidate.brief?.goal).toBe("Manual goal");
  expect(saved?.candidate.diagrams[0].nodes[0].title).toBe("Manual graph");
  view.unmount();
  await mount(false, ["diagram", "brief"]);
  expect(store.session.content.brief?.goal).toBe("Manual goal");
  expect(store.session.content.diagrams[0].nodes[0].title).toBe("Manual graph");
  expect(edits()).toHaveLength(1);
});

it("keeps legacy diagram-only drafts from changing or resending project briefs", async () => {
  original.schemaVersion = 2;
  original.brief = { ...emptyBrief(), goal: "Human intent" };
  await mount();
  act(() =>
    store.change((content) => {
      content.brief!.goal = "Not part of this proposal";
      content.diagrams[0].nodes[0].title = "Authored diagram";
    }, "Edit"),
  );
  expect(store.session.content.brief?.goal).toBe("Human intent");
  await act(async () => {
    expect(await controls.flush()).toBe(true);
  });
  expect(JSON.parse(edits()[0][1]!.body as string)).not.toHaveProperty("brief");
});

it("restricts task-only edits and recovers the durable task list including order and stable check IDs", async () => {
  original.schemaVersion = 3;
  original.buildTasks = [
    {
      ...createBuildTask(),
      id: "build",
      title: "Agent task",
      acceptanceChecks: [{ id: "criterion", text: "Initial check" }],
    },
  ];
  const view = await mount(false, ["buildTasks"]);
  act(() =>
    store.change((content) => {
      content.name = "Wrong name";
      content.diagrams[0].nodes[0].title = "Wrong graph";
      content.buildTasks![0].title = "Manual build task";
      content.buildTasks![0].acceptanceChecks[0].text = "Revised check";
      content.buildTasks!.push({
        ...createBuildTask(),
        id: "second",
        title: "Next task",
        prerequisiteIds: ["build"],
      });
      content.buildTasks!.reverse();
    }, "Edit tasks"),
  );
  await act(async () => {
    expect(await controls.flush()).toBe(true);
  });
  const body = JSON.parse(edits()[0][1]!.body as string);
  expect(body).not.toHaveProperty("diagram");
  expect(body).not.toHaveProperty("brief");
  expect(body.buildTasks.map((item: { id: string }) => item.id)).toEqual([
    "second",
    "build",
  ]);
  expect(store.session.content.name).toBe("Project");
  expect(store.session.content.diagrams[0].nodes[0].title).toBe("Original");
  view.unmount();
  await mount(false, ["buildTasks"]);
  expect(store.session.content.buildTasks?.[1].acceptanceChecks).toEqual([
    { id: "criterion", text: "Revised check" },
  ]);
  act(() =>
    store.change((content) => {
      content.buildTasks = [];
    }, "Remove all tasks"),
  );
  await act(async () => {
    expect(await controls.flush()).toBe(true);
  });
  expect(JSON.parse(edits().at(-1)![1]!.body as string).buildTasks).toEqual([]);
});

it("derives missing task links after scoped diagram edits without authoring task details", async () => {
  original.schemaVersion = 3;
  original.buildTasks = [
    {
      ...createBuildTask(),
      id: "build",
      title: "Independent task",
      status: "done",
      nodeLinks: [
        {
          nodeId: "node",
          diagramId: "diagram",
          title: "Original",
          missing: false,
        },
      ],
    },
  ];
  await mount(false, ["diagram"]);
  act(() =>
    store.change((content) => {
      content.diagrams[0].nodes = [];
      content.buildTasks![0].title = "Unpermitted edit";
    }, "Delete linked node"),
  );
  expect(store.session.content.buildTasks?.[0]).toMatchObject({
    title: "Independent task",
    status: "done",
    nodeLinks: [{ nodeId: "node", title: "Original", missing: true }],
  });
  await act(async () => {
    expect(await controls.flush()).toBe(true);
  });
  expect(JSON.parse(edits()[0][1]!.body as string)).not.toHaveProperty(
    "buildTasks",
  );
  act(() => store.undo());
  expect(store.session.content.buildTasks?.[0].nodeLinks[0].missing).toBe(
    false,
  );
});

it("does not downgrade schema 3 or change tasks while editing only a brief", async () => {
  original.schemaVersion = 3;
  original.brief = emptyBrief();
  original.buildTasks = [createBuildTask()];
  await mount(false, ["brief"]);
  act(() =>
    store.change((content) => {
      content.brief!.goal = "Clarified intent";
      content.buildTasks = [];
    }, "Edit brief"),
  );
  expect(store.session.content.schemaVersion).toBe(3);
  expect(store.session.content.buildTasks).toEqual(original.buildTasks);
  await act(async () => {
    expect(await controls.flush()).toBe(true);
  });
  expect(controls.draft.candidate.schemaVersion).toBe(3);
});
