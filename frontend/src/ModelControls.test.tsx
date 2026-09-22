import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import ModelControls, {
  MODEL_PREFERENCE_KEY,
  PLANNING_SERVER_RESTART,
  readModelPreference,
  selectModel,
  selectionProblem,
  useModelSelection,
} from "./ModelControls";
import { api } from "./api";
import { type ModelCapabilities, type ModelSelection } from "./planning";
vi.mock("./api", () => ({ api: vi.fn() }));
const capabilities: ModelCapabilities = {
  status: "ready",
  source: "cli_catalogue",
  cliVersion: "test",
  fetchedAt: null,
  models: [
    {
      id: "a",
      label: "First",
      description: "",
      defaultReasoningEffort: "low",
      reasoningEfforts: [
        { id: "low", description: "Brief" },
        { id: "medium", description: "Balanced" },
      ],
      isDefault: true,
    },
    {
      id: "b",
      label: "Second",
      description: "",
      defaultReasoningEffort: "high",
      reasoningEfforts: [
        { id: "medium", description: "Balanced" },
        { id: "high", description: "Thorough" },
      ],
      isDefault: false,
    },
    {
      id: "c",
      label: "Third",
      description: "",
      defaultReasoningEffort: null,
      reasoningEfforts: [],
      isDefault: false,
    },
  ],
};
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("offers only advertised efforts and visibly chooses a compatible default", () => {
  function Harness() {
    const [selection, setSelection] = useState<ModelSelection>({
      mode: "default",
    });
    return (
      <ModelControls
        selection={selection}
        capabilities={capabilities}
        onChange={setSelection}
      />
    );
  }
  render(<Harness />);
  const models = screen.getByLabelText("Model"),
    effort = screen.getByLabelText("Reasoning effort") as HTMLSelectElement;
  expect(effort.disabled).toBe(true);
  fireEvent.change(models, { target: { value: "a" } });
  expect(effort.value).toBe("low");
  expect([...effort.options].map((item) => item.value)).toEqual([
    "low",
    "medium",
  ]);
  fireEvent.change(models, { target: { value: "b" } });
  expect(effort.value).toBe("high");
  fireEvent.change(effort, { target: { value: "medium" } });
  fireEvent.change(models, { target: { value: "a" } });
  expect(effort.value).toBe("medium");
  fireEvent.change(models, { target: { value: "c" } });
  expect(effort.disabled).toBe(true);
  expect(effort.value).toBe("");
});
it("does not silently replace missing selections or infer unsupported efforts", () => {
  const unknown: ModelSelection = {
    mode: "explicit",
    model: "missing",
    reasoningEffort: "ultra",
  };
  expect(selectionProblem(unknown, capabilities)).toMatch(/no longer listed/);
  expect(
    selectionProblem(
      { mode: "explicit", model: "a", reasoningEffort: "ultra" },
      capabilities,
    ),
  ).toMatch(/supported/);
  expect(selectionProblem(unknown, null)).toMatch(/cannot be verified/);
  expect(selectionProblem({ mode: "default" }, null)).toBe("");
  expect(selectModel("not-listed", unknown, capabilities)).toEqual(unknown);
});
it("reads preferences defensively and works when browser storage is unavailable", () => {
  for (const value of [
    "{",
    "null",
    '{"mode":"explicit","model":42}',
    '{"mode":"other"}',
  ]) {
    localStorage.setItem(MODEL_PREFERENCE_KEY, value);
    expect(readModelPreference()).toEqual({ mode: "default" });
  }
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  expect(readModelPreference()).toEqual({ mode: "default" });
});
it("keeps default usable when discovery fails and refreshes only on explicit request", async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error("Update Codex CLI"));
  const { result } = renderHook(() => useModelSelection());
  await waitFor(() =>
    expect(result.current.capabilities?.status).toBe("unavailable"),
  );
  expect(result.current.problem).toBe("");
  expect(result.current.capabilities?.reason).toBe("Update Codex CLI");
  vi.mocked(api).mockResolvedValueOnce(capabilities);
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.capabilities?.status).toBe("ready");
  expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual([
    "/planning/capabilities",
    "/planning/capabilities/refresh",
  ]);
  act(() =>
    result.current.setSelection({
      mode: "explicit",
      model: "b",
      reasoningEffort: "high",
    }),
  );
  expect(JSON.parse(localStorage.getItem(MODEL_PREFERENCE_KEY)!)).toEqual({
    mode: "explicit",
    model: "b",
    reasoningEffort: "high",
  });
});

it("does not present cached efforts as verified when catalogue discovery is unavailable", () => {
  render(
    <ModelControls
      selection={{ mode: "explicit", model: "a", reasoningEffort: "low" }}
      capabilities={{
        ...capabilities,
        status: "unavailable",
        reason: "Refresh failed",
      }}
      onChange={vi.fn()}
    />,
  );
  expect(
    (screen.getByLabelText("Reasoning effort") as HTMLSelectElement).disabled,
  ).toBe(true);
  expect(screen.queryByRole("option", { name: "medium" })).toBeNull();
  expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("a");
});

it("blocks a missing server endpoint and preserves the selection while reconnecting", async () => {
  const selected: ModelSelection = {
    mode: "explicit",
    model: "b",
    reasoningEffort: "high",
  };
  localStorage.setItem(MODEL_PREFERENCE_KEY, JSON.stringify(selected));
  vi.mocked(api).mockRejectedValueOnce(
    Object.assign(new Error("Unknown API route."), { status: 404 }),
  );
  const { result } = renderHook(() => useModelSelection());
  await waitFor(() => expect(result.current.serverIncompatible).toBe(true));
  expect(result.current.problem).toBe(PLANNING_SERVER_RESTART);
  expect(result.current.selection).toEqual(selected);
  act(() => result.current.setSelection({ mode: "default" }));
  expect(result.current.problem).toBe(PLANNING_SERVER_RESTART);
  act(() => result.current.setSelection(selected));
  vi.mocked(api).mockResolvedValueOnce(capabilities);
  await act(async () => result.current.refresh(false));
  expect(result.current.serverIncompatible).toBe(false);
  expect(result.current.problem).toBe("");
  expect(result.current.selection).toEqual(selected);
});

it("does not erase a confirmed server mismatch when a later check cannot connect", async () => {
  vi.mocked(api).mockResolvedValueOnce(capabilities);
  const { result } = renderHook(() => useModelSelection());
  await waitFor(() =>
    expect(result.current.capabilities?.status).toBe("ready"),
  );
  act(() => result.current.markServerIncompatible());
  vi.mocked(api).mockRejectedValueOnce(new Error("Connection refused"));
  await act(async () => result.current.refresh(false));
  expect(result.current.serverIncompatible).toBe(true);
  expect(result.current.problem).toBe(PLANNING_SERVER_RESTART);
});

it("keeps planning and coding defaults independent and restores each provider choice", async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path.startsWith("/agent/status")
      ? { agent: { available: true, label: "Ollama" } }
      : ({
          ...capabilities,
          provider: path.includes("ollama") ? "ollama" : undefined,
        } as any),
  );
  const planning = renderHook(() => useModelSelection());
  const coding = renderHook(() => useModelSelection(true, "coding"));
  await waitFor(() =>
    expect(planning.result.current.capabilities).not.toBeNull(),
  );
  act(() =>
    planning.result.current.setSelection({
      mode: "explicit",
      model: "a",
      reasoningEffort: "low",
    }),
  );
  act(() => coding.result.current.setProvider("ollama"));
  await waitFor(() =>
    expect(coding.result.current.capabilities?.provider).toBe("ollama"),
  );
  act(() =>
    coding.result.current.setSelection({
      provider: "ollama",
      mode: "explicit",
      model: "b",
      reasoningEffort: "high",
    }),
  );
  expect(planning.result.current.selection).toEqual({
    mode: "explicit",
    model: "a",
    reasoningEffort: "low",
  });
  act(() => coding.result.current.setProvider("codex"));
  expect(coding.result.current.selection).toEqual({ mode: "default" });
  act(() => coding.result.current.setProvider("ollama"));
  expect(coding.result.current.selection).toEqual({
    provider: "ollama",
    mode: "explicit",
    model: "b",
    reasoningEffort: "high",
  });
  coding.unmount();
  const reopened = renderHook(() => useModelSelection(true, "coding"));
  expect(reopened.result.current.selection).toEqual({
    provider: "ollama",
    mode: "explicit",
    model: "b",
    reasoningEffort: "high",
  });
});

it("ignores a delayed old provider catalogue and refreshes the selected provider explicitly", async () => {
  let release!: (value: ModelCapabilities) => void;
  vi.mocked(api).mockImplementation((path, options) => {
    if (path === "/planning/capabilities")
      return new Promise((resolve) => {
        release = resolve as typeof release;
      });
    if (path.startsWith("/agent/status"))
      return Promise.resolve({
        agent: { available: true, label: "Ollama" },
      }) as any;
    return Promise.resolve({ ...capabilities, provider: "ollama" }) as any;
  });
  const { result } = renderHook(() => useModelSelection());
  act(() => result.current.setProvider("ollama"));
  await waitFor(() =>
    expect(result.current.capabilities?.provider).toBe("ollama"),
  );
  await act(async () => release(capabilities));
  expect(result.current.capabilities?.provider).toBe("ollama");
  await act(async () => result.current.refresh());
  expect(api).toHaveBeenCalledWith("/planning/capabilities/refresh", {
    method: "POST",
    body: '{"provider":"ollama"}',
  });
});

it("allows explicit cloud model IDs without inventing reasoning or tool support", () => {
  const selection: ModelSelection = {
    provider: "anthropic",
    mode: "explicit",
    model: "a-new-model",
    reasoningEffort: null,
  };
  expect(selectionProblem(selection, null, "coding")).toBe("");
  expect(
    selectionProblem({ ...selection, reasoningEffort: "high" }, null),
  ).toMatch(/supported reasoning/);
  expect(
    selectionProblem(
      {
        provider: "ollama",
        mode: "explicit",
        model: "missing",
        reasoningEffort: null,
      },
      { ...capabilities, provider: "ollama" },
    ),
  ).toMatch(/not installed/);
  const caps: ModelCapabilities = {
    ...capabilities,
    provider: "anthropic",
    models: [{ ...capabilities.models[2], capabilities: { tools: false } }],
  };
  expect(
    selectionProblem({ ...selection, model: "c" }, caps, "coding"),
  ).toMatch(/coding tools/);
  render(
    <ModelControls
      selection={selection}
      capabilities={null}
      onChange={vi.fn()}
      onProviderChange={vi.fn()}
    />,
  );
  expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(
    "a-new-model",
  );
  expect(screen.queryByLabelText("Reasoning effort")).toBeNull();
});

it("offers model default as null for provider reasoning, without inventing an effort", () => {
  const caps: ModelCapabilities = { ...capabilities, provider: "ollama" };
  const onChange = vi.fn();
  const choice: ModelSelection = {
    provider: "ollama",
    mode: "explicit",
    model: "a",
    reasoningEffort: null,
  };
  expect(selectionProblem(choice, caps)).toBe("");
  render(
    <ModelControls
      selection={{ ...choice, reasoningEffort: "low" }}
      capabilities={caps}
      onChange={onChange}
    />,
  );
  fireEvent.change(screen.getByLabelText("Reasoning effort"), {
    target: { value: "" },
  });
  expect(onChange).toHaveBeenCalledWith(choice);
});
