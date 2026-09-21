import { afterEach, expect, it } from "vitest";
import {
  PLANNING_DRAFT_PREFIX,
  readPlanningDrafts,
  writePlanningDrafts,
} from "./planning";
import { emptyBrief } from "./types";
afterEach(() => sessionStorage.clear());
it("recovers a brief-only revision and exact uncertain request without inventing a diagram edit", () => {
  const brief = { ...emptyBrief(), goal: "Keep the manually reviewed goal" };
  const failedPrompt = {
    mutationId: "same-receipt",
    text: "Refine this",
    diagramId: "main",
    nodeId: null,
    proposalId: "proposal",
    proposalBrief: brief,
    selection: { mode: "default" as const },
  };
  const revision = {
    proposalId: "proposal",
    title: "Brief proposal",
    diagram: { id: "main", name: "Main", nodes: [], edges: [] },
    brief,
    editableSections: ["brief" as const],
    nonce: "revision",
  };
  writePlanningDrafts("p", {
    message: "Refine this",
    comments: {},
    failedPrompt,
    revision,
  });
  const result = readPlanningDrafts("p");
  expect(result.failedPrompt).toEqual(failedPrompt);
  expect(result.failedPrompt).not.toHaveProperty("proposalDiagram");
  expect(result.revision).toEqual(revision);
});
it("rejects malformed saved brief candidates instead of silently dropping their fields", () => {
  sessionStorage.setItem(
    PLANNING_DRAFT_PREFIX + "p",
    JSON.stringify({
      failedPrompt: {
        mutationId: "receipt",
        text: "Refine",
        diagramId: "main",
        nodeId: null,
        proposalId: "proposal",
        proposalBrief: { goal: 42 },
      },
    }),
  );
  expect(readPlanningDrafts("p").failedPrompt).toBeNull();
});
