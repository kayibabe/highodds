import { describe, expect, it } from "vitest";
import { fitPaperCalibration, paperArms, paperCandidates, temperatureProbabilities, summarizeResearchRows, type PaperForecast, type PaperQuote, type CalibrationObservation } from "../src/paper-research.js";
import { legOutcome } from "../src/settlement.js";
import { canonicalPaperJson } from "../src/paper-research.js";
const now="2026-10-12T10:00:00Z",kickoff="2026-10-12T12:00:00Z";
const forecasts:PaperForecast[]=["YES","NO"].map((selection,i)=>({id:selection,market:"BTTS",selection,probability:i?.2:.8,asOfAt:"2026-10-12T09:30:00Z",createdAt:"2026-10-12T09:30:01Z",modelRunId:"model",modelVersion:"v1",modelCreatedAt:"2026-10-12T08:00:00Z",trainedUntil:"2026-10-12T07:00:00Z"}));
const quotes:PaperQuote[]=["YES","NO"].map((selection,i)=>({id:selection,market:"BTTS",selection,odds:i?3:1.5,bookmakerId:"book",bookmakerName:"Book",priority:1,active:true,capturedAt:"2026-10-12T09:50:00Z",receivedAt:"2026-10-12T09:51:00Z",rawPayloadId:"raw",rawReceivedAt:"2026-10-12T09:51:00Z"}));
describe("prospective paper evidence",()=>{
  it("normalizes JSONB key order and last-digit floating-point changes for evidence hashes",()=>{
    expect(canonicalPaperJson({z:.8*1.5-1,a:[{b:2,a:1}]})).toBe(canonicalPaperJson({a:[{a:1,b:2}],z:.2000000000000002}));
    expect(()=>canonicalPaperJson({probability:NaN})).toThrow();
  });
  it("rejects late raw receipts, stale prices and incomplete or mixed-book markets",()=>{
    for(const altered of [[quotes[0]!],quotes.map(q=>({...q,rawReceivedAt:"2026-10-12T10:01:00Z"})),quotes.map(q=>({...q,capturedAt:"2026-10-12T08:00:00Z"})),quotes.map((q,i)=>({...q,bookmakerId:`book${i}`}))]) {
      const c=paperCandidates(forecasts,altered,now,kickoff,{});
      expect(c).toHaveLength(2);expect(c.every(p=>p.quote===null)).toBe(true);expect(paperArms(c).every(a=>a.status==="PASS")).toBe(true);
    }
  });
  it("requires coherent forecasts and refuses post-kickoff capture",()=>{
    expect(paperCandidates(forecasts.map((p,i)=>({...p,modelRunId:`model${i}`})),quotes,now,kickoff,{})).toEqual([]);
    expect(paperCandidates(forecasts,quotes,kickoff,kickoff,{})).toEqual([]);
    expect(paperCandidates(forecasts.map(p=>({...p,trainedUntil:"2026-10-12T10:00:00Z"})),quotes,now,kickoff,{})).toEqual([]);
  });
  it("records the baseline and BTTS arm but blocks unsupported calibration",()=>{
    const c=paperCandidates(forecasts,quotes,now,kickoff,{}),arms=paperArms(c);
    expect(c.reduce((s,p)=>s+p.marketProbability!,0)).toBeCloseTo(1);
    expect(arms[0]!.status).toBe("PAPER_PICK");expect(arms[1]!.status).toBe("PAPER_PICK");
    expect(arms[2]!.reason).toBe("CALIBRATION_NOT_READY");
  });
  it("preserves probability sums, and learns only from the earlier day partition",()=>{
    expect(temperatureProbabilities([.7,.2,.1],2).reduce((a,b)=>a+b,0)).toBeCloseTo(1);
    const rows:CalibrationObservation[]=Array.from({length:400},(_,i)=>({decisionId:`d${i}`,fixtureId:`f${i}`,day:new Date(Date.UTC(2026,0,1+Math.floor(i/10))).toISOString().slice(0,10),market:"BTTS",probabilities:[.9,.1],winner:i%10<6?0:1}));
    expect(fitPaperCalibration(rows.slice(0,40)).BTTS!.temperature).toBeNull();
    const fit=fitPaperCalibration(rows).BTTS!;
    expect(fit.temperature).toBeGreaterThan(1);expect(fit.calibratedLogLoss!).toBeLessThan(fit.rawLogLoss!);
    expect(fit.trainingIds.some(id=>fit.validationIds.includes(id))).toBe(false);
    expect(fit.trainingIds).not.toContain("d399");expect(fit.validationIds).toContain("d399");
  });
  it("excludes live and void scores and never prices missing odds at zero",()=>{
    const live=legOutcome("BTTS","YES",{status:"LIVE",homeGoals:1,awayGoals:1});
    const stats=summarizeResearchRows([{probability:.8,odds:2,outcome:live},{probability:.7,odds:2,outcome:"VOID"},{probability:.6,odds:null,outcome:"WIN"},{probability:.6,odds:2.5,outcome:"WIN"},{probability:.6,odds:2,outcome:"LOSS"}]);
    expect(stats.settled).toBe(3);expect(stats.priced).toBe(2);expect(stats.unpriced).toBe(1);expect(stats.net).toBe(.5);expect(stats.roi).toBe(.25);
  });
});
