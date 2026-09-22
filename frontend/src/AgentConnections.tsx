import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { providerLabel, type ProviderId } from "./planning";
import { ErrorMessage } from "./ui";
import "./provider-controls.css";
type Connection = {
  id: ProviderId;
  label: string;
  endpoint: string | null;
  configured: boolean;
  credentialSource: string | null;
  reason?: string;
};
export default function AgentConnections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [checking, setChecking] = useState<ProviderId | null>(null);
  const [checks, setChecks] = useState<
    Partial<Record<ProviderId, { available: boolean; reason?: string }>>
  >({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function checkApi(connection: Connection) {
    if (
      checking ||
      !connection.configured ||
      !["openai", "anthropic", "gemini"].includes(connection.id)
    )
      return;
    setChecking(connection.id);
    setChecks((current) => ({ ...current, [connection.id]: undefined }));
    try {
      const result = await api<{
        agent: { available: boolean; reason?: string };
      }>("/agent/check", {
        method: "POST",
        body: JSON.stringify({ provider: connection.id }),
      });
      if (mounted.current)
        setChecks((current) => ({ ...current, [connection.id]: result.agent }));
    } catch (error) {
      if (mounted.current)
        setChecks((current) => ({
          ...current,
          [connection.id]: {
            available: false,
            reason:
              error instanceof Error ? error.message : "The API check failed.",
          },
        }));
    } finally {
      if (mounted.current) setChecking(null);
    }
  }
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    api<{ connections: Connection[] }>("/agent/connections")
      .then((result) => {
        if (alive)
          setConnections(
            Array.isArray(result.connections) ? result.connections : [],
          );
      })
      .catch((error) => {
        if (alive)
          setError(
            error instanceof Error
              ? error.message
              : "Connections are unavailable.",
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  return (
    <section className="agent-connections" aria-label="Provider connections">
      <h3>Connections</h3>
      {loading && <p role="status">Loading connection configuration…</p>}
      <ErrorMessage message={error} />
      <ul>
        {connections.map((connection) => (
          <li key={connection.id}>
            <strong>{connection.label || providerLabel(connection.id)}</strong>{" "}
            —{" "}
            {connection.id === "codex"
              ? "Optional · existing CLI sign-in"
              : connection.id === "ollama"
                ? connection.configured
                  ? "Local endpoint"
                  : "Invalid endpoint"
                : connection.configured
                  ? "Configured"
                  : "Not configured"}
            {connection.endpoint && (
              <div className="muted">{connection.endpoint}</div>
            )}
            {connection.reason && <div>{connection.reason}</div>}
            {["openai", "anthropic", "gemini"].includes(connection.id) && (
              <div className="connection-check">
                <button
                  aria-label={`Check ${providerLabel(connection.id)} API connection`}
                  disabled={loading || !!checking || !connection.configured}
                  onClick={() => void checkApi(connection)}
                >
                  {checking === connection.id
                    ? "Checking API…"
                    : "Check API connection"}
                </button>
                {checks[connection.id] && (
                  <p role="status">
                    {checks[connection.id]!.available
                      ? "API reachable. Access to individual models is checked when requested."
                      : checks[connection.id]!.reason ||
                        "The API could not be reached."}
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      <button
        disabled={loading || !!checking}
        onClick={() => {
          setChecks({});
          setRevision((value) => value + 1);
        }}
      >
        Reload configuration
      </button>
      <details>
        <summary>Provider setup</summary>
        <p>
          Codex CLI uses its existing sign-in. Ollama uses your local server and
          installed models; its default address is 127.0.0.1:11434. Set
          PLANBRANCH_OLLAMA_URL before starting PlanBranch to change it.
        </p>
        <p>
          For cloud providers, set the matching environment variable before
          starting PlanBranch: OPENAI_API_KEY, ANTHROPIC_API_KEY, or
          GEMINI_API_KEY. Restart PlanBranch after changing the environment.
        </p>
        <p>
          Keys stay on the server; they are never stored in browser preferences.
          Cloud requests send the selected planning context or coding files to
          that provider.
        </p>
        <p>
          <a
            href="https://ollama.com/download"
            target="_blank"
            rel="noreferrer"
          >
            Ollama setup
          </a>{" "}
          ·{" "}
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noreferrer"
          >
            OpenAI keys
          </a>{" "}
          ·{" "}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer"
          >
            Anthropic keys
          </a>{" "}
          ·{" "}
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
          >
            Gemini keys
          </a>
        </p>
      </details>
    </section>
  );
}
