import { createHash } from "node:crypto";
import { db } from "@highodds/db";
import { blantyreDayBounds, blantyreToday, canonicalPaperJson, fitPaperCalibration, paperArms, paperCandidates, PAPER_POLICY, PAPER_SELECTIONS, resolveSelection,
  type CalibrationObservation, type PaperCalibration, type PaperCandidate, type PaperArm } from "@highodds/core";

export const paperEvidenceHash = (value: unknown) => createHash("sha256").update(canonicalPaperJson(value)).digest("hex");
const hash = paperEvidenceHash;
export interface PaperEvidence { candidates: PaperCandidate[]; arms: PaperArm[]; rejectedForecastIds: string[]; }

export async function capturePaperResearch(now = new Date()): Promise<{ captured: number; settled: number; calibrationDay: string }> {
  // Settle from observed final records only. This never mutates a ticket or publishes a pick.
  const open = await db.paperDecision.findMany({ where: { outcome: null, fixture: { status: { in: ["FINISHED", "POSTPONED", "CANCELLED"] } } }, include: { fixture: true } });
  let settled = 0;
  for (const d of open) {
    const f=d.fixture;
    if (f.receivedAt > now || (f.status === "FINISHED" && (f.homeGoals === null || f.awayGoals === null))) continue;
    const result=await db.paperOutcome.createMany({ data: [{decisionId:d.id,status:f.status,homeGoals:f.homeGoals,awayGoals:f.awayGoals,resultReceivedAt:f.receivedAt}],skipDuplicates:true });
    settled+=result.count;
  }
  const day=blantyreToday(now), cutoffAt=blantyreDayBounds(day).start;
  let calibration=await db.paperCalibration.findUnique({where:{policyVersion_day:{policyVersion:PAPER_POLICY.version,day}}});
  const policyHash=hash(PAPER_POLICY);
  if(!calibration) {
    const previous=await db.paperDecision.findMany({where:{policyVersion:PAPER_POLICY.version,outcome:{status:"FINISHED",recordedAt:{lt:cutoffAt}},kickoff:{lt:cutoffAt}},include:{outcome:true}});
    const observations:CalibrationObservation[]=[];
    for(const d of previous) {
      const evidence=d.evidence as unknown as PaperEvidence, result=d.outcome!;
      for(const [market,selections] of Object.entries(PAPER_SELECTIONS)) {
        const candidates=selections.map(s=>evidence.candidates.find(c=>c.market===market&&c.selection===s));
        if(candidates.some(c=>!c))continue;
        const winner=selections.findIndex(s=>resolveSelection(market,s,result.homeGoals!,result.awayGoals!)==="WIN");
        if(winner<0)continue;
        observations.push({decisionId:d.id,fixtureId:d.fixtureId,day:blantyreToday(d.kickoff),market,probabilities:candidates.map(c=>c!.probability),winner});
      }
    }
    const artifact=fitPaperCalibration(observations);
    await db.paperCalibration.createMany({data:[{policyVersion:PAPER_POLICY.version,day,cutoffAt,policyHash,artifactHash:hash(artifact),policy:JSON.parse(canonicalPaperJson(PAPER_POLICY)),artifact:JSON.parse(canonicalPaperJson(artifact))}],skipDuplicates:true});
    calibration=await db.paperCalibration.findUniqueOrThrow({where:{policyVersion_day:{policyVersion:PAPER_POLICY.version,day}}});
  }
  if(calibration.policyHash!==policyHash)throw new Error("Paper policy changed without a new version; capture blocked");
  if(calibration.artifactHash!==hash(calibration.artifact))throw new Error("Paper calibration checksum mismatch; capture blocked");
  // Freeze the artifact before establishing the decision cutoff; never backdate a new snapshot.
  now = new Date();
  if (blantyreToday(now) !== day) return { captured: 0, settled, calibrationDay: day };
  // Earliest five-minute tick within six hours of kickoff. Missing evidence creates an immutable PASS.
  const fixtures=await db.fixture.findMany({where:{status:"SCHEDULED",kickoff:{gt:new Date(now.getTime()+60_000),lte:new Date(now.getTime()+PAPER_POLICY.captureWindowHours*3_600_000)},paperDecisions:{none:{policyVersion:PAPER_POLICY.version}}},
    orderBy:[{kickoff:"asc"},{id:"asc"}],take:100,
    include:{predictions:{where:{stage:{in:["SELECTION","PRELIMINARY"]}},include:{market:true,modelRun:true}},
      quotes:{where:{capturedAt:{gte:new Date(now.getTime()-PAPER_POLICY.maximumQuoteAgeMinutes*60_000),lte:now},receivedAt:{lte:now},bookmaker:{active:true}},include:{market:true,bookmaker:true,rawPayload:{select:{receivedAt:true}}}}}});
  let captured=0;
  for(const f of fixtures) {
    if(f.kickoff.getTime()<=Date.now()+1000)continue;
    // Legacy predictions can be viewed retrospectively, but cannot seed a new prospective experiment.
    const forecasts=f.predictions.filter(p=>p.createdAt!==null&&p.createdAt<=now).map(p=>({id:p.id,market:p.market.normalizedKey??p.market.name,selection:p.selection,probability:Number(p.probability),asOfAt:p.asOfAt.toISOString(),createdAt:p.createdAt!.toISOString(),stage:p.stage,modelRunId:p.modelRunId,modelVersion:p.modelRun.version,modelCreatedAt:p.modelRun.createdAt.toISOString(),trainedUntil:p.modelRun.trainedUntil.toISOString()}));
    const quotes=f.quotes.map(q=>({id:q.id,market:q.market.normalizedKey??q.market.name,selection:q.selection,odds:Number(q.decimalOdds),bookmakerId:q.bookmakerId,bookmakerName:q.bookmaker.name,priority:q.bookmaker.priority,active:q.bookmaker.active,capturedAt:q.capturedAt.toISOString(),receivedAt:q.receivedAt.toISOString(),rawPayloadId:q.rawPayloadId,rawReceivedAt:q.rawPayload?.receivedAt.toISOString()??null}));
    const candidates=paperCandidates(forecasts,quotes,now.toISOString(),f.kickoff.toISOString(),calibration.artifact as unknown as PaperCalibration);
    const evidence:PaperEvidence={candidates,arms:paperArms(candidates),rejectedForecastIds:f.predictions.filter(p=>!candidates.some(c=>c.id===p.id)).map(p=>p.id)};
    const result=await db.paperDecision.createMany({data:[{policyVersion:PAPER_POLICY.version,fixtureId:f.id,calibrationId:calibration.id,decidedAt:now,kickoff:f.kickoff,evidence:JSON.parse(canonicalPaperJson(evidence)),evidenceHash:hash(evidence)}],skipDuplicates:true});
    captured+=result.count;
  }
  return {captured,settled,calibrationDay:day};
}
