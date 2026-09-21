import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import CodexConnection, { CodexConnectionDialog } from "./CodexConnection";
import App from "./App";
import { api, bootstrap, post } from "./api";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: vi.fn(),
  bootstrap: vi.fn(async () => {}),
  post: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() {
      this.open = false;
    },
  });
});
afterEach(cleanup);

describe("Codex connection check", () => {
  it("only reads local status and shows available CLI details without starting a task", async () => {
    vi.mocked(api).mockResolvedValue({
      agent: { available: true, label: "Codex CLI" },
      cliVersion: "0.143.0",
    });
    render(<CodexConnection />);
    await screen.findByText("Codex ready");
    expect(screen.getByText("CLI 0.143.0")).toBeTruthy();
    expect(api).toHaveBeenCalledExactlyOnceWith("/connection");
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/Install Codex CLI/)).toBeNull();
  });
  it("offers concise manual setup and refreshes an unavailable connection only on request", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({
        agent: {
          available: false,
          label: "Codex CLI",
          reason: "Codex is not signed in.",
        },
      })
      .mockResolvedValueOnce({
        agent: { available: true, label: "Codex CLI" },
      });
    render(<CodexConnection />);
    await screen.findByText("Codex unavailable");
    expect(screen.getByText("Codex is not signed in.")).toBeTruthy();
    expect(
      screen.getByText("You can create and edit plans without Codex."),
    ).toBeTruthy();
    const guide = screen.getByRole("link", { name: "Codex setup guide" });
    expect(guide.getAttribute("href")).toBe(
      "https://learn.chatgpt.com/docs/codex/cli",
    );
    expect(guide.getAttribute("rel")).toContain("noopener");
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await screen.findByText("Codex ready");
    expect(vi.mocked(api).mock.calls).toEqual([
      ["/connection"],
      ["/connection?refresh=1"],
    ]);
    expect(screen.queryByText("Codex is not signed in.")).toBeNull();
  });
  it("keeps a failed status check retryable and renders server text inertly", async () => {
    vi.mocked(api)
      .mockRejectedValueOnce(new Error("<script>check failed</script>"))
      .mockResolvedValueOnce({
        agent: {
          available: false,
          label: "Codex CLI",
          reason: "Install the CLI first.",
        },
      });
    render(<CodexConnection />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "<script>check failed</script>",
    );
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await screen.findByText("Install the CLI first.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
  it("ignores an old status response after the component is closed and reopened", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(api)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValueOnce({
        agent: { available: true, label: "Codex CLI" },
      });
    const first = render(<CodexConnection />);
    first.unmount();
    render(<CodexConnection />);
    await screen.findByText("Codex ready");
    await act(async () =>
      resolve({
        agent: {
          available: false,
          label: "Codex CLI",
          reason: "Old unavailable check",
        },
      }),
    );
    expect(screen.queryByText("Old unavailable check")).toBeNull();
    expect(screen.getByText("Codex ready")).toBeTruthy();
  });
  it("closes predictably and restores focus to the launcher", async () => {
    vi.mocked(api).mockResolvedValue({
      agent: { available: true, label: "Codex CLI" },
    });
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Connection settings</button>
          {open && <CodexConnectionDialog onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Connection settings" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", {
      name: "Codex connection",
    });
    await within(dialog).findByText("Codex ready");
    fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("first-run manual planning", () => {
  it.each(["checking", "unavailable"])(
    "keeps New project reachable while Codex is %s",
    async (status) => {
      vi.mocked(api).mockImplementation((async (path: string) => {
        if (path === "/projects") return { projects: [] };
        if (path === "/connection")
          return status === "checking"
            ? new Promise(() => {})
            : {
                agent: {
                  available: false,
                  label: "Codex CLI",
                  reason: "No local sign-in",
                },
              };
        throw new Error(`Unexpected request ${path}`);
      }) as typeof api);
      render(<App />);
      const create = await screen.findByRole("button", { name: "New project" });
      expect(bootstrap).toHaveBeenCalledOnce();
      await screen.findByText(
        status === "checking" ? "Checking Codex…" : "Codex unavailable",
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect((create as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(create);
      const dialog = await screen.findByRole("dialog", { name: "New project" });
      const input = within(dialog).getByRole("textbox");
      fireEvent.change(input, { target: { value: "A manual plan" } });
      expect((input as HTMLInputElement).value).toBe("A manual plan");
      expect(
        (
          within(dialog).getByRole("button", {
            name: "Create project",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      expect(post).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(
          vi
            .mocked(api)
            .mock.calls.every(([path]) =>
              ["/projects", "/connection"].includes(path),
            ),
        ).toBe(true),
      );
    },
  );
});
