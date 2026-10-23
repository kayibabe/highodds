import { db } from "@highodds/db";
import { buildTicketsAround, conservativeExpectedValue, devigProbability, isGuardedAwayWin, legEligibility, legEligibilityForTier, modelImpliedEdge, quoteIsFresh, SELECTION_WINDOW_HOURS, TICKET_TIERS, type CandidateLeg, type SupportedMarket, type TicketTier } from "@highodds/core";
import { generatePredictions } from "./predict.js";

const SELECTION_WINDOW_MS = SELECTION_WINDOW_HOURS * 60 * 60 * 1000;

const MARKET_OUTCOME_COUNT: Record<SupportedMarket, number> = { MATCH_WINNER: 3, TOTAL_GOALS: 2, BTTS: 2 };
const TOTAL_GOALS_RULE_KEY = "TOTAL_GOALS_ODDS_1_80_V1";
const TOTAL_GOALS_RULE_MIN_ODDS = 1.8;
/** Bump only when the candidate construction or selection policy changes materially. */
const CANDIDATE_SNAPSHOT_POLICY_VERSION = "acca-away-tier-guard-v2";

export interface PublishResult { published: number; predicted: number; predictionsSkipped: number; }

export async function publishTickets(now: Date): Promise<PublishResult> {
  const targetDate = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (await db.ticketVersion.findFirst({ where: { targetDate }, select: { id: true } })) {
    return { published: 0, predicted: 0, predictionsSkipped: 0 };
  }
  const forecast = await generatePredictions(now);
  const result = (published: number): PublishResult => ({ published, predicted: forecast.predicted, predictionsSkipped: forecast.skipped });
  const windowEnd = new Date(now.getTime() + SELECTION_WINDOW_MS);
  const fixtures = await db.fixture.findMany({
    where: { status: "SCHEDULED", kickoff: { gte: now, lte: windowEnd } },
    select: { id: true, competitionId: true, kickoff: true }
  });
  if (fixtures.length === 0) return result(0);
  const fixtureIds = fixtures.map((fixture) => fixture.id);
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));

  const activeBookmakers = await db.bookmaker.findMany({ where: { active: true }, orderBy: { priority: "asc" } });
  if (activeBookmakers.length === 0) return result(0);
  const bookmakerPriority = activeBookmakers.map((bookmaker) => bookmaker.id);

  const markets = await db.market.findMany({ where: { normalizedKey: { not: null } }, select: { id: true, normalizedKey: true } });
  const marketKeyById = new Map(markets.map((market) => [market.id, market.normalizedKey as SupportedMarket]));

  const quotes = await db.oddsQuote.findMany({
    where: { fixtureId: { in: fixtureIds }, marketId: { in: markets.map((m) => m.id) }, bookmakerId: { in: bookmakerPriority } },
    orderBy: { capturedAt: "desc" },
    distinct: ["fixtureId", "bookmakerId", "marketId", "selection"]
  });
  const freshQuotes = quotes.filter((quote) => {
    const fixture = fixtureById.get(quote.fixtureId);
    return fixture ? quoteIsFresh({ capturedAt: quote.capturedAt }, fixture.kickoff, now) : false;
  });
  if (freshQuotes.length === 0) return result(0);

  const predictions = await db.prediction.findMany({
    where: { stage: "SELECTION", fixtureId: { in: fixtureIds }, marketId: { in: markets.map((m) => m.id) } },
    orderBy: { asOfAt: "desc" },
    distinct: ["fixtureId", "marketId", "selection"]
  });
  const predictionKey = (fixtureId: string, marketId: string, selection: string) => `${fixtureId}:${marketId}:${selection}`;
  const predictionByKey = new Map(predictions.map((prediction) => [predictionKey(prediction.fixtureId, prediction.marketId, prediction.selection), prediction]));

  // Lock the prospective Total Goals cohort once per fixture. The unique key and skipDuplicates
  // make this idempotent if the runner retries after the daily job has already captured prices.
  const totalGoalsMarketIds = new Set(markets.filter((market) => market.normalizedKey === "TOTAL_GOALS").map((market) => market.id));
  const priorityByBookmaker = new Map(activeBookmakers.map((bookmaker, index) => [bookmaker.id, index]));
  const totalGoalsQuotes = new Map<string, typeof freshQuotes[number]>();
  for (const quote of freshQuotes) {
    if (!totalGoalsMarketIds.has(quote.marketId)) continue;
    const key = `${quote.fixtureId}:${quote.selection}`;
    const current = totalGoalsQuotes.get(key);
    const currentRank = current ? priorityByBookmaker.get(current.bookmakerId) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
    const quoteRank = priorityByBookmaker.get(quote.bookmakerId) ?? Number.MAX_SAFE_INTEGER;
    if (!current || quoteRank < currentRank || (quoteRank === currentRank && quote.capturedAt > current.capturedAt)) totalGoalsQuotes.set(key, quote);
  }
  const totalGoalsPickByFixture = new Map<string, { prediction: (typeof predictions)[number]; quote: (typeof freshQuotes)[number] }>();
  for (const prediction of predictions) {
    if (!totalGoalsMarketIds.has(prediction.marketId)) continue;
    const quote = totalGoalsQuotes.get(`${prediction.fixtureId}:${prediction.selection}`);
    if (!quote || Number(quote.decimalOdds) < TOTAL_GOALS_RULE_MIN_ODDS) continue;
    const current = totalGoalsPickByFixture.get(prediction.fixtureId);
    if (!current || Number(prediction.probability) > Number(current.prediction.probability)) totalGoalsPickByFixture.set(prediction.fixtureId, { prediction, quote });
  }
  if (totalGoalsPickByFixture.size > 0) {
    await db.validationPick.createMany({
      data: [...totalGoalsPickByFixture.values()].map(({ prediction, quote }) => ({
        ruleKey: TOTAL_GOALS_RULE_KEY, fixtureId: prediction.fixtureId, marketKey: "TOTAL_GOALS", selection: prediction.selection,
        probability: prediction.probability, decimalOdds: quote.decimalOdds, quoteId: quote.id, capturedAt: quote.capturedAt
      })),
      skipDuplicates: true
    });
  }

  // Devig consensus probability per (fixture, market, selection) averaged across bookmakers offering that market.
  const byFixtureBookmakerMarket = new Map<string, typeof freshQuotes>();
  for (const quote of freshQuotes) {
    const groupKey = `${quote.fixtureId}:${quote.bookmakerId}:${quote.marketId}`;
    const group = byFixtureBookmakerMarket.get(groupKey) ?? [];
    group.push(quote);
    byFixtureBookmakerMarket.set(groupKey, group);
  }
  const consensusSum = new Map<string, { sum: number; count: number }>();
  for (const group of byFixtureBookmakerMarket.values()) {
    const marketKey = marketKeyById.get(group[0]!.marketId);
    if (!marketKey) continue;
    const uniqueSelections = new Set(group.map((quote) => quote.selection));
    if (uniqueSelections.size < MARKET_OUTCOME_COUNT[marketKey]) continue; // partial market: devigging would misprice the missing outcome as impossible
    const allOdds = group.map((quote) => Number(quote.decimalOdds));
    for (const quote of group) {
      const devigged = devigProbability(Number(quote.decimalOdds), allOdds);
      const key = predictionKey(quote.fixtureId, quote.marketId, quote.selection);
      const running = consensusSum.get(key) ?? { sum: 0, count: 0 };
      running.sum += devigged; running.count += 1;
      consensusSum.set(key, running);
    }
  }

  // quoteId is retained only until the immutable candidate-universe snapshot is written. The core
  // selector sees the normal CandidateLeg shape and cannot depend on database identifiers.
  const candidates: Array<CandidateLeg & { quoteId: string }> = [];
  for (const quote of freshQuotes) {
    const marketKey = marketKeyById.get(quote.marketId);
    if (!marketKey) continue;
    const fixture = fixtureById.get(quote.fixtureId);
    if (!fixture) continue;
    const key = predictionKey(quote.fixtureId, quote.marketId, quote.selection);
    const prediction = predictionByKey.get(key);
    const consensus = consensusSum.get(key);
    if (!prediction || !consensus) continue;
    const modelProbability = Number(prediction.probability);
    const consensusProbability = consensus.sum / consensus.count;
    const decimalOdds = Number(quote.decimalOdds);
    const agreement = Math.min(modelProbability, consensusProbability) / Math.max(modelProbability, consensusProbability);
    candidates.push({
      bookmakerId: quote.bookmakerId, fixtureId: quote.fixtureId, market: marketKey, selection: quote.selection,
      decimalOdds, capturedAt: quote.capturedAt, modelProbability, consensusProbability,
      conservativeExpectedValue: conservativeExpectedValue(modelProbability, decimalOdds), confidenceScore: Math.round(agreement * 100),
      leagueId: fixture.competitionId, kickoff: fixture.kickoff, quoteId: quote.id
    });
  }
  if (candidates.length === 0) return result(0);

  const liveVersions = await db.ticketVersion.findMany({
    where: { targetDate, successors: { none: {} } },
    orderBy: { publishedAt: "desc" },
    include: { legs: { select: { fixtureId: true } } }
  });
  const openByTier = new Map<TicketTier["key"], (typeof liveVersions)[number]>();
  for (const version of liveVersions) if (!openByTier.has(version.tier)) openByTier.set(version.tier, version);

  // Tiers never share a fixture, including with today's tickets that stay live (locked, or not replaced).
  const drafts = buildTicketsAround(candidates, bookmakerPriority, now, [...openByTier.values()].map((version) => ({
    tier: version.tier, locked: true, fixtureIds: version.legs.map((leg) => leg.fixtureId)
  })));
  if (drafts.length === 0) return result(0);

  // This is the prospective comparison denominator. It includes every candidate that had a
  // contemporaneous prediction, complete de-vigged market and fresh captured quote—not just the
  // legs ultimately selected for a ticket. It is intentionally only written alongside a real
  // publication decision; old tickets are not backfilled from hindsight data.
  const selected = new Map<string, { tier: TicketTier["key"]; confidenceThreshold: number }>();
  const candidateKey = (candidate: Pick<CandidateLeg, "fixtureId" | "bookmakerId" | "market" | "selection">) =>
    `${candidate.fixtureId}:${candidate.bookmakerId}:${candidate.market}:${candidate.selection}`;
  for (const draft of drafts) for (const leg of draft.legs) {
    selected.set(candidateKey(leg), { tier: draft.tier.key, confidenceThreshold: draft.confidenceThreshold });
  }
  let published = 0;

  // A snapshot is evidence for precisely the ticket versions that committed with it. Keeping all
  // versions, legs and their snapshot in one transaction prevents a retry/failure from presenting
  // an intended-but-never-published leg as selected in the research denominator.
  await db.$transaction(async (tx) => {
    // A daily publication is immutable even before kickoff. Recheck under a
    // transaction lock so simultaneous workers cannot publish competing sets.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`highodds:daily-tickets:${targetDate.toISOString()}`}))`;
    const retained = await tx.ticketVersion.findFirst({ where: { targetDate }, select: { id: true } });
    if (retained) return;
    const snapshot = await tx.candidateSnapshotRun.create({
      data: {
        targetDate, capturedAt: now, policyVersion: CANDIDATE_SNAPSHOT_POLICY_VERSION,
        candidates: {
          create: candidates.map((candidate) => {
            const selection = selected.get(candidateKey(candidate));
            return {
              fixtureId: candidate.fixtureId, quoteId: candidate.quoteId, marketKey: candidate.market, selection: candidate.selection,
              decimalOdds: candidate.decimalOdds, modelProbability: candidate.modelProbability,
              consensusProbability: candidate.consensusProbability, confidenceScore: candidate.confidenceScore,
              conservativeExpectedValue: candidate.conservativeExpectedValue,
              baseEligibilityReason: legEligibility(candidate, now).reason ?? null,
              tierEligibility: Object.fromEntries(TICKET_TIERS.map((tier) => [tier.key, legEligibilityForTier(candidate, tier, now).reason ?? null])),
              selected: selection !== undefined, ticketTier: selection?.tier ?? null,
              confidenceThreshold: selection?.confidenceThreshold ?? null
            };
          })
        }
      },
      select: { id: true }
    });
    for (const draft of drafts) {
      const open = openByTier.get(draft.tier.key);
      if (open && open.lockAt <= now) continue; // defensive: buildTicketsAround never drafts a locked tier
      const lockAt = draft.legs.reduce((earliest, leg) => (leg.kickoff < earliest ? leg.kickoff : earliest), draft.legs[0]!.kickoff);
      const version = await tx.ticketVersion.create({
        data: {
          targetDate, tier: draft.tier.key, bookmakerId: draft.bookmakerId, combinedOdds: draft.combinedOdds,
          confidenceThreshold: draft.confidenceThreshold, relaxed: draft.relaxed, lockAt,
          supersedesId: open?.id ?? null, candidateSnapshotRunId: snapshot.id,
          decision: draft.legs.map((leg) => ({
            fixtureId: leg.fixtureId, market: leg.market, selection: leg.selection, decimalOdds: leg.decimalOdds,
            modelProbability: leg.modelProbability, consensusProbability: leg.consensusProbability, confidenceScore: leg.confidenceScore,
            modelImpliedEdge: modelImpliedEdge(leg),
            selectionGuard: isGuardedAwayWin(leg) ? "AWAY_WIN_1_80_1_99_MIN_MODEL_EDGE_5PP" : null
          })) as unknown as object
        }
      });
      for (const leg of draft.legs) {
        const quote = freshQuotes.find((q) => q.fixtureId === leg.fixtureId && q.bookmakerId === leg.bookmakerId && q.selection === leg.selection && marketKeyById.get(q.marketId) === leg.market);
        if (!quote) throw new Error(`Missing source quote for leg ${leg.fixtureId}/${leg.selection}`);
        await tx.ticketLeg.create({ data: { ticketVersionId: version.id, fixtureId: leg.fixtureId, quoteId: quote.id, marketKey: leg.market, selection: leg.selection, decimalOdds: leg.decimalOdds, probability: leg.modelProbability } });
      }
      published += 1;
    }
  }, { timeout: 15_000 });
  return result(published);
}
