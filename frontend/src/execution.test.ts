import { beforeEach, describe, expect, it } from "vitest";
import {
  executionReceiptKey,
  readExecutionReceipt,
  writeExecutionReceipt,
  executionActive,
} from "./execution";
beforeEach(() => sessionStorage.clear());
describe("execution request receipts", () => {
  it("retains exact reviewed start and confirmed result identities", () => {
    const start = {
      kind: "start" as const,
      body: {
        mutationId: "request",
        previewId: "reviewed",
        confirmed: true as const,
      },
    };
    writeExecutionReceipt("project", start);
    expect(readExecutionReceipt("project")).toEqual(start);
    const apply = {
      kind: "apply" as const,
      runId: "run",
      body: {
        mutationId: "original",
        digest: "immutable",
        confirmed: true as const,
      },
    };
    writeExecutionReceipt("project", apply);
    expect(readExecutionReceipt("project")).toEqual(apply);
    writeExecutionReceipt("project", null);
    expect(readExecutionReceipt("project")).toBeNull();
  });
  it.each([
    "broken",
    {},
    {
      kind: "start",
      body: { mutationId: "id", previewId: "reviewed", confirmed: false },
    },
    { kind: "apply", runId: "run", body: { mutationId: "id", digest: "hash" } },
    {
      kind: "complete",
      runId: "run",
      body: {
        mutationId: "id",
        digest: "hash",
        confirmed: true,
        baseRevision: -1,
      },
    },
    { kind: "unknown", runId: "run", body: { mutationId: "id" } },
  ])("rejects malformed or unconfirmed receipt %j", (value) => {
    sessionStorage.setItem(
      executionReceiptKey("project"),
      JSON.stringify(value),
    );
    expect(readExecutionReceipt("project")).toBeNull();
  });
  it("does not classify interrupted work as active or automatically retryable", () => {
    expect(executionActive({ state: "running" })).toBe(true);
    expect(executionActive({ state: "interrupted" })).toBe(false);
  });
});
