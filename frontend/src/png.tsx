import { createRoot } from "react-dom/client";
import { ReactFlow, type ReactFlowInstance } from "@xyflow/react";
import { toBlob } from "html-to-image";
import {
  flowEdges,
  flowNodes,
  nodeTypes,
  edgeTypes,
  type FlowNode,
} from "./Canvas";
import type { Diagram } from "./types";
import { downloadBlob } from "./api";
const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
/** Render all nodes/edges on a separate surface, then measure their actual DOM bounds. */
export async function exportPng(diagram: Diagram) {
  if (!diagram.nodes.length)
    throw new Error("Add a node before exporting a diagram.");
  const nodes = flowNodes(diagram);
  const minX = Math.min(...nodes.map((n) => n.position.x));
  const minY = Math.min(...nodes.map((n) => n.position.y));
  const maxX = Math.max(...nodes.map((n) => n.position.x + 220));
  const maxY = Math.max(...nodes.map((n) => n.position.y + 150));
  let width = Math.ceil(maxX - minX + 500),
    height = Math.ceil(maxY - minY + 500);
  if (width > 16000 || height > 16000 || width * height > 64000000)
    throw new Error(
      "The diagram is too spread out for a readable PNG. Move distant nodes closer and try again.",
    );
  const host = document.createElement("div");
  host.className = "png-export";
  // Exports intentionally use the light token scope in theme.css. Read its
  // computed background after attaching so SVG/HTML and the image share a palette.
  host.dataset.theme = "light";
  Object.assign(host.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${width}px`,
    height: `${height}px`,
    background: "var(--canvas)",
  });
  document.body.appendChild(host);
  const backgroundColor = getComputedStyle(host).backgroundColor;
  const root = createRoot(host);
  try {
    const instance = await new Promise<ReactFlowInstance<FlowNode>>(
      (resolve) => {
        root.render(
          <ReactFlow<FlowNode>
            colorMode="light"
            nodes={nodes}
            edges={flowEdges(diagram)}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultViewport={{ x: 250 - minX, y: 250 - minY, zoom: 1 }}
            onInit={resolve}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            onlyRenderVisibleElements={false}
            minZoom={0.01}
            maxZoom={4}
          />,
        );
      },
    );
    await document.fonts.ready;
    await frame();
    await frame();
    await frame();
    const rect = host.getBoundingClientRect();
    const parts = Array.from(
      host.querySelectorAll(
        ".react-flow__node,.react-flow__edge-path,.react-flow__edge-text,.react-flow__edge-textbg,.flow-edge-label",
      ),
    )
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width || r.height);
    const left = Math.min(...parts.map((r) => r.left - rect.left)),
      top = Math.min(...parts.map((r) => r.top - rect.top)),
      right = Math.max(...parts.map((r) => r.right - rect.left)),
      bottom = Math.max(...parts.map((r) => r.bottom - rect.top));
    width = Math.ceil(right - left + 160);
    height = Math.ceil(bottom - top + 160);
    if (width > 16000 || height > 16000 || width * height > 64000000)
      throw new Error(
        "Diagram labels extend beyond the safe image size. Shorten labels or move nodes closer.",
      );
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    await instance.setViewport({
      x: 250 - minX - left + 80,
      y: 250 - minY - top + 80,
      zoom: 1,
    });
    await frame();
    await frame();
    const blob = await toBlob(host, {
      width,
      height,
      pixelRatio: Math.min(2, Math.sqrt(64000000 / (width * height))),
      backgroundColor,
      // Reset both physical and logical positioning: computed inset-inline otherwise
      // retains the offscreen offset and overrides left/top inside the SVG clone.
      style: {
        position: "static",
        inset: "auto",
        insetInline: "auto",
        insetBlock: "auto",
        transform: "none",
        margin: "0",
      },
      filter: (el) =>
        !(
          el instanceof HTMLElement &&
          el.classList.contains("react-flow__attribution")
        ),
    });
    if (!blob)
      throw new Error(
        "The browser could not create the image. Try a smaller diagram.",
      );
    downloadBlob(
      blob,
      `${diagram.name.replace(/[^a-z0-9_-]+/gi, "-") || "diagram"}.png`,
    );
  } finally {
    root.unmount();
    host.remove();
  }
}
