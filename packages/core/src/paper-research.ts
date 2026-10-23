import { legOutcome } from "./settlement.js";

/** Frozen research protocol. Changes require a new version; never grants publication authority. */
export const PAPER_POLICY = {
  version: "market-calibration-paper-v3", hashFormat: "sha256-canonical-json-12sig-v1", paperOnly: true, captureWindowHours: 6,
  forecastStagePreference: ["SELECTION", "PRELIMINARY"],
  minimumProbability: 0.6, minimumExpectedReturn: 0.05, maximumQuoteAgeMinutes: 60,
  maximumQuoteSkewMinutes: 5, minimumTrainingDays: 30, minimumTrainingFixtures: 300,
  minimumMarketFixtures: 100, holdoutDayFraction: 0.2, temperaturePenalty: 0.01,
  temperatures: [0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3],
  promotion: "BLOCKED_REQUIRES_INDEPENDENT_REVIEW"
} as const;
/** PostgreSQL JSONB reorders object keys; hash a canonical form that survives a database round trip. */
export function canonicalPaperJson(value: unknown): string {
  // Prisma/PostgreSQL can shift the last binary float digit on JSONB round trips.
  // Store derived numbers at a declared precision; source odds/probabilities have 4/6 decimal places.
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite paper evidence");
    return JSON.stringify(Number(value.toPrecision(12)));
  }
  if (Array.isArray(value)) return `[${value.map(canonicalPaperJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([key,item])=>`${JSON.stringify(key)}:${canonicalPaperJson(item)}`).join(",")}}`;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Paper evidence must contain JSON values only");
  return json;
}
export const PAPER_SELECTIONS: Record<string, readonly string[]> = {
  MATCH_WINNER: ["HOME", "DRAW", "AWAY"], TOTAL_GOALS: ["OVER_2_5", "UNDER_2_5"], BTTS: ["YES", "NO"]
};
export interface PaperForecast {
  id: string; market: string; selection: string; probability: number; asOfAt: string; createdAt: string; stage?: string;
  modelRunId: string; modelVersion: string; modelCreatedAt: string; trainedUntil: string;
}
export interface PaperQuote {
  id: string; market: string; selection: string; odds: number; bookmakerId: string;
  bookmakerName: string; priority: number; active: boolean; capturedAt: string; receivedAt: string;
  rawPayloadId: string | null; rawReceivedAt: string | null;
}
export interface PaperCandidate extends PaperForecast {
  quote: PaperQuote | null; marketProbability: number | null; calibratedProbability: number | null;
  reason: string | null;
}
export interface CalibrationObservation {
  decisionId: string; fixtureId: string; day: string; market: string;
  probabilities: number[]; winner: number;
}
export interface MarketCalibrationArtifact {
  temperature: number | null; reason: string; fixtures: number; days: number;
  trainingIds: string[]; validationIds: string[]; rawLogLoss: number | null; calibratedLogLoss: number | null;
}
export type PaperCalibration = Record<string, MarketCalibrationArtifact>;
const time = (value: string) => new Date(value).getTime();
export function temperatureProbabilities(probabilities: number[], temperature: number): number[] {
  if (!(temperature > 0) || probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw new Error("Invalid probability distribution");
  const powers = probabilities.map(p => Math.max(p, 1e-9) ** (1 / temperature));
  const total = powers.reduce((sum, p) => sum + p, 0);
  return powers.map(p => p / total);
}
const loss = (rows: CalibrationObservation[], temperature: number) => rows.reduce((sum, r) => sum - Math.log(temperatureProbabilities(r.probabilities, temperature)[r.winner]!), 0) / rows.length;

/** Only immutable, previously observed outcomes may be supplied by the loader. Whole days stay together. */
export function fitPaperCalibration(observations: CalibrationObservation[]): PaperCalibration {
  const allDays = new Set(observations.map(r => r.day)).size;
  const allFixtures = new Set(observations.map(r => r.fixtureId)).size;
  return Object.fromEntries(Object.keys(PAPER_SELECTIONS).map(market => {
    const rows = observations.filter(r => r.market === market);
    const days = [...new Set(rows.map(r => r.day))].sort();
    const base: MarketCalibrationArtifact = { temperature: null, reason: "INSUFFICIENT_HISTORY", fixtures: rows.length, days: days.length, trainingIds: [], validationIds: [], rawLogLoss: null, calibratedLogLoss: null };
    if (allDays < PAPER_POLICY.minimumTrainingDays || allFixtures < PAPER_POLICY.minimumTrainingFixtures || rows.length < PAPER_POLICY.minimumMarketFixtures || days.length < PAPER_POLICY.minimumTrainingDays) return [market, base];
    const split = days[Math.floor(days.length * (1 - PAPER_POLICY.holdoutDayFraction))]!;
    const train = rows.filter(r => r.day < split), validation = rows.filter(r => r.day >= split);
    if (train.length < 60 || validation.length < 20) return [market, base];
    const temperature = [...PAPER_POLICY.temperatures].sort((a,b) =>
      (loss(train,a) + PAPER_POLICY.temperaturePenalty * Math.log(a) ** 2) - (loss(train,b) + PAPER_POLICY.temperaturePenalty * Math.log(b) ** 2))[0]!;
    const rawLogLoss = loss(validation,1), calibratedLogLoss = loss(validation,temperature);
    return [market, { ...base, trainingIds: train.map(r=>r.decisionId), validationIds: validation.map(r=>r.decisionId), rawLogLoss, calibratedLogLoss,
      temperature: calibratedLogLoss < rawLogLoss ? temperature : null,
      reason: calibratedLogLoss < rawLogLoss ? "PAPER_TEST_ONLY" : "NO_HOLDOUT_IMPROVEMENT" }];
  }));
}

/** Complete contemporaneous distributions only; no mixing model runs or bookmakers. */
export function paperCandidates(forecasts: PaperForecast[], quotes: PaperQuote[], decisionAt: string, kickoff: string, calibration: PaperCalibration): PaperCandidate[] {
  const now = time(decisionAt);
  if (!Number.isFinite(now) || now >= time(kickoff)) return [];
  const candidates: PaperCandidate[] = [];
  const eligibleForecasts = forecasts.filter(p => Number.isFinite(p.probability) && p.probability >= 0 && p.probability <= 1
    && time(p.createdAt) <= now && time(p.asOfAt) <= now && time(p.asOfAt) < time(kickoff)
    && time(p.trainedUntil) <= time(p.asOfAt) && time(p.modelCreatedAt) <= time(p.asOfAt));
  const operational = eligibleForecasts.filter(p => p.stage !== "PRELIMINARY");
  // Match the Forecast Archive: use operational selections when available, and use
  // preliminary forecasts only when the fixture has no selection-stage forecast.
  const preferredForecasts = operational.length ? operational : eligibleForecasts;
  for (const [market, selections] of Object.entries(PAPER_SELECTIONS)) {
    const valid = preferredForecasts.filter(p => p.market === market && selections.includes(p.selection))
      .sort((a,b)=>time(b.asOfAt)-time(a.asOfAt)||a.id.localeCompare(b.id));
    const latest = valid[0]; if (!latest) continue;
    const distribution = selections.map(selection=>valid.find(p=>p.selection===selection&&p.modelRunId===latest.modelRunId&&p.asOfAt===latest.asOfAt));
    if (distribution.some(p=>!p)) continue;
    const predictions = distribution as PaperForecast[];
    if (Math.abs(predictions.reduce((sum,p)=>sum+p.probability,0)-1)>0.001) continue;
    const usable = quotes.filter(q=>q.market===market && q.active && Number.isFinite(q.odds) && q.odds>1 && q.rawPayloadId && q.rawReceivedAt
      && time(q.capturedAt)<=now && time(q.receivedAt)<=now && time(q.rawReceivedAt)<=now
      && now-time(q.capturedAt)<=PAPER_POLICY.maximumQuoteAgeMinutes*60_000);
    const books = [...new Map(usable.map(q=>[q.bookmakerId,q])).values()].sort((a,b)=>a.priority-b.priority||a.bookmakerId.localeCompare(b.bookmakerId));
    let bundle: PaperQuote[] | null = null;
    for (const book of books) {
      const values = selections.map(selection=>usable.filter(q=>q.bookmakerId===book.bookmakerId&&q.selection===selection).sort((a,b)=>time(b.capturedAt)-time(a.capturedAt)||a.id.localeCompare(b.id))[0]);
      if (values.some(q=>!q)) continue;
      const complete=values as PaperQuote[], times=complete.map(q=>time(q.capturedAt));
      if (Math.max(...times)-Math.min(...times)>PAPER_POLICY.maximumQuoteSkewMinutes*60_000) continue;
      bundle=complete; break;
    }
    const margin=bundle?.reduce((sum,q)=>sum+1/q.odds,0) ?? null;
    const temperature=calibration[market]?.temperature;
    const corrected=temperature ? temperatureProbabilities(predictions.map(p=>p.probability),temperature) : null;
    predictions.forEach((p,i)=>candidates.push({...p,quote:bundle?.[i]??null,marketProbability:bundle&&margin?(1/bundle[i]!.odds)/margin:null,
      calibratedProbability:corrected?.[i]??null,reason:bundle?null:"MISSING_COMPLETE_FRESH_PRICE_EVIDENCE"}));
  }
  return candidates;
}
export interface PaperArm {
  arm: "baseline" | "btts_yes" | "calibrated_value";
  status: "PAPER_PICK" | "PASS"; reason: string; candidateId: string | null;
  probability: number | null; expectedReturn: number | null;
}
export function paperArms(candidates: PaperCandidate[]): PaperArm[] {
  const ordered=[...candidates].sort((a,b)=>b.probability-a.probability||a.id.localeCompare(b.id));
  const choose=(arm:PaperArm["arm"],candidate:PaperCandidate|undefined,probability:number|null,reason:string):PaperArm=>({arm,
    status:candidate?.quote&&probability!==null?"PAPER_PICK":"PASS",reason:candidate?.quote&&probability!==null?"PAPER_ONLY":candidate?.reason??reason,
    candidateId:candidate?.id??null,probability,expectedReturn:candidate?.quote&&probability!==null?probability*candidate.quote.odds-1:null});
  const baseline=ordered.find(p=>p.probability>=PAPER_POLICY.minimumProbability);
  const btts=ordered.find(p=>p.market==="BTTS"&&p.selection==="YES"&&p.probability>=PAPER_POLICY.minimumProbability);
  const value=ordered.filter(p=>p.quote&&p.calibratedProbability!==null&&p.calibratedProbability>=PAPER_POLICY.minimumProbability&&p.calibratedProbability*p.quote.odds-1>=PAPER_POLICY.minimumExpectedReturn)
    .sort((a,b)=>(b.calibratedProbability!*b.quote!.odds)-(a.calibratedProbability!*a.quote!.odds)||a.id.localeCompare(b.id))[0];
  return [choose("baseline",baseline,baseline?.probability??null,"NO_QUALIFYING_FORECAST"),choose("btts_yes",btts,btts?.probability??null,"NO_QUALIFYING_BTTS_YES"),
    choose("calibrated_value",value,value?.calibratedProbability??null,candidates.some(p=>p.calibratedProbability!==null)?"NO_SUPPORTED_VALUE":"CALIBRATION_NOT_READY")];
}

export function summarizeResearchRows(rows: Array<{ probability: number; odds: number | null; outcome: ReturnType<typeof legOutcome> }>) {
  const settled=rows.filter(r=>r.outcome==="WIN"||r.outcome==="LOSS"),won=settled.filter(r=>r.outcome==="WIN").length;
  const priced=settled.filter(r=>r.odds!==null&&Number.isFinite(r.odds)&&r.odds>1);
  const net=priced.reduce((sum,r)=>sum+(r.outcome==="WIN"?r.odds!-1:-1),0);
  return {selected:rows.length,settled:settled.length,won,lost:settled.length-won,hitRate:settled.length?won/settled.length:null,
    meanProbability:settled.length?settled.reduce((sum,r)=>sum+r.probability,0)/settled.length:null,
    priced:priced.length,unpriced:settled.length-priced.length,net:priced.length?net:null,roi:priced.length?net/priced.length:null,
    voids:rows.filter(r=>r.outcome==="VOID").length,pending:rows.filter(r=>r.outcome==="PENDING"||r.outcome==="UNRESOLVED").length};
}
