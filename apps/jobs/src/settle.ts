import { db } from "@highodds/db";
import { resolveSelection } from "@highodds/core";
import { ApiFootballClient } from "./api-football.js";
import { ingestFixtures } from "./ingestion.js";

const REFRESH_BATCH_SIZE = 20; // API-Football's /fixtures?ids= accepts at most 20 "id-id-id" values per request

/**
 * INGEST_FIXTURES only ever captures a fixture once, before kickoff (see run-due.ts); nothing else
 * re-fetches it afterward. Left alone, a fixture that has actually finished stays SCHEDULED in the
 * database forever, and settleResults would treat its ticket as permanently pending. This targets
 * only fixtures that are actually blocking a real settlement decision (an unlocked, unsettled
 * ticket leg) rather than refreshing every stale row in the database.
 */
export async function refreshPendingResults(now: Date, client: Pick<ApiFootballClient, "getPaged"> = new ApiFootballClient()): Promise<{ refreshed: number }> {
  const staleFixtures = await db.fixture.findMany({
    where: {
      status: { in: ["SCHEDULED", "LIVE"] },
      kickoff: { lt: now },
      ticketLegs: { some: { ticketVersion: { lockAt: { lte: now }, settlements: { none: {} }, successors: { none: {} } } } }
    },
    select: { providerId: true }
  });
  if (staleFixtures.length === 0) return { refreshed: 0 };

  let refreshed = 0;
  for (let i = 0; i < staleFixtures.length; i += REFRESH_BATCH_SIZE) {
    const batch = staleFixtures.slice(i, i + REFRESH_BATCH_SIZE);
    const records = await client.getPaged("/fixtures", { ids: batch.map((fixture) => fixture.providerId).join("-") });
    const result = await ingestFixtures(records);
    refreshed += result.ingested;
  }
  return { refreshed };
}

// Kickoff + 90 min + half-time + stoppage/extra time/penalties comfortably fits in 3 hours.
const MATCH_FINISH_BUFFER_MS = 3 * 60 * 60 * 1000;

/**
 * Operator catch-up for every past fixture still marked SCHEDULED/LIVE, not only ticket legs:
 * re-fetches one /fixtures?date= snapshot per affected UTC date (one request covers a whole day,
 * far cheaper in quota than /fixtures?ids= batches of 20), so the matches view and calibration
 * history reflect final scores too.
 */
export async function refreshStaleFixtures(now: Date, client: Pick<ApiFootballClient, "getPaged"> = new ApiFootballClient()): Promise<{ dates: string[]; refreshed: number; refreshedById: number }> {
  const staleWhere = { status: { in: ["SCHEDULED" as const, "LIVE" as const] }, kickoff: { lt: new Date(now.getTime() - MATCH_FINISH_BUFFER_MS) } };
  const stale = await db.fixture.findMany({ where: staleWhere, select: { kickoff: true } });
  const dates = [...new Set(stale.map((fixture) => fixture.kickoff.toISOString().slice(0, 10)))].sort();
  let refreshed = 0;
  for (const date of dates) {
    const records = await client.getPaged("/fixtures", { date });
    refreshed += (await ingestFixtures(records)).ingested;
  }

  // A fixture moved to another date drops out of its original day's snapshot; fetch those by id.
  const missed = await db.fixture.findMany({ where: { ...staleWhere, receivedAt: { lt: now } }, select: { providerId: true } });
  let refreshedById = 0;
  for (let i = 0; i < missed.length; i += REFRESH_BATCH_SIZE) {
    const batch = missed.slice(i, i + REFRESH_BATCH_SIZE);
    const records = await client.getPaged("/fixtures", { ids: batch.map((fixture) => fixture.providerId).join("-") });
    refreshedById += (await ingestFixtures(records)).ingested;
  }
  return { dates, refreshed, refreshedById };
}

// 45 + 15 half-time + 45 minutes: no match can reach full time sooner, so polling earlier only burns quota.
const EARLIEST_FINISH_MS = 105 * 60 * 1000;
// Recently kicked-off matches are re-checked every cron tick (5 min); the margin absorbs tick jitter.
const RECENT_WINDOW_MS = 3 * 60 * 60 * 1000;
const RECENT_RECHECK_MS = 4 * 60 * 1000;
// A pending ticket leg past that window (delayed, suspended mid-game) keeps a tighter cadence than
// the rest; untracked stragglers back off to hourly and drop out after LOOKBACK_MS (the daily
// SETTLE_RESULTS job and the settle-played CLI remain the catch-up for anything older).
const TICKET_LEG_RECHECK_MS = 15 * 60 * 1000;
const STRAGGLER_RECHECK_MS = 60 * 60 * 1000;
const LOOKBACK_MS = 48 * 60 * 60 * 1000;

/** Refresh published-ticket fixtures soon after kickoff so LIVE status and minutes stay current. */
export async function refreshLiveTicketFixtures(now: Date, client: Pick<ApiFootballClient, "getPaged"> = new ApiFootballClient()): Promise<{ requested: number; refreshed: number }> {
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);
  const fixtures = await db.fixture.findMany({
    where: {
      status: { in: ["SCHEDULED", "LIVE"] },
      kickoff: { gte: at(EARLIEST_FINISH_MS), lte: now },
      receivedAt: { lt: at(RECENT_RECHECK_MS) },
      ticketLegs: { some: { ticketVersion: { lockAt: { lte: now }, successors: { none: {} } } } }
    },
    orderBy: { kickoff: "asc" },
    select: { providerId: true }
  });

  let refreshed = 0;
  const providerIds = [...new Set(fixtures.map((fixture) => fixture.providerId))];
  for (let i = 0; i < providerIds.length; i += REFRESH_BATCH_SIZE) {
    const records = await client.getPaged("/fixtures", { ids: providerIds.slice(i, i + REFRESH_BATCH_SIZE).join("-") });
    refreshed += (await ingestFixtures(records)).ingested;
  }
  return { requested: providerIds.length, refreshed };
}

/**
 * Runs on every cron tick so a match is recorded as FINISHED (and any ticket it completes is
 * settled) within minutes of full time instead of waiting for the daily SETTLE_RESULTS job. Only
 * fixtures that could plausibly have finished are requested, ticket legs first.
 */
export async function refreshFinishedFixtures(now: Date, client: Pick<ApiFootballClient, "getPaged"> = new ApiFootballClient()): Promise<{ requested: number; refreshed: number }> {
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);
  const open = { status: { in: ["SCHEDULED" as const, "LIVE" as const] }, kickoff: { lte: at(EARLIEST_FINISH_MS) } };
  const recent = { kickoff: { gte: at(RECENT_WINDOW_MS) }, receivedAt: { lt: at(RECENT_RECHECK_MS) } };

  const ticketLegs = await db.fixture.findMany({
    where: {
      ...open,
      ticketLegs: { some: { ticketVersion: { lockAt: { lte: now }, settlements: { none: {} }, successors: { none: {} } } } },
      OR: [recent, { receivedAt: { lt: at(TICKET_LEG_RECHECK_MS) } }]
    },
    orderBy: { kickoff: "asc" }, select: { providerId: true }
  });
  const others = await db.fixture.findMany({
    where: { ...open, OR: [recent, { kickoff: { gte: at(LOOKBACK_MS) }, receivedAt: { lt: at(STRAGGLER_RECHECK_MS) } }] },
    orderBy: { kickoff: "desc" }, select: { providerId: true }
  });
  const providerIds = [...new Set([...ticketLegs, ...others].map((fixture) => fixture.providerId))];

  let refreshed = 0;
  for (let i = 0; i < providerIds.length; i += REFRESH_BATCH_SIZE) {
    const records = await client.getPaged("/fixtures", { ids: providerIds.slice(i, i + REFRESH_BATCH_SIZE).join("-") });
    refreshed += (await ingestFixtures(records)).ingested;
  }
  return { requested: providerIds.length, refreshed };
}

export async function settleResults(now: Date): Promise<{ settled: number; pending: number }> {
  const candidates = await db.ticketVersion.findMany({
    where: { lockAt: { lte: now }, settlements: { none: {} }, successors: { none: {} } },
    include: { legs: { include: { fixture: true } } }
  });

  let settled = 0; let pending = 0;
  for (const ticket of candidates) {
    const evidence = ticket.legs.map((leg) => ({
      fixtureId: leg.fixtureId, marketKey: leg.marketKey, selection: leg.selection,
      status: leg.fixture.status, homeGoals: leg.fixture.homeGoals, awayGoals: leg.fixture.awayGoals,
      result: leg.fixture.status === "FINISHED" ? resolveSelection(leg.marketKey, leg.selection, leg.fixture.homeGoals!, leg.fixture.awayGoals!) : null
    }));
    // One losing leg beats the whole acca, so it settles LOSS at once without waiting for (or being
    // voided by) the legs still to play.
    const lost = evidence.some((leg) => leg.result === "LOSS");
    const unresolved = ticket.legs.some((leg) => leg.fixture.status === "SCHEDULED" || leg.fixture.status === "LIVE");
    if (unresolved && !lost) { pending += 1; continue; }

    const voided = ticket.legs.some((leg) => leg.fixture.status === "POSTPONED" || leg.fixture.status === "CANCELLED");
    let outcome: "WIN" | "LOSS" | "VOID";
    let profitUnits: number;
    if (lost) {
      outcome = "LOSS"; profitUnits = -1;
    } else if (voided) {
      outcome = "VOID"; profitUnits = 0;
    } else {
      const allWin = evidence.every((leg) => leg.result === "WIN");
      outcome = allWin ? "WIN" : "LOSS";
      profitUnits = allWin ? Number(ticket.combinedOdds) - 1 : -1;
    }

    await db.settlement.create({ data: { ticketVersionId: ticket.id, outcome, profitUnits, settledAt: now, evidence: evidence as unknown as object } });
    settled += 1;
  }
  return { settled, pending };
}
