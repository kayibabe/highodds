-- Do not manufacture ingestion timestamps for legacy forecasts.
ALTER TABLE "Prediction" ADD COLUMN "createdAt" TIMESTAMP(3);
ALTER TABLE "Prediction" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "PaperCalibration" (
  "id" TEXT PRIMARY KEY, "policyVersion" TEXT NOT NULL, "day" TEXT NOT NULL,
  "cutoffAt" TIMESTAMP(3) NOT NULL, "policyHash" TEXT NOT NULL, "artifactHash" TEXT NOT NULL,
  "policy" JSONB NOT NULL, "artifact" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaperCalibration_cutoff_check" CHECK ("cutoffAt" <= "createdAt")
);
CREATE UNIQUE INDEX "PaperCalibration_policyVersion_day_key" ON "PaperCalibration"("policyVersion", "day");
CREATE TABLE "PaperDecision" (
  "id" TEXT PRIMARY KEY, "policyVersion" TEXT NOT NULL, "fixtureId" TEXT NOT NULL,
  "calibrationId" TEXT NOT NULL, "decidedAt" TIMESTAMP(3) NOT NULL, "kickoff" TIMESTAMP(3) NOT NULL,
  "evidence" JSONB NOT NULL, "evidenceHash" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaperDecision_time_check" CHECK ("decidedAt" < "kickoff" AND "decidedAt" <= "createdAt" AND "createdAt" < "kickoff"),
  CONSTRAINT "PaperDecision_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture"("id") ON DELETE RESTRICT,
  CONSTRAINT "PaperDecision_calibrationId_fkey" FOREIGN KEY ("calibrationId") REFERENCES "PaperCalibration"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "PaperDecision_policyVersion_fixtureId_key" ON "PaperDecision"("policyVersion", "fixtureId");
CREATE INDEX "PaperDecision_decidedAt_idx" ON "PaperDecision"("decidedAt");
CREATE FUNCTION highodds_validate_paper_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Fixture" f WHERE f.id = NEW."fixtureId" AND f.status = 'SCHEDULED'
    AND f.kickoff = NEW.kickoff AND f.kickoff > clock_timestamp()) THEN
    RAISE EXCEPTION 'Paper decisions require a currently scheduled future fixture';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "PaperCalibration" c WHERE c.id = NEW."calibrationId"
    AND c."policyVersion" = NEW."policyVersion" AND c."createdAt" <= NEW."decidedAt") THEN
    RAISE EXCEPTION 'Paper calibration must be frozen before the decision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER highodds_paper_decision_time_guard BEFORE INSERT ON "PaperDecision"
FOR EACH ROW EXECUTE FUNCTION highodds_validate_paper_decision();
CREATE TABLE "PaperOutcome" (
  "id" TEXT PRIMARY KEY, "decisionId" TEXT NOT NULL UNIQUE, "status" TEXT NOT NULL,
  "homeGoals" INTEGER, "awayGoals" INTEGER, "resultReceivedAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaperOutcome_status_check" CHECK ("status" IN ('FINISHED','POSTPONED','CANCELLED')),
  CONSTRAINT "PaperOutcome_score_check" CHECK ("status" <> 'FINISHED' OR ("homeGoals" IS NOT NULL AND "awayGoals" IS NOT NULL AND "homeGoals" >= 0 AND "awayGoals" >= 0)),
  CONSTRAINT "PaperOutcome_received_check" CHECK ("resultReceivedAt" <= "recordedAt"),
  CONSTRAINT "PaperOutcome_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "PaperDecision"("id") ON DELETE RESTRICT
);
CREATE TRIGGER highodds_paper_calibration_no_mutation BEFORE UPDATE OR DELETE ON "PaperCalibration"
FOR EACH ROW EXECUTE FUNCTION highodds_reject_ticket_mutation();
CREATE TRIGGER highodds_paper_decision_no_mutation BEFORE UPDATE OR DELETE ON "PaperDecision"
FOR EACH ROW EXECUTE FUNCTION highodds_reject_ticket_mutation();
CREATE TRIGGER highodds_paper_outcome_no_mutation BEFORE UPDATE OR DELETE ON "PaperOutcome"
FOR EACH ROW EXECUTE FUNCTION highodds_reject_ticket_mutation();
