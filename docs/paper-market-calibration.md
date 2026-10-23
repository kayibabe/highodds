# Prospective market calibration

Protocol `market-calibration-paper-v3` is research only. No component writes TicketVersion, TicketLeg, or ValidationPick, places a bet, sends a recommendation, or grants publication authority.

V3 selects Selection-stage forecasts when any exist for the fixture. If there are none, it uses the Preliminary-stage forecasts, matching the Forecast Archive's fallback. This corrects v2's Selection-only input, which produced PASS decisions even where timestamped Preliminary distributions were available. V2 and earlier records remain append-only, excluded from v3 results and calibration, and visible as archived protocol counts.

The initial v1 startup captured only PASS decisions. It was superseded before evaluation to use canonical JSON checksums that survive PostgreSQL JSONB key reordering and floating-point serialization. Derived numeric values are saved with 12 significant digits; captured odds and source probabilities already have lower database precision. Those append-only v1 records remain preserved and are excluded from v2 training and results.

The local jobs loop calls the collector every tick, within its existing execution deadline. `npm run jobs:paper-research --workspace=@highodds/jobs` runs one collection/settlement pass manually. Database migration `20261012200000_paper_research` must precede the new web/jobs image.

## Decision protocol

- One append-only snapshot per fixture and protocol on the first available tick between one minute and six hours before kickoff. Worker batches are limited to 100 fixtures; subsequent ticks catch up. Missing evidence is a permanent PASS, not a reason to rewrite the experiment later.
- The complete eligible candidate universe, exact model/forecast identifiers, probabilities, selected quote identity and timestamps, bookmaker priority/name, normalized bookmaker probabilities, decisions and PASS reasons are persisted with a checksum.
- Only forecasts with a real `Prediction.createdAt` no later than the decision time qualify. Legacy rows remain unavailable to prospective capture, though their reconstructed results stay visible in Forecast Archive. Selection-stage forecasts take precedence over Preliminary-stage forecasts when both exist.
- Complete distributions must share forecast timestamp/model run. Complete quote markets must come from one active bookmaker, have at most five minutes of capture skew, be no older than 60 minutes, and have local quote and linked raw-payload receipt timestamps no later than decision time.
- Capture performs no extra provider requests. It uses the existing prediction/odds ingestion jobs. A lack of new forecasts or fresh prices is reported as PASS and may reduce coverage substantially; the protocol never silently relaxes evidence requirements.
- Baseline: strongest complete model probability at least 60%, with usable quote evidence. This comparator has stricter price/provenance requirements than the retrospective archive and is labelled accordingly.
- BTTS Yes arm: complete BTTS forecast, Yes probability at least 60%, usable quote. This was chosen after the initial audit; only future results may validate it.
- Calibrated-value arm: largest estimated return among complete markets with supported calibrated probability at least 60% and expected return at least 5%. The thresholds are frozen research settings, not validated optimal thresholds.

## Calibration and temporal separation

Each CAT day freezes an append-only artifact before capturing decisions. Training uses only this protocol's previously saved decisions with immutable FINISHED outcomes recorded before CAT midnight. No retrospective audit rows are inserted as prospective history.

Require 30 observed days, 300 distinct fixtures overall and 100 observations plus 30 days per market. The last 20% of observed days are held out; require at least 60 training and 20 validation observations. Fit multiclass temperature scaling on the earlier partition by log loss with a 0.01 log-temperature squared penalty, using the fixed temperature grid in `PAPER_POLICY`. Normalize the full distribution to preserve complementary probabilities. Retain the training-only fit only if it improves log loss on held-out days. Otherwise PASS. Store exact training/validation decision IDs, temperature and losses in the artifact.

This is a predeclared daily expanding-history algorithm, not a frozen single fitted model. Every future decision stores its daily artifact ID. Changing algorithm/settings requires a new protocol version; a policy hash mismatch fails closed.

## Settlement and review

Final scores are recorded separately and append-only. LIVE scores cannot settle decisions. POSTPONED and CANCELLED are void; a future reschedule cannot rewrite an existing decision. Later provider corrections need a separately reviewed correction protocol.

The web comparison uses hypothetical one-unit singles, excludes unpriced/pending/void rows from ROI and includes PASS counts. It shows mean forecast, actual hit rate and Brier scores against a same-match bookmaker probability baseline. Different arms select different matches; their headline ROIs are not a paired causal estimate. Exact saved evidence remains available for an independent common-universe evaluation.

Promotion is always blocked by this implementation. Minimum review collection targets are 30 completed days, 300 priced settled picks overall and 100 in any promoted market. Counts alone cannot grant authority. Independent review must still examine clustering-aware uncertainty, paired/common-universe results, costs, drawdown, day/league concentration and untouched future performance. There is no staking or automatic promotion mechanism.

## Historical measurement repair

Forecast Archive reads all matching fixtures in 500-row batches under a repeatable-read transaction. It displays actual saved forecast coverage, only scores FINISHED results, and separates hit-rate counts from priced/unpriced settled counts. Its hypothetical return proxy uses quotes and linked raw payloads received by the original forecast, with current active-bookmaker priority and no freshness filter. This policy is explicitly labelled and distinct from the stricter prospective policy and the historical screener's hindsight best-price exploration.

## Verification

Core tests cover chronology, quote provenance, completeness, bookmaker mixing, probability normalization, train/validation day separation, insufficient history, final-only settlement and missing-price denominators. A local `_test` PostgreSQL integration test verifies idempotency, immutable records, final-only outcome capture and rejection of backdated decisions. Run database integration tests against isolated test databases; do not point them at the application database.

For rollback, restore the prior web/jobs images. The migration is additive and older code ignores the new tables. Do not erase captured evidence or manufacture legacy forecast insertion times.
