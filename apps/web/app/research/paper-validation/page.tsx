import Link from "next/link";
import { db } from "@highodds/db";
import { blantyreToday, legOutcome, PAPER_POLICY, summarizeResearchRows, type PaperArm, type PaperCandidate, type PaperCalibration } from "@highodds/core";

export const dynamic = "force-dynamic";
const pct = (n: number | null) => n === null ? "Unavailable" : `${(n * 100).toFixed(1)}%`;
const names = { baseline: "Current model comparator", btts_yes: "BTTS Yes research", calibrated_value: "Calibrated value" };
type Evidence = { candidates: PaperCandidate[]; arms: PaperArm[] };

export default async function PaperValidationPage() {
  const [decisions, artifact, priorProtocols] = await Promise.all([
    db.paperDecision.findMany({ where: { policyVersion: PAPER_POLICY.version }, orderBy: { decidedAt: "desc" }, include: { outcome: true, fixture: { select: { homeTeam: true, awayTeam: true } } } }),
    db.paperCalibration.findFirst({ where: { policyVersion: PAPER_POLICY.version }, orderBy: { day: "desc" } }),
    db.paperDecision.groupBy({ by: ["policyVersion"], where: { policyVersion: { not: PAPER_POLICY.version } }, _count: { _all: true }, orderBy: { policyVersion: "asc" } })
  ]);
  const arms = (Object.keys(names) as Array<keyof typeof names>).map(name => {
    const selected = decisions.flatMap(d => {
      const evidence = d.evidence as unknown as Evidence, arm = evidence.arms.find(a => a.arm === name);
      const candidate = evidence.candidates.find(c => c.id === arm?.candidateId);
      if (!arm || arm.status !== "PAPER_PICK" || !candidate?.quote || arm.probability === null) return [];
      const outcome = d.outcome ? legOutcome(candidate.market, candidate.selection, d.outcome) : "PENDING" as const;
      return [{ probability: arm.probability, odds: candidate.quote.odds, outcome, day: blantyreToday(d.kickoff), marketProbability: candidate.marketProbability }];
    });
    const settled = selected.filter(r => r.outcome === "WIN" || r.outcome === "LOSS");
    const stats = summarizeResearchRows(selected);
    const brier = settled.length ? settled.reduce((sum, r) => sum + (r.probability - Number(r.outcome === "WIN")) ** 2, 0) / settled.length : null;
    const marketRows = settled.filter(r => r.marketProbability !== null);
    const marketBrier = marketRows.length ? marketRows.reduce((sum, r) => sum + (r.marketProbability! - Number(r.outcome === "WIN")) ** 2, 0) / marketRows.length : null;
    return { name, ...stats, passes: decisions.length - selected.length, days: new Set(settled.map(r => r.day)).size, brier, marketBrier };
  });
  const calibration = artifact?.artifact as unknown as PaperCalibration | undefined;
  return <section>
    <p className="eyebrow">PROSPECTIVE RESEARCH</p><h1>Paper comparison</h1>
    <p className="page-intro">New decisions are saved before kickoff with their forecast, prices and reasons. These are hypothetical singles, with no stake or publication authority.</p>
    <div className="notice"><strong>Promotion blocked · collecting evidence</strong><p>Readiness requires at least 30 completed days, 300 priced settled decisions, 100 for any market proposed for promotion, and an independent review of calibration, uncertainty, costs and unseen performance. Reaching a count does not automatically qualify a strategy.</p></div>
    <p>{decisions.length} immutable fixture decisions · protocol {PAPER_POLICY.version} · <Link href="/research/model-history">Historical market audit</Link></p>
    <p className="meta">This protocol follows the Forecast Archive: Selection forecasts take priority, with Preliminary forecasts used when no Selection forecast exists for that fixture. Earlier protocol records remain archived: {priorProtocols.map(p => `${p.policyVersion} (${p._count._all})`).join(", ") || "none"}.</p>
    <h2>Results from saved decisions</h2>
    <p><Link href="/research/probability-bands">Review probability-band mixes</Link></p>
    <p className="meta">One hypothetical unit per priced settled pick, before costs. Pending and void picks are excluded from ROI. PASS decisions remain visible. Arms can choose different matches; returns are not a paired causal comparison.</p>
    <div className="matches-table-wrap"><table className="matches-table"><thead><tr><th>Research arm</th><th>Paper picks</th><th>Passes</th><th>Settled / days</th><th>Hit rate</th><th>Net units</th><th>Paper ROI</th></tr></thead><tbody>{arms.map(a => <tr key={a.name}>
      <th scope="row">{names[a.name]}</th><td>{a.selected}</td><td>{a.passes}</td><td>{a.settled} / {a.days}</td><td>{pct(a.hitRate)}</td><td>{a.net === null ? "Unavailable" : a.net.toFixed(2)}</td><td>{pct(a.roi)}</td>
    </tr>)}</tbody></table></div>
    <h2>Probability quality</h2><p className="meta">Lower Brier scores are better. The bookmaker comparator removes margin using a complete same-bookmaker market captured within five minutes. It is evaluated on the same selected matches.</p>
    <div className="matches-table-wrap"><table className="matches-table"><thead><tr><th>Research arm</th><th>Mean probability</th><th>Observed wins</th><th>Model Brier</th><th>Bookmaker Brier</th></tr></thead><tbody>{arms.map(a => <tr key={a.name}><th scope="row">{names[a.name]}</th><td>{pct(a.meanProbability)}</td><td>{pct(a.hitRate)}</td><td>{a.brier?.toFixed(4) ?? "Unavailable"}</td><td>{a.marketBrier?.toFixed(4) ?? "Unavailable"}</td></tr>)}</tbody></table></div>
    <h2>Calibration readiness</h2>
    <p>The regularized temperature model uses only previously recorded prospective outcomes. Whole later days are reserved for validation; no historical audit results are backfilled into this trial. Insufficient history or no validation improvement produces PASS.</p>
    {calibration ? <div className="matches-table-wrap"><table className="matches-table"><thead><tr><th>Market</th><th>Training pool / days</th><th>Temperature</th><th>Status</th></tr></thead><tbody>{Object.entries(calibration).map(([market,c]) => <tr key={market}><th scope="row">{market.replaceAll("_", " ")}</th><td>{c.fixtures} / {c.days}</td><td>{c.temperature?.toFixed(2) ?? "Not fitted"}</td><td>{c.reason.replaceAll("_", " ")}</td></tr>)}</tbody></table></div> : <p>No calibration artifact yet. The local jobs worker will freeze one on its next research tick.</p>}
    <details><summary>Protocol and evidence</summary><p>Capture once on the first worker tick between one minute and six hours before kickoff. A missing forecast or complete fresh price creates a saved PASS; it is never rewritten after the result. Prices must be received with linked source evidence by decision time and at most 60 minutes old. The calibrated arm requires at least 60% probability and 5% estimated return; these are frozen research settings, not validated thresholds.</p><p>Daily calibration cutoff: {artifact?.cutoffAt.toISOString() ?? "Unavailable"}. Policy hash: {artifact?.policyHash ?? "Unavailable"}. Artifact hash: {artifact?.artifactHash ?? "Unavailable"}.</p><p>Outcome records are append-only. Later provider corrections require a separately reviewed correction protocol; they do not silently rewrite this experiment.</p></details>
    <h2>Latest decisions</h2>
    {decisions.length === 0 ? <p>No prospective fixture decisions yet. Historical results are kept separate.</p> : <div className="matches-table-wrap"><table className="matches-table"><thead><tr><th>Fixture</th><th>Saved (CAT)</th><th>Result evidence</th><th>Decisions and reasons</th></tr></thead><tbody>{decisions.slice(0,20).map(d => {
      const evidence=d.evidence as unknown as Evidence;
      return <tr key={d.id}><th scope="row"><Link href={`/research?fixture=${d.fixtureId}`}>{d.fixture.homeTeam.name} vs {d.fixture.awayTeam.name}</Link></th><td>{d.decidedAt.toLocaleString("en-GB",{timeZone:"Africa/Blantyre"})}</td><td>{d.outcome?.status ?? "PENDING"}</td><td>{evidence.arms.map(a => <div key={a.arm}>{names[a.arm]}: {a.status.replaceAll("_"," ")} · {a.reason.replaceAll("_"," ")}</div>)}<details><summary>Saved evidence</summary><p>Decision {d.id} · checksum {d.evidenceHash}</p>{evidence.candidates.map(c=><p key={c.id}>{c.market} {c.selection} · {pct(c.probability)} · {c.quote ? `${c.quote.odds.toFixed(2)} (${c.quote.bookmakerName}) · quote ${c.quote.id}` : "No complete fresh price"} · model {c.modelVersion}</p>)}</details></td></tr>;
    })}</tbody></table></div>}
  </section>;
}
