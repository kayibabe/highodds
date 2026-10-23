import { redirect } from "next/navigation";
import { db } from "@highodds/db";
import { auth, isAuthDisabled, LOCAL_ACCESS_EMAIL } from "../../auth";
import { FixtureCalendar } from "../fixture-calendar";
import { extendSubscriber, retrainNow, retryJob, toggleAdminRole, toggleBookmakerActive } from "./actions";

export const dynamic = "force-dynamic";

function fmt(date: Date | null | undefined): string { return date ? date.toISOString().replace("T", " ").slice(0, 16) : "—"; }
function coverage(job: { jobType: string; payload: unknown }): string {
  if (job.jobType === "EVENING_FORECAST" && job.payload && typeof job.payload === "object") {
    const value = job.payload as Record<string, unknown>;
    return typeof value.predicted === "number" && typeof value.skipped === "number"
      ? `${value.targetDate}: ${value.predicted} market outcomes; ${value.skipped} skipped matches` : "Awaiting evening forecast";
  }
  if (job.jobType !== "VERIFY_ODDS_COVERAGE" || !job.payload || typeof job.payload !== "object") return "—";
  const value = job.payload as Record<string, unknown>;
  return typeof value.checked === "number" && typeof value.remaining === "number" ? `${value.checked} checked; ${value.remaining} missing` : "—";
}

export default async function AdminPage() {
  const session = isAuthDisabled() ? { user: { email: LOCAL_ACCESS_EMAIL, role: "ADMIN" as const } } : await auth();
  if (!session?.user?.email) redirect("/signin");
  if (session.user.role !== "ADMIN") redirect("/signin");

  const [users, jobs, quota, modelRuns, auditLogs, bookmakers] = await Promise.all([
    db.user.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    db.jobRun.findMany({ orderBy: { updatedAt: "desc" }, take: 20 }),
    db.apiQuotaUsage.findFirst({ where: { usageDate: new Date(new Date().toISOString().slice(0, 10)) } }),
    db.modelRun.findMany({ orderBy: { createdAt: "desc" }, take: 10, include: { competition: true } }),
    db.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 30, include: { actor: true } }),
    db.bookmaker.findMany({ orderBy: { priority: "asc" } })
  ]);

  return (
    <section>
      <p className="eyebrow">ADMINISTRATION</p>
      <h1>Operations console</h1>
      <div className="notice">Role validation occurs server-side on every action below. This screen contains no payment controls.</div>

      <h2>Subscribers</h2>
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Active until</th><th></th><th></th></tr></thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>{user.email}</td>
              <td>{user.role}</td>
              <td>{fmt(user.activeTo)}</td>
              <td><form action={extendSubscriber}><input type="hidden" name="userId" value={user.id} /><button type="submit">+30 days</button></form></td>
              <td><form action={toggleAdminRole}><input type="hidden" name="userId" value={user.id} /><button type="submit">{user.role === "ADMIN" ? "Revoke admin" : "Make admin"}</button></form></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Bookmakers</h2>
      <p>At least one bookmaker must be active for ticket publication to select quotes.</p>
      <table>
        <thead><tr><th>Name</th><th>Priority</th><th>Active</th><th></th></tr></thead>
        <tbody>
          {bookmakers.map((bookmaker) => (
            <tr key={bookmaker.id}>
              <td>{bookmaker.name}</td>
              <td>{bookmaker.priority}</td>
              <td>{bookmaker.active ? "Yes" : "No"}</td>
              <td><form action={toggleBookmakerActive}><input type="hidden" name="bookmakerId" value={bookmaker.id} /><button type="submit">{bookmaker.active ? "Deactivate" : "Activate"}</button></form></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Jobs &amp; quota</h2>
      <FixtureCalendar now={new Date()} basePath="/research" />
      <p>Today&apos;s API-Football usage: {quota ? `${quota.requestCount} requests (plan quota ${quota.quotaLimit}/day, shared key)` : "No requests yet today"}</p>
      <table>
        <thead><tr><th>Type</th><th>Status</th><th>Attempts</th><th>Run after</th><th>Coverage</th><th>Last error</th><th></th></tr></thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>{job.jobType}</td>
              <td>{job.status}</td>
              <td>{job.attempts}</td>
              <td>{fmt(job.runAfter)}</td>
              <td>{coverage(job)}</td>
              <td>{job.lastError ?? "—"}</td>
              <td>{job.status !== "DONE" && job.status !== "RUNNING" && <form action={retryJob}><input type="hidden" name="jobId" value={job.id} /><button type="submit">Retry now</button></form>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Model diagnostics</h2>
      <form action={retrainNow}><button type="submit">Retrain now (queues TRAIN_MODEL)</button></form>
      <table>
        <thead><tr><th>Competition</th><th>Method</th><th>Trained until</th><th>Teams</th></tr></thead>
        <tbody>
          {modelRuns.map((run) => (
            <tr key={run.id}>
              <td>{run.competition?.name ?? "—"}</td>
              <td>{run.method}</td>
              <td>{fmt(run.trainedUntil)}</td>
              <td>{Object.keys((run.artifact as { teams?: Record<string, unknown> })?.teams ?? {}).length}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Audit log</h2>
      <table>
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
        <tbody>
          {auditLogs.map((entry) => (
            <tr key={entry.id}>
              <td>{fmt(entry.createdAt)}</td>
              <td>{entry.actor?.email ?? "system"}</td>
              <td>{entry.action}</td>
              <td>{entry.target}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
