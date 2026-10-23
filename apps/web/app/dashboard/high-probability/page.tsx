import { redirect } from "next/navigation";
import { db } from "@highodds/db";
import { activeUser } from "../../../auth";
import { blantyreDayBounds, blantyreToday, forecastEvidence, forecastStageLabel, highProbabilityPick, historicalSweetSpot, legOutcome, parseIsoDay, probabilityThreshold, PROBABILITY_THRESHOLDS, type StoredPrediction } from "@highodds/core";
import { LEG_OUTCOME_LABEL, selectionLabel, shortPickLabel } from "../../../lib/selection";
import { loadForecastEvidence } from "../../../lib/forecast-evidence";
import { DayNav, formatDay } from "../../date-nav";
import { FixtureCalendar } from "../../fixture-calendar";
import { MODEL_PICK_FILTERS, modelPickFilter } from "@highodds/core";
import { ResearchPerformanceSummary, ResearchStakeInput } from "../../research-performance";
import { resolveResearchQuote } from "../../../lib/research-odds";
import { ForecastFilterSelect, ForecastPricedOnly } from "../../forecast-filters";

export const dynamic = "force-dynamic";

const TIER_LABEL: Record<string, string> = { STANDARD: "Standard", VALUE: "Value", HIGH: "High" };
const MARKET_LABEL: Record<string, string> = { MATCH_WINNER: "Match winner", TOTAL_GOALS: "Total goals", BTTS: "Both teams score" };

const BLANTYRE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Blantyre", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
const BLANTYRE_RECEIVED = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Blantyre", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ date?: string | string[]; minProbability?: string | string[]; pick?: string | string[]; stake?: string | string[]; pricedOnly?: string | string[] }> }) {
  if (!await activeUser()) redirect("/signin");

  const { date, minProbability, pick: pickParam, stake, pricedOnly: pricedOnlyParam } = await searchParams;
  const minimumPercent = probabilityThreshold(minProbability);
  const pickFilter = modelPickFilter(pickParam);
  const parsedStake = typeof stake === "string" ? Number(stake) : NaN;
  const simulatorStake = Number.isFinite(parsedStake) ? Math.min(1_000_000, Math.max(0.01, parsedStake)) : 1;
  const pricedOnly = pricedOnlyParam === "1" || pricedOnlyParam === "on";
  // Ticket target dates are UTC days (matching the publish schedule); fixtures use the same day in Blantyre time.
  const now = new Date();
  const today = blantyreToday(now);
  const day = parseIsoDay(date) ?? today;
  const isToday = day === today;
  const localDay = blantyreDayBounds(day);
  const historicalThroughDate = new Date(`${day}T00:00:00.000Z`);
  historicalThroughDate.setUTCDate(historicalThroughDate.getUTCDate() - 1);
  const historicalThroughDay = historicalThroughDate.toISOString().slice(0, 10);
  const historicalCutoff = localDay.start;

  // Historical context is cut off at the selected day's local midnight: only settled
  // matches through the preceding day can influence the recommendation.
  const historicalRows = await db.$queryRaw<Array<{
    fixtureId: string; marketKey: string; selection: string; probability: number; asOfAt: Date;
    trainedUntil: Date; kickoff: Date; status: string; homeGoals: number; awayGoals: number;
  }>>`
    SELECT p."fixtureId", m."normalizedKey" AS "marketKey", p."selection",
      p."probability"::float8 AS "probability", p."asOfAt", mr."trainedUntil",
      f."kickoff", f."status", f."homeGoals", f."awayGoals"
    FROM "Prediction" p
      JOIN "Fixture" f ON f."id" = p."fixtureId"
      JOIN "Market" m ON m."id" = p."marketId"
      JOIN "ModelRun" mr ON mr."id" = p."modelRunId"
    WHERE p."stage" = 'SELECTION' AND f."status" = 'FINISHED' AND f."kickoff" < ${historicalCutoff}
      AND f."homeGoals" IS NOT NULL AND f."awayGoals" IS NOT NULL
      AND m."normalizedKey" IS NOT NULL AND p."asOfAt" < f."kickoff"
      AND mr."trainedUntil" <= p."asOfAt"
    ORDER BY p."fixtureId", p."asOfAt" DESC, p."id" ASC`;
  const historicalByFixture = new Map<string, typeof historicalRows>();
  for (const row of historicalRows) historicalByFixture.set(row.fixtureId, [...(historicalByFixture.get(row.fixtureId) ?? []), row]);
  const historicalPicks = [...historicalByFixture.values()].flatMap((rows) => {
    const first = rows[0];
    if (!first) return [];
    const pick = highProbabilityPick(rows.map((row) => ({ ...row, marketKey: row.marketKey, probability: Number(row.probability) })), first.kickoff, now, 0);
    if (!pick) return [];
    const outcome = legOutcome(pick.marketKey!, pick.selection, first);
    return outcome === "WIN" || outcome === "LOSS" ? [{ marketKey: pick.marketKey!, selection: pick.selection, probability: pick.probability, win: outcome === "WIN" }] : [];
  });
  const sweetSpot = historicalSweetSpot(historicalPicks);

  const fixtures = await db.fixture.findMany({
      where: { kickoff: { gte: localDay.start, lt: localDay.end } },
      orderBy: [{ kickoff: "asc" }, { id: "asc" }],
      select: { id: true, competitionId: true, kickoff: true, status: true, homeGoals: true, awayGoals: true, competition: { select: { name: true } }, homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } }
    });

  const fixtureIds = fixtures.map((fixture) => fixture.id);
  const [predictions, ticketLegs] = fixtureIds.length === 0 ? [[], []] : await Promise.all([
    db.prediction.findMany({
      where: { fixtureId: { in: fixtureIds } },
      orderBy: [{ asOfAt: "desc" }, { id: "asc" }],
      select: { fixtureId: true, selection: true, probability: true, asOfAt: true, stage: true, modelRun: { select: { method: true, trainedUntil: true } }, market: { select: { normalizedKey: true } } }
    }),
    db.ticketLeg.findMany({
      where: { fixtureId: { in: fixtureIds }, ticketVersion: { successors: { none: {} } } },
      select: { fixtureId: true, marketKey: true, selection: true, ticketVersion: { select: { tier: true } } }
    })
  ]);
  const predictionsByFixture = new Map<string, (StoredPrediction & { method: string; trainedUntil: Date; stage: string })[]>();
  for (const row of predictions) {
    const list = predictionsByFixture.get(row.fixtureId) ?? [];
    list.push({ marketKey: row.market.normalizedKey, selection: row.selection, probability: Number(row.probability), asOfAt: row.asOfAt, stage: row.stage, method: row.modelRun.method, trainedUntil: row.modelRun.trainedUntil });
    predictionsByFixture.set(row.fixtureId, list);
  }
  const legsByFixture = new Map<string, typeof ticketLegs>();
  for (const leg of ticketLegs) legsByFixture.set(leg.fixtureId, [...(legsByFixture.get(leg.fixtureId) ?? []), leg]);
  const modelPickFixtures = fixtures.flatMap((fixture) => {
    const pick = highProbabilityPick(predictionsByFixture.get(fixture.id) ?? [], fixture.kickoff, now, minimumPercent, pickFilter);
    return pick ? [{ fixture, pick }] : [];
  });
  const [evidenceRows, quotes] = await Promise.all([
    loadForecastEvidence(modelPickFixtures.map(({ fixture, pick }) => ({ fixtureId: fixture.id, competitionId: fixture.competitionId, forecastAt: pick.asOfAt }))),
    modelPickFixtures.length ? db.oddsQuote.findMany({
      where: { fixtureId: { in: modelPickFixtures.map(({ fixture }) => fixture.id) }, bookmaker: { active: true }, capturedAt: { lte: now } },
      select: { fixtureId: true, selection: true, decimalOdds: true, capturedAt: true, bookmaker: { select: { name: true, priority: true } }, market: { select: { normalizedKey: true } } }
    }) : []
  ]);
  const displayedPicks = modelPickFixtures.map(({ fixture, pick }) => {
    const quote = resolveResearchQuote(quotes.filter((item) => item.fixtureId === fixture.id), {
      marketKey: pick.marketKey!, selection: pick.selection, kickoff: fixture.kickoff, forecastAt: pick.asOfAt, mode: "forecast"
    });
    return { fixture, pick, quote, outcome: legOutcome(pick.marketKey!, pick.selection, fixture) };
  });
  const pricedPicks = displayedPicks.filter((row) => row.quote !== null);
  const visiblePicks = pricedOnly ? pricedPicks : displayedPicks;
  const simulatedSettled = pricedPicks.filter((row) => row.outcome === "WIN" || row.outcome === "LOSS");
  const simulatedWins = simulatedSettled.filter((row) => row.outcome === "WIN");
  const simulatedLosses = simulatedSettled.length - simulatedWins.length;
  const simulationReturnsPerUnit = simulatedWins.reduce((sum, row) => sum + Number(row.quote!.decimalOdds), 0);
  const simulationNetPerUnit = simulationReturnsPerUnit - simulatedSettled.length;
  const visibleSelectionSummary = new Map<string, { market: string; selection: string; selected: number; settled: number; won: number; lost: number; voided: number }>();
  for (const { fixture, pick } of visiblePicks) {
    const market = pick.marketKey!;
    const key = `${market}\u0000${pick.selection}`;
    const row = visibleSelectionSummary.get(key) ?? { market, selection: pick.selection, selected: 0, settled: 0, won: 0, lost: 0, voided: 0 };
    const outcome = legOutcome(market, pick.selection, fixture);
    row.selected += 1;
    if (outcome === "WIN") { row.settled += 1; row.won += 1; }
    else if (outcome === "LOSS") { row.settled += 1; row.lost += 1; }
    else if (outcome === "VOID") row.voided += 1;
    visibleSelectionSummary.set(key, row);
  }
  const visibleSelectionSummaryRows = [...visibleSelectionSummary.values()].sort((a, b) => a.market.localeCompare(b.market) || a.selection.localeCompare(b.selection));
  const selectionSummaryTable = <section className="high-probability-summary" aria-labelledby="high-probability-summary-title">
    <div className="section-heading"><div><p className="eyebrow">SELECTION SUMMARY</p><h3 id="high-probability-summary-title">Selected market performance</h3></div><p className="meta">For the date and filters above</p></div>
    <div className="matches-table-wrap"><table className="matches-table high-probability-summary-table">
      <thead><tr><th>Selected market</th><th>Selection</th><th>Selected</th><th>Settled</th><th>Won</th><th>Lost</th><th>Hit rate</th></tr></thead>
      <tbody>{visibleSelectionSummaryRows.length === 0 ? <tr><td colSpan={7}>No selections meet the current filters.</td></tr> : visibleSelectionSummaryRows.map((row) => <tr key={`${row.market}-${row.selection}`}>
        <th scope="row">{MARKET_LABEL[row.market] ?? row.market}</th><td>{selectionLabel(row.selection)}</td><td className="num">{row.selected}</td><td className="num">{row.settled}</td><td className="num">{row.won}</td><td className="num">{row.lost}</td><td className="num">{row.settled ? `${(row.won / row.settled * 100).toFixed(1)}%` : "—"}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="meta">Only won and lost selections are included in the hit-rate denominator. Pending and void selections remain out of the denominator.</p>
  </section>;

  return (
    <section>
      <p className="eyebrow">MATCH CALENDAR · MODEL FORECASTS</p>
      <h1>High Probability Matches</h1>
      <FixtureCalendar now={now} basePath="/dashboard/high-probability" selectedDay={day} params={{ minProbability: String(minimumPercent), pick: pickFilter.value, stake: simulatorStake.toFixed(2), ...(pricedOnly ? { pricedOnly: "1" } : {}) }} />
      <DayNav basePath="/dashboard/high-probability" day={day} today={today} allowFuture params={{ minProbability: String(minimumPercent), pick: pickFilter.value, stake: simulatorStake.toFixed(2), ...(pricedOnly ? { pricedOnly: "1" } : {}) }} />
      <p className="page-intro">Compare model picks for <strong>{formatDay(day)}</strong> with historical calibration evidence.</p>
      <p className="meta">Tomorrow&apos;s preliminary market forecasts run at 22:00 Malawi time. Morning forecasts refresh at 07:45–08:00. Preliminary picks may change and cannot publish paper tickets.</p>
      <details open={visiblePicks.length === 0}>
        <summary>All {fixtures.length} pulled matches on {formatDay(day)}</summary>
        {fixtures.length === 0 ? <p>No pulled matches for this date. Calendar refresh coverage is shown above.</p> : <div className="matches-table-wrap"><table className="matches-table">
          <thead><tr><th>Time</th><th>Match</th><th>Status</th><th>Forecast</th></tr></thead>
          <tbody>{fixtures.map((fixture) => <tr key={fixture.id}>
            <td>{BLANTYRE_TIME.format(fixture.kickoff)}</td>
            <th scope="row"><a href={`/research?date=${day}&fixture=${fixture.id}`}>{fixture.homeTeam.name} vs {fixture.awayTeam.name}</a><small>{fixture.competition.name}</small></th>
            <td>{fixture.status}</td><td>{predictionsByFixture.has(fixture.id) ? "Forecast stored · inspect match" : fixture.kickoff > now ? "Forecast pending" : "No forecast stored"}</td>
          </tr>)}</tbody>
        </table></div>}
      </details>
      <p className="forecast-sweet-spot" role="status"><strong>{sweetSpot ? `Historical sweet spot: ${shortPickLabel(sweetSpot.marketKey, sweetSpot.selection)} at ${sweetSpot.threshold}%+ model probability — ${sweetSpot.wins}/${sweetSpot.matches} settled wins (${(sweetSpot.hitRate * 100).toFixed(1)}% hit rate).` : "Historical sweet spot: not enough settled results yet."}</strong> <span>Based on settled matches through {formatDay(historicalThroughDay)}; this is paper evidence, not a staking recommendation.</span></p>

      <section className="matches-section" aria-label={isToday ? "Today's high-probability matches" : `High-probability matches on ${formatDay(day)}`}>
        <form className="date-form probability-filter" action="/dashboard/high-probability" method="get">
          <input type="hidden" name="date" value={day} />
          <ForecastFilterSelect name="minProbability" value={String(minimumPercent)} label="Model probability" options={PROBABILITY_THRESHOLDS.map((threshold) => ({ value: threshold, label: `${threshold}% and above` }))} />
          <ForecastFilterSelect name="pick" value={pickFilter.value} label="Model pick" options={MODEL_PICK_FILTERS.map((filter) => ({ value: filter.value, label: filter.label }))} />
          <ForecastPricedOnly checked={pricedOnly} />
          <ResearchStakeInput initialStake={simulatorStake} />
        </form>
        <p className="filter-summary" role="status"><strong>{visiblePicks.length}</strong> {pricedOnly ? "priced signals" : "signals"} · {pickFilter.label} · {minimumPercent}% and above · {pricedPicks.length} of {modelPickFixtures.length} have an eligible active-bookmaker quote.</p>
        <section className="high-probability-simulation" aria-labelledby="simulation-title">
          <div className="section-heading"><div><p className="eyebrow">PAPER SIMULATION</p><h3 id="simulation-title">Returns at captured odds</h3></div><p className="meta">MWK stake per selection</p></div>
          <ResearchPerformanceSummary initialStake={simulatorStake} settledCount={simulatedSettled.length} wins={simulatedWins.length} losses={simulatedLosses} voids={pricedPicks.filter((row) => row.outcome === "VOID").length} pending={pricedPicks.filter((row) => row.outcome === "PENDING").length} returnsPerUnit={simulationReturnsPerUnit} netPerUnit={simulationNetPerUnit} roiPercent={simulatedSettled.length ? simulationNetPerUnit / simulatedSettled.length * 100 : null} />
          <p className="meta">Uses the first local active-bookmaker price captured after each forecast and before kickoff, choosing the configured bookmaker priority. {modelPickFixtures.length - pricedPicks.length} selection{modelPickFixtures.length - pricedPicks.length === 1 ? "" : "s"} without a usable captured price {modelPickFixtures.length - pricedPicks.length === 1 ? "is" : "are"} excluded.</p>
        </section>
        {selectionSummaryTable}
        {visiblePicks.length === 0 ? <div className="notice">{pricedOnly ? "No priced signals meet the current filters." : `No matches have ${pickFilter.value === "ALL" ? "an eligible model pick" : `${pickFilter.label} as their strongest model pick`} at ${minimumPercent}% and above for ${formatDay(day)}. Try another model pick, a lower threshold or another date.`}</div> : (
          <div className="matches-table-wrap">
            <table className="matches-table">
              <thead><tr><th>Time</th><th>Match</th><th>Model pick</th><th>Result</th><th>Match odds</th><th>Historical evidence</th><th>Paper ticket</th></tr></thead>
              <tbody>{visiblePicks.map(({ fixture, pick, quote, outcome: pickOutcome }) => {
                const legs = legsByFixture.get(fixture.id) ?? [];
                const resultOutcome = fixture.status === "POSTPONED" || fixture.status === "CANCELLED" ? "VOID" : pickOutcome;
                const evidence = forecastEvidence(evidenceRows, { fixtureId: fixture.id, competitionId: fixture.competitionId,
                  market: pick.marketKey!, selection: pick.selection, method: pick.method, probability: pick.probability, forecastAt: pick.asOfAt });
                return (
                  <tr key={fixture.id}>
                    <td>{BLANTYRE_TIME.format(fixture.kickoff)}</td>
                    <td className="match-summary"><a href={`/research?date=${day}&fixture=${fixture.id}`}>{fixture.homeTeam.name} vs {fixture.awayTeam.name}</a><small>{fixture.competition.name} · {fixture.status}{fixture.homeGoals !== null && fixture.awayGoals !== null ? ` · ${fixture.homeGoals}–${fixture.awayGoals}` : ""}</small></td>
                    <td className="match-pick">{pick ? <>
                      <span>{shortPickLabel(pick.marketKey!, pick.selection)} <small>{(pick.probability * 100).toFixed(1)}%</small></span>
                      <small>{forecastStageLabel(pick.stage)} · {BLANTYRE_RECEIVED.format(pick.asOfAt)}</small>
                      {pickOutcome && pickOutcome !== "PENDING" && <span className={`status-badge leg-outcome ${pickOutcome.toLowerCase()}`}>{LEG_OUTCOME_LABEL[pickOutcome]}</span>}
                    </> : <span className="match-pick-none">—</span>}</td>
                    <td className="match-result">{fixture.homeGoals !== null && fixture.awayGoals !== null ? <>
                      <strong>{fixture.homeGoals}–{fixture.awayGoals}</strong>
                      <span className={`status-badge leg-outcome ${resultOutcome.toLowerCase()}`}>{LEG_OUTCOME_LABEL[resultOutcome] ?? resultOutcome}</span>
                    </> : resultOutcome === "VOID" ? <>
                      <strong>Void</strong><small>{fixture.status}</small>
                    </> : <span className="match-pick-none">Pending</span>}</td>
                    <td className="match-odds">{quote ? <><strong>{Number(quote.decimalOdds).toFixed(2)}</strong><small>{quote.bookmaker.name}<br />Captured {BLANTYRE_RECEIVED.format(quote.capturedAt)}</small></> : <span className="match-pick-none">No eligible active-bookmaker price</span>}</td>
                    <td className="match-calibration">
                      <p>{evidence.observed === null ? "No comparable results." : <>Observed <strong>{(evidence.observed * 100).toFixed(1)}%</strong> · <strong>{evidence.matches}</strong> comparisons</>}</p>
                      <p className="meta">{evidence.matches === 0 ? "Reliability unknown." : evidence.matches < 30 ? "Small sample." : "Historical comparison."}</p>
                      <details><summary>Calibration details</summary>
                        {evidence.interval && <p>95% win-rate interval: {(evidence.interval.lower * 100).toFixed(1)}–{(evidence.interval.upper * 100).toFixed(1)}%. Similar forecasts averaged {(evidence.predicted! * 100).toFixed(1)}%. Observed minus predicted: {((evidence.gap ?? 0) * 100).toFixed(1)} percentage points.</p>}
                        <p>Same competition, market, selection and model method; {(evidence.lower * 100).toFixed(0)}–{(evidence.upper * 100).toFixed(0)}% band (upper boundary excluded except 100%), preceding 180 days. Comparison ends at the forecast: {BLANTYRE_RECEIVED.format(pick.asOfAt)}.</p>
                        <p>One latest eligible forecast per match. Only finished results received before this forecast are included; later refreshed records are excluded. Model versions may differ. The interval assumes independent matches.</p>
                        <a href={`/research?date=${day}&fixture=${fixture.id}`}>Inspect this forecast</a> · <a href="/analysis#calibration">Market calibration</a>
                      </details>
                    </td>
                    <td className="match-pick">{legs.length === 0 ? <span className="match-pick-none">—</span> : legs.map((leg) => {
                      const outcome = legOutcome(leg.marketKey, leg.selection, fixture);
                      return <span key={`${leg.ticketVersion.tier}-${leg.marketKey}`} className="match-ticket-leg">
                        <span>{TIER_LABEL[leg.ticketVersion.tier] ?? leg.ticketVersion.tier}: {shortPickLabel(leg.marketKey, leg.selection)}</span>
                        {outcome !== "PENDING" && <span className={`status-badge leg-outcome ${outcome.toLowerCase()}`}>{LEG_OUTCOME_LABEL[outcome]}</span>}
                      </span>;
                    })}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        <p className="meta">Fixture status is refreshed by the scheduled ingestion job; it is not a live score feed.</p>
      </section>
    </section>
  );
}
