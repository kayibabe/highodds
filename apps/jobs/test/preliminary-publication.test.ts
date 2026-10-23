import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ fixtures: vi.fn(), bookmakers: vi.fn(), markets: vi.fn(), quotes: vi.fn(), predictions: vi.fn(), validation: vi.fn(), ticketVersion: vi.fn(), tickets: vi.fn() }));
vi.mock("@highodds/db", () => ({ db: {
  fixture: { findMany: mock.fixtures }, bookmaker: { findMany: mock.bookmakers }, market: { findMany: mock.markets },
  oddsQuote: { findMany: mock.quotes }, prediction: { findMany: mock.predictions },
  validationPick: { createMany: mock.validation }, ticketVersion: { findFirst: mock.ticketVersion, findMany: mock.tickets }
} }));
vi.mock("../src/predict.js", () => ({ generatePredictions: vi.fn().mockResolvedValue({ predicted: 0, skipped: 1 }) }));
import { publishTickets } from "../src/publish.js";

describe("preliminary publication isolation", () => {
  beforeEach(() => vi.clearAllMocks());
  it("cannot publish or enter the prospective priced cohort when only previews exist", async () => {
    const now = new Date("2026-10-05T06:00:00Z");
    mock.fixtures.mockResolvedValue([{ id: "fixture", competitionId: "league", kickoff: new Date("2026-10-05T18:00:00Z") }]);
    mock.bookmakers.mockResolvedValue([{ id: "book", priority: 1, active: true }]);
    mock.markets.mockResolvedValue([{ id: "goals", normalizedKey: "TOTAL_GOALS" }]);
    mock.quotes.mockResolvedValue(["OVER_2_5", "UNDER_2_5"].map(selection => ({ id: selection, fixtureId: "fixture", marketId: "goals", bookmakerId: "book", selection, decimalOdds: 2.2, capturedAt: now })));
    // A preview would otherwise qualify for the price-based prospective cohort.
    mock.predictions.mockImplementation(async ({ where }) => where.stage === "SELECTION" ? [] : [{ fixtureId: "fixture", marketId: "goals", selection: "OVER_2_5", probability: 0.7, stage: "PRELIMINARY" }]);
    mock.ticketVersion.mockResolvedValue(null);
    mock.tickets.mockResolvedValue([]);
    expect(await publishTickets(now)).toEqual({ published: 0, predicted: 0, predictionsSkipped: 1 });
    expect(mock.predictions.mock.calls[0][0].where.stage).toBe("SELECTION");
    expect(mock.validation).not.toHaveBeenCalled();
    expect(mock.tickets).not.toHaveBeenCalled();
  });
});
