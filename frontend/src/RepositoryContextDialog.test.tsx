import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import RepositoryContextDialog from "./RepositoryContextDialog";
import { api } from "./api";
import type { PlanningPrompt } from "./planning";

vi.mock("./api", () => ({ api: vi.fn() }));
const prompt: PlanningPrompt = {
  mutationId: "message",
  text: "Reuse helper",
  diagramId: "diagram",
  nodeId: null,
  selection: { mode: "explicit", model: "fixture", reasoningEffort: null },
};
const catalogue = {
  files: ["app.py", "tests/test_app.py"],
  symbols: [],
  revision: "a".repeat(40),
  partial: false,
  exclusions: "Sensitive files excluded.",
};
const packageResult = {
  previewId: "preview",
  packageHash: "b".repeat(64),
  provider: "codex",
  model: "fixture",
  revision: "a".repeat(40),
  requestBytes: 2500,
  notice: "Frozen snapshot; previous history omitted.",
  outgoing: { text: "selected_source_only" },
  source: {
    files: [
      {
        path: "app.py",
        text: "selected_source_only",
        startLine: 1,
        endLine: 1,
        redactedLines: [],
      },
    ],
  },
};
beforeEach(() => {
  vi.clearAllMocks();
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
  vi.mocked(api).mockImplementation(async (url) =>
    url.endsWith("/files")
      ? catalogue
      : url.endsWith("/preview")
        ? packageResult
        : {},
  );
});
afterEach(cleanup);

it("requires a concrete preview and explicit consent before sending", async () => {
  const send = vi.fn(async () => {});
  render(
    <RepositoryContextDialog
      projectId="project"
      prompt={prompt}
      onSend={send}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByLabelText("app.py"));
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Preview outgoing request" }),
  );
  const confirm = await screen.findByRole("button", {
    name: "Confirm and send this package",
  });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("selected_source_only")).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/I confirm sending/));
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(send).toHaveBeenCalledWith({
      ...prompt,
      repositoryConsent: {
        previewId: "preview",
        packageHash: "b".repeat(64),
        confirmed: true,
      },
    }),
  );
});

it("changing selected source clears consent and cancels the old package", async () => {
  const send = vi.fn(async () => {});
  render(
    <RepositoryContextDialog
      projectId="project"
      prompt={prompt}
      onSend={send}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByLabelText("app.py"));
  fireEvent.click(
    screen.getByRole("button", { name: "Preview outgoing request" }),
  );
  fireEvent.click(await screen.findByLabelText(/I confirm sending/));
  fireEvent.click(screen.getByLabelText("tests/test_app.py"));
  expect(
    screen.queryByRole("button", { name: "Confirm and send this package" }),
  ).toBeNull();
  expect(send).not.toHaveBeenCalled();
  expect(
    vi.mocked(api).mock.calls.some(([url]) => url.endsWith("/cancel")),
  ).toBe(true);
});

it("closing while preparing cancels and cannot send a late preview", async () => {
  const send = vi.fn(async () => {}),
    close = vi.fn();
  let resolve!: (value: typeof packageResult) => void;
  vi.mocked(api).mockImplementation(async (url) =>
    url.endsWith("/preview")
      ? new Promise((done) => {
          resolve = done;
        })
      : catalogue,
  );
  const view = render(
    <RepositoryContextDialog
      projectId="project"
      prompt={prompt}
      onSend={send}
      onClose={close}
    />,
  );
  fireEvent.click(await screen.findByLabelText("app.py"));
  fireEvent.click(
    screen.getByRole("button", { name: "Preview outgoing request" }),
  );
  await screen.findByRole("button", { name: "Cancel preview" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel preview" }));
  resolve(packageResult);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Confirm and send this package" }),
    ).toBeNull(),
  );
  view.unmount();
  expect(send).not.toHaveBeenCalled();
});
