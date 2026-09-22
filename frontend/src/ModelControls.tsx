import "./provider-controls.css";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api";
import { updateAgentPreference, usePreferences } from "./preferences";
import {
  validModelSelection,
  providerIds,
  providerLabel,
  selectionProvider,
  type ProviderId,
  type ModelPurpose,
  type AgentStatus,
  type ModelCapabilities,
  type ModelSelection,
} from "./planning";
export const MODEL_PREFERENCE_KEY = "flowdesk.planning-model.v1";
export const PLANNING_SERVER_RESTART =
  "Restart PlanBranch, then reload this window to use chat and model settings. Your draft remains here.";
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
    if (validModelSelection(value) && selectionProvider(value) === "codex")
      return value;
  } catch {
    /* Optional browser preference. */
  }
  return { mode: "default" };
}
export function selectionProblem(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
  purpose: ModelPurpose = "planning",
): string {
  const provider = selectionProvider(selection);
  if (selection.mode === "default") return "";
  if (!selection.model.trim()) return "Choose a model.";
  const cloud = ["openai", "anthropic", "gemini"].includes(provider);
  if (capabilities?.provider && capabilities.provider !== provider)
    return "Loading models…";
  if (capabilities?.status !== "ready" && !cloud)
    return provider === "codex"
      ? "This model cannot be verified. Refresh models or choose CLI default."
      : "The local model list is unavailable. Check the connection and refresh models.";
  const model =
    capabilities?.status === "ready"
      ? capabilities.models.find((item) => item.id === selection.model)
      : undefined;
  if (!model && !cloud)
    return provider === "codex"
      ? "Your saved model is no longer listed. Choose another model or CLI default."
      : "This model is not installed. Choose an installed model or install it in Ollama, then refresh.";
  if (model?.capabilities?.generation === false)
    return "This model does not support text generation.";
  if (
    purpose === "coding" &&
    (model?.capabilities?.tools === false || model?.tools === false)
  )
    return "This model does not support coding tools. Choose another model.";
  const efforts = model?.reasoningEfforts ?? [];
  if (selection.reasoningEffort === null && provider !== "codex") return "";
  if (
    efforts.length
      ? !efforts.some((item) => item.id === selection.reasoningEffort)
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
  const provider = selectionProvider(previous);
  if (!modelId && provider === "codex") return { mode: "default" };
  const model = capabilities?.models.find((item) => item.id === modelId);
  if (!model && provider === "codex") return previous;
  const oldEffort =
    previous.mode === "explicit" ? previous.reasoningEffort : null;
  return {
    ...(provider === "codex" ? {} : { provider }),
    mode: "explicit",
    model: modelId,
    reasoningEffort: model?.reasoningEfforts.some(
      (item) => item.id === oldEffort,
    )
      ? oldEffort
      : (model?.defaultReasoningEffort ?? null),
  } as ModelSelection;
}
export function useModelSelection(
  active = true,
  purpose: ModelPurpose = "planning",
) {
  const { preferences } = usePreferences();
  const preference =
    purpose === "coding" ? preferences.codingAgent : preferences.planningAgent;
  const provider = preference.provider;
  const selection: ModelSelection =
    preference.selections[provider] ??
    (provider === "codex"
      ? { mode: "default" }
      : { provider, mode: "explicit", model: "", reasoningEffort: null });
  const setSelection = (value: ModelSelection) =>
    updateAgentPreference(purpose, selectionProvider(value), value);
  const setProvider = (value: ProviderId) =>
    updateAgentPreference(purpose, value);
  const [loaded, setLoaded] = useState<{
    provider: ProviderId;
    capabilities: ModelCapabilities;
  } | null>(null);
  const [status, setStatus] = useState<{
    provider: ProviderId;
    agent: AgentStatus;
  } | null>(null);
  const capabilities =
    loaded?.provider === provider ? loaded.capabilities : null;
  const agent = status?.provider === provider ? status.agent : null;
  const [refreshing, setRefreshing] = useState(false);
  const [serverIncompatible, setServerIncompatible] = useState(false);
  const sequence = useRef(0);
  const alive = useRef(true);
  const unavailable = (reason: string): ModelCapabilities => ({
    status: "unavailable",
    source: provider === "codex" ? "cli_catalogue" : "provider_catalogue",
    provider,
    models: [],
    cliVersion: null,
    fetchedAt: null,
    reason,
  });
  function markServerIncompatible() {
    ++sequence.current;
    setRefreshing(false);
    setServerIncompatible(true);
    setLoaded({ provider, capabilities: unavailable(PLANNING_SERVER_RESTART) });
  }
  async function refresh(explicit = true) {
    const ticket = ++sequence.current;
    setRefreshing(true);
    const statusRequest =
      provider === "codex"
        ? Promise.resolve(null)
        : api<{ agent: AgentStatus }>(
            `/agent/status?provider=${provider}`,
          ).catch((error) => ({
            agent: {
              available: false,
              label: providerLabel(provider),
              reason:
                error instanceof Error
                  ? error.message
                  : "Connection unavailable.",
            },
          }));
    try {
      const [result, connection] = await Promise.all([
        api<ModelCapabilities>(
          explicit
            ? "/planning/capabilities/refresh"
            : `/planning/capabilities${provider === "codex" ? "" : `?provider=${provider}`}`,
          explicit
            ? {
                method: "POST",
                body: JSON.stringify(provider === "codex" ? {} : { provider }),
              }
            : {},
        ),
        statusRequest,
      ]);
      if (alive.current && ticket === sequence.current) {
        setServerIncompatible(false);
        setLoaded({
          provider,
          capabilities:
            result.status && Array.isArray(result.models)
              ? result
              : unavailable("The model list is unavailable."),
        });
        if (connection) setStatus({ provider, agent: connection.agent });
      }
    } catch (error) {
      const connection = await statusRequest;
      if (alive.current && ticket === sequence.current) {
        if (connection) setStatus({ provider, agent: connection.agent });
        if (
          provider === "codex" &&
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          error.status === 404
        ) {
          markServerIncompatible();
          return;
        }
        setLoaded({
          provider,
          capabilities: unavailable(
            error instanceof Error
              ? error.message
              : "The model list is unavailable.",
          ),
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
    ++sequence.current;
    setRefreshing(false);
    if (active) void refresh(false);
  }, [active, provider]);
  return {
    provider,
    setProvider,
    selection,
    setSelection,
    capabilities,
    agent,
    refreshing,
    refresh,
    serverIncompatible: provider === "codex" && serverIncompatible,
    markServerIncompatible,
    problem:
      provider === "codex" && serverIncompatible
        ? PLANNING_SERVER_RESTART
        : selectionProblem(selection, capabilities, purpose),
  };
}
export default function ModelControls({
  selection,
  capabilities,
  onChange,
  onProviderChange,
  problemId = "planning-model-problem",
}: {
  selection: ModelSelection;
  capabilities: ModelCapabilities | null;
  onChange: (value: ModelSelection) => void;
  onProviderChange?: (value: ProviderId) => void;
  problemId?: string;
}) {
  const provider = selectionProvider(selection);
  const models =
    capabilities?.status === "ready" &&
    (!capabilities.provider || capabilities.provider === provider)
      ? capabilities.models
      : [];
  const model =
    selection.mode === "explicit"
      ? models.find((item) => item.id === selection.model)
      : undefined;
  const problem = selectionProblem(selection, capabilities);
  const selectedId = selection.mode === "explicit" ? selection.model : "";
  const manualModel = ["openai", "anthropic", "gemini"].includes(provider);
  const listId = useId();
  return (
    <div className="planning-model-controls">
      {onProviderChange && (
        <select
          aria-label="Provider"
          value={provider}
          onChange={(event) =>
            onProviderChange(event.target.value as ProviderId)
          }
        >
          {providerIds.map((id) => (
            <option key={id} value={id}>
              {providerLabel(id)}
            </option>
          ))}
        </select>
      )}
      {manualModel ? (
        <>
          <input
            aria-label="Model"
            placeholder="Model ID"
            list={listId}
            value={selectedId}
            maxLength={200}
            aria-invalid={Boolean(problem)}
            aria-describedby={problem ? problemId : undefined}
            onChange={(event) =>
              onChange(selectModel(event.target.value, selection, capabilities))
            }
          />
          <datalist id={listId}>
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </datalist>
        </>
      ) : (
        <select
          aria-label="Model"
          aria-invalid={Boolean(problem)}
          aria-describedby={problem ? problemId : undefined}
          value={selectedId}
          onChange={(event) =>
            onChange(selectModel(event.target.value, selection, capabilities))
          }
        >
          <option value="">
            {provider === "codex" ? "CLI default" : "Choose model"}
          </option>
          {selectedId && !models.some((item) => item.id === selectedId) && (
            <option value={selectedId}>Unavailable: {selectedId}</option>
          )}
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      )}
      {(provider === "codex" || !!model?.reasoningEfforts.length) && (
        <select
          aria-label="Reasoning effort"
          disabled={!model?.reasoningEfforts.length}
          value={
            selection.mode === "explicit"
              ? (selection.reasoningEffort ?? "")
              : ""
          }
          onChange={(event) => {
            if (selection.mode === "explicit")
              onChange({
                ...selection,
                reasoningEffort: event.target.value || null,
              });
          }}
        >
          {provider !== "codex" && <option value="">Model default</option>}
          {provider === "codex" &&
            (!model?.reasoningEfforts.length ||
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
      )}
    </div>
  );
}
