import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), predict: vi.fn() }));
vi.mock("@highodds/db", () => ({ db: { ticketVersion: { findFirst: mocks.findFirst } } }));
vi.mock("../src/predict.js", () => ({ generatePredictions: mocks.predict }));
import { publishTickets } from "../src/publish.js";

it("retains a published daily set before rerunning selection or prediction", async () => {
  mocks.findFirst.mockResolvedValue({ id: "original" });
  expect(await publishTickets(new Date("2026-10-12T18:00:00Z"))).toEqual({
    published: 0, predicted: 0, predictionsSkipped: 0
  });
  expect(mocks.predict).not.toHaveBeenCalled();
  expect(mocks.findFirst).toHaveBeenCalledWith({
    where: { targetDate: new Date("2026-10-12T00:00:00Z") }, select: { id: true }
  });
});
