/**
 * Pipeline settings shared by the jobs runner (which acts on them) and the web app (which reports
 * them), so the analysis page can never describe a different rule from the one that ran.
 */

/** Selection-window forecasts and tickets consider fixtures this many hours after the run. */
export const SELECTION_WINDOW_HOURS = 20;

/**
 * Published paper-ticket fixtures are re-queried at most this often before kickoff. This is
 * deliberately separate from daily market ingestion: it creates post-publication price evidence
 * without repeatedly polling the full selection universe.
 */
export const TICKET_ODDS_REFRESH_MINUTES = 30;

/** Bound the API-Football fixture calls made by one cron invocation. */
export const MAX_TICKET_ODDS_FIXTURES_PER_TICK = 12;

/** Fixture discovery covers today and the following six Africa/Blantyre calendar days. */
export const FIXTURE_LOOKAHEAD_DAYS = 7;

/** Daily jobs, created idempotently per UTC day. 05:00 UTC is 07:00 Africa/Blantyre. */
export const DAILY_JOB_SCHEDULE = [
  { jobType: "INGEST_FIXTURES", utcTime: "00:05" },
  { jobType: "TRAIN_MODEL", utcTime: "04:00" },
  { jobType: "INGEST_ODDS", utcTime: "04:30" },
  { jobType: "VERIFY_ODDS_COVERAGE", utcTime: "04:45" },
  { jobType: "PUBLISH_TICKETS", utcTime: "05:00" },
  { jobType: "EVENING_FORECAST", utcTime: "20:00" },
  { jobType: "SETTLE_RESULTS", utcTime: "21:00" }
] as const;

/** A claimed job not completed within this lease is requeued. */
export const JOB_LEASE_MINUTES = 20;
/** A failed job is released to run again after this delay. */
export const JOB_RETRY_MINUTES = 5;
