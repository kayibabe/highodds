import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@highodds/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const expected = process.env.PORTFOLIO_EXPORT_TOKEN;
  const supplied = request.headers.get("x-portfolio-token");
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function parseDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const targetDate = parseDate(request.nextUrl.searchParams.get("date"));
  if (!targetDate) return Response.json({ error: "A valid date is required" }, { status: 422 });

  const run = await db.candidateSnapshotRun.findFirst({
    where: { targetDate, ticketVersions: { some: {} } },
    orderBy: [{ capturedAt: "asc" }, { id: "asc" }],
    include: {
      candidates: {
        orderBy: [{ fixtureId: "asc" }, { id: "asc" }],
        include: {
          fixture: {
            include: { competition: true, homeTeam: true, awayTeam: true },
          },
        },
      },
    },
  });

  if (!run) {
    return Response.json({ app: "highodds", target_date: targetDate.toISOString().slice(0, 10), captured: false, captured_at: null, policy_version: null, rows: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  // Export the immutable candidate universe, not only the subset assembled
  // into ACCA tickets. Portfolio ranks this independent daily slate separately.
  const eligibleCandidates = run.candidates.filter((candidate) =>
    Object.values(candidate.tierEligibility as Record<string, string | null>).some((reason) => reason === null)
  );
  const rows = eligibleCandidates.map((candidate) => ({
    source_id: candidate.id,
    source_group_id: run.id,
    match_id: candidate.fixture.providerId,
    home_team: candidate.fixture.homeTeam.name,
    away_team: candidate.fixture.awayTeam.name,
    competition: candidate.fixture.competition.name,
    kickoff_at: candidate.fixture.kickoff.toISOString(),
    market: candidate.marketKey,
    selection: candidate.selection,
    odds: Number(candidate.decimalOdds),
    probability: Number(candidate.modelProbability),
    market_probability: Number(candidate.consensusProbability),
    status: candidate.fixture.status,
    score: candidate.fixture.homeGoals == null || candidate.fixture.awayGoals == null
      ? null
      : `${candidate.fixture.homeGoals}-${candidate.fixture.awayGoals}`,
    outcome: null,
    qualification_status: candidate.selected ? "ticket_selected" : "daily_candidate",
    qualification_reason: candidate.baseEligibilityReason,
    evidence: {
      run_id: run.id,
      captured_at: run.capturedAt.toISOString(),
      policy_version: run.policyVersion,
      quote_id: candidate.quoteId,
      confidence_score: candidate.confidenceScore,
      conservative_expected_value: Number(candidate.conservativeExpectedValue),
      tier_eligibility: candidate.tierEligibility,
      ticket_tier: candidate.ticketTier,
      selected_for_ticket: candidate.selected,
    },
  }));

  return Response.json({
    app: "highodds",
    target_date: targetDate.toISOString().slice(0, 10),
    captured: true,
    captured_at: run.capturedAt.toISOString(),
    policy_version: run.policyVersion,
    rows,
  }, { headers: { "Cache-Control": "no-store" } });
}
