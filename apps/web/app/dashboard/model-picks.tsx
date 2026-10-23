import { selectionTone, shortPickLabel } from "../../lib/selection";
import type { DailyModelPick } from "../../lib/analysis";

const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Blantyre", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;

export default function ModelPicks({ day, picks }: { day: string; picks: DailyModelPick[] }) {
  const matches = new Set(picks.map((pick) => pick.fixtureId)).size;
  const ticketed = picks.filter((pick) => pick.onTicket).length;
  return <section className="model-picks-day" aria-labelledby="model-picks-day-title">
    <div className="ticket-board-heading">
      <div><p className="eyebrow">WALK-FORWARD VALIDATION</p><h2 id="model-picks-day-title">Model picks</h2></div>
      <p>{matches} qualifying {matches === 1 ? "match" : "matches"} · {picks.length} market picks · {ticketed} also on a current paper ticket.</p>
    </div>
    {picks.length === 0 ? <div className="notice">No finished qualifying model picks for this date.</div> : <div className="matches-table-wrap">
      <table className="analysis-table model-picks-day-table">
        <caption>Highest-probability selection per market, compared with the current paper selection</caption>
        <thead><tr><th>Kickoff</th><th>Match</th><th>Market pick</th><th>Model</th><th>Result</th><th>Our selection</th></tr></thead>
        <tbody>{picks.map((pick) => <tr key={`${pick.fixtureId}-${pick.marketKey}`}>
          <td className="num">{time.format(pick.kickoff)}</td>
          <th scope="row"><a href={`/research?date=${day}&fixture=${pick.fixtureId}`}>{pick.homeTeam} vs {pick.awayTeam}</a><small>{pick.competition}</small></th>
          <td><span className={`market-pick ${selectionTone(pick.selection)}`}>{shortPickLabel(pick.marketKey, pick.selection)}</span></td>
          <td className="num">{pct(pick.probability)}</td>
          <td><span className={`status-badge ${pick.outcome.toLowerCase()}`}>{pick.outcome === "WIN" ? "Won" : "Lost"}</span></td>
          <td>{pick.onTicket ? <span className="status-badge win">Matched</span> : <span className="match-pick-none">Not selected</span>}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    <p className="meta">Only finished fixtures with a pre-kickoff forecast from a model trained no later than that forecast are included. “Our selection” means a matching leg on a current, non-superseded paper ticket.</p>
  </section>;
}
