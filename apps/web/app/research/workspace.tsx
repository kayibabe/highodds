import Link from "next/link";
import { FixtureCalendar } from "../fixture-calendar";
import { db } from "@highodds/db";
import { blantyreDayBounds, blantyreToday, displayLegOutcome, forecastStageLabel, highProbabilityPick, historicalScreenerSweetSpot, MODEL_PICK_FILTERS, modelPickFilter, parseIsoDay, parseSettlementEvidence, preferSelectionForecasts, PROBABILITY_THRESHOLDS, resolveDayRange, resolveSelection, type StoredPrediction } from "@highodds/core";
import { DayNav, formatDay, RangeNav, rangeLabel } from "../date-nav";
import { ResearchMoneyCell, ResearchPerformanceSummary, ResearchStakeInput } from "../research-performance";
import { EVIDENCE_WINDOW_DAYS, forecastEvidence } from "@highodds/core";
import { loadForecastEvidence } from "../../lib/forecast-evidence";
import { resolveResearchQuote } from "../../lib/research-odds";
import { loadResearchDecisionPrices } from "../../lib/research-decision-prices";
import { legOutcome, summarizeResearchRows } from "@highodds/core";

export const dynamic = "force-dynamic";

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const dateTime = (value: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Blantyre", dateStyle: "medium", timeStyle: "short" }).format(value);
const label = (value: string) => value.replaceAll("_", " ");
const marketLabel = (value: string) => ({ TOTAL_GOALS: "Total goals", MATCH_WINNER: "Match winner", BTTS: "Both teams score" }[value] ?? label(value));
const selectionLabel = (value: string) => ({ UNDER_2_5: "Under 2.5", OVER_2_5: "Over 2.5", HOME: "Home", DRAW: "Draw", AWAY: "Away", YES: "Yes", NO: "No" }[value] ?? label(value));
const score = (fixture: { homeGoals: number | null; awayGoals: number | null }) => fixture.homeGoals !== null && fixture.awayGoals !== null ? `${fixture.homeGoals}–${fixture.awayGoals}` : null;
const LEG_OUTCOME_LABEL: Record<string, string> = { WIN: "Won", LOSS: "Lost", VOID: "Void", PENDING: "Pending", UNRESOLVED: "Unresolved" };
const HIGH_PROBABILITY_THRESHOLD = 0.6;
const SCREEN_MARKETS = ["TOTAL_GOALS", "MATCH_WINNER", "BTTS"] as const;
const SCREEN_SELECTIONS = ["UNDER_2_5", "OVER_2_5", "HOME", "DRAW", "AWAY", "YES", "NO"] as const;

const fixtureInclude = {
  competition: true, homeTeam: true, awayTeam: true,
  predictions: { orderBy: { asOfAt: "desc" as const }, include: { market: true, modelRun: true } },
  quotes: { orderBy: { capturedAt: "desc" as const }, take: 100, include: { bookmaker: true, market: true } }
};
const highProbabilityFixtureInclude = {
  competition: true, homeTeam: true, awayTeam: true,
  predictions: { where: { stage: "SELECTION" as const }, orderBy: [{ asOfAt: "desc" as const }, { id: "asc" as const }], include: { market: true, modelRun: { select: { trainedUntil: true, createdAt: true, method: true } } } }
};

function resultHeadline(fixture: { status: string; statusCode: string | null; elapsedMinute: number | null; homeGoals: number | null; awayGoals: number | null }): string {
  const line = score(fixture);
  if (fixture.status === "FINISHED") return line ? `Full time · ${line}` : "Finished · score not recorded";
  if (fixture.status === "LIVE") return `In play${fixture.elapsedMinute === null ? "" : ` · ${fixture.elapsedMinute}′`}${line ? ` · ${line}` : ""}`;
  if (line) return `Score recorded · ${line}`;
  if (fixture.status === "POSTPONED") return "Postponed · markets void";
  if (fixture.status === "CANCELLED") return "Cancelled · markets void";
  return "Not started";
}

function numberParam(value: string | string[] | undefined, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanScreenValue(value: string | string[] | undefined, allowed: readonly string[], fallback: string): string {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

export type ResearchSearchParams = {
  fixture?: string | string[]; date?: string | string[]; range?: string | string[]; from?: string | string[]; to?: string | string[]; screen?: string | string[]; market?: string | string[];
  selection?: string | string[]; pick?: string | string[]; minProbability?: string | string[]; minOdds?: string | string[]; maxQuoteAge?: string | string[]; stake?: string | string[]; pricedOnly?: string | string[];
  summaryRange?: string | string[]; summaryFrom?: string | string[]; summaryTo?: string | string[];
};

export default async function ResearchWorkspace({ searchParams, view }: {
  searchParams: Promise<ResearchSearchParams>; view: "fixture" | "screener" | "history";
}) {
  const params = await searchParams;
  const { fixture: fixtureParam, date } = params;
  const fixtureId = typeof fixtureParam === "string" ? fixtureParam : undefined;
  const screening = view === "screener";
  const legacyMarket = cleanScreenValue(params.market, SCREEN_MARKETS, "TOTAL_GOALS");
  const legacySelection = cleanScreenValue(params.selection, SCREEN_SELECTIONS, "UNDER_2_5");
  const legacyPick = MODEL_PICK_FILTERS.find((filter) => filter.market === legacyMarket && filter.selection === legacySelection)?.value ?? "ALL";
  const modelFilter = modelPickFilter(typeof params.pick === "string" ? params.pick : legacyPick);
  const minProbability = Math.min(1, Math.max(0, numberParam(params.minProbability, 60) / 100));
  const minOdds = Math.max(1, numberParam(params.minOdds, 1.8));
  const maxQuoteAge = Math.max(0, numberParam(params.maxQuoteAge, 0));
  const stakePerSelection = Math.min(1_000_000, Math.max(0.01, numberParam(params.stake, 1)));
  const pricedOnly = params.pricedOnly === "1" || params.pricedOnly === "on";
  const now = new Date();
  const today = blantyreToday(now);
  const day = parseIsoDay(date) ?? (view === "fixture" ? today : null);
  const range = resolveDayRange(params, today, "30d");
  const rangeBounds = range.from && range.to ? { start: blantyreDayBounds(range.from).start, end: blantyreDayBounds(range.to).end } : null;
  const summaryRange = resolveDayRange({ range: params.summaryRange, from: params.summaryFrom, to: params.summaryTo }, today, "30d");
  const summaryBounds = { start: summaryRange.from ? blantyreDayBounds(summaryRange.from).start : undefined, end: blantyreDayBounds(summaryRange.to ?? today).end };

  // Inspector includes every pulled fixture, even before a forecast exists. Historical
  // screeners keep their evidence-only universe for retrospective performance.
  const fixtures = view !== "history" ? await db.fixture.findMany({
    where: screening
      ? { ...(rangeBounds ? { kickoff: { gte: rangeBounds.start, lt: rangeBounds.end } } : {}), OR: [{ predictions: { some: { stage: "SELECTION" } } }, { ticketLegs: { some: {} } }] }
      : day
      ? { kickoff: { gte: blantyreDayBounds(day).start, lt: blantyreDayBounds(day).end } }
      : { kickoff: { gte: new Date(now.getTime() - 12 * 60 * 60 * 1000) }, predictions: { some: {} } },
    orderBy: [{ kickoff: "asc" }, { id: "asc" }],
    include: screening ? { ...fixtureInclude, predictions: { ...fixtureInclude.predictions, where: { stage: "SELECTION" } } } : fixtureInclude
  }) : [];
  const selected = view === "fixture" ? fixtures.find((fixture) => fixture.id === fixtureId)
    ?? (fixtureId ? await db.fixture.findUnique({ where: { id: fixtureId }, include: fixtureInclude }) : null)
    ?? fixtures[0] : undefined;

  // Batch every matching fixture; a display limit must never change the performance denominator.
  const summaryFixtures = view === "history" ? await db.$transaction(async tx => {
    const rows = [];
    let cursor: string | undefined;
    for (;;) {
      const batch = await tx.fixture.findMany({
        where: { kickoff: { ...(summaryBounds.start ? { gte: summaryBounds.start } : {}), lt: summaryBounds.end }, predictions: { some: { stage: "SELECTION" } } },
        orderBy: { id: "asc" }, take: 500, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: highProbabilityFixtureInclude
      });
      rows.push(...batch);
      if (batch.length < 500) break;
      cursor = batch[batch.length - 1]!.id;
    }
    return rows.sort((a,b) => b.kickoff.getTime() - a.kickoff.getTime() || b.id.localeCompare(a.id));
  }, { isolationLevel: "RepeatableRead", maxWait: 15_000, timeout: 60_000 }) : [];

  const highProbabilityRows = summaryFixtures.flatMap((fixture) => {
    const latestByMarketSelection = new Map<string, (typeof fixture.predictions)[number]>();
    fixture.predictions
      .filter((row) => row.asOfAt < fixture.kickoff && row.modelRun.trainedUntil <= row.asOfAt)
      .forEach((row) => {
        const key = `${row.market.normalizedKey ?? row.market.name}:${row.selection}`;
        const current = latestByMarketSelection.get(key);
        if (!current || row.asOfAt > current.asOfAt) latestByMarketSelection.set(key, row);
      });

    const byMarket = new Map<string, (typeof fixture.predictions)[number][]>();
    for (const prediction of latestByMarketSelection.values()) {
      const market = prediction.market.normalizedKey ?? prediction.market.name;
      const rows = byMarket.get(market) ?? [];
      rows.push(prediction);
      byMarket.set(market, rows);
    }

    const marketPicks = Array.from(byMarket.entries()).flatMap(([market, rows]) => {
      const pick = rows.reduce((best, row) => Number(row.probability) > Number(best.probability) ? row : best);
      return Number(pick.probability) >= HIGH_PROBABILITY_THRESHOLD ? [{ market, pick }] : [];
    });
    const strongest = marketPicks.reduce<(typeof marketPicks)[number] | undefined>((best, row) => !best || Number(row.pick.probability) > Number(best.pick.probability) ? row : best, undefined);
    if (!strongest) return [];
    const finishedScore = fixture.status === "FINISHED" && fixture.homeGoals !== null && fixture.awayGoals !== null
        ? { home: fixture.homeGoals, away: fixture.awayGoals }
        : null;
    const outcome = finishedScore ? resolveSelection(strongest.market, strongest.pick.selection, finishedScore.home, finishedScore.away) : null;
    return [{ fixture, market: strongest.market, pick: strongest.pick, outcome }];
  });
  const historyPrices = await loadResearchDecisionPrices(highProbabilityRows.map(row => row.pick.id));

  const screenCandidates = screening ? fixtures.flatMap((fixture) => {
    const pick = highProbabilityPick(fixture.predictions.map((row) => ({
      marketKey: row.market.normalizedKey ?? row.market.name, selection: row.selection, probability: Number(row.probability),
      asOfAt: row.asOfAt, trainedUntil: row.modelRun.trainedUntil
    } satisfies StoredPrediction & { trainedUntil: Date })), fixture.kickoff, now, 0, modelFilter);
    if (!pick || pick.probability < minProbability) return [];
    const quote = resolveResearchQuote(fixture.quotes, {
      marketKey: pick.marketKey!, selection: pick.selection, kickoff: fixture.kickoff,
      ...(maxQuoteAge ? { maxQuoteAgeMinutes: maxQuoteAge } : {}), mode: "historical"
    });
    if (pricedOnly && !quote) return [];
    if (quote && Number(quote.decimalOdds) < minOdds) return [];
    return [{ fixture, marketKey: pick.marketKey!, selection: pick.selection, probability: pick.probability, odds: quote ? Number(quote.decimalOdds) : null, bookmaker: quote?.bookmaker.name ?? null, quoteCapturedAt: quote?.capturedAt ?? null, predictionAsOfAt: pick.asOfAt, trainedUntil: pick.trainedUntil }];
  }) : [];
  const sweetSpotRows = screening ? fixtures.flatMap((fixture) => {
    if (fixture.homeGoals === null || fixture.awayGoals === null) return [];
    const pick = highProbabilityPick(fixture.predictions.map((row) => ({
      marketKey: row.market.normalizedKey ?? row.market.name, selection: row.selection, probability: Number(row.probability),
      asOfAt: row.asOfAt, trainedUntil: row.modelRun.trainedUntil
    } satisfies StoredPrediction & { trainedUntil: Date })), fixture.kickoff, now, 0);
    if (!pick) return [];
    const outcome = resolveSelection(pick.marketKey!, pick.selection, fixture.homeGoals, fixture.awayGoals);
    if (outcome === null) return [];
    const quotes = fixture.quotes.filter((quote) => quote.bookmaker.active && quote.capturedAt < fixture.kickoff
      && (quote.market.normalizedKey ?? quote.market.name) === pick.marketKey && quote.selection === pick.selection)
      .map((quote) => ({ odds: Number(quote.decimalOdds), quoteAgeMinutes: (fixture.kickoff.getTime() - quote.capturedAt.getTime()) / 60_000 }));
    return [{ marketKey: pick.marketKey!, selection: pick.selection, probability: pick.probability, win: outcome === "WIN", quotes }];
  }) : [];
  const screenerSweetSpot = historicalScreenerSweetSpot(sweetSpotRows);

  const selectedFixture = selected;

  const probabilityGroups = selectedFixture && preferSelectionForecasts(selectedFixture.predictions.filter((row) => row.asOfAt < selectedFixture.kickoff && row.asOfAt <= now && row.modelRun.trainedUntil <= row.asOfAt)).reduce((groups, prediction) => {
    if (prediction.asOfAt >= selectedFixture.kickoff || prediction.asOfAt > now || prediction.modelRun.trainedUntil > prediction.asOfAt) return groups;
    const key = prediction.market.normalizedKey ?? prediction.market.name;
    const rows = groups.get(key) ?? [];
    if (!rows.some((row) => row.selection === prediction.selection)) rows.push(prediction);
    groups.set(key, rows);
    return groups;
  }, new Map<string, NonNullable<typeof selectedFixture>["predictions"]>());

  const finalScore = selectedFixture && selectedFixture.homeGoals !== null && selectedFixture.awayGoals !== null
    ? { home: selectedFixture.homeGoals, away: selectedFixture.awayGoals } : null;
  const marketResults = Array.from(probabilityGroups?.entries() ?? []).map(([market, rows]) => {
    const outcomes = rows.map((row) => ({ row, hit: finalScore ? resolveSelection(market, row.selection, finalScore.home, finalScore.away) === "WIN" : null }));
    const pick = rows.reduce<(typeof rows)[number] | undefined>((best, row) => !best || Number(row.probability) > Number(best.probability) ? row : best, undefined);
    const resolvable = outcomes.every((item) => item.hit !== null) && outcomes.some((item) => item.hit);
    const brier = finalScore && resolvable ? outcomes.reduce((sum, item) => sum + (Number(item.row.probability) - Number(item.hit)) ** 2, 0) / outcomes.length : null;
    return { market, rows, outcomes, pick, pickHit: pick ? outcomes.find((item) => item.row === pick)?.hit ?? null : null, brier, winner: outcomes.find((item) => item.hit)?.row ?? null };
  });

  const evidenceRows = await loadForecastEvidence(selectedFixture ? marketResults.flatMap(({ rows }) => rows.map((row) => ({
    fixtureId: selectedFixture.id, competitionId: selectedFixture.competitionId, forecastAt: row.asOfAt
  }))) : []);

  const ticketLegs = selectedFixture ? await db.ticketLeg.findMany({
    where: { fixtureId: selectedFixture.id, ticketVersion: { successors: { none: {} } } },
    include: { ticketVersion: { include: { settlements: true } } },
    orderBy: { ticketVersion: { tier: "asc" } }
  }) : [];

  const bestMarketResult = marketResults
    .filter((item) => item.pick)
    .sort((a, b) => Number(b.pick!.probability) - Number(a.pick!.probability))[0];
  const bestPick = bestMarketResult?.pick;
  const bestQuote = selectedFixture && bestPick
    ? resolveResearchQuote(selectedFixture.quotes, {
      marketKey: bestMarketResult.market, selection: bestPick.selection, kickoff: selectedFixture.kickoff,
      mode: "historical"
    })
    : null;
  const bestOdds = bestQuote ? Number(bestQuote.decimalOdds) : null;
  const bestImplied = bestOdds && bestOdds > 0 ? 1 / bestOdds : null;
  const bestEdge = bestImplied === null || !bestPick ? null : Number(bestPick.probability) - bestImplied;
  const publishedBest = bestPick && selectedFixture
    ? ticketLegs.some((leg) => leg.marketKey === bestMarketResult!.market && leg.selection === bestPick.selection)
    : false;
  const verdict = publishedBest ? "BET" : bestPick ? "WATCH" : "PASS";
  const verdictReason = verdict === "BET"
    ? "This selection is present on a published paper ticket."
    : verdict === "WATCH"
      ? "A model signal exists, but it is not a published paper selection."
      : "No pre-kickoff model selection is available for this fixture.";

  const candidateResults = screenCandidates.map((candidate) => {
    const fixture = candidate.fixture;
    const finished = fixture.status === "FINISHED" && fixture.homeGoals !== null && fixture.awayGoals !== null;
    const outcome = finished ? resolveSelection(candidate.marketKey, candidate.selection, fixture.homeGoals!, fixture.awayGoals!) : null;
    const voided = fixture.status === "POSTPONED" || fixture.status === "CANCELLED";
    const result = voided ? "VOID" : outcome ?? "PENDING";
    const profitUnits = candidate.odds === null ? null : result === "WIN" ? candidate.odds - 1 : result === "LOSS" ? -1 : result === "VOID" ? 0 : null;
    return { ...candidate, result, profitUnits };
  });
  const settledCandidates = candidateResults.filter((candidate) => candidate.profitUnits !== null);
  const wins = settledCandidates.filter((candidate) => candidate.result === "WIN").length;
  const losses = settledCandidates.filter((candidate) => candidate.result === "LOSS").length;
  const voids = settledCandidates.filter((candidate) => candidate.result === "VOID").length;
  const pending = candidateResults.length - settledCandidates.length;
  const settledCount = settledCandidates.length;
  const returnsPerUnit = settledCandidates.reduce((sum, candidate) => sum + (candidate.result === "WIN" && candidate.odds !== null ? candidate.odds : 0), 0);
  const netPerUnit = settledCandidates.reduce((sum, candidate) => sum + candidate.profitUnits!, 0);
  const roi = settledCount > 0 ? netPerUnit / settledCount * 100 : null;
  const listHref = (id: string) => `/research?${new URLSearchParams({ fixture: id, ...(day ? { date: day } : {}) })}`;
  const dateKey = (value: Date) => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Blantyre", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  };
  const highProbabilityGroups = new Map<string, Map<string, Map<string, typeof highProbabilityRows[number][]>>>();
  for (const row of highProbabilityRows) {
    const dayKey = dateKey(row.fixture.kickoff);
    const year = dayKey.slice(0, 4);
    const month = dayKey.slice(0, 7);
    const years = highProbabilityGroups.get(year) ?? new Map<string, Map<string, typeof highProbabilityRows[number][]>>();
    const months = years.get(month) ?? new Map<string, typeof highProbabilityRows[number][]>();
    const days = months.get(dayKey) ?? [];
    days.push(row);
    months.set(dayKey, days);
    years.set(month, months);
    highProbabilityGroups.set(year, years);
  }
  const summarizeSelectorRows = (rows: typeof highProbabilityRows) => {
    return summarizeResearchRows(rows.map(row => ({ probability: Number(row.pick.probability), odds: historyPrices.get(row.pick.id) ?? null, outcome: legOutcome(row.market, row.pick.selection, row.fixture) })));
  };
  const selectorSummaryRows = [
    ["MATCH_WINNER", ["HOME", "DRAW", "AWAY"]],
    ["BTTS", ["YES", "NO"]],
    ["TOTAL_GOALS", ["OVER_2_5", "UNDER_2_5"]]
  ] as const;
  const selectorOutcomeRows = selectorSummaryRows.flatMap(([market, selections]) => selections.map((selection) => ({
    market,
    selection,
    ...summarizeSelectorRows(highProbabilityRows.filter((row) => row.market === market && row.pick.selection === selection))
  })));
  const renderHighProbabilityTable = (rows: typeof highProbabilityRows) => <div className="matches-table-wrap"><table className="matches-table"><thead><tr><th>Match</th><th>Kickoff</th><th>Market</th><th>Model outcome</th><th>Probability</th><th>Result</th></tr></thead><tbody>{rows.map(({ fixture, market, pick, outcome }) => <tr key={`${fixture.id}-${market}`}>
    <th scope="row"><Link href={listHref(fixture.id)}>{fixture.homeTeam.name} vs {fixture.awayTeam.name}</Link><small>{fixture.competition.name}</small></th>
    <td>{dateTime(fixture.kickoff)}</td>
    <td>{marketLabel(market)}</td>
    <td>{selectionLabel(pick.selection)}</td>
    <td className="num">{pct(Number(pick.probability))}</td>
    <td>{outcome ? <span className={`status-badge ${outcome.toLowerCase()}`}>{outcome === "WIN" ? "Won" : "Lost"} · {score(fixture)}</span> : <span>{fixture.status === "CANCELLED" || fixture.status === "POSTPONED" ? "Void" : "Pending"}</span>}</td>
  </tr>)}</tbody></table></div>;

  return <section>
    <p className="eyebrow">RESEARCH WORKSPACE</p>
    <h1>{view === "fixture" ? "Fixture Inspector" : view === "screener" ? "Historical Screener" : "Forecast Archive"}</h1>
    <p className="page-intro">{view === "fixture" ? "Inspect one fixture from forecast to result: probabilities, captured prices, and settlement evidence." : view === "screener" ? "Compare historical pre-kickoff forecasts and captured prices, with outcomes and paper returns." : "Review the model's highest-probability selections and outcome hit rates over time."} Probabilities are model estimates, not validated edges or betting recommendations.</p>
    {screening ? <RangeNav basePath="/research/screener" range={range} today={today} params={{ screen: "1", pick: modelFilter.value, minProbability: String(Math.round(minProbability * 100)), minOdds: String(minOdds), stake: stakePerSelection.toFixed(2), ...(pricedOnly ? { pricedOnly: "1" } : {}), ...(maxQuoteAge ? { maxQuoteAge: String(maxQuoteAge) } : {}) }} /> : view === "fixture" ? <><FixtureCalendar now={now} basePath="/research" selectedDay={day} /><DayNav basePath="/research" day={day} today={today} allowFuture /></> : null}
    {screening && <section className="research-screener" aria-labelledby="research-screener-title">
      <div><p className="eyebrow">RESEARCH SCREENER</p><h2 id="research-screener-title">Find model-picked candidates</h2><p className="meta">Choose the model probability and selection first. Add pricing filters when you need executable-quote analysis; results include settled P&amp;L, net, and ROI.</p></div>
      <form className="research-filter-form" action="/research/screener" method="get">
        <input type="hidden" name="screen" value="1" />
        {range.preset === "custom" ? <><input type="hidden" name="from" value={range.from ?? ""} /><input type="hidden" name="to" value={range.to ?? ""} /></> : <input type="hidden" name="range" value={range.preset} />}
        <label>Minimum model probability<select name="minProbability" defaultValue={String(Math.round(minProbability * 100))}>{PROBABILITY_THRESHOLDS.map((threshold) => <option key={threshold} value={threshold}>{threshold}% and above</option>)}</select></label>
        <label>Model selection<select name="pick" defaultValue={modelFilter.value}>{MODEL_PICK_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}</select></label>
        <label className="inline-checkbox"><input type="checkbox" name="pricedOnly" value="1" defaultChecked={pricedOnly} /> Only show priced candidates</label>
        <details className="research-filter-advanced"><summary>Pricing options</summary><div className="research-filter-advanced-fields">
          <label>Min captured odds<input name="minOdds" type="number" min="1.01" max="1000" step="0.01" defaultValue={minOdds.toFixed(2)} /></label>
          <ResearchStakeInput initialStake={stakePerSelection} />
          <label>Max quote age at kickoff (min)<input name="maxQuoteAge" type="number" min="0" step="30" placeholder="Any" defaultValue={maxQuoteAge || ""} /></label>
        </div></details>
        <button className="date-go" type="submit">Find candidates</button>
      </form>
      <p className="forecast-sweet-spot" role="status"><strong>{screenerSweetSpot ? `Sweet spot for ${rangeLabel(range)}: ${marketLabel(screenerSweetSpot.marketKey)} · ${selectionLabel(screenerSweetSpot.selection)} · ${screenerSweetSpot.probabilityThreshold}%+ probability · odds ≥ ${screenerSweetSpot.minimumOdds.toFixed(2)}${screenerSweetSpot.maximumQuoteAgeMinutes === null ? "" : ` · quote age ≤ ${screenerSweetSpot.maximumQuoteAgeMinutes} min`} — ${screenerSweetSpot.wins}/${screenerSweetSpot.matches} wins (${(screenerSweetSpot.hitRate * 100).toFixed(1)}% hit rate) · ${(screenerSweetSpot.paperRoi * 100 >= 0 ? "+" : "")}${(screenerSweetSpot.paperRoi * 100).toFixed(1)}% paper ROI.` : `Sweet spot for ${rangeLabel(range)}: not enough priced settled candidates yet.`}</strong> <span>Recalculated from the selected range as new settled results and quotes arrive. This is paper evidence, not a staking recommendation.</span></p>
    </section>}
    {screening && <section className="research-candidates" aria-labelledby="research-candidates-title"><div className="section-heading"><div><p className="eyebrow">MODEL PICK ANALYSIS · {screenCandidates.length} MATCH{screenCandidates.length === 1 ? "" : "ES"}</p><h2 id="research-candidates-title">{modelFilter.label} · P&amp;L / Net / ROI</h2></div><p className="meta">{rangeLabel(range)} · probability ≥ {pct(minProbability)}{pricedOnly ? " · priced only" : ""} · odds ≥ {minOdds.toFixed(2)}{maxQuoteAge ? ` · quote age ≤ ${maxQuoteAge} min` : ""}</p></div>
      <ResearchPerformanceSummary initialStake={stakePerSelection} settledCount={settledCount} wins={wins} losses={losses} voids={voids} pending={pending} returnsPerUnit={returnsPerUnit} netPerUnit={netPerUnit} roiPercent={roi} />
      {screenCandidates.length === 0 ? <div className="notice">No stored matches meet all filters for {rangeLabel(range)}. The analysis cards above are zeroed because there are no qualifying selections.</div> : <div className="matches-table-wrap"><table className="matches-table"><thead><tr><th>Match</th><th>Kickoff</th><th>Model probability</th><th>Captured odds</th><th>Bookmaker</th><th>Match result</th><th>Net P&amp;L</th><th>Evidence</th></tr></thead><tbody>{candidateResults.map((candidate) => {
        const fixture = candidate.fixture;
        const scoreText = score(fixture);
        const outcomeLabel = candidate.result === "VOID" ? "Void" : candidate.result === "WIN" ? "Won" : candidate.result === "LOSS" ? "Lost" : "Pending";
        const outcomeClass = candidate.result.toLowerCase();
        return <tr key={fixture.id}><th scope="row"><Link href={listHref(fixture.id)}>{fixture.homeTeam.name} vs {fixture.awayTeam.name}</Link><small>{fixture.competition.name} · {label(candidate.marketKey)} · {label(candidate.selection)}</small></th><td>{dateTime(fixture.kickoff)}</td><td className="num">{pct(candidate.probability)}</td><td className="num">{candidate.odds === null ? "—" : candidate.odds.toFixed(2)}</td><td>{candidate.bookmaker ?? "No eligible quote"}</td><td className="research-candidate-result">{scoreText ?? "—"}<span className={`status-badge ${outcomeClass}`}>{outcomeLabel}</span></td><ResearchMoneyCell initialStake={stakePerSelection} profitUnits={candidate.profitUnits} /><td><small>Forecast {dateTime(candidate.predictionAsOfAt)}<br />{candidate.quoteCapturedAt ? `Quote ${dateTime(candidate.quoteCapturedAt)}` : "No captured quote"}</small></td></tr>;
      })}</tbody></table></div>}
    </section>}
    {view === "history" && <section className="research-high-probability" aria-labelledby="research-high-probability-title">
      <h2 id="research-high-probability-title">{highProbabilityRows.length} picks at or above {pct(HIGH_PROBABILITY_THRESHOLD)}</h2>
      <p className="research-history-intro">These are the model's highest-probability outcomes, not evidence-qualified selections. Inspect captured prices, quote freshness, and the fixture record before drawing any conclusion.</p>
      <RangeNav basePath="/research/model-history" range={summaryRange} today={today} paramNames={{ range: "summaryRange", from: "summaryFrom", to: "summaryTo" }} />
      <p className="meta">Saved forecast fixture coverage in this range: {summaryFixtures.length ? `${formatDay(dateKey(summaryFixtures[summaryFixtures.length - 1]!.kickoff))} to ${formatDay(dateKey(summaryFixtures[0]!.kickoff))}` : "none"}. All {summaryFixtures.length} matching fixtures are included; no sample truncation. Only final results count as wins or losses.</p>
      <p><Link href="/research/paper-validation">View prospective paper comparison and calibration readiness</Link></p>
      {highProbabilityRows.length > 0 && <section className="research-selector-summary" aria-labelledby="research-selector-summary-title"><div className="section-heading"><div><p className="eyebrow">MODEL SELECTOR</p><h3 id="research-selector-summary-title">Hit rates</h3></div><p className="meta">Pending picks are excluded from the hit-rate denominator</p></div><div className="matches-table-wrap"><table className="matches-table"><thead><tr><th>Selected market</th><th>Selection</th><th>Selected</th><th>Settled</th><th>Won</th><th>Lost</th><th>Hit rate</th></tr></thead><tbody>{selectorOutcomeRows.map((row) => <tr key={`${row.market}-${row.selection}`}><th scope="row">{marketLabel(row.market)}</th><td>{selectionLabel(row.selection)}</td><td className="num">{row.selected}</td><td className="num">{row.settled}</td><td className="num">{row.won}</td><td className="num">{row.lost}</td><td className="num">{row.hitRate === null ? "—" : pct(row.hitRate)}</td></tr>)}</tbody></table></div></section>}
      {highProbabilityRows.length > 0 && <section aria-labelledby="research-paper-returns">
        <h3 id="research-paper-returns">Calibration and paper returns</h3>
        <p className="meta">One hypothetical unit per priced settled pick. Prices must have been captured and received, with source evidence, by forecast time. Uses current active-bookmaker priority; no freshness filter. This reconstructs historical performance, not placed bets. Missing prices remain unknown. Pending and void picks are excluded from both hit rate and ROI.</p>
        <div className="matches-table-wrap"><table className="matches-table"><thead><tr><th>Selection</th><th>Mean forecast</th><th>Hit rate</th><th>Priced settled</th><th>Unpriced settled</th><th>Paper net (units)</th><th>Paper ROI</th></tr></thead><tbody>{selectorOutcomeRows.map(row => <tr key={row.market + row.selection}>
          <th scope="row">{marketLabel(row.market)} · {selectionLabel(row.selection)}</th>
          <td>{row.meanProbability === null ? "—" : pct(row.meanProbability)}</td><td>{row.hitRate === null ? "—" : pct(row.hitRate)}</td><td>{row.priced}</td><td>{row.unpriced}</td>
          <td>{row.net === null ? "Unavailable" : row.net.toFixed(2)}</td><td>{row.roi === null ? "Unavailable" : pct(row.roi)}</td>
        </tr>)}</tbody></table></div>
      </section>}
      {highProbabilityRows.length === 0 ? <div className="notice">No high-probability market picks are available for {rangeLabel(summaryRange)}.</div> : <div className="research-high-probability-groups">{Array.from(highProbabilityGroups.entries()).sort(([a], [b]) => b.localeCompare(a)).map(([year, months]) => {
        return <details key={year}><summary><strong>{year}</strong><small>{Array.from(months.values()).reduce((count, days) => count + Array.from(days.values()).reduce((dayCount, rows) => dayCount + rows.length, 0), 0)} market picks</small></summary><div className="research-high-probability-months">{Array.from(months.entries()).sort(([a], [b]) => b.localeCompare(a)).map(([month, days]) => {
          return <details key={month}><summary><strong>{new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "Africa/Blantyre" }).format(new Date(`${month}-01T00:00:00.000Z`))}</strong><small>{Array.from(days.values()).reduce((count, rows) => count + rows.length, 0)} market picks</small></summary><div className="research-high-probability-days">{Array.from(days.entries()).sort(([a], [b]) => b.localeCompare(a)).map(([dayKey, rows]) => <details key={dayKey}><summary><strong>{formatDay(dayKey)}</strong><small>{rows.length} market pick{rows.length === 1 ? "" : "s"}</small></summary>{renderHighProbabilityTable(rows)}</details>)}</div></details>;
        })}</div></details>;
      })}</div>}
    </section>}
    {view === "fixture" && <>
    <p className="meta">{screening ? `Matches with a model forecast or published ticket leg in ${rangeLabel(range)} (Blantyre time).` : `All ${fixtures.length} pulled fixtures on ${formatDay(day ?? today)} (Malawi time), including matches awaiting a forecast.`}</p>
    {fixtures.length === 0 && !selectedFixture ? <div className="notice">No pulled fixtures for this date. Check calendar refresh coverage above before treating this as an empty schedule.</div> : <div className="research-layout">
      <nav className="research-fixtures" aria-label="Pulled fixtures">
        {fixtures.length === 0 && <p className="meta">No other researched fixtures for this view.</p>}
        {fixtures.map((fixture) => <Link key={fixture.id} href={listHref(fixture.id)} className={`research-fixture${fixture.id === selectedFixture?.id ? " active" : ""}`}>
          <small>{dateTime(fixture.kickoff)} · {fixture.competition.name}</small><strong>{fixture.homeTeam.name} <span>vs</span> {fixture.awayTeam.name}</strong><small>{fixture.status}{score(fixture) ? ` · ${score(fixture)}` : ""}</small>
        </Link>)}
      </nav>
      {selectedFixture && <article className="research-detail">
        <p className="eyebrow">{selectedFixture.competition.name} · {dateTime(selectedFixture.kickoff)}</p>
        <h2>{selectedFixture.homeTeam.name} vs {selectedFixture.awayTeam.name}</h2>
        <p className="meta">Fixture status: {selectedFixture.status}{selectedFixture.statusCode ? ` (${selectedFixture.statusCode})` : ""}. Last received {dateTime(selectedFixture.receivedAt)}.</p>

        <section className="match-decision" aria-labelledby="match-decision-title">
          <div className="match-decision-heading">
            <div><p className="eyebrow">EXECUTIVE BETTING SUMMARY</p><h3 id="match-decision-title">Model verdict</h3></div>
            <span className={`decision-badge ${verdict.toLowerCase()}`}>{verdict}</span>
          </div>
          <p className="match-decision-verdict">{verdictReason} This is research evidence, not an instruction to stake money.</p>
          {bestPick ? <div className="match-decision-grid">
            <div><small>Recommended market</small><strong>{marketLabel(bestMarketResult!.market)} · {selectionLabel(bestPick.selection)}</strong></div>
            <div><small>Model probability</small><strong>{pct(Number(bestPick.probability))}</strong></div>
            <div><small>Captured odds</small><strong>{bestOdds === null ? "Unavailable" : bestOdds.toFixed(2)}</strong></div>
            <div><small>Implied probability</small><strong>{bestImplied === null ? "Unavailable" : pct(bestImplied)}</strong></div>
            <div><small>Model fair odds</small><strong>{Number(bestPick.probability) > 0 ? (1 / Number(bestPick.probability)).toFixed(2) : "Unavailable"}</strong></div>
            <div><small>Edge</small><strong>{bestEdge === null ? "Unavailable" : `${bestEdge >= 0 ? "+" : ""}${(bestEdge * 100).toFixed(1)} pp`}</strong></div>
          </div> : <div className="notice">No pre-kickoff model selection is stored for this fixture. PASS is a data state, not a claim that every market was evaluated.</div>}
          {bestPick && <div className="match-decision-notes">
            <div><strong>Why this is the leading signal</strong><p>It is the highest stored probability among the supported markets for this fixture, subject to the pre-kickoff and model-training cutoff checks.</p></div>
            <div><strong>Risks and limits</strong><p>{bestQuote ? "The price is a captured historical quote and may not be available now." : "No eligible captured quote is available, so value and executable pricing cannot be verified."} A single fixture is not enough to establish reliability.</p></div>
          </div>}
        </section>

        <section className="research-result" aria-labelledby="research-result-title">
          <h3 id="research-result-title">Match result</h3>
          <div className={`research-scoreboard status-${selectedFixture.status.toLowerCase()}`}>
            <span>{selectedFixture.homeTeam.name}</span>
            <strong>{score(selectedFixture) ?? "–"}</strong>
            <span>{selectedFixture.awayTeam.name}</span>
          </div>
          <p className="research-result-state">{resultHeadline(selectedFixture)}</p>
          {finalScore && marketResults.length > 0 && <div className="matches-table-wrap"><table className="matches-table">
            <thead><tr><th>Market</th><th>Result</th><th>Model pick</th><th>Model gave the result</th><th>Brier</th></tr></thead>
            <tbody>{marketResults.map((item) => <tr key={item.market}>
              <td>{label(item.market)}</td>
              <td>{item.winner ? label(item.winner.selection) : "Not resolvable"}</td>
              <td>{item.pick ? <>{label(item.pick.selection)} {item.pickHit === null ? null : <span className={`status-badge ${item.pickHit ? "win" : "loss"}`}>{item.pickHit ? "Hit" : "Miss"}</span>}</> : "—"}</td>
              <td>{item.winner ? pct(Number(item.winner.probability)) : "—"}</td>
              <td>{item.brier === null ? "—" : item.brier.toFixed(3)}</td>
            </tr>)}</tbody>
          </table></div>}
          {!finalScore && <p className="meta">{selectedFixture.status === "SCHEDULED" || selectedFixture.status === "LIVE" ? "Market results appear once the final score is stored." : "No final score is recorded; postponed and cancelled fixtures void every market."}</p>}
          {finalScore && <p className="meta">The model pick is the selection with the highest stored probability in each market. Brier is scored across that market&apos;s selections for this one match; lower is better and a single match is noisy.</p>}
        </section>

        {ticketLegs.length > 0 && <>
          <h3>On published tickets</h3>
          <div className="matches-table-wrap"><table className="matches-table">
            <thead><tr><th>Ticket</th><th>Selection</th><th>Odds</th><th>This leg</th><th>Ticket outcome</th></tr></thead>
            <tbody>{ticketLegs.map((leg) => {
              const settlement = leg.ticketVersion.settlements[0];
              const ticketOutcome = settlement?.outcome ?? "PENDING";
              const recorded = ticketOutcome !== "PENDING" ? parseSettlementEvidence(settlement?.evidence).find((row) => row.fixtureId === leg.fixtureId) : undefined;
              const outcome = displayLegOutcome(recorded, leg.marketKey, leg.selection, selectedFixture).outcome;
              const target = leg.ticketVersion.targetDate.toISOString().slice(0, 10);
              return <tr key={leg.id}>
                <td><Link href={`/results?from=${target}&to=${target}`}>{leg.ticketVersion.tier} · {target}</Link></td>
                <td>{label(leg.marketKey)}: {label(leg.selection)}</td>
                <td>{Number(leg.decimalOdds).toFixed(2)}</td>
                <td><span className={`status-badge ${outcome.toLowerCase()}`}>{LEG_OUTCOME_LABEL[outcome] ?? outcome}</span></td>
                <td><span className={`status-badge ${ticketOutcome.toLowerCase()}`}>{ticketOutcome}</span></td>
              </tr>;
            })}</tbody>
          </table></div>
        </>}

        <h3>Model probabilities</h3>
        <p className="meta">Forecasts made before kickoff. Each selection is compared with the same market, selection, competition and model method in its 10 percentage point probability band over the preceding {EVIDENCE_WINDOW_DAYS} days.</p>
        {marketResults.length === 0 ? <p>No model forecast is stored for this fixture.</p> : <div className="research-probabilities">{marketResults.map(({ market, rows, outcomes }) => <div className="research-market" key={market}>
          <strong>{label(market)}</strong>
          <div>{outcomes.map(({ row, hit }) => <span key={`${row.modelRunId}-${row.selection}`} className={hit ? "research-hit" : undefined}><b>{label(row.selection)}{hit ? " ✓" : ""}</b>{pct(Number(row.probability))}</span>)}</div>
          {outcomes.map(({ row }) => {
            const evidence = forecastEvidence(evidenceRows, { fixtureId: selectedFixture.id, competitionId: selectedFixture.competitionId,
              market, selection: row.selection, method: row.modelRun.method, probability: Number(row.probability), forecastAt: row.asOfAt });
            return <div className="research-forecast-evidence" key={`evidence-${row.selection}`}>
              <p><b>{selectionLabel(row.selection)}</b>: {pct(Number(row.probability))} predicted probability. {evidence.observed === null
                ? "No comparable completed matches are available."
                : <>Similar forecasts historically won {pct(evidence.observed)} of the time across {evidence.matches} matches ({evidence.wins} wins).</>}</p>
              {evidence.interval && <p className="meta">Historical win-rate range: {pct(evidence.interval.lower)}–{pct(evidence.interval.upper)} (95% interval). Similar forecasts averaged {pct(evidence.predicted!)}; observed minus predicted: {((evidence.gap ?? 0) * 100).toFixed(1)} percentage points. {evidence.matches < 30 ? "Small sample: reliability remains uncertain." : "Historical comparison; this does not establish reliability for this match."}</p>}
              <details><summary>Comparison evidence</summary><p className="meta">Probability band: {pct(evidence.lower)}–{pct(evidence.upper)} (upper boundary excluded except 100%). One latest eligible forecast per match. Comparison ends at {dateTime(row.asOfAt)}. Only finished matches whose current result record was received before that forecast are included; later refreshed records are excluded conservatively. Matching model methods may include different trained model versions. The interval assumes independent matches; shared teams and model changes can increase uncertainty. <Link href="/analysis#calibration">View market hit rates and selection bias</Link>.</p></details>
            </div>;
          })}
          <small>{rows[0] ? `${forecastStageLabel(rows[0].stage)} · ${rows[0].modelRun.method} · trained through ${dateTime(rows[0].modelRun.trainedUntil)} · forecast ${dateTime(rows[0].asOfAt)}` : ""}</small>
          {rows[0]?.stage === "PRELIMINARY" && <p className="meta">Preliminary forecast for tomorrow. It may change after morning retraining and cannot publish a paper ticket. Any captured price below is historical, not a current executable offer.</p>}
        </div>)}</div>}
        <h3>Captured prices</h3>
        <p className="meta">Quotes are grouped by market and selection. Each record was captured before kickoff; this feed may be incomplete between provider snapshots.</p>
        {selectedFixture.quotes.length === 0 ? <p>No locally captured prices for this fixture.</p> : <div className="matches-table-wrap"><table className="matches-table"><thead><tr><th>Market</th><th>Selection</th><th>Bookmaker</th><th>Odds</th><th>Movement</th><th>Captured</th><th>Provider update</th></tr></thead><tbody>{selectedFixture.quotes.map((quote, index) => {
          const older = selectedFixture.quotes.slice(index + 1).find((candidate) => candidate.bookmakerId === quote.bookmakerId && candidate.marketId === quote.marketId && candidate.selection === quote.selection);
          const change = older ? (Number(quote.decimalOdds) - Number(older.decimalOdds)) / Number(older.decimalOdds) * 100 : null;
          return <tr key={quote.id}><td>{quote.market.normalizedKey ?? quote.market.name}</td><td>{quote.selection}</td><td>{quote.bookmaker.name}</td><td>{Number(quote.decimalOdds).toFixed(2)}</td><td>{change === null ? "First capture" : `${change > 0 ? "+" : ""}${change.toFixed(1)}% vs previous`}</td><td>{dateTime(quote.capturedAt)}</td><td>{quote.providerUpdatedAt ? dateTime(quote.providerUpdatedAt) : "Not supplied"}</td></tr>;
        })}</tbody></table></div>}
      </article>}
    </div>}
    </>}
  </section>;
}
