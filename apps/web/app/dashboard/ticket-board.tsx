"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { LEG_OUTCOME_LABEL, selectionLabel, selectionTone } from "../../lib/selection";

export type TicketLegData = {
  id: string;
  home: string;
  away: string;
  competition: string;
  kickoff: string;
  fixtureStatus: string;
  statusCode: string | null;
  elapsedMinute: number | null;
  homeGoals: number | null;
  awayGoals: number | null;
  market: string;
  selection: string;
  odds: number;
  probability: number;
  quoteCapturedAt: string | null;
  consensusProbability: number | null;
  agreementScore: number | null;
  /** WIN / LOSS / VOID / PENDING / UNRESOLVED for this leg alone. */
  outcome: string;
  /** "settlement" = read from the immutable settlement evidence; "live" = previewed from fixture state. */
  outcomeSource: "settlement" | "live";
  settledScore: string | null;
  /** True when this leg decided (or is deciding) the ticket outcome. */
  decisive: boolean;
};

export type TicketCardData = {
  id: string;
  tier: string;
  targetDate: string;
  combinedOdds: number;
  confidenceThreshold: number;
  relaxed: boolean;
  publishedAt: string;
  lockAt: string;
  bookmaker: string | null;
  outcome: string;
  profitUnits: number | null;
  /** Plain-language explanation of which legs decided the ticket. */
  attribution: string;
  legs: TicketLegData[];
};

type SelectedLeg = { ticket: TicketCardData; leg: TicketLegData };
type DetailView = "overview" | "probability" | "odds" | "result";

const TIER_LABEL: Record<string, string> = { STANDARD: "Standard", VALUE: "Value", HIGH: "High" };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (value: number) => String(value).padStart(2, "0");

// Formatted by hand rather than with Intl: this component renders on the server (Node) and hydrates
// in the browser, and their ICU data disagree on en-GB punctuation ("Thu 24 Sept" vs "Thu, 24 Sept"),
// which caused a hydration mismatch. Africa/Blantyre is UTC+02:00 year round.
function time(iso: string): string {
  const local = new Date(Date.parse(iso) + 2 * 60 * 60 * 1000);
  return `${WEEKDAYS[local.getUTCDay()]} ${two(local.getUTCDate())} ${MONTHS[local.getUTCMonth()]}, ${two(local.getUTCHours())}:${two(local.getUTCMinutes())} CAT`;
}

function utcTime(iso: string): string {
  return iso.replace("T", " ").slice(0, 16) + " UTC";
}

function pct(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

function matchState(leg: TicketLegData): string {
  if (leg.fixtureStatus === "SCHEDULED") return "Pending";
  if (leg.fixtureStatus === "FINISHED") return "Finished";
  if (leg.fixtureStatus === "POSTPONED") return "Void / postponed";
  if (leg.fixtureStatus === "CANCELLED") return "Void / cancelled";
  const period: Record<string, string> = { "1H": "1st half", HT: "Half-time", "2H": "2nd half", ET: "Extra time", BT: "Break", P: "Penalties" };
  const label = period[leg.statusCode ?? ""] ?? "Live";
  return leg.elapsedMinute === null ? label : `${label} · ${leg.elapsedMinute}′`;
}

function scoreline(leg: TicketLegData): string {
  return leg.homeGoals !== null && leg.awayGoals !== null ? `${leg.homeGoals}–${leg.awayGoals}` : "—";
}

function LegOutcomeBadge({ leg }: { leg: TicketLegData }) {
  return <span className={`status-badge leg-outcome ${leg.outcome.toLowerCase()}`}>{LEG_OUTCOME_LABEL[leg.outcome] ?? leg.outcome}</span>;
}

function decisiveNote(ticket: TicketCardData, leg: TicketLegData): string | null {
  if (!leg.decisive) return null;
  if (ticket.outcome === "WIN") return "Contributed to the win";
  if (ticket.outcome === "LOSS") return "Cost the ticket";
  if (ticket.outcome === "VOID") return "Voided the ticket";
  if (leg.outcome === "LOSS") return "Beats the ticket";
  if (leg.outcome === "VOID") return "Will void the ticket";
  return null;
}

function DetailPanel({ selected, onClose }: { selected: SelectedLeg; onClose: () => void }) {
  const [view, setView] = useState<DetailView>("overview");
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const { ticket, leg } = selected;
  const implied = leg.odds > 0 ? 1 / leg.odds : null;
  const gap = implied === null ? null : (leg.probability - implied) * 100;
  const score = leg.homeGoals !== null && leg.awayGoals !== null ? `${leg.homeGoals}–${leg.awayGoals}` : null;

  useEffect(() => {
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const controls = panelRef.current?.querySelectorAll<HTMLButtonElement>("button");
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const views: { id: DetailView; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "probability", label: "Probability" },
    { id: "odds", label: "Odds source" },
    { id: "result", label: "Result" }
  ];

  return (
    <div className="selection-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={panelRef} className="selection-panel" role="dialog" aria-modal="true" aria-labelledby="selection-title">
        <div className="selection-panel-head">
          <div>
            <p className="eyebrow">SELECTION EVIDENCE · PAPER RESEARCH</p>
            <h2 id="selection-title">{leg.home} <span>vs</span> {leg.away}</h2>
            <p>{leg.competition} · <strong>{time(leg.kickoff)}</strong></p>
          </div>
          <button ref={closeRef} type="button" className="selection-close" onClick={onClose} aria-label="Close selection details">×</button>
        </div>

        <div className="selection-panel-chips">
          <span className="selection-chip">{TIER_LABEL[ticket.tier] ?? ticket.tier} ticket</span>
          <span className="selection-chip">{ticket.outcome.toLowerCase()} ticket</span>
          <span className={`selection-chip leg-chip ${leg.outcome.toLowerCase()}`}>Leg {(LEG_OUTCOME_LABEL[leg.outcome] ?? leg.outcome).toLowerCase()}</span>
          {ticket.relaxed && <span className="selection-chip caution">Relaxed criteria</span>}
        </div>

        <div className="selection-evidence-card">
          <div className="selection-evidence-head"><strong>Published snapshot</strong><span>Leg-level review · advisory</span></div>
          <div className="selection-evidence-grid">
            <div><small>Model estimate</small><strong>{pct(leg.probability)}</strong></div>
            <div><small>Bookmaker implied</small><strong>{implied === null ? "Unavailable" : pct(implied)}</strong></div>
            <div><small>Model / market agreement</small><strong>{leg.agreementScore === null ? "Unavailable" : `${leg.agreementScore.toFixed(0)}/100`}</strong></div>
            <div><small>Market consensus</small><strong>{leg.consensusProbability === null ? "Unavailable" : pct(leg.consensusProbability)}</strong></div>
          </div>
          <p>These are recorded estimates and prices from publication, not a guarantee or a current betting price.</p>
        </div>

        <div className="selection-facts">
          <div><small>Market</small><strong><span className={`market-pick ${selectionTone(leg.selection)}`}>{leg.market}: {selectionLabel(leg.selection)}</span></strong></div>
          <div><small>Snapshot odds</small><strong>{leg.odds.toFixed(2)}×</strong></div>
          <div><small>Match state</small><strong>{matchState(leg)}</strong></div>
          <div><small>Score</small><strong>{score ?? "Not recorded"}</strong></div>
        </div>

        <nav className="selection-tabs" aria-label="Selection detail sections">
          {views.map((item) => (
            <button key={item.id} type="button" className={view === item.id ? "active" : ""} aria-pressed={view === item.id} onClick={() => setView(item.id)}>{item.label}</button>
          ))}
        </nav>

        <div className="selection-view">
          {view === "overview" && <>
            <h3>Selection overview</h3>
            <dl>
              <div><dt>Published selection</dt><dd><span className={`market-pick ${selectionTone(leg.selection)}`}>{leg.market}: {selectionLabel(leg.selection)}</span></dd></div>
              <div><dt>Kickoff</dt><dd>{time(leg.kickoff)}</dd></div>
              <div><dt>Ticket published</dt><dd>{utcTime(ticket.publishedAt)}</dd></div>
              <div><dt>Ticket lock</dt><dd>{utcTime(ticket.lockAt)}</dd></div>
              <div><dt>Confidence floor</dt><dd>{ticket.confidenceThreshold}%</dd></div>
            </dl>
            <h3>Why this selection was published</h3>
            <ul className="evidence-list">
              <li>Model estimate: <strong>{pct(leg.probability)}</strong> at publication.</li>
              <li>{implied === null ? "Bookmaker implied probability is unavailable, so value cannot be verified." : <>Model minus captured implied probability: <strong>{gap! >= 0 ? "+" : ""}{gap!.toFixed(1)} percentage points</strong>.</>}</li>
              <li>{leg.consensusProbability === null ? "Cross-bookmaker consensus was not recorded for this leg." : <>Recorded market consensus: <strong>{pct(leg.consensusProbability)}</strong>.</>}</li>
              <li>{leg.agreementScore === null ? "Model/market agreement is unavailable." : <>Recorded model/market agreement: <strong>{leg.agreementScore.toFixed(0)}/100</strong>.</>}</li>
            </ul>
            <h3>Risks and limits</h3>
            <ul className="evidence-list risk-list">
              <li>This is a paper selection, not an executable or guaranteed bet.</li>
              <li>The snapshot is point-in-time; current odds, lineups, injuries, and context may differ.</li>
              <li>The ticket confidence floor is a publishing rule, not this match&apos;s win probability.</li>
            </ul>
          </>}
          {view === "probability" && <>
            <h3>Probability evidence</h3>
            <dl>
              <div><dt>Published model estimate</dt><dd>{pct(leg.probability)}</dd></div>
              <div><dt>Bookmaker implied probability</dt><dd>{implied === null ? "Unavailable" : pct(implied)}</dd></div>
              <div><dt>Model minus implied</dt><dd>{gap === null ? "Unavailable" : `${gap >= 0 ? "+" : ""}${gap.toFixed(1)} percentage points`}</dd></div>
              <div><dt>De-vigged market consensus</dt><dd>{leg.consensusProbability === null ? "Unavailable" : pct(leg.consensusProbability)}</dd></div>
              <div><dt>Model / market agreement</dt><dd>{leg.agreementScore === null ? "Unavailable" : `${leg.agreementScore.toFixed(0)}/100`}</dd></div>
            </dl>
            <p>The gap compares a model estimate with a single bookmaker&apos;s price. It is a review signal, not verified value. Consensus and agreement appear only when the matching publication snapshot is stored.</p>
          </>}
          {view === "odds" && <>
            <h3>Recorded odds source</h3>
            <dl>
              <div><dt>Bookmaker</dt><dd>{ticket.bookmaker ?? "Unavailable"}</dd></div>
              <div><dt>Decimal odds</dt><dd>{leg.odds.toFixed(2)}×</dd></div>
              <div><dt>Captured at</dt><dd>{leg.quoteCapturedAt ? utcTime(leg.quoteCapturedAt) : "Unavailable"}</dd></div>
              <div><dt>Published at</dt><dd>{utcTime(ticket.publishedAt)}</dd></div>
            </dl>
            <p>This is the quote recorded for the published leg. Check the bookmaker for any current price.</p>
          </>}
          {view === "result" && <>
            <h3>Recorded result</h3>
            <dl>
              <div><dt>Match state</dt><dd>{matchState(leg)}</dd></div>
              <div><dt>Stored score</dt><dd>{score ?? "Not recorded"}</dd></div>
              {leg.outcomeSource === "settlement" && leg.settledScore !== score && <div><dt>Score at settlement</dt><dd>{leg.settledScore ?? "Not recorded"}</dd></div>}
              <div><dt>This leg</dt><dd><LegOutcomeBadge leg={leg} /></dd></div>
              <div><dt>Whole ticket outcome</dt><dd>{ticket.outcome.toLowerCase()}</dd></div>
              <div><dt>Role in the ticket</dt><dd>{decisiveNote(ticket, leg) ?? (ticket.outcome === "PENDING" ? "Not decisive yet" : "Not decisive")}</dd></div>
            </dl>
            <p>{ticket.attribution}</p>
            <p>{leg.outcomeSource === "settlement"
              ? "This leg's result is read from the settlement evidence recorded when the ticket settled."
              : "The ticket has not settled; this leg's result is a preview from the latest stored fixture state and can change until settlement."}</p>
          </>}
        </div>
      </section>
    </div>
  );
}

export default function TicketBoard({ tickets, eyebrow = "PRIMARY RESEARCH OUTPUT", title = "Published recommendations", showDate = false, compact = false, showHeading = true }: {
  tickets: TicketCardData[]; eyebrow?: string; title?: string; showDate?: boolean; compact?: boolean; showHeading?: boolean;
}) {
  const [selected, setSelected] = useState<SelectedLeg | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = () => {
    setSelected(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  if (tickets.length === 0) return null;

  return (
    <>
      {showHeading && <div className="ticket-board-heading">
        <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>
        <p>Each leg shows whether it won, lost, or was voided. Open a match for its recorded model, market, odds, and result details.</p>
      </div>}
      <div className="ticket-cards">
        {tickets.map((ticket) => {
          const card = <article className={`ticket-card premium-ticket tier-${ticket.tier.toLowerCase()}`}>
            <div className="premium-ticket-top">
              <div className="premium-ticket-title">
                <h3><span className="tier-dot" />{TIER_LABEL[ticket.tier] ?? ticket.tier}</h3>
                <div className="premium-ticket-tags">
                  {showDate && <span className="selection-chip">{ticket.targetDate}</span>}
                  <span className={`status-badge ${ticket.outcome.toLowerCase()}`}>{ticket.outcome}</span>
                  {ticket.relaxed && <span className="selection-chip caution">Relaxed criteria</span>}
                </div>
              </div>
              <div className="premium-ticket-stats">
                <div><small>Ticket odds</small><strong>{ticket.combinedOdds.toFixed(2)}×</strong></div>
                <div><small>Legs</small><strong>{ticket.legs.length}</strong></div>
                <div><small>Confidence floor</small><strong>{ticket.confidenceThreshold}%</strong></div>
                <div><small>Locks</small><strong>{time(ticket.lockAt)}</strong></div>
              </div>
              <div className="premium-ticket-meta">
                <span>Bookmaker <strong>{ticket.bookmaker ?? "Unavailable"}</strong></span>
                <span>Published {utcTime(ticket.publishedAt)}</span>
                <span>Paper research</span>
                {ticket.profitUnits !== null && <span>Result <strong>{ticket.profitUnits >= 0 ? "+" : ""}{ticket.profitUnits.toFixed(2)} u</strong></span>}
              </div>
              <p className={`ticket-attribution ${ticket.outcome.toLowerCase()}`}>{ticket.attribution}</p>
            </div>
            <ul className="premium-leg-list" aria-label={`${TIER_LABEL[ticket.tier] ?? ticket.tier} ticket legs`}>
              {ticket.legs.map((leg) => {
                const implied = leg.odds > 0 ? 1 / leg.odds : null;
                const gap = implied === null ? null : (leg.probability - implied) * 100;
                const note = decisiveNote(ticket, leg);
                return (
                  <li key={leg.id} className={`leg-${leg.outcome.toLowerCase()}${leg.decisive ? " decisive" : ""}`}>
                    <button type="button" className="premium-leg-trigger" aria-haspopup="dialog" aria-label={`View evidence for ${leg.home} vs ${leg.away} (leg ${(LEG_OUTCOME_LABEL[leg.outcome] ?? leg.outcome).toLowerCase()})`} onClick={(event) => { triggerRef.current = event.currentTarget; setSelected({ ticket, leg }); }}>
                      <span className="premium-leg-main">
                        <strong>{leg.home} <span>vs</span> {leg.away}</strong>
                        <small>{leg.competition} · {time(leg.kickoff)}</small>
                        <span className={`premium-leg-market market-pick ${selectionTone(leg.selection)}`}>{leg.market}: {selectionLabel(leg.selection)}</span>
                        <span className="premium-leg-market">{matchState(leg)} · Score {scoreline(leg)}</span>
                        {note && <small className="leg-decisive-note">{note}</small>}
                      </span>
                      <LegOutcomeBadge leg={leg} />
                      <span className="premium-leg-numbers">
                        <strong>{leg.odds.toFixed(2)}×</strong>
                        <small>Model {pct(leg.probability)}</small>
                        {gap !== null && <small className="premium-leg-gap">{gap >= 0 ? "+" : ""}{gap.toFixed(1)} pp vs implied</small>}
                      </span>
                      <span className="premium-leg-arrow" aria-hidden="true">›</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </article>;
          if (!compact) return <Fragment key={ticket.id}>{card}</Fragment>;
          return <details key={ticket.id} className={`ticket-history-item tier-${ticket.tier.toLowerCase()}`}>
            <summary className="ticket-history-summary">
              <strong><span className="tier-dot" />{TIER_LABEL[ticket.tier] ?? ticket.tier}</strong>
              <span>{ticket.targetDate}</span>
              <span className={`status-badge ${ticket.outcome.toLowerCase()}`}>{ticket.outcome}</span>
              <span>{ticket.legs.length} legs</span>
              <span>{ticket.combinedOdds.toFixed(2)}×</span>
              <span className="ticket-history-arrow" aria-hidden="true">›</span>
            </summary>
            {card}
          </details>;
        })}
      </div>
      {selected && <DetailPanel key={selected.leg.id} selected={selected} onClose={close} />}
    </>
  );
}
