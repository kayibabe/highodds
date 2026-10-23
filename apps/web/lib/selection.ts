// Plain helpers shared by server pages and client components (a "use client" module's exports
// can't be called from a server component).

export function selectionLabel(selection: string): string {
  if (selection === "HOME") return "Home win";
  if (selection === "AWAY") return "Away win";
  if (selection === "DRAW") return "Draw";
  if (selection === "YES") return "Yes";
  if (selection === "NO") return "No";
  const total = /^(OVER|UNDER)_([0-9]+)_([0-9]+)$/.exec(selection);
  return total ? `${total[1] === "OVER" ? "Over" : "Under"} ${total[2]}.${total[3]}` : selection;
}

export function selectionTone(selection: string): string {
  const value = selection.toUpperCase();
  if (value.startsWith("OVER") || value.includes("_OVER")) return "market-pick-over";
  if (value.startsWith("UNDER") || value.includes("_UNDER")) return "market-pick-under";
  if (value === "HOME") return "market-pick-home";
  if (value === "DRAW") return "market-pick-draw";
  if (value === "AWAY") return "market-pick-away";
  if (value === "YES") return "market-pick-yes";
  if (value === "NO") return "market-pick-no";
  if (["1X", "X2", "12"].includes(value)) return "market-pick-cover";
  return "market-pick-other";
}

const SHORT_MARKET: Record<string, string> = { MATCH_WINNER: "1X2", TOTAL_GOALS: "Goals", BTTS: "BTTS" };

/** Compact "market: selection" label for table cells, e.g. "BTTS: Yes", "Goals: Over 2.5". */
export function shortPickLabel(marketKey: string, selection: string): string {
  return `${SHORT_MARKET[marketKey] ?? marketKey}: ${selectionLabel(selection)}`;
}

export const LEG_OUTCOME_LABEL: Record<string, string> = { WIN: "Won", LOSS: "Lost", VOID: "Void", PENDING: "Pending", UNRESOLVED: "Unresolved" };
