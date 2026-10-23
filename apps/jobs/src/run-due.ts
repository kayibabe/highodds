import { ApiFootballClient, getOddsWithProvenance } from "./api-football.js";
import { parseIsoDay, providerDates, SELECTION_WINDOW_HOURS } from "@highodds/core";
import { ingestFixtures, ingestOdds } from "./ingestion.js";
import { generatePredictions } from "./predict.js";
import { captureOddsCoverage } from "./odds-coverage.js";
import { claimDueJobs, completeJob, ensureDailyJobs, failAndReleaseJob, requeueExpiredLeases } from "./schedule.js";
import { NoTrainingDataError, assertTrainedAny, trainModel } from "./train.js";
import { publishTickets } from "./publish.js";
import { refreshFinishedFixtures, refreshLiveTicketFixtures, refreshPendingResults, settleResults } from "./settle.js";
import { refreshPublishedTicketOdds } from "./ticket-odds-refresh.js";
import { capturePaperResearch } from "./paper-research.js";

const EXECUTION_TIMEOUT_MS = 4 * 60 * 1000;
// Missing history won't fix itself within minutes; retry hourly so training resumes on its own after a backfill.
const NO_TRAINING_DATA_RETRY_MS = 60 * 60 * 1000;
const deadline = Date.now() + EXECUTION_TIMEOUT_MS;

async function execute(job: { jobType: string; idempotencyKey: string; payload?: unknown }): Promise<Record<string, number | string> | undefined> {
  const client = new ApiFootballClient();
  const date = new Date().toISOString().slice(0, 10);
  switch (job.jobType) {
    case "EVENING_FORECAST": {
      const targetDate = job.payload && typeof job.payload === "object" && "targetDate" in job.payload
        ? parseIsoDay(job.payload.targetDate) : null;
      if (!targetDate) throw new Error("Evening forecast requires a valid pinned target date");
      const result = await generatePredictions(new Date(), { stage: "PRELIMINARY", targetDate });
      console.log(`EVENING_FORECAST targetDate=${targetDate} predicted=${result.predicted} skipped=${result.skipped}`);
      return { targetDate, ...result };
    }
    case "INGEST_FIXTURES": {
      const requestedDate = job.payload && typeof job.payload === "object" && "fixtureDate" in job.payload
        ? parseIsoDay(job.payload.fixtureDate) : parseIsoDay(job.idempotencyKey.split(":").at(-1)) ?? date;
      if (!requestedDate) throw new Error("Invalid fixture ingestion date");
      const fixtures = await client.getPaged("/fixtures", { date: requestedDate });
      const result = await ingestFixtures(fixtures);
      console.log(`INGEST_FIXTURES date=${requestedDate} ingested=${result.ingested} rejected=${result.rejected}`);
      return { fixtureDate: requestedDate, ...result };
    }
    case "INGEST_ODDS": {
      const now = new Date();
      let quotes = 0; let rejected = 0;
      for (const oddsDate of providerDates(now, new Date(now.getTime() + SELECTION_WINDOW_HOURS * 3_600_000))) {
        const result = await ingestOdds(await getOddsWithProvenance(client, { date: oddsDate }));
        quotes += result.quotes; rejected += result.rejected;
      }
      return { quotes, rejected };
    }
    case "VERIFY_ODDS_COVERAGE": {
      const result = await captureOddsCoverage(new Date(), client);
      console.log(`VERIFY_ODDS_COVERAGE forecasts=${result.forecasts} checked=${result.checked} retried=${result.retried} captured=${result.captured} remaining=${result.remaining}`);
      return { ...result };
    }
    case "TRAIN_MODEL": {
      const result = await trainModel(new Date());
      console.log(`TRAIN_MODEL trained=${result.trained} skipped=${result.skipped}`);
      assertTrainedAny(result);
      return;
    }
    case "PUBLISH_TICKETS": {
      const result = await publishTickets(new Date());
      console.log(`PUBLISH_TICKETS predicted=${result.predicted} predictionsSkipped=${result.predictionsSkipped} published=${result.published}`);
      return;
    }
    case "SETTLE_RESULTS": {
      // Settlement only reads the database, so a failed refresh (e.g. the shared key's daily limit)
      // must not hold back tickets the stored results already decide; the job still retries.
      const settleNow = new Date();
      const refreshError = await refreshPendingResults(settleNow, client).then(() => null, (error: unknown) => error);
      await settleResults(settleNow);
      if (refreshError) throw refreshError;
      return;
    }
    default: throw new Error(`Unsupported job type: ${job.jobType}`);
  }
}

async function main(): Promise<void> {
  const now = new Date();
  await ensureDailyJobs(now);
  await requeueExpiredLeases(now);
  const jobs = await claimDueJobs(now);
  for (const job of jobs) {
    if (Date.now() >= deadline - 15_000) {
      await failAndReleaseJob(job.id, new Error("Execution deadline reached before job start"), 0);
      continue;
    }
    try {
      const result = await execute(job);
      await completeJob(job.id, result);
    } catch (error) {
      console.error(`${job.jobType} failed:`, error instanceof Error ? error.message : error);
      await failAndReleaseJob(job.id, error, error instanceof NoTrainingDataError ? NO_TRAINING_DATA_RETRY_MS : undefined);
    }
  }
  await settleFinishedMatches();
  await refreshTicketOdds();
  if (Date.now() < deadline - 15_000) {
    try {
      console.log("PAPER_RESEARCH", JSON.stringify(await capturePaperResearch(new Date())));
    } catch (error) {
      console.error("PAPER_RESEARCH failed:", error instanceof Error ? error.message : error);
    }
  }
}

/** Every tick, bounded evidence capture for prices observed after a ticket was published. */
async function refreshTicketOdds(): Promise<void> {
  if (Date.now() >= deadline - 30_000) return;
  try {
    const result = await refreshPublishedTicketOdds(new Date(), new ApiFootballClient());
    if (result.requested > 0) console.log(`TICKET_ODDS_REFRESH eligible=${result.eligible} requested=${result.requested} captured=${result.captured} rejected=${result.rejected}`);
  } catch (error) {
    // A later quote is diagnostic evidence, never a reason to interrupt daily publication or settlement.
    console.error("TICKET_ODDS_REFRESH failed:", error instanceof Error ? error.message : error);
  }
}

/** Every tick, not a daily job: picks up full-time results within minutes and settles what they complete. */
async function settleFinishedMatches(): Promise<void> {
  if (Date.now() >= deadline - 30_000) return;
  const now = new Date();
  try {
    const live = await refreshLiveTicketFixtures(now);
    if (live.requested > 0) console.log(`LIVE_FIXTURE_REFRESH requested=${live.requested} refreshed=${live.refreshed}`);
  } catch (error) {
    console.error("LIVE_FIXTURE_REFRESH failed:", error instanceof Error ? error.message : error);
  }
  let refresh = { requested: 0, refreshed: 0 };
  try {
    refresh = await refreshFinishedFixtures(now);
  } catch (error) {
    // Keep going: settlement only needs the database, and results already stored may decide tickets.
    console.error("LIVE_SETTLE refresh failed:", error instanceof Error ? error.message : error);
  }
  try {
    const settle = await settleResults(now);
    if (refresh.requested > 0 || settle.settled > 0) console.log(`LIVE_SETTLE requested=${refresh.requested} refreshed=${refresh.refreshed} settled=${settle.settled} pending=${settle.pending}`);
  } catch (error) {
    console.error("LIVE_SETTLE settle failed:", error instanceof Error ? error.message : error);
  }
}

try { await main(); } catch (error) { console.error(error); process.exitCode = 1; }
