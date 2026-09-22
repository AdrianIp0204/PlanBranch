import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsDialog from "./SettingsDialog";
import { api, post } from "./api";
import { readPreferences } from "./preferences";
import { desktopNotificationPermission, prepareNotificationSound, requestDesktopNotificationPermission } from "./operationNotifications";

vi.mock("./api", () => ({ api: vi.fn(), post: vi.fn() }));
vi.mock("./ModelControls", () => ({
  default: () => <div>Model controls</div>,
  useModelSelection: () => ({ selection: { mode: "default" }, capabilities: null, setSelection: vi.fn(), problem: "", refreshing: false, refresh: vi.fn() }),
}));
vi.mock("./CodexConnection", () => ({ default: () => <div>Codex connection</div> }));
vi.mock("./operationNotifications", () => ({ desktopNotificationPermission: vi.fn(), prepareNotificationSound: vi.fn(), requestDesktopNotificationPermission: vi.fn() }));

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.open = false; } });
  localStorage.clear(); readPreferences(); vi.clearAllMocks();
  vi.mocked(api).mockResolvedValue({ version: "1.0.0", dataDirectory: "disposable-data" });
  vi.mocked(desktopNotificationPermission).mockReturnValue("default");
  vi.mocked(prepareNotificationSound).mockResolvedValue(true);
  vi.mocked(requestDesktopNotificationPermission).mockResolvedValue("granted");
});
afterEach(cleanup);
async function openAgentSettings() {
  render(<SettingsDialog onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /^Agent$/ }));
  await act(async () => {});
}

it("leaves optional delivery off and never prompts when opening Settings or Agent", async () => {
  await openAgentSettings();
  expect((screen.getByRole("checkbox", { name: "Play a short sound" }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("Desktop notifications: off.")).toBeTruthy();
  expect(prepareNotificationSound).not.toHaveBeenCalled();
  expect(requestDesktopNotificationPermission).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
});

it("unlocks sound only on explicit opt-in and keeps shared preferences synchronized", async () => {
  let complete!: (enabled: boolean) => void;
  vi.mocked(prepareNotificationSound).mockReturnValue(new Promise<boolean>(resolve => { complete = resolve; }));
  await openAgentSettings();
  const sound = screen.getByRole("checkbox", { name: "Play a short sound" }) as HTMLInputElement;
  fireEvent.click(sound);
  expect(prepareNotificationSound).toHaveBeenCalledTimes(1);
  expect(sound.disabled).toBe(true);
  expect(readPreferences().sound).toBe(false);
  await act(async () => complete(true));
  expect(readPreferences().sound).toBe(true);
  expect(sound.checked).toBe(true);
  fireEvent.click(sound);
  expect(readPreferences().sound).toBe(false);
  expect(prepareNotificationSound).toHaveBeenCalledTimes(1);
});

it("keeps sound off with useful feedback if audio is unavailable", async () => {
  vi.mocked(prepareNotificationSound).mockResolvedValue(false);
  await openAgentSettings();
  fireEvent.click(screen.getByRole("checkbox", { name: "Play a short sound" }));
  expect(await screen.findByText("Sound is unavailable in this browser. In-app notices remain enabled.")).toBeTruthy();
  expect(readPreferences().sound).toBe(false);
});

it("requests desktop permission only through Enable/Retry and keeps denial actionable", async () => {
  vi.mocked(requestDesktopNotificationPermission).mockResolvedValueOnce("denied").mockResolvedValueOnce("granted");
  await openAgentSettings();
  fireEvent.click(screen.getByRole("button", { name: "Enable desktop notifications" }));
  expect(await screen.findByText("Desktop notifications: blocked by the browser.")).toBeTruthy();
  expect(readPreferences().desktop).toBe(false);
  expect(requestDesktopNotificationPermission).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry desktop notifications" }));
  await waitFor(() => expect(readPreferences().desktop).toBe(true));
  expect(screen.getByText("Desktop notifications: on.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disable desktop notifications" }));
  expect(readPreferences().desktop).toBe(false);
  expect(requestDesktopNotificationPermission).toHaveBeenCalledTimes(2);
  expect(post).not.toHaveBeenCalled();
});

it("explains unsupported desktop notifications without offering a broken permission action", async () => {
  vi.mocked(desktopNotificationPermission).mockReturnValue("unsupported");
  await openAgentSettings();
  expect(screen.getByText("Desktop notifications: unavailable in this browser.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Enable desktop notifications" })).toBeNull();
  expect(requestDesktopNotificationPermission).not.toHaveBeenCalled();
});
