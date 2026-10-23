import { db } from "@highodds/db";
import { attributeTicket, displayLegOutcome, parseSettlementEvidence, type TicketOutcome } from "@highodds/core";
import type { TicketCardData } from "../app/dashboard/ticket-board";

export type DecisionLeg = {
  fixtureId: string; market: string; selection: string; decimalOdds: number;
  modelProbability: number; consensusProbability: number; confidenceScore: number
};

/** Reads the per-leg snapshot PUBLISH_TICKETS stored on a TicketVersion; malformed rows are dropped. */
export function decisionLegs(value: unknown): DecisionLeg[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is DecisionLeg => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return typeof row.fixtureId === "string" && typeof row.market === "string" && typeof row.selection === "string"
      && typeof row.decimalOdds === "number" && Number.isFinite(row.decimalOdds)
      && typeof row.modelProbability === "number" && row.modelProbability >= 0 && row.modelProbability <= 1
      && typeof row.consensusProbability === "number" && row.consensusProbability >= 0 && row.consensusProbability <= 1
      && typeof row.confidenceScore === "number" && row.confidenceScore >= 0 && row.confidenceScore <= 100;
  });
}

type TicketWhere = NonNullable<NonNullable<Parameters<typeof db.ticketVersion.findMany>[0]>["where"]>;

/**
 * Loads current (non-superseded) ticket versions as board cards, with each leg's outcome and the
 * legs that decided the ticket. Settled tickets read the immutable settlement evidence; unsettled
 * tickets preview the same rules against the latest stored fixture state.
 */
export async function loadTicketCards(where: TicketWhere, take?: number, includeSuperseded = false): Promise<TicketCardData[]> {
  const tickets = await db.ticketVersion.findMany({
    where: { ...where, ...(includeSuperseded ? {} : { successors: { none: {} } }) },
    orderBy: [{ targetDate: "desc" }, { tier: "asc" }, { publishedAt: "desc" }],
    take,
    include: { legs: { include: { fixture: { include: { competition: true, homeTeam: true, awayTeam: true } } } }, settlements: true }
  });
  if (tickets.length === 0) return [];

  const [markets, bookmakers, quotes] = await Promise.all([
    db.market.findMany({ where: { normalizedKey: { not: null } }, select: { normalizedKey: true, name: true } }),
    db.bookmaker.findMany({ where: { id: { in: [...new Set(tickets.map((ticket) => ticket.bookmakerId))] } }, select: { id: true, name: true } }),
    db.oddsQuote.findMany({ where: { id: { in: tickets.flatMap((ticket) => ticket.legs.map((leg) => leg.quoteId)) } }, select: { id: true, capturedAt: true } })
  ]);
  const marketNameByKey = new Map(markets.map((market) => [market.normalizedKey!, market.name]));
  const bookmakerNameById = new Map(bookmakers.map((bookmaker) => [bookmaker.id, bookmaker.name]));
  const quoteTimeById = new Map(quotes.map((quote) => [quote.id, quote.capturedAt]));

  return tickets.map((ticket) => {
    const decisions = decisionLegs(ticket.decision);
    const settlement = ticket.settlements[0];
    const outcome: TicketOutcome = settlement?.outcome ?? "PENDING";
    const settled = outcome !== "PENDING";
    const evidence = new Map(parseSettlementEvidence(settlement?.evidence).map((row) => [row.fixtureId, row]));

    const legs = ticket.legs.map((leg) => {
      const odds = Number(leg.decimalOdds);
      const probability = Number(leg.probability);
      const snapshot = decisions.find((item) => item.fixtureId === leg.fixtureId && item.market === leg.marketKey
        && item.selection === leg.selection && Math.abs(item.decimalOdds - odds) < 0.0001
        && Math.abs(item.modelProbability - probability) < 0.000001);
      const shown = displayLegOutcome(settled ? evidence.get(leg.fixtureId) : undefined, leg.marketKey, leg.selection, leg.fixture);
      const recorded = shown.fromSettlement ? evidence.get(leg.fixtureId) : undefined;
      return {
        id: leg.id, home: leg.fixture.homeTeam.name, away: leg.fixture.awayTeam.name,
        competition: leg.fixture.competition.name, kickoff: leg.fixture.kickoff.toISOString(),
        fixtureStatus: leg.fixture.status, statusCode: leg.fixture.statusCode, elapsedMinute: leg.fixture.elapsedMinute, homeGoals: leg.fixture.homeGoals, awayGoals: leg.fixture.awayGoals,
        market: marketNameByKey.get(leg.marketKey) ?? leg.marketKey, selection: leg.selection,
        odds, probability, quoteCapturedAt: quoteTimeById.get(leg.quoteId)?.toISOString() ?? null,
        consensusProbability: snapshot?.consensusProbability ?? null,
        agreementScore: snapshot?.confidenceScore ?? null,
        outcome: shown.outcome,
        outcomeSource: recorded ? "settlement" as const : "live" as const,
        settledScore: recorded && recorded.homeGoals !== null && recorded.awayGoals !== null ? `${recorded.homeGoals}–${recorded.awayGoals}` : null,
        decisive: false
      };
    }).sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id));

    const attribution = attributeTicket(outcome, legs);
    const decisive = new Set(attribution.decisiveLegIds);
    return {
      id: ticket.id, tier: ticket.tier, targetDate: ticket.targetDate.toISOString().slice(0, 10), combinedOdds: Number(ticket.combinedOdds),
      confidenceThreshold: ticket.confidenceThreshold, relaxed: ticket.relaxed,
      publishedAt: ticket.publishedAt.toISOString(), lockAt: ticket.lockAt.toISOString(),
      bookmaker: bookmakerNameById.get(ticket.bookmakerId) ?? null,
      outcome, profitUnits: settlement?.profitUnits === null || settlement?.profitUnits === undefined ? null : Number(settlement.profitUnits),
      attribution: attribution.summary,
      legs: legs.map((leg) => ({ ...leg, decisive: decisive.has(leg.id) }))
    };
  });
}
