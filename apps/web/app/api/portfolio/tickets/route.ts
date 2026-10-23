import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { loadTicketCards } from "../../../../lib/tickets";

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

  const from = parseDate(request.nextUrl.searchParams.get("from"));
  const to = parseDate(request.nextUrl.searchParams.get("to"));
  if (!from || !to || from > to || (to.valueOf() - from.valueOf()) / 86_400_000 > 3660) {
    return Response.json({ error: "A valid date range of up to ten years is required" }, { status: 422 });
  }
  const toExclusive = new Date(to.valueOf() + 86_400_000);
  const tickets = await loadTicketCards({ targetDate: { gte: from, lt: toExclusive } }, 2000, true);
  return Response.json({ tickets }, { headers: { "Cache-Control": "no-store" } });
}
