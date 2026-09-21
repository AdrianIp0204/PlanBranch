import { describe, expect, it } from "vitest";
import { placeEdgeLabel, type Obstacle } from "./edgeLabels";

const boxes: Obstacle[] = [
  { x: 80, y: 300, width: 220, height: 112 },
  { x: 330, y: 300, width: 220, height: 112 },
  { x: 600, y: 300, width: 220, height: 142 },
];
const clearOfNodes = (
  point: { x: number; y: number },
  width: number,
  height: number,
  nodes = boxes,
) =>
  nodes.every(
    (box) =>
      point.x + width / 2 <= box.x ||
      point.x - width / 2 >= box.x + box.width ||
      point.y + height / 2 <= box.y ||
      point.y - height / 2 >= box.y + box.height,
  );

describe("connection label placement", () => {
  it("keeps a clear existing anchor unchanged", () => {
    const anchor = { x: 315, y: 240 };
    expect(placeEdgeLabel(anchor, { width: 130, height: 26 }, boxes, [])).toBe(
      anchor,
    );
  });

  it("moves a horizontal dogleg label onto nearby clear edge space", () => {
    const point = placeEdgeLabel(
      { x: 315, y: 356 },
      { width: 130, height: 26 },
      boxes,
      [
        { x: 315, y: 360 },
        { x: 245, y: 432 },
        { x: 280, y: 500 },
      ],
    );
    expect(point).toEqual({ x: 245, y: 432 });
    expect(clearOfNodes(point, 130, 26)).toBe(true);
  });

  it("checks unrelated nodes rather than only the connection endpoints", () => {
    const point = placeEdgeLabel(
      { x: 600, y: 400 },
      { width: 200, height: 30 },
      boxes,
      [
        { x: 700, y: 430 },
        { x: 570, y: 470 },
      ],
    );
    expect(point).toEqual({ x: 570, y: 470 });
    expect(clearOfNodes(point, 200, 30)).toBe(true);
  });

  it("finds room for a multiline label when no point on the edge fits", () => {
    const anchor = { x: 315, y: 356 };
    const point = placeEdgeLabel(anchor, { width: 240, height: 90 }, boxes, [
      { x: 315, y: 320 },
      { x: 315, y: 400 },
    ]);
    expect(clearOfNodes(point, 240, 90)).toBe(true);
    expect(anchor).toEqual({ x: 315, y: 356 });
    expect(boxes[0]).toEqual({ x: 80, y: 300, width: 220, height: 112 });
  });

  it("walks past overlapping obstacles and reserves room above proposal badges", () => {
    const crowded = [
      { x: 0, y: 76, width: 220, height: 136 },
      { x: 210, y: 50, width: 220, height: 170 },
      { x: -100, y: 220, width: 750, height: 300 },
    ];
    const point = placeEdgeLabel(
      { x: 215, y: 140 },
      { width: 240, height: 70 },
      crowded,
      [],
    );
    expect(clearOfNodes(point, 240, 70, crowded)).toBe(true);
    expect(point.y + 35).toBeLessThan(50);
  });
});
