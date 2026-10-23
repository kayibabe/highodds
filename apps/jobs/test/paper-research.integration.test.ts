import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "@highodds/db";
import { capturePaperResearch, paperEvidenceHash } from "../src/paper-research.js";
import { PAPER_POLICY } from "@highodds/core";

describe.skipIf(!process.env.DATABASE_URL?.match(/\/[^/?]*_test(\?|$)/))("paper research immutable DB evidence", () => {
  it("records an idempotent prospective PASS, rejects mutations and settles only final results", async () => {
    const seed=randomInt(850_000_000,900_000_000);
    const competition=await db.competition.create({data:{providerId:seed,name:"Paper research synthetic league"}});
    const home=await db.team.create({data:{providerId:seed,name:"Paper Home"}});
    const away=await db.team.create({data:{providerId:seed+1,name:"Paper Away"}});
    const f=await db.fixture.create({data:{providerId:seed,competitionId:competition.id,homeTeamId:home.id,awayTeamId:away.id,kickoff:new Date(Date.now()+2*3_600_000)}});
    await capturePaperResearch();
    const first=await db.paperDecision.findUniqueOrThrow({where:{policyVersion_fixtureId:{policyVersion:PAPER_POLICY.version,fixtureId:f.id}}});
    expect((first.evidence as {arms:Array<{status:string}>}).arms.every(a=>a.status==="PASS")).toBe(true);
    await capturePaperResearch();
    expect(await db.paperDecision.count({where:{fixtureId:f.id}})).toBe(1);
    await expect(db.paperDecision.update({where:{id:first.id},data:{evidenceHash:"changed"}})).rejects.toThrow();
    await expect(db.paperCalibration.delete({where:{id:first.calibrationId}})).rejects.toThrow();
    await db.fixture.update({where:{id:f.id},data:{status:"LIVE",homeGoals:1,awayGoals:1}});
    await capturePaperResearch();
    expect(await db.paperOutcome.count({where:{decisionId:first.id}})).toBe(0);
    await db.fixture.update({where:{id:f.id},data:{status:"FINISHED",homeGoals:2,awayGoals:1}});
    await capturePaperResearch();
    const outcome=await db.paperOutcome.findUniqueOrThrow({where:{decisionId:first.id}});
    expect(outcome.status).toBe("FINISHED");
    await expect(db.paperOutcome.update({where:{id:outcome.id},data:{homeGoals:0}})).rejects.toThrow();
    const past=await db.fixture.create({data:{providerId:seed+2,competitionId:competition.id,homeTeamId:home.id,awayTeamId:away.id,kickoff:new Date(Date.now()-3600_000)}});
    await expect(db.paperDecision.create({data:{fixtureId:past.id,policyVersion:PAPER_POLICY.version,calibrationId:first.calibrationId,decidedAt:new Date(Date.now()-7200_000),kickoff:past.kickoff,evidence:{},evidenceHash:"invalid"}})).rejects.toThrow();
    const priced=await db.fixture.create({data:{providerId:seed+3,competitionId:competition.id,homeTeamId:home.id,awayTeamId:away.id,kickoff:new Date(Date.now()+3*3_600_000)}});
    const model=await db.modelRun.create({data:{version:"paper-test",method:"test",trainedUntil:new Date(Date.now()-3600_000),artifact:{}}});
    const market=await db.market.create({data:{providerId:seed,normalizedKey:"BTTS",name:"Paper BTTS"}});
    const book=await db.bookmaker.create({data:{providerId:seed,name:"Paper Book",priority:1,active:true}});
    const raw=await db.rawProviderPayload.create({data:{endpoint:"/test",requestKey:String(seed),page:1,body:{synthetic:true}}});
    const asOfAt=new Date();
    for (const [selection,probability,decimalOdds] of [["YES",.8,1.5],["NO",.2,3]] as const) {
      await db.prediction.create({data:{fixtureId:priced.id,marketId:market.id,selection,probability,modelRunId:model.id,asOfAt,stage:"SELECTION"}});
      await db.oddsQuote.create({data:{fixtureId:priced.id,marketId:market.id,bookmakerId:book.id,selection,decimalOdds,capturedAt:new Date(),rawPayloadId:raw.id}});
    }
    await capturePaperResearch();
    const saved=await db.paperDecision.findUniqueOrThrow({where:{policyVersion_fixtureId:{policyVersion:PAPER_POLICY.version,fixtureId:priced.id}}});
    const evidence=saved.evidence as {arms:Array<{arm:string;status:string}>;candidates:Array<{quote:{rawPayloadId:string};createdAt:string}>};
    expect(evidence.arms.find(a=>a.arm==="baseline")!.status).toBe("PAPER_PICK");
    expect(evidence.arms.find(a=>a.arm==="calibrated_value")!.status).toBe("PASS");
    expect(evidence.candidates[0]!.quote.rawPayloadId).toBe(raw.id);
    expect(evidence.candidates[0]!.createdAt).toBeTruthy();
    expect(saved.evidenceHash).toBe(paperEvidenceHash(saved.evidence));
    const frozen=await db.paperCalibration.findUniqueOrThrow({where:{id:saved.calibrationId}});
    expect(frozen.artifactHash).toBe(paperEvidenceHash(frozen.artifact));
    expect(frozen.policyHash).toBe(paperEvidenceHash(frozen.policy));
  },30_000);
});
