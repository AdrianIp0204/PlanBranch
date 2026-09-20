import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  validModelSelection,
  type ModelCapabilities,
  type ModelSelection,
} from "./planning";

export const MODEL_PREFERENCE_KEY = "flowdesk.planning-model.v1";
export const PLANNING_SERVER_RESTART =
  "Restart FlowDesk, then reload this window to use chat and model settings. Your draft remains here.";
export function isLegacyPlanningServerError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "status" in error &&
    error.status === 400 &&
    error.message === "Unexpected fields in planning message: selection."
  );
}
export function readModelPreference(): ModelSelection {
  try {
    const value = JSON.parse(
      localStorage.getItem(MODEL_PREFERENCE_KEY) ?? "null",
    );
    if (validModelSelection(value))
      return value.mode === "default"
        ? { mode: "default" }
        : {
            mode: "explicit",
            model: value.model,
            reasoningEffort: value.reasoningEffort,
          };
  } catch {
    /* Optional browser preference. */
  }
  return { mode: "default" };
}
export function selectionProblem(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): string {
  if (selection.mode === "default") return "";
  if (capabilities?.status !== "ready")
    return "This model cannot be verified. Refresh models or choose CLI default.";
  const model = capabilities.models.find((item) => item.id === selection.model);
  if (!model)
    return "Your saved model is no longer listed. Choose another model or CLI default.";
  if (
    model.reasoningEfforts.length
      ? !model.reasoningEfforts.some(
          (item) => item.id === selection.reasoningEffort,
        )
      : selection.reasoningEffort !== null
  )
    return "Choose a supported reasoning level for this model.";
  return "";
}
export function selectModel(
  modelId: string,
  previous: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!modelId) return { mode: "default" };
  const model = capabilities?.models.find((item) => item.id === modelId);
  if (!model) return previous;
  const oldEffort =
    previous.mode === "explicit" ? previous.reasoningEffort : null;
  return {
    mode: "explicit",
    model: modelId,
    reasoningEffort: model.reasoningEfforts.some(
      (item) => item.id === oldEffort,
    )
      ? oldEffort
      : model.defaultReasoningEffort,
  };
}
export function useModelSelection(active = true) {
  const [selection, setSelection] = useState(readModelPreference);
  const [capabilities, setCapabilities] = useState<ModelCapabilities | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [serverIncompatible, setServerIncompatible] = useState(false);
  const sequence = useRef(0);
  const alive = useRef(true);
  function markServerIncompatible() {
    ++sequence.current;
    setRefreshing(false);
    setServerIncompatible(true);
    setCapabilities({
      status: "unavailable",
      source: "cli_catalogue",
      models: [],
      cliVersion: null,
      fetchedAt: null,
      reason: PLANNING_SERVER_RESTART,
    });
  }
  async function refresh(explicit = true) {
    const ticket = ++sequence.current;
    setRefreshing(true);
    try {
      const result = await api<ModelCapabilities>(
        explicit ? "/planning/capabilities/refresh" : "/planning/capabilities",
        explicit ? { method: "POST", body: "{}" } : {},
      );
      if (alive.current && ticket === sequence.current) {
        setServerIncompatible(false);
        setCapabilities(
          result.status && Array.isArray(result.models)
            ? result
            : {
                status: "unavailable",
                source: "cli_catalogue",
                models: [],
                cliVersion: null,
                fetchedAt: null,
                reason:
                  "The model list is unavailable. CLI default is still available.",
              },
        );
      }
    } catch (error) {
      if (alive.current && ticket === sequence.current) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 404
        ) {
          markServerIncompatible();
          return;
        }
        setCapabilities({
          status: "unavailable",
          source: "cli_catalogue",
          models: [],
          cliVersion: null,
          fetchedAt: null,
          reason:
            error instanceof Error
              ? error.message
              : "The model list is unavailable.",
        });
      }
    } finally {
      if (alive.current && ticket === sequence.current) setRefreshing(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++sequence.current;
    };
  }, []);
  useEffect(() => {
    if (active && !capabilities) void refresh(false);
  }, [active]);
  useEffect(() => {
    try {
      localStorage.setItem(MODEL_PREFERENCE_KEY, JSON.stringify(selection));
    } catch {
      /* Selecting still works when storage is unavailable. */
    }
  }, [selection]);
  return {
    selection,
    setSelection,
    capabilities,
    refreshing,
    refresh,
    serverIncompatible,
    markServerIncompatible,
    problem: serverIncompatible
      ? PLANNING_SERVER_RESTART
      : selectionProblem(selection, capabilities),
  };
}
export default function ModelControls({
  selection,
  capabilities,
  onChange,
}: {
  selection: ModelSelection;
  capabilities: ModelCapabilities | null;
  onChange: (value: ModelSelection) => void;
}) {
  const models = capabilities?.status === "ready" ? capabilities.models : [];
  const model =
    selection.mode === "explicit"
      ? models.find((item) => item.id === selection.model)
      : undefined;
  const problem = selectionProblem(selection, capabilities);
  const selectedId = selection.mode === "explicit" ? selection.model : "";
  return (
    <div className="planning-model-controls">
      <select
        aria-label="Model"
        aria-invalid={Boolean(problem)}
        aria-describedby={problem ? "planning-model-problem" : undefined}
        value={selectedId}
        onChange={(event) =>
          onChange(selectModel(event.target.value, selection, capabilities))
        }
      >
        <option value="">CLI default</option>
        {selectedId && !models.some((item) => item.id === selectedId) && (
          <option value={selectedId}>Unavailable: {selectedId}</option>
        )}
        {models.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Reasoning effort"
        disabled={!model?.reasoningEfforts.length}
        value={
          selection.mode === "explicit" ? (selection.reasoningEffort ?? "") : ""
        }
        onChange={(event) => {
          if (selection.mode === "explicit")
            onChange({ ...selection, reasoningEffort: event.target.value });
        }}
      >
        {(!model?.reasoningEfforts.length ||
          (selection.mode === "explicit" &&
            !model.reasoningEfforts.some(
              (item) => item.id === selection.reasoningEffort,
            ))) && (
          <option value="">
            {selection.mode === "default"
              ? "Default effort"
              : model?.reasoningEfforts.length
                ? "Choose effort"
                : "No effort setting"}
          </option>
        )}
        {model?.reasoningEfforts.map((item) => (
          <option key={item.id} value={item.id}>
            {item.id}
          </option>
        ))}
      </select>
    </div>
  );
}
