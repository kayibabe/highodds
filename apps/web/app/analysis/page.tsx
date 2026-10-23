import { redirect } from "next/navigation";
import {
  AWAY_WIN_STANDARD_MAX_ODDS_EXCLUSIVE, AWAY_WIN_STANDARD_MIN_MODEL_PROBABILITY, CONFIDENCE_THRESHOLDS, DAILY_JOB_SCHEDULE, DIXON_COLES_RHO, EV_HAIRCUT, EXPECTED_GOALS_FLOOR, HISTORY_LOOKBACK_DAYS, IPF_ITERATIONS,
  JOB_LEASE_MINUTES, JOB_RETRY_MINUTES, LEAGUE_MIN_MATCHES, MAX_LEGS_PER_LEAGUE, MIN_LEG_ODDS, MIN_TICKET_LEGS, MODEL_METHOD,
  isPickFilterActive, parsePickFilter, QUOTE_MAX_AGE_MINUTES, resolveDayRange, SCORELINE_MAX_GOALS, SELECTION_WINDOW_HOURS, TEAM_MIN_MATCHES,
  TICKET_TIERS, utcToday, type CalibrationBucket, type CandidateCohortPerformance, type DayRange, type PickFilter, type PickPerformance
} from "@highodds/core";
import { auth, isAuthDisabled, LOCAL_ACCESS_EMAIL } from "../../auth";
import { loadCalibration, loadModelCoverage, loadModelPicks, loadPipelineHealth, loadTicketPerformance, loadUpcomingFunnel } from "../../lib/analysis";
import { RangeNav, rangeLabel } from "../date-nav";
import { FixtureCalendar } from "../fixture-calendar";

export const dynamic = "force-dynamic";

const pct = (value: number | null, digits = 1) => value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
const num = (value: number | null, digits = 2) => value === null ? "—" : value.toFixed(digits);
const count = (value: number) => value.toLocaleString("en-GB");
const label = (value: string) => value.replaceAll("_", " ");
const signedPp = (value: number) => `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`;
const BLANTYRE = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Blantyre", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const when = (value: Date | null) => value ? BLANTYRE.format(value) : "Never";

function ago(value: Date | null, now: Date): string {
  if (!value) return "no record";
  const minutes = Math.round((now.getTime() - value.getTime()) / 60000);
  if (minutes < 0) return "scheduled ahead";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

const SECTIONS = [
  { id: "parameters", title: "Decision parameters" },
  { id: "pipeline", title: "Pipeline health" },
  { id: "funnel", title: `Next ${SELECTION_WINDOW_HOURS}h funnel` },
  { id: "model", title: "Model coverage" },
  { id: "calibration", title: "Calibration" },
  { id: "picks", title: "Model picks" },
  { id: "tickets", title: "Ticket performance" },
  { id: "candidates", title: "Candidate universe" }
];

type Parameter = { name: string; value: string; effect: string };

const PARAMETER_GROUPS: Array<{ title: string; rows: Parameter[] }> = [
  {
    title: "Evidence and model",
    rows: [
      { name: "Model method", value: MODEL_METHOD, effect: "Poisson team attack/defence strengths fitted per competition by iterative proportional fitting, projected through a Dixon-Coles scoreline grid." },
      { name: "History lookback", value: `${HISTORY_LOOKBACK_DAYS} days`, effect: "Finished matches older than this are ignored, both for training and for a fixture's evidence check." },
      { name: "League evidence floor", value: `${LEAGUE_MIN_MATCHES} matches`, effect: "A competition with fewer finished matches in the lookback is not trained, and its fixtures are not scored." },
      { name: "Team evidence floor", value: `${TEAM_MIN_MATCHES} matches each`, effect: "Both teams need this many finished matches in the lookback before a fixture gets a prediction." },
      { name: "Fitting passes", value: String(IPF_ITERATIONS), effect: "Fixed number of attack, defence and home-advantage update passes per training run." },
      { name: "Dixon-Coles ρ", value: String(DIXON_COLES_RHO), effect: "Adjusts 0–0, 1–0, 0–1 and 1–1 probabilities for low-score dependence." },
      { name: "Scoreline grid", value: `0–${SCORELINE_MAX_GOALS} goals a side`, effect: "Scorelines enumerated when turning expected goals into market probabilities." },
      { name: "Expected-goals floor", value: String(EXPECTED_GOALS_FLOOR), effect: "Minimum expected goals per side, so a very weak attack still yields a defined distribution." }
    ]
  },
  {
    title: "Leg eligibility",
    rows: [
      { name: "Markets", value: "Match winner · Over/Under 2.5 · Both teams score", effect: "Only these normalised markets are predicted, priced and eligible for tickets." },
      { name: "Minimum leg odds", value: MIN_LEG_ODDS.toFixed(2), effect: "Shorter prices are rejected as a ticket leg." },
      { name: "EV haircut", value: pct(EV_HAIRCUT, 0), effect: `Conservative EV = p × (1 − ${EV_HAIRCUT}) × odds − 1 must be above zero.` },
      { name: "Quote freshness", value: `${QUOTE_MAX_AGE_MINUTES} min`, effect: "A leg's price must be captured before kickoff and no older than this when the ticket is built." },
      { name: "Market consensus", value: "Proportional de-vig, averaged", effect: "Each bookmaker's full market is de-vigged; partial markets are skipped so a missing outcome is not priced as impossible." },
      { name: "Confidence score", value: "min(model, consensus) ÷ max × 100", effect: "Agreement between the model and the market; tickets require a minimum score." },
      { name: "Away match winner (paper control)", value: `No Value/High; Standard p ≥ ${pct(AWAY_WIN_STANDARD_MIN_MODEL_PROBABILITY, 0)}, odds < ${AWAY_WIN_STANDARD_MAX_ODDS_EXCLUSIVE.toFixed(2)}`, effect: "Prospective restriction after the observed Away-leg shortfall; every tier's allow/reject result is retained in the candidate snapshot." }
    ]
  },
  {
    title: "Ticket construction",
    rows: [
      ...TICKET_TIERS.map((tier) => ({ name: `${tier.key} tier`, value: tier.maxOddsExclusive === null ? `≥ ${tier.minOdds}` : `${tier.minOdds} – < ${tier.maxOddsExclusive}`, effect: "Combined decimal odds band for the tier's accumulator." })),
      { name: "Confidence thresholds", value: CONFIDENCE_THRESHOLDS.join(" → "), effect: `Tried strictest first; a ticket built below ${CONFIDENCE_THRESHOLDS[0]} is marked relaxed.` },
      { name: "Legs per ticket", value: `≥ ${MIN_TICKET_LEGS}, ≤ ${MAX_LEGS_PER_LEAGUE} per competition`, effect: "Accumulators only, with a cap on legs from one competition." },
      { name: "Bookmaker", value: "One per ticket, by priority", effect: "Active bookmakers are tried in priority order; every leg of a ticket uses the same one." },
      { name: "Fixture overlap", value: "None across tiers", effect: "Tiers never share a fixture, so one result cannot sink several tickets; STANDARD picks first." }
    ]
  },
  {
    title: "Pipeline",
    rows: [
      { name: "Selection window", value: `${SELECTION_WINDOW_HOURS} h`, effect: "Morning selection-window forecasts and paper tickets use this horizon. Evening preliminary forecasts cover tomorrow's full Malawi calendar day." },
      ...DAILY_JOB_SCHEDULE.map((job) => ({ name: label(job.jobType), value: `${job.utcTime} UTC`, effect: "Daily job created idempotently; the runner picks it up on its next pass after this time." })),
      { name: "Job lease / retry", value: `${JOB_LEASE_MINUTES} min / ${JOB_RETRY_MINUTES} min`, effect: "A claimed job not finished within the lease is requeued; a failed job retries after the delay." }
    ]
  }
];

const signedUnits = (value: number, digits = 2) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
const roi = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
const tone = (value: number | null) => value === null || value === 0 ? "" : value > 0 ? "positive" : "negative";
const pickGroupLabel = (group: string) => group === "ALL" ? "All markets" : group.split(":").map(label).join(" · ");

function PickTable({ caption, firstColumn, rows }: { caption: string; firstColumn: string; rows: PickPerformance[] }) {
  return <div className="matches-table-wrap">
    <table className="analysis-table">
      <caption>{caption}</caption>
      <thead>
        <tr><th scope="col">{firstColumn}</th><th scope="col">Picks</th><th scope="col">Hit rate</th><th scope="col">Expected</th><th scope="col">Priced</th><th scope="col">Avg odds</th><th scope="col">Profit (units)</th><th scope="col">ROI ± 1 s.e.</th><th scope="col">Value picks</th><th scope="col">Value hit rate</th><th scope="col">Value ROI</th></tr>
      </thead>
      <tbody>{rows.map((row) => <tr key={row.group} className={row.group === "ALL" ? "total" : undefined}>
        <th scope="row">{pickGroupLabel(row.group)}</th>
        <td className="num">{count(row.picks)}</td>
        <td className="num">{pct(row.hitRate)} <small>({count(row.hits)})</small></td>
        <td className="num">{pct(row.expectedHitRate)}</td>
        <td className="num">{count(row.priced)}</td>
        <td className="num">{num(row.avgOdds)}</td>
        <td className={`num ${row.priced ? tone(row.profitUnits) : ""}`}>{row.priced ? signedUnits(row.profitUnits) : "—"}</td>
        <td className={`num ${tone(row.roiPercent)}`}>{roi(row.roiPercent)}{row.roiStdErrPercent === null ? null : <small> ± {row.roiStdErrPercent.toFixed(1)}</small>}</td>
        <td className="num">{count(row.valuePicks)}</td>
        <td className="num">{pct(row.valueHitRate)}</td>
        <td className={`num ${tone(row.valueRoiPercent)}`}>{roi(row.valueRoiPercent)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function CandidateUniverseTable({ caption, firstColumn, rows }: { caption: string; firstColumn: string; rows: CandidateCohortPerformance[] }) {
  return <div className="matches-table-wrap">
    <table className="analysis-table">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">{firstColumn}</th><th scope="col">Cohort</th><th scope="col">Legs</th><th scope="col">W / L / pending</th><th scope="col">Hit rate</th><th scope="col">Expected</th><th scope="col">Paper profit</th><th scope="col">Paper ROI</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={`${row.group}-${row.cohort}`} className={row.group === "ALL" ? "total" : undefined}>
        <th scope="row">{row.group === "ALL" ? "All captured candidates" : pickGroupLabel(row.group)}</th>
        <td>{row.cohort}</td>
        <td className="num">{count(row.legs)}</td>
        <td className="num">{row.wins} / {row.losses} / {row.pending}</td>
        <td className="num">{pct(row.hitRate)}</td>
        <td className="num">{pct(row.expectedHitRate)}</td>
        <td className={`num ${row.wins + row.losses ? tone(row.profitUnits) : ""}`}>{row.wins + row.losses ? signedUnits(row.profitUnits) : "—"}</td>
        <td className={`num ${tone(row.roiPercent)}`}>{roi(row.roiPercent)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function ReliabilityChart({ buckets }: { buckets: CalibrationBucket[] }) {
  const size = 260; const pad = 34; const plot = size - pad - 10;
  const x = (value: number) => pad + value * plot;
  const y = (value: number) => 10 + (1 - value) * plot;
  const filled = buckets.filter((bucket) => bucket.predictions > 0 && bucket.meanPredicted !== null && bucket.observedRate !== null);
  const maxCount = Math.max(1, ...filled.map((bucket) => bucket.predictions));
  return <svg className="reliability-chart" viewBox={`0 0 ${size} ${size}`} role="img" aria-labelledby="reliability-title reliability-desc">
    <title id="reliability-title">Reliability diagram</title>
    <desc id="reliability-desc">Observed frequency against mean predicted probability for each probability bucket. Points on the diagonal are perfectly calibrated. The table beside it lists the same values.</desc>
    {[0, 0.25, 0.5, 0.75, 1].map((tick) => <g key={tick}>
      <line className="reliability-grid" x1={x(0)} x2={x(1)} y1={y(tick)} y2={y(tick)} />
      <text className="reliability-tick" x={pad - 6} y={y(tick) + 3} textAnchor="end">{tick * 100}</text>
      <text className="reliability-tick" x={x(tick)} y={size - 14} textAnchor="middle">{tick * 100}</text>
    </g>)}
    <line className="reliability-diagonal" x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} />
    {filled.map((bucket) => <circle key={bucket.lower} className="reliability-point" cx={x(bucket.meanPredicted!)} cy={y(bucket.observedRate!)} r={4 + 5 * Math.sqrt(bucket.predictions / maxCount)}>
      <title>{`${pct(bucket.lower, 0)}–${pct(bucket.upper, 0)}: predicted ${pct(bucket.meanPredicted)}, observed ${pct(bucket.observedRate)} (${count(bucket.predictions)} forecasts)`}</title>
    </circle>)}
    <text className="reliability-axis" x={x(0.5)} y={size - 1} textAnchor="middle">Predicted %</text>
    <text className="reliability-axis" x={10} y={y(0.5)} textAnchor="middle" transform={`rotate(-90 10 ${y(0.5)})`}>Observed %</text>
  </svg>;
}

function PickFilterForm({ range, filter, groups }: { range: DayRange; filter: PickFilter; groups: string[] }) {
  const markets = [...new Set(groups.map((group) => group.split(":")[0]!))];
  const current = filter.market === null ? "" : filter.selection === null ? filter.market : `${filter.market}:${filter.selection}`;
  const period: Record<string, string> = range.preset === "custom" ? { from: range.from!, to: range.to! } : { range: range.preset };
  const clearHref = `/analysis?${new URLSearchParams(period).toString()}#picks`;
  return <form className="date-form analysis-pick-filter" action="/analysis#picks" method="get" aria-label="Filter model picks">
    {Object.entries(period).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
    <label>Pick
      <select name="pick" defaultValue={current}>
        <option value="">All picks</option>
        {markets.map((market) => <optgroup key={market} label={label(market)}>
          <option value={market}>Any {label(market).toLowerCase()} pick</option>
          {groups.filter((group) => group.startsWith(`${market}:`)).map((group) => <option key={group} value={group}>{pickGroupLabel(group)}</option>)}
        </optgroup>)}
      </select>
    </label>
    <label>Min odds <input type="number" name="minOdds" min="1.01" max="1000" step="0.01" inputMode="decimal" placeholder="Any" defaultValue={filter.minOdds ?? ""} /></label>
    <button type="submit" className="date-go">Apply</button>
    {isPickFilterActive(filter) && <a className="date-chip" href={clearHref}>Clear filter</a>}
  </form>;
}

function describeFilter(filter: PickFilter): string {
  const pick = filter.market === null ? "all picks" : filter.selection === null ? `${label(filter.market).toLowerCase()} picks` : pickGroupLabel(`${filter.market}:${filter.selection}`);
  return filter.minOdds === null ? pick : `${pick} at odds ≥ ${filter.minOdds.toFixed(2)}`;
}

export default async function AnalysisPage({ searchParams }: { searchParams: Promise<{ range?: string | string[]; from?: string | string[]; to?: string | string[]; pick?: string | string[]; minOdds?: string | string[] }> }) {
  const session = isAuthDisabled() ? { user: { email: LOCAL_ACCESS_EMAIL, role: "ADMIN" as const } } : await auth();
  if (!session?.user?.email) redirect("/signin");
  if (session.user.role !== "ADMIN") redirect("/signin");

  const params = await searchParams;
  const now = new Date();
  const today = utcToday(now);
  const range = resolveDayRange(params, today);
  const period = rangeLabel(range);

  const [pipeline, funnel, model, calibration, tickets] = await Promise.all([
    loadPipelineHealth(now), loadUpcomingFunnel(now), loadModelCoverage(now), loadCalibration(range), loadTicketPerformance(range)
  ]);
  const pickFilter = parsePickFilter(params);
  const picks = await loadModelPicks(range, calibration.rows, pickFilter);

  const pooled = calibration.byMarket.find((row) => row.market === "ALL") ?? null;
  const allPicks = picks.overall;
  const ticketTotals = tickets.tiers.reduce((sum, tier) => ({ wins: sum.wins + tier.wins, decided: sum.decided + tier.wins + tier.losses }), { wins: 0, decided: 0 });
  const failingJobs = pipeline.jobHealth.filter((job) => job.latestStatus !== "DONE" && job.lastError).length;
  const todayQuota = pipeline.quota.find((row) => row.usageDate.toISOString().slice(0, 10) === today) ?? null;
  const funnelMax = Math.max(1, funnel.steps[0]!.count);

  return (
    <section className="analysis">
      <p className="eyebrow">SYSTEM ANALYSIS</p>
      <h1>Model &amp; pipeline</h1>
      <p>Every parameter that shapes a paper ticket, from the rules the jobs apply to how the model and tickets have actually performed. The rule values below come from the same code the jobs run.</p>

      <nav className="analysis-toc" aria-label="Analysis sections">
        {SECTIONS.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
      </nav>

      <RangeNav basePath="/analysis" range={range} today={today} />
      <p className="meta">Performance period: <strong>{period}</strong>. The period applies to calibration and ticket performance; parameters, pipeline health, the funnel and model coverage always show the current state.</p>
      <FixtureCalendar now={now} basePath="/research" />

      <div className="analysis-kpis" aria-label="Headline figures">
        <article><small>Modelled competitions</small><strong>{count(model.competitions)}</strong><span>{model.stale > 0 ? `${count(model.stale)} older than ${model.staleBeforeHours}h` : "All trained recently"}</span></article>
        <article><small>Next {funnel.windowHours}h</small><strong>{count(funnel.steps[2]!.count)} / {count(funnel.steps[0]!.count)}</strong><span>fixtures with a prediction</span></article>
        <article><small>Brier · {period}</small><strong>{pooled ? pooled.brier.toFixed(4) : "—"}</strong><span>{count(calibration.scored)} scored forecasts</span></article>
        <article><small>Model pick ROI · {period}</small><strong>{roi(allPicks?.roiPercent ?? null)}</strong><span>{allPicks ? `${pct(allPicks.hitRate)} hit rate · ${count(allPicks.priced)} priced picks` : "No scored picks"}</span></article>
        <article><small>Ticket hit rate · {period}</small><strong>{ticketTotals.decided ? pct(ticketTotals.wins / ticketTotals.decided) : "—"}</strong><span>{count(tickets.tickets)} tickets, {count(ticketTotals.decided)} decided</span></article>
        <article><small>Average CLV</small><strong>{tickets.clv === null ? "—" : `${tickets.clv.toFixed(2)}%`}</strong><span>settled legs in period</span></article>
        <article className={failingJobs > 0 ? "attention" : undefined}><small>Jobs needing attention</small><strong>{failingJobs}</strong><span>{todayQuota ? `API ${count(todayQuota.requestCount)} / ${count(todayQuota.quotaLimit)} today` : "No API calls today"}</span></article>
      </div>

      <section id="parameters" className="analysis-section" aria-labelledby="parameters-title">
        <h2 id="parameters-title">Decision parameters</h2>
        <p className="meta">Configured rules. Changing one means changing code in <code>@highodds/core</code>; this page updates with it. The API plan quota is set per environment and shown under pipeline health; HighOdds does not cap its own usage.</p>
        {PARAMETER_GROUPS.map((group) => <div key={group.title} className="matches-table-wrap">
          <table className="analysis-table param-table">
            <caption>{group.title}</caption>
            <thead><tr><th scope="col">Parameter</th><th scope="col">Value</th><th scope="col">Effect</th></tr></thead>
            <tbody>{group.rows.map((row) => <tr key={row.name}><th scope="row">{row.name}</th><td className="num">{row.value}</td><td>{row.effect}</td></tr>)}</tbody>
          </table>
        </div>)}
      </section>

      <section id="pipeline" className="analysis-section" aria-labelledby="pipeline-title">
        <h2 id="pipeline-title">Pipeline health</h2>
        <div className="analysis-split">
          <div className="matches-table-wrap">
            <table className="analysis-table">
              <caption>Data freshness</caption>
              <thead><tr><th scope="col">Latest</th><th scope="col">When (Blantyre)</th><th scope="col">Age</th></tr></thead>
              <tbody>{pipeline.freshness.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td className="num">{when(row.at)}</td><td className="num">{ago(row.at, now)}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="matches-table-wrap">
            <table className="analysis-table">
              <caption>Inventory</caption>
              <tbody>
                <tr><th scope="row">Competitions / teams</th><td className="num">{count(pipeline.inventory.competitions)} / {count(pipeline.inventory.teams)}</td></tr>
                <tr><th scope="row">Fixtures by status</th><td>{["SCHEDULED", "LIVE", "FINISHED", "POSTPONED", "CANCELLED"].map((status) => `${label(status).toLowerCase()} ${count(pipeline.fixturesByStatus[status] ?? 0)}`).join(" · ")}</td></tr>
                <tr><th scope="row">Bookmakers active</th><td className="num">{count(pipeline.inventory.activeBookmakers)} of {count(pipeline.inventory.bookmakers)}</td></tr>
                <tr><th scope="row">Markets normalised</th><td className="num">{count(pipeline.inventory.normalizedMarkets)} of {count(pipeline.inventory.markets)}</td></tr>
                <tr><th scope="row">Odds quotes / predictions</th><td className="num">{count(pipeline.inventory.quotes)} / {count(pipeline.inventory.predictions)}</td></tr>
                <tr><th scope="row">Model runs</th><td className="num">{count(pipeline.inventory.modelRuns)}</td></tr>
                <tr className={pipeline.overdueResults > 0 ? "attention" : undefined}><th scope="row">Results overdue</th><td className="num">{count(pipeline.overdueResults)} fixtures still open {pipeline.overdueResultHours}h+ after kickoff</td></tr>
                <tr className={pipeline.unsettledLocked > 0 ? "attention" : undefined}><th scope="row">Locked, unsettled tickets</th><td className="num">{count(pipeline.unsettledLocked)}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="matches-table-wrap">
          <table className="analysis-table">
            <caption>Jobs · last {pipeline.jobHistoryDays} days</caption>
            <thead><tr><th scope="col">Job</th><th scope="col">Latest status</th><th scope="col">Run after</th><th scope="col">Attempts</th><th scope="col">Last completed</th><th scope="col">Done / runs</th><th scope="col">Last error</th></tr></thead>
            <tbody>{pipeline.jobHealth.length === 0 ? <tr><td colSpan={7}>No job runs recorded in this window.</td></tr> : pipeline.jobHealth.map((job) => <tr key={job.jobType} className={job.latestStatus !== "DONE" && job.lastError ? "attention" : undefined}>
              <th scope="row">{label(job.jobType)}</th>
              <td><span className={`status-badge ${job.latestStatus === "DONE" ? "win" : job.latestStatus === "FAILED" || job.lastError ? "loss" : "pending"}`}>{job.latestStatus}</span></td>
              <td className="num">{when(job.latestRunAfter)}</td>
              <td className="num">{job.latestAttempts}</td>
              <td className="num">{when(job.lastCompletedAt)}</td>
              <td className="num">{job.done} / {job.runs}</td>
              <td className="analysis-error">{!job.lastError ? "—" : job.latestStatus === "DONE" ? <small>Earlier attempt: {job.lastError}</small> : job.lastError}</td>
            </tr>)}</tbody>
          </table>
        </div>

        <div className="matches-table-wrap">
          <table className="analysis-table">
            <caption>API-Football quota · last 7 days used</caption>
            <thead><tr><th scope="col">Day (UTC)</th><th scope="col">HighOdds requests</th><th scope="col">Plan quota (shared key)</th><th scope="col">HighOdds share</th></tr></thead>
            <tbody>{pipeline.quota.length === 0 ? <tr><td colSpan={4}>No API usage recorded.</td></tr> : pipeline.quota.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.usageDate.toISOString().slice(0, 10)}</th>
                <td className="num">{count(row.requestCount)}</td>
                <td className="num">{count(row.quotaLimit)}</td>
                <td className="num">{pct(row.quotaLimit > 0 ? row.requestCount / row.quotaLimit : null, 0)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section id="funnel" className="analysis-section" aria-labelledby="funnel-title">
        <h2 id="funnel-title">Next {funnel.windowHours}h funnel</h2>
        <p className="meta">How today&apos;s selection window narrows through each gate, measured now. A fixture needs both a prediction and a fresh price before it can become a candidate leg; the odds, EV and confidence gates then apply per selection.</p>
        <ol className="analysis-funnel">
          {funnel.steps.map((step) => <li key={step.label}>
            <div className="analysis-funnel-label"><strong>{step.label}</strong><small>{step.note}</small></div>
            <div className="analysis-funnel-bar" aria-hidden="true"><span style={{ width: `${Math.max(step.count > 0 ? 1.5 : 0, step.count / funnelMax * 100)}%` }} /></div>
            <span className="analysis-funnel-count">{count(step.count)}</span>
          </li>)}
        </ol>
      </section>

      <section id="model" className="analysis-section" aria-labelledby="model-title">
        <h2 id="model-title">Model coverage</h2>
        <p className="meta">Latest fitted parameters per competition ({model.methods.join(", ") || "no method recorded"}). Home advantage is the multiplier on the home side&apos;s expected goals; 1.00 means none.</p>
        <div className="analysis-kpis compact">
          <article><small>Competitions</small><strong>{count(model.competitions)}</strong><span>{count(model.stale)} stale (&gt; {model.staleBeforeHours}h)</span></article>
          <article><small>Home advantage</small><strong>{num(model.medianHomeAdvantage)}</strong><span>median · range {num(model.minHomeAdvantage)}–{num(model.maxHomeAdvantage)}</span></article>
          <article><small>Goals per team-match</small><strong>{num(model.medianLeagueAverageGoals)}</strong><span>median league average</span></article>
          <article><small>Matches / teams</small><strong>{num(model.medianMatches, 0)} / {num(model.medianTeams, 0)}</strong><span>median per competition</span></article>
          <article><small>Trained through</small><strong>{model.newestTrainedUntil ? ago(model.newestTrainedUntil, now) : "—"}</strong><span>oldest {model.oldestTrainedUntil ? ago(model.oldestTrainedUntil, now) : "—"}</span></article>
        </div>
        {model.largest.length === 0 ? <div className="notice">No competition has a trained model yet. TRAIN_MODEL needs {LEAGUE_MIN_MATCHES} finished matches in the last {HISTORY_LOOKBACK_DAYS} days.</div> : <div className="matches-table-wrap">
          <table className="analysis-table">
            <caption>Largest {model.largest.length} of {count(model.competitions)} modelled competitions, by training matches</caption>
            <thead><tr><th scope="col">Competition</th><th scope="col">Matches</th><th scope="col">Teams</th><th scope="col">Home adv.</th><th scope="col">League avg goals</th><th scope="col">Trained through</th></tr></thead>
            <tbody>{model.largest.map((row) => {
              const stale = now.getTime() - row.trainedUntil.getTime() > model.staleBeforeHours * 3600000;
              return <tr key={row.competitionId} className={stale ? "attention" : undefined}>
                <th scope="row">{row.name}{row.country ? <small> · {row.country}</small> : null}</th>
                <td className="num">{count(row.matches)}</td>
                <td className="num">{count(row.teams)}</td>
                <td className="num">{num(row.homeAdvantage)}</td>
                <td className="num">{num(row.leagueAverageGoals)}</td>
                <td className="num">{when(row.trainedUntil)}{stale ? " · stale" : ""}</td>
              </tr>;
            })}</tbody>
          </table>
        </div>}
      </section>

      <section id="calibration" className="analysis-section" aria-labelledby="calibration-title">
        <h2 id="calibration-title">Calibration</h2>
        <p className="meta">Showing <strong>{period}</strong>. Calibration uses fixtures kicking off in these days (Blantyre time); ticket figures use the tickets&apos; UTC target dates. Walk-forward rules match the Results page: the latest forecast per selection, made before kickoff by a model trained no later. {count(calibration.excluded)} rows were excluded as late, look-ahead or unresolvable.</p>
        {calibration.scored === 0 ? <div className="notice">No finished fixtures with a walk-forward prediction in {period}. Calibration appears once predicted fixtures finish.</div> : <>
          <div className="matches-table-wrap">
            <table className="analysis-table">
              <caption>Scores by market</caption>
              <thead><tr><th scope="col">Market</th><th scope="col">Fixtures</th><th scope="col">Forecasts</th><th scope="col">Brier</th><th scope="col">Log-loss</th><th scope="col">Top pick hit rate</th></tr></thead>
              <tbody>{calibration.byMarket.map((row) => <tr key={row.market} className={row.market === "ALL" ? "total" : undefined}>
                <th scope="row">{row.market === "ALL" ? "All markets" : label(row.market)}</th>
                <td className="num">{count(row.fixtures)}</td>
                <td className="num">{count(row.predictions)}</td>
                <td className="num">{row.brier.toFixed(4)}</td>
                <td className="num">{row.logLoss.toFixed(4)}</td>
                <td className="num">{pct(row.pickAccuracy)} <small>({count(row.pickHits)})</small></td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="meta">Brier and log-loss are per selection; lower is better. For reference, always forecasting 50% on a two-way market scores a Brier of 0.25.</p>

          <div className="matches-table-wrap">
            <table className="analysis-table">
              <caption>Bias by selection</caption>
              <thead><tr><th scope="col">Market</th><th scope="col">Selection</th><th scope="col">Forecasts</th><th scope="col">Mean predicted</th><th scope="col">Observed</th><th scope="col">Bias</th></tr></thead>
              <tbody>{calibration.bySelection.map((row) => <tr key={`${row.market}-${row.selection}`}>
                <th scope="row">{label(row.market)}</th>
                <td>{label(row.selection)}</td>
                <td className="num">{count(row.predictions)}</td>
                <td className="num">{pct(row.meanPredicted)}</td>
                <td className="num">{pct(row.observedRate)}</td>
                <td className={`num ${Math.abs(row.bias) >= 0.03 ? "analysis-bias" : ""}`}>{signedPp(row.bias)}{Math.abs(row.bias) >= 0.03 ? (row.bias > 0 ? " · overrated" : " · underrated") : ""}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="meta">Bias is mean predicted minus observed rate, in percentage points. Gaps of 3 pp or more are labelled.</p>

          <details className="analysis-details">
            <summary>Probability calibration by market and selection</summary>
            <p className="meta">Five probability bands are evaluated separately for each selection. Cohorts below 30 forecasts are exploratory and are not promotion evidence.</p>
            <div className="matches-table-wrap">
              <table className="analysis-table">
                <caption>Walk-forward reliability by selection and probability band</caption>
                <thead><tr><th scope="col">Market</th><th scope="col">Selection</th><th scope="col">Band</th><th scope="col">Forecasts</th><th scope="col">Predicted</th><th scope="col">Observed</th><th scope="col">Gap</th><th scope="col">Evidence</th></tr></thead>
                <tbody>{calibration.bySelectionProbability.map((row) => <tr key={`${row.market}-${row.selection}-${row.lower}`} className={row.exploratory ? "attention" : undefined}>
                  <th scope="row">{label(row.market)}</th><td>{label(row.selection)}</td><td>{pct(row.lower, 0)}–{pct(row.upper, 0)}</td>
                  <td className="num">{count(row.predictions)}</td><td className="num">{pct(row.meanPredicted)}</td><td className="num">{pct(row.observedRate)}</td>
                  <td className="num">{row.meanPredicted === null || row.observedRate === null ? "—" : signedPp(row.observedRate - row.meanPredicted)}</td><td>{row.exploratory ? "Exploratory" : "30+ forecasts"}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </details>

          <details className="analysis-details">
            <summary>Calibration by competition and selection</summary>
            <div className="matches-table-wrap">
              <table className="analysis-table">
                <caption>Walk-forward forecasts; cohorts below 30 are exploratory</caption>
                <thead><tr><th scope="col">Competition</th><th scope="col">Market</th><th scope="col">Selection</th><th scope="col">Forecasts</th><th scope="col">Predicted</th><th scope="col">Observed</th><th scope="col">Bias</th><th scope="col">Evidence</th></tr></thead>
                <tbody>{calibration.byCompetitionSelection.map((row) => <tr key={`${row.competition}-${row.market}-${row.selection}`} className={row.exploratory ? "attention" : undefined}>
                  <th scope="row">{row.competition}</th><td>{label(row.market)}</td><td>{label(row.selection)}</td>
                  <td className="num">{count(row.predictions)}</td><td className="num">{pct(row.meanPredicted)}</td><td className="num">{pct(row.observedRate)}</td>
                  <td className={`num ${Math.abs(row.bias) >= 0.03 ? "analysis-bias" : ""}`}>{signedPp(row.bias)}</td><td>{row.exploratory ? "Exploratory" : "30+ forecasts"}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </details>

          <div className="analysis-split reliability">
            <figure className="analysis-figure">
              <ReliabilityChart buckets={calibration.buckets} />
              <figcaption>Each dot is one probability bucket; larger dots hold more forecasts. Dots above the diagonal mean the outcome happened more often than predicted.</figcaption>
            </figure>
            <div className="matches-table-wrap">
              <table className="analysis-table">
                <caption>Reliability by probability bucket</caption>
                <thead><tr><th scope="col">Bucket</th><th scope="col">Forecasts</th><th scope="col">Predicted</th><th scope="col">Observed</th><th scope="col">Gap</th></tr></thead>
                <tbody>{calibration.buckets.map((bucket) => <tr key={bucket.lower}>
                  <th scope="row">{pct(bucket.lower, 0)}–{pct(bucket.upper, 0)}</th>
                  <td className="num">{count(bucket.predictions)}</td>
                  <td className="num">{pct(bucket.meanPredicted)}</td>
                  <td className="num">{pct(bucket.observedRate)}</td>
                  <td className="num">{bucket.meanPredicted === null || bucket.observedRate === null ? "—" : signedPp(bucket.observedRate - bucket.meanPredicted)}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </div>
        </>}
      </section>

      <section id="picks" className="analysis-section" aria-labelledby="picks-title">
        <h2 id="picks-title">Model picks</h2>
        <p className="meta">Every finished fixture kicking off in <strong>{period}</strong>, not only the ones on tickets. The model pick is each market&apos;s highest-probability selection, as on the Research page, from the same walk-forward forecasts as calibration. ROI stakes one unit on every pick at its last pre-kickoff price from the highest-priority active bookmaker that quoted it; picks with no captured price count towards hit rate but not ROI.</p>
        {picks.total > 0 && <PickFilterForm range={range} filter={pickFilter} groups={picks.groups} />}
        {isPickFilterActive(pickFilter) && picks.total > 0 && <p className="meta" role="status">Showing <strong>{describeFilter(pickFilter)}</strong>: {count(picks.picks)} of {count(picks.total)} picks.{pickFilter.minOdds !== null ? " A minimum price leaves out picks with no captured price, so hit rate and ROI cover the same bets." : ""}</p>}
        {picks.total === 0 ? <div className="notice">No finished fixtures with a walk-forward pick in {period}.</div> : picks.picks === 0 ? <div className="notice">No picks match {describeFilter(pickFilter)} in {period}.</div> : <>
          <PickTable caption="By market" firstColumn="Market" rows={picks.byMarket} />
          <PickTable caption="By selection" firstColumn="Pick" rows={picks.bySelection} />
          <PickTable caption="By model confidence" firstColumn="Pick probability" rows={picks.byBand} />
          <p className="meta">Expected is the model&apos;s mean probability for the same picks; a hit rate below it means the model is overconfident. A value pick has probability × closing odds above 1, before the {pct(EV_HAIRCUT, 0)} ticket haircut. The ± figure is one standard error: an ROI within about two of them of zero is not distinguishable from luck.</p>
        </>}
      </section>

      <section id="tickets" className="analysis-section" aria-labelledby="tickets-title">
        <h2 id="tickets-title">Ticket performance</h2>
        <p className="meta">Current (non-superseded) ticket versions targeted in <strong>{period}</strong>. Expected hit rate is the model&apos;s own win probability for the same decided tickets or legs; a hit rate well below it means the model is overconfident on what it publishes.</p>
        {tickets.tickets === 0 ? <div className="notice">No paper tickets were published for {period}.</div> : <>
          <div className="matches-table-wrap">
            <table className="analysis-table">
              <caption>By tier</caption>
              <thead><tr><th scope="col">Tier</th><th scope="col">Published</th><th scope="col">W / L / V / pending</th><th scope="col">Hit rate</th><th scope="col">Expected</th><th scope="col">Profit (units)</th><th scope="col">ROI</th><th scope="col">Avg legs</th><th scope="col">Avg odds</th><th scope="col">Relaxed</th></tr></thead>
              <tbody>{tickets.tiers.map((tier) => <tr key={tier.tier}>
                <th scope="row">{tier.tier}</th>
                <td className="num">{count(tier.published)}</td>
                <td className="num">{tier.wins} / {tier.losses} / {tier.voids} / {tier.pending}</td>
                <td className="num">{pct(tier.hitRate)}</td>
                <td className="num">{pct(tier.expectedHitRate)}</td>
                <td className={`num ${tier.profitUnits > 0 ? "positive" : tier.profitUnits < 0 ? "negative" : ""}`}>{tier.settled ? tier.profitUnits.toFixed(2) : "—"}</td>
                <td className="num">{tier.roiPercent === null ? "—" : `${tier.roiPercent.toFixed(1)}%`}</td>
                <td className="num">{num(tier.avgLegs, 1)}</td>
                <td className="num">{num(tier.avgCombinedOdds)}</td>
                <td className="num">{pct(tier.relaxedShare, 0)}</td>
              </tr>)}</tbody>
            </table>
          </div>

          <div className="matches-table-wrap">
            <table className="analysis-table">
              <caption>Legs by market</caption>
              <thead><tr><th scope="col">Market</th><th scope="col">Legs</th><th scope="col">W / L / V / pending</th><th scope="col">Hit rate</th><th scope="col">Expected</th><th scope="col">Avg odds</th><th scope="col">Avg model edge</th><th scope="col">Avg confidence</th></tr></thead>
              <tbody>{tickets.markets.map((row) => <tr key={row.market} className={row.market === "ALL" ? "total" : undefined}>
                <th scope="row">{row.market === "ALL" ? "All markets" : label(row.market)}</th>
                <td className="num">{count(row.legs)}</td>
                <td className="num">{row.wins} / {row.losses} / {row.voids} / {row.pending}</td>
                <td className="num">{pct(row.hitRate)}</td>
                <td className="num">{pct(row.expectedHitRate)}</td>
                <td className="num">{num(row.avgOdds)}</td>
                <td className="num">{row.avgEdgePercent === null ? "—" : `${row.avgEdgePercent.toFixed(1)}%`}</td>
                <td className="num">{num(row.avgConfidence, 0)}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="matches-table-wrap">
            <table className="analysis-table">
              <caption>Post-publication quote capture cadence</caption>
              <thead><tr><th scope="col">Market</th><th scope="col">Ticket legs</th><th scope="col">Legs with later quote</th><th scope="col">Update coverage</th><th scope="col">Mean later quotes</th><th scope="col">Valid CLV legs</th><th scope="col">Mean CLV</th></tr></thead>
              <tbody>{tickets.quoteCadence.byMarket.map((row) => <tr key={row.group}>
                <th scope="row">{label(row.group)}</th><td className="num">{count(row.legs)}</td><td className="num">{count(row.legsWithPostPublicationUpdate)}</td>
                <td className="num">{pct(row.updateCoverage)}</td><td className="num">{num(row.meanPostPublicationUpdates, 1)}</td><td className="num">{count(row.legsWithValidClv)}</td>
                <td className="num">{row.meanClvPercent === null ? "—" : `${row.meanClvPercent.toFixed(2)}%`}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="meta">CLV is now unavailable unless a strictly later same-bookmaker quote was captured before kickoff. Model edge is probability × odds − 1 before the {pct(EV_HAIRCUT, 0)} haircut. Confidence thresholds used: {tickets.thresholds.map((row) => `${row.threshold} (${row.count})`).join(", ")}.</p>
          <div className="notice" role="status">Accumulator correlation review: {count(tickets.correlation.flaggedTickets)} of {count(tickets.correlation.ticketsChecked)} tickets contain multiple selections from the same fixture. {tickets.correlation.flaggedPairs.length === 0 ? "No same-fixture correlation flags were found in this period." : "These combinations should not be interpreted as independent legs without a deliberate joint-probability model."}</div>
        </>}
      </section>

      <section id="candidates" className="analysis-section" aria-labelledby="candidates-title">
        <h2 id="candidates-title">Candidate universe</h2>
        <p className="meta">Prospective paper comparison only. Each included publication stores every contemporaneous prediction-plus-complete-market candidate, its captured quote, model and consensus probabilities, confidence, conservative EV and tier-policy gate result. “Eligible not selected” was allowed in at least one tier but was not used in the published accumulator; it is not a simulated replacement ticket. Profit stakes one unit per finished leg at its captured price, so it tests legs rather than claiming accumulator returns.</p>
        {tickets.candidateUniverse.snapshotRuns === 0 ? <div className="notice">No ticket in {period} has a captured candidate universe yet. This is intentional: existing tickets are not reconstructed using hindsight. The report begins with publications after the candidate-universe migration is deployed.</div> : <>
          <div className="analysis-kpis compact">
            <article><small>Publication snapshots</small><strong>{count(tickets.candidateUniverse.snapshotRuns)}</strong><span>immutable candidate universes</span></article>
            <article><small>Candidates captured</small><strong>{count(tickets.candidateUniverse.captured)}</strong><span>{count(tickets.candidateUniverse.eligible)} cleared leg-level gates</span></article>
            <article><small>Selected legs</small><strong>{count(tickets.candidateUniverse.selected)}</strong><span>{count(tickets.candidateUniverse.selectedWithoutEligibility)} selected outside eligibility</span></article>
          </div>
          {tickets.candidateUniverse.selectedWithoutEligibility > 0 && <div className="notice">Data integrity alert: selected legs should always be eligible at their captured decision time. Investigate before interpreting this report.</div>}
          <CandidateUniverseTable caption="Selected versus eligible but not selected" firstColumn="Universe" rows={tickets.candidateUniverse.cohorts} />
          <details className="analysis-details">
            <summary>Break down the same cohorts</summary>
            <CandidateUniverseTable caption="By market and selection" firstColumn="Market · selection" rows={tickets.candidateUniverse.byMarket} />
            <CandidateUniverseTable caption="By captured odds band" firstColumn="Odds band" rows={tickets.candidateUniverse.byOddsBand} />
            <CandidateUniverseTable caption="By model probability band" firstColumn="Probability band" rows={tickets.candidateUniverse.byProbabilityBand} />
            <CandidateUniverseTable caption="By competition" firstColumn="Competition" rows={tickets.candidateUniverse.byCompetition} />
            <CandidateUniverseTable caption="By bookmaker" firstColumn="Bookmaker" rows={tickets.candidateUniverse.byBookmaker} />
            <CandidateUniverseTable caption="By confidence agreement" firstColumn="Confidence" rows={tickets.candidateUniverse.byConfidence} />
            <CandidateUniverseTable caption="By published tier and threshold" firstColumn="Tier / threshold" rows={tickets.candidateUniverse.byTier} />
          </details>
          <p className="meta">Do not promote an alternative from these tables alone: the samples start only after deployment, may be small, and selected and non-selected candidates are not exchangeable ticket constructions. Use them to diagnose calibration and price failures, then evaluate pre-declared two-leg, strict-confidence, no-same-league and inverse arms prospectively in separate paper cohorts.</p>
        </>}
      </section>
    </section>
  );
}
