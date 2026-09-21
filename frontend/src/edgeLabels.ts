export type Point = { x: number; y: number };
export type LabelSize = { width: number; height: number };
export type Obstacle = Point & LabelSize;

/** Place the whole label in clear space, preferring a point on its own edge. */
export function placeEdgeLabel(
  anchor: Point,
  size: LabelSize,
  obstacles: Obstacle[],
  pathPoints: Point[],
): Point {
  const halfWidth = size.width / 2 + 6;
  const halfHeight = size.height / 2 + 6;
  const intersects = (point: Point, box: Obstacle) =>
    point.x + halfWidth > box.x &&
    point.x - halfWidth < box.x + box.width &&
    point.y + halfHeight > box.y &&
    point.y - halfHeight < box.y + box.height;
  const clear = (point: Point) =>
    !obstacles.some((box) => intersects(point, box));
  if (clear(anchor)) return anchor;
  const distance = (p: Point) => (p.x - anchor.x) ** 2 + (p.y - anchor.y) ** 2;
  const nearest = (points: Point[]) =>
    points.reduce((best, point) =>
      distance(point) < distance(best) ? point : best,
    );
  const onPath = pathPoints.filter(clear);
  if (onPath.length) return nearest(onPath);

  // A short or crowded edge may have no segment wide enough. Walk out of the
  // obstructed strip in each direction; a small leader keeps the label attached.
  const candidates: Point[] = [];
  for (const axis of ["x", "y"] as const) {
    const extent = axis === "x" ? "width" : "height";
    const half = axis === "x" ? halfWidth : halfHeight;
    for (const direction of [-1, 1]) {
      const point = { ...anchor };
      const ordered = [...obstacles].sort((a, b) =>
        direction > 0
          ? a[axis] - b[axis]
          : b[axis] + b[extent] - a[axis] - a[extent],
      );
      for (const box of ordered) {
        if (intersects(point, box)) {
          point[axis] =
            direction > 0 ? box[axis] + box[extent] + half : box[axis] - half;
        }
      }
      candidates.push(point);
    }
  }
  return nearest(candidates);
}
