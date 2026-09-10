import type { DetectedSymbol, PlannedVariable } from "./types";

/** Match backend precedence: proven absence takes priority over stale evidence. */
export function planState(
  plan: PlannedVariable,
  matches: { plannedId: string; symbolId: string; decision: string }[],
  symbols: DetectedSymbol[],
) {
  const linked = matches.filter(
    (match) => match.plannedId === plan.id && match.decision === "confirmed",
  );
  if (!linked.length) return "Planned only";
  const found = linked.map((match) =>
    symbols.find((symbol) => symbol.id === match.symbolId),
  );
  if (found.some((symbol) => !symbol || symbol.state === "not_detected"))
    return "Linked, not detected";
  if (
    found.some(
      (symbol) =>
        symbol!.ambiguousIdentity ||
        ["stale", "historical", "unverified"].includes(symbol!.state),
    )
  )
    return "Stale scan";
  return "Linked and detected";
}

export function evidenceState(symbol: DetectedSymbol) {
  if (["historical", "unverified"].includes(symbol.state))
    return "Historical / unverified";
  if (symbol.state === "not_detected") return "Not detected";
  if (symbol.state === "current" && symbol.ambiguousIdentity)
    return "Current · identity needs review";
  if (symbol.state === "current") return "Current";
  if (symbol.state === "stale") return "Stale";
  return symbol.state.replaceAll("_", " ");
}

export function symbolDescription(symbol: DetectedSymbol) {
  const line = symbol.locations[0]?.line;
  return `${symbol.name} · ${symbol.file} · ${symbol.scope || "<module>"}${line ? ` · line ${line}` : ""} · ${evidenceState(symbol)}`;
}
