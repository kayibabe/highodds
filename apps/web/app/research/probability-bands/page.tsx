import Link from "next/link";
import { db } from "@highodds/db";
import { legOutcome, PAPER_POLICY, type PaperArm, type PaperCandidate } from "@highodds/core";

export const dynamic = "force-dynamic";

const ARMS = ["baseline", "btts_yes", "calibrated_value"] as const;
type ArmName = (typeof ARMS)[number];
type Evidence = { candidates: PaperCandidate[]; arms: PaperArm[] };
type PickRow = {
  decisionId: string;
  kickoff: Date;
  decidedAt: Date;
  home: string;
  away: string;
  competition: string;
  arm: ArmName;
  market: string;
  selection: string;
  probability: number;
  marketProbability: number | null;
  odds: number;
  expectedReturn: number | null;
  outcome: "WIN" | "LOSS" | "VOID" | "PENDING" | "UNRESOLVED";
};

const ARM_NAMES: Record<ArmName, string> = {
  baseline: "Current model comparator",
  btts_yes: "BTTS Yes research",
  calibrated_value: "Calibrated value"
};
const MARKET_NAMES: Record<string, string> = { MATCH_WINNER: "Match winner", TOTAL_GOALS: "Total goals", BTTS: "Both teams score" };
const SELECTION_NAMES: Record<string, string> = { HOME: "Home", DRAW: "Draw", AWAY: "Away", OVER_2_5: "Over 2.5 goals", UNDER_2_5: "Under 2.5 goals", YES: "Yes", NO: "No" };
const pct = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
const signedUnits = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}u`;
const dateTime = (value: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Blantyre", dateStyle: "medium", timeStyle: "short" }).format(value);

function probabilityBand(value: number): string {
  if (value < 0.5) return "<50%";
  const lower = Math.min(95, Math.floor(value * 20) * 5);
  return `${lower}–${lower + 5}%`;
}

function resultFor(candidate: PaperCandidate, decision: { outcome: { status: string; homeGoals: number | null; awayGoals: number | null } | null }): PickRow["outcome"] {
  if (!decision.outcome) return "PENDING";
  return legOutcome(candidate.market, candidate.selection, decision.outcome);
}

function stats(rows: PickRow[]) {
  const wins = rows.filter(row => row.outcome === "WIN").length;
  const losses = rows.filter(row => row.outcome === "LOSS").length;
  const voids = rows.filter(row => row.outcome === "VOID").length;
  const settled = wins + losses;
  const pending = rows.filter(row => row.outcome === "PENDING" || row.outcome === "UNRESOLVED").length;
  const net = rows.reduce((sum, row) => sum + (row.outcome === "WIN" ? row.odds - 1 : row.outcome === "LOSS" ? -1 : 0), 0);
  return { picks: rows.length, settled, wins, losses, voids, pending, hitRate: settled ? wins / settled : null, net: settled ? net : null, roi: settled ? net / settled : null };
}

export default async function ProbabilityBandsPage() {
  const [decisions, priorProtocols] = await Promise.all([
    db.paperDecision.findMany({
      where: { policyVersion: PAPER_POLICY.version },
      orderBy: { kickoff: "asc" },
      include: { outcome: true, fixture: { select: { homeTeam: true, awayTeam: true, competition: true } } }
    }),
    db.paperDecision.groupBy({ by: ["policyVersion"], where: { policyVersion: { not: PAPER_POLICY.version } }, _count: { _all: true }, orderBy: { policyVersion: "asc" } })
  ]);

  const rows: PickRow[] = decisions.flatMap(decision => {
    const evidence = decision.evidence as unknown as Evidence;
    return evidence.arms.flatMap(arm => {
      if (!ARMS.includes(arm.arm) || arm.status !== "PAPER_PICK" || arm.candidateId === null || arm.probability === null) return [];
      const candidate = evidence.candidates.find(item => item.id === arm.candidateId);
      if (!candidate?.quote) return [];
      return [{
        decisionId: decision.id,
        kickoff: decision.kickoff,
        decidedAt: decision.decidedAt,
        home: decision.fixture.homeTeam.name,
        away: decision.fixture.awayTeam.name,
        competition: decision.fixture.competition.name,
        arm: arm.arm,
        market: candidate.market,
        selection: candidate.selection,
        probability: arm.probability,
        marketProbability: candidate.marketProbability,
        odds: candidate.quote.odds,
        expectedReturn: arm.expectedReturn,
        outcome: resultFor(candidate, decision)
      }];
    });
  });

  const mixes = new Map<string, { arm: ArmName; modelBand: string; marketBand: string; rows: PickRow[] }>();
  for (const row of rows) {
    if (row.marketProbability === null) continue;
    const modelBand = probabilityBand(row.probability), marketBand = probabilityBand(row.marketProbability);
    const key = `${row.arm}:${modelBand}:${marketBand}`;
    const group = mixes.get(key) ?? { arm: row.arm, modelBand, marketBand, rows: [] };
    group.rows.push(row);
    mixes.set(key, group);
  }
  const mixRows = [...mixes.values()].map(group => ({ ...group, ...stats(group.rows) }))
    .sort((a, b) => (b.settled >= 30 ? 1 : 0) - (a.settled >= 30 ? 1 : 0) || (b.roi ?? -Infinity) - (a.roi ?? -Infinity) || b.settled - a.settled);
  const established = mixRows.filter(row => row.settled >= 30);
  const exploratory = mixRows.filter(row => row.settled < 30);

  const calibrated = rows.filter(row => row.arm === "calibrated_value");
  const overall = stats(calibrated);
  const now = new Date();
  const recentStart = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const recent = stats(calibrated.filter(row => row.kickoff >= recentStart && row.kickoff <= now));
  const upcoming = calibrated.filter(row => row.kickoff >= now && row.outcome === "PENDING").sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());

  const renderMixRows = (items: typeof mixRows) => items.map((row, index) => <tr key={`${row.arm}-${row.modelBand}-${row.marketBand}`}>
    <td>{index + 1}</td><td>{ARM_NAMES[row.arm]}</td><td>{row.modelBand}</td><td>{row.marketBand}</td><td>{row.settled}</td>
    <td>{row.wins} / {row.losses}</td><td>{pct(row.hitRate)}</td><td>{signedUnits(row.net)}</td><td>{pct(row.roi)}</td>
  </tr>);

  return <section className="probability-bands-page">
    <header className="page-heading">
      <p className="eyebrow">PROSPECTIVE RESEARCH</p>
      <h1>Probability mixes</h1>
      <p className="page-intro">Review frozen paper picks by model and bookmaker probability bands. Every decision was saved before kickoff with its quote and source evidence.</p>
    </header>

    <div className="notice probability-bands-notice">
      <strong>Paper research · promotion blocked</strong>
      <p>These figures describe the saved <code>{PAPER_POLICY.version}</code> trial. They do not change live selection rules or grant publication or staking authority. Historical reconstructions and earlier protocols are excluded.</p>
      <p>{decisions.length} immutable fixture decisions · {rows.length} priced arm picks · archived protocols: {priorProtocols.map(item => `${item.policyVersion} (${item._count._all})`).join(", ") || "none"}</p>
    </div>

    <section className="probability-bands-panel" aria-labelledby="mix-table-title">
      <div className="section-heading"><div><p className="eyebrow">BEST-PERFORMING MIXES</p><h2 id="mix-table-title">Model probability × bookmaker probability</h2></div><p className="meta">Established rows require 30 settled picks · sorted by flat-stake ROI</p></div>
      <p className="probability-bands-copy">ROI uses one hypothetical unit per priced settled pick, before costs. Pending and void picks are excluded. Each row is one research arm and band pair; the same fixture may appear in different arms.</p>
      {established.length ? <div className="matches-table-wrap"><table className="matches-table probability-bands-table"><thead><tr><th>#</th><th>Research arm</th><th>Model band</th><th>Bookmaker band</th><th>N</th><th>Won / lost</th><th>Hit rate</th><th>Net units</th><th>ROI</th></tr></thead><tbody>{renderMixRows(established)}</tbody></table></div> : rows.length ? <p className="empty-state">No band pair has reached 30 settled paper picks yet. Smaller samples are kept below as exploratory evidence.</p> : null}
      {exploratory.length > 0 && <details className="probability-bands-exploratory"><summary>Exploratory band pairs · under 30 settled picks ({exploratory.length})</summary><div className="matches-table-wrap"><table className="matches-table probability-bands-table"><thead><tr><th>#</th><th>Research arm</th><th>Model band</th><th>Bookmaker band</th><th>N</th><th>Won / lost</th><th>Hit rate</th><th>Net units</th><th>ROI</th></tr></thead><tbody>{renderMixRows(exploratory)}</tbody></table></div></details>}
      {!rows.length && <p className="empty-state">No priced paper picks have been captured for this protocol yet. The worker records future decisions prospectively; earlier match results are not backfilled into the trial.</p>}
    </section>

    <section className="probability-bands-panel" aria-labelledby="upcoming-picks-title">
      <div className="section-heading"><div><p className="eyebrow">FROZEN DAILY LEDGER</p><h2 id="upcoming-picks-title">Upcoming calibrated-value picks</h2></div><p className="meta">One saved decision per fixture · <Link href="/research/paper-validation">Protocol details</Link></p></div>
      {upcoming.length ? <div className="matches-table-wrap"><table className="matches-table probability-bands-table"><thead><tr><th>Kickoff</th><th>Match / league</th><th>Market / pick</th><th>Model</th><th>Bookmaker</th><th>Odds</th><th>Expected return</th><th>Status</th></tr></thead><tbody>{upcoming.map(row => <tr key={row.decisionId}>
        <td>{dateTime(row.kickoff)}</td><td>{row.home} vs {row.away}<small className="probability-bands-subline">{row.competition}</small></td>
        <td>{MARKET_NAMES[row.market] ?? row.market} · {SELECTION_NAMES[row.selection] ?? row.selection}</td><td>{pct(row.probability)}</td><td>{pct(row.marketProbability)}</td><td>{row.odds.toFixed(2)}</td><td>{pct(row.expectedReturn)}</td><td><span className="probability-bands-status">Frozen · pending</span></td>
      </tr>)}</tbody></table></div> : <p className="empty-state">No upcoming calibrated-value picks are currently frozen. PASS decisions remain in the paper ledger.</p>}
    </section>

    <section className="probability-bands-panel" aria-labelledby="prospective-title">
      <div className="section-heading"><div><p className="eyebrow">PROSPECTIVE PERFORMANCE</p><h2 id="prospective-title">Calibrated-value paper results</h2></div><p className="meta">Pre-kickoff decisions only · <Link href="/research/paper-validation">Compare all research arms</Link></p></div>
      <div className="probability-bands-kpis">
        <article><small>FROZEN PICKS</small><strong>{overall.picks}</strong><span>Priced decisions in this arm</span></article>
        <article><small>SETTLED / PENDING</small><strong>{overall.settled} / {overall.pending}</strong><span>Void: {overall.voids}</span></article>
        <article><small>WON / LOST</small><strong>{overall.wins} / {overall.losses}</strong><span>Priced settled picks</span></article>
        <article><small>HIT RATE</small><strong>{pct(overall.hitRate)}</strong><span>Wins ÷ wins and losses</span></article>
        <article><small>FLAT-STAKE P&amp;L</small><strong className={overall.net !== null && overall.net < 0 ? "negative" : "positive"}>{signedUnits(overall.net)}</strong><span>One unit per priced settled pick</span></article>
        <article><small>ROI</small><strong>{pct(overall.roi)}</strong><span>Before costs</span></article>
        <article><small>RECENT ROI · 60 DAYS</small><strong>{pct(recent.roi)}</strong><span>By kickoff date</span></article>
      </div>
      <p className="probability-bands-copy">Results are still a research sample. ROI does not account for costs, uncertainty, league concentration, or execution, and cannot establish profitability or authorize a rule change.</p>
    </section>
  </section>;
}
