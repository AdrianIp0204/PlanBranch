import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AgentConnections from "./AgentConnections";
import { api } from "./api";
vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("shows metadata and environment setup without a credential input or a provider generation call", async () => {
  vi.mocked(api).mockResolvedValue({
    connections: [
      {
        id: "openai",
        label: "OpenAI",
        configured: false,
        credentialSource: "OPENAI_API_KEY",
        endpoint: "https://api.openai.com",
      },
    ],
  });
  render(<AgentConnections />);
  await screen.findByText("OpenAI");
  fireEvent.click(screen.getByText("Provider setup"));
  expect(
    screen.getByText(/OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY/),
  ).toBeTruthy();
  expect(document.querySelector("input")).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "Check OpenAI API connection",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(api).toHaveBeenCalledExactlyOnceWith("/agent/connections");
  fireEvent.click(screen.getByRole("button", { name: "Reload configuration" }));
  expect(api).toHaveBeenCalledTimes(2);
});

it("checks a configured API only after an explicit click and does not claim model access", async () => {
  vi.mocked(api).mockImplementation(async (path, options) =>
    path === "/agent/connections"
      ? ({
          connections: [
            {
              id: "openai",
              label: "OpenAI",
              configured: true,
              credentialSource: "OPENAI_API_KEY",
              endpoint: "https://api.openai.com",
            },
          ],
        } as any)
      : ({ agent: { available: true, verified: true } } as any),
  );
  render(<AgentConnections />);
  const check = await screen.findByRole("button", {
    name: "Check OpenAI API connection",
  });
  expect(api).toHaveBeenCalledExactlyOnceWith("/agent/connections");
  fireEvent.click(check);
  await screen.findByText(
    "API reachable. Access to individual models is checked when requested.",
  );
  expect(api).toHaveBeenLastCalledWith("/agent/check", {
    method: "POST",
    body: '{"provider":"openai"}',
  });
  expect(
    vi
      .mocked(api)
      .mock.calls.every(
        ([path]) => !path.includes("messages") && !path.includes("runs"),
      ),
  ).toBe(true);
});
it("keeps a failed metadata API check explicit and retryable", async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({
      connections: [
        {
          id: "anthropic",
          label: "Anthropic",
          configured: true,
          credentialSource: "ANTHROPIC_API_KEY",
          endpoint: "https://api.anthropic.com",
        },
      ],
    })
    .mockRejectedValueOnce(new Error("Authentication was refused"));
  render(<AgentConnections />);
  const check = await screen.findByRole("button", {
    name: "Check Anthropic API connection",
  });
  fireEvent.click(check);
  await screen.findByText("Authentication was refused");
  expect((check as HTMLButtonElement).disabled).toBe(false);
  expect(api).toHaveBeenCalledTimes(2);
});
