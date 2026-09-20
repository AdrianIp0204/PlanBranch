import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import {
  LAYOUT_KEY,
  ResizeHandle,
  defaultLayout,
  readLayout,
  useLayout,
} from "./layout";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("innerHeight", 900);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local layout preferences", () => {
  it("falls back safely for corrupt, unavailable, or invalid stored values", () => {
    for (const invalid of ["{", "null", "false", '"not a layout"']) {
      localStorage.setItem(LAYOUT_KEY, invalid);
      expect(readLayout()).toEqual(defaultLayout(1440));
    }
    localStorage.setItem(
      LAYOUT_KEY,
      '{"navigationOpen":"false","inspectorWidth":1e309,"catalogueHeight":null}',
    );
    expect(readLayout()).toEqual(defaultLayout(1440));
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    expect(readLayout()).toEqual(defaultLayout(1440));
  });

  it("clamps persisted dimensions and retains only recognised preferences", () => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        navigationOpen: false,
        inspectorOpen: false,
        catalogueOpen: true,
        inspectorWidth: 9999,
        catalogueHeight: -100,
        notes: "Must not enter layout state",
        history: ["Must not enter layout state"],
      }),
    );
    expect(readLayout()).toEqual({
      navigationOpen: false,
      inspectorOpen: false,
      catalogueOpen: true,
      sidePanel: "inspector",
      inspectorWidth: 520,
      catalogueHeight: 230,
    });
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ inspectorWidth: 1, catalogueHeight: 9999 }),
    );
    expect(readLayout()).toMatchObject({
      inspectorWidth: 280,
      catalogueHeight: 600,
    });
  });

  it("stores only the layout key and resets according to the current window", () => {
    localStorage.setItem("unrelated-preference", "keep");
    const write = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(useLayout);
    act(() => {
      result.current.preference("inspectorWidth", 420);
      result.current.preference("catalogueOpen", (open) => !open);
    });
    expect(result.current.layout).toMatchObject({
      inspectorWidth: 420,
      catalogueOpen: true,
    });
    expect(write.mock.calls.every(([key]) => key === LAYOUT_KEY)).toBe(true);
    const persisted = JSON.parse(localStorage.getItem(LAYOUT_KEY)!);
    expect(Object.keys(persisted).sort()).toEqual(
      Object.keys(defaultLayout()).sort(),
    );
    expect(localStorage.getItem("unrelated-preference")).toBe("keep");
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 600);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(result.current.windowSize).toEqual({ width: 800, height: 600 });
    expect(result.current.layout.navigationOpen).toBe(true);
    act(() => result.current.reset());
    expect(result.current.layout).toEqual(defaultLayout(800));
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!)).toEqual(
      defaultLayout(800),
    );
  });

  it("remains usable when reading and writing storage are denied", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(useLayout);
    act(() => result.current.preference("inspectorOpen", false));
    expect(result.current.layout.inspectorOpen).toBe(false);
    act(() => result.current.reset());
    expect(result.current.layout).toEqual(defaultLayout());
  });
});

function ResizerHarness({
  orientation,
  onChange,
  onCollapse,
  onBubble,
}: {
  orientation: "vertical" | "horizontal";
  onChange: (value: number) => void;
  onCollapse: () => void;
  onBubble?: () => void;
}) {
  const [value, setValue] = useState(340);
  return (
    <div onKeyDown={onBubble}>
      <input aria-label="Native text" defaultValue="Keep editing" />
      <input aria-label="Native checkbox" type="checkbox" />
      <ResizeHandle
        label="Resize pane"
        controls="pane"
        orientation={orientation}
        value={value}
        min={280}
        max={520}
        onCollapse={onCollapse}
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
      <div id="pane" />
      <span id="resize-help">Use arrows or Enter</span>
    </div>
  );
}

describe("bounded panel resizing", () => {
  it.each([
    ["vertical", "ArrowLeft", "ArrowRight"],
    ["horizontal", "ArrowUp", "ArrowDown"],
  ] as const)(
    "uses %s grow/shrink keys, bounds, and collapse without leaking events",
    (orientation, grow, shrink) => {
      const onChange = vi.fn();
      const onCollapse = vi.fn();
      const onBubble = vi.fn();
      render(
        <ResizerHarness {...{ orientation, onChange, onCollapse, onBubble }} />,
      );
      const handle = screen.getByRole("separator", { name: "Resize pane" });
      expect(handle.getAttribute("aria-controls")).toBe("pane");
      expect(handle.getAttribute("aria-orientation")).toBe(orientation);
      expect(handle.getAttribute("aria-valuemin")).toBe("280");
      expect(handle.getAttribute("aria-valuemax")).toBe("520");
      handle.focus();
      expect(fireEvent.keyDown(handle, { key: grow })).toBe(false);
      expect(handle.getAttribute("aria-valuenow")).toBe("356");
      fireEvent.keyDown(handle, { key: grow, shiftKey: true });
      expect(handle.getAttribute("aria-valuenow")).toBe("396");
      fireEvent.keyDown(handle, { key: shrink });
      expect(handle.getAttribute("aria-valuenow")).toBe("380");
      fireEvent.keyDown(handle, { key: "Home" });
      fireEvent.keyDown(handle, { key: shrink });
      expect(handle.getAttribute("aria-valuenow")).toBe("280");
      fireEvent.keyDown(handle, { key: "End" });
      fireEvent.keyDown(handle, { key: grow });
      expect(handle.getAttribute("aria-valuetext")).toBe("520 pixels");
      const changes = onChange.mock.calls.length;
      fireEvent.keyDown(handle, { key: "Enter" });
      expect(onCollapse).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(changes);
      expect(onBubble).not.toHaveBeenCalled();

      const input = screen.getByLabelText("Native text") as HTMLInputElement;
      input.focus();
      input.setSelectionRange(2, 2);
      for (const key of [grow, shrink, "Home", "End", "Enter", "Backspace"])
        expect(fireEvent.keyDown(input, { key })).toBe(true);
      const checkbox = screen.getByLabelText("Native checkbox");
      fireEvent.keyDown(checkbox, { key: grow });
      fireEvent.click(checkbox);
      expect((checkbox as HTMLInputElement).checked).toBe(true);
      expect(input.value).toBe("Keep editing");
      expect(onChange).toHaveBeenCalledTimes(changes);
      expect(onCollapse).toHaveBeenCalledTimes(1);
      expect(onBubble).toHaveBeenCalledTimes(7);
    },
  );

  it.each(["vertical", "horizontal"] as const)(
    "tracks only the captured %s pointer and clamps movement",
    (orientation) => {
      class TestPointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, properties: PointerEventInit = {}) {
          super(type, properties);
          this.pointerId = properties.pointerId ?? 0;
        }
      }
      vi.stubGlobal("PointerEvent", TestPointerEvent);
      const onChange = vi.fn();
      const onCollapse = vi.fn();
      render(<ResizerHarness {...{ orientation, onChange, onCollapse }} />);
      const handle = screen.getByRole("separator", { name: "Resize pane" });
      const capture = vi.fn();
      const release = vi.fn();
      handle.setPointerCapture = capture;
      handle.hasPointerCapture = () => true;
      handle.releasePointerCapture = release;
      const pointer = (coordinate: number, pointerId = 4) => ({
        pointerId,
        button: 0,
        clientX: orientation === "vertical" ? coordinate : 100,
        clientY: orientation === "horizontal" ? coordinate : 100,
      });
      fireEvent.pointerDown(handle, { ...pointer(500), button: 2 });
      fireEvent.pointerMove(handle, pointer(450));
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.pointerDown(handle, pointer(500));
      expect(document.activeElement).toBe(handle);
      expect(capture).toHaveBeenCalledWith(4);
      fireEvent.pointerMove(handle, pointer(450, 99));
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.pointerMove(handle, pointer(450));
      expect(handle.getAttribute("aria-valuenow")).toBe("390");
      fireEvent.pointerMove(handle, pointer(-500));
      expect(handle.getAttribute("aria-valuenow")).toBe("520");
      fireEvent.pointerMove(handle, pointer(2000));
      expect(handle.getAttribute("aria-valuenow")).toBe("280");
      fireEvent.pointerUp(handle, pointer(2000, 99));
      expect(release).not.toHaveBeenCalled();
      fireEvent.pointerCancel(handle, pointer(2000));
      expect(release).toHaveBeenCalledWith(4);
      const changes = onChange.mock.calls.length;
      fireEvent.pointerMove(handle, pointer(450));
      expect(onChange).toHaveBeenCalledTimes(changes);
      fireEvent.pointerDown(handle, pointer(500));
      fireEvent.lostPointerCapture(handle, pointer(500));
      fireEvent.pointerMove(handle, pointer(450));
      expect(onChange).toHaveBeenCalledTimes(changes);
      expect(onCollapse).not.toHaveBeenCalled();
    },
  );
});
