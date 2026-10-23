import { Prisma } from "@prisma/client";
import { db } from "@highodds/db";

/** Retrospective proxy, not an immutable published decision. No later prices enter this metric. */
export async function loadResearchDecisionPrices(predictionIds: string[]): Promise<Map<string, number>> {
  if (!predictionIds.length) return new Map();
  const rows = await db.$queryRaw<Array<{ predictionId: string; odds: number }>>(Prisma.sql`
    SELECT p.id AS "predictionId", price.odds FROM "Prediction" p
    JOIN "Fixture" f ON f.id = p."fixtureId"
    JOIN "ModelRun" mr ON mr.id = p."modelRunId"
    JOIN LATERAL (
      SELECT q."decimalOdds"::float8 AS odds FROM "OddsQuote" q
      JOIN "Bookmaker" b ON b.id = q."bookmakerId"
      JOIN "RawProviderPayload" raw ON raw.id = q."rawPayloadId"
      WHERE q."fixtureId" = p."fixtureId" AND q."marketId" = p."marketId" AND q.selection = p.selection
        AND b.active AND q."decimalOdds" > 1
        AND q."capturedAt" <= p."asOfAt" AND q."receivedAt" <= p."asOfAt" AND raw."receivedAt" <= p."asOfAt"
      ORDER BY b.priority, b.id, q."capturedAt" DESC, q.id LIMIT 1
    ) price ON true
    WHERE p.id IN (${Prisma.join(predictionIds)}) AND p."asOfAt" < f.kickoff
      AND mr."trainedUntil" <= p."asOfAt" AND mr."createdAt" <= p."asOfAt"`);
  return new Map(rows.map(row => [row.predictionId, row.odds]));
}
