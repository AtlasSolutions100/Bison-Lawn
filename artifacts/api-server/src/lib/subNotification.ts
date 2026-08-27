import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendCustomerMessageViaGmail } from "./customerMessageDelivery";
import { defaultGmailProxy, type GmailProxy } from "./gmail";
import { getCompanyProfile } from "./companyProfile";
import { logger } from "./logger";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type NewJobNotice = {
  jobId: number;
  serviceName: string;
  clientName: string | null;
  clientAddress: string | null;
  scheduledDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  amount: number;
};

/**
 * Tell a subcontractor a job has been added to their day.
 *
 * The owner asked for this alongside auto-scheduling: "mowing to be scheduled
 * with the route that it best fits into (notification to sub that new job has
 * been added)". Until now an auto-created job only wrote an audit event, which
 * the office sees and the sub does not — so a job could appear on someone's
 * route overnight with nothing to tell them.
 *
 * Never throws. A sub who does not hear about a job will still see it on their
 * board in the morning; an exception here would roll back into the acceptance
 * path and risk losing the customer's approval, which is far worse.
 */
export async function notifyAssignedSub(
  assignedToId: number | null,
  notice: NewJobNotice,
  proxy: GmailProxy = defaultGmailProxy,
): Promise<void> {
  if (assignedToId == null) return;

  try {
    const [sub] = await db.select().from(usersTable).where(eq(usersTable.id, assignedToId));
    // No address on file is the normal case for a sub who signed in with a
    // phone-only account. Not an error, and not worth logging every time.
    if (!sub?.email) return;

    const company = await getCompanyProfile();
    const when = notice.scheduledDate
      ? `on ${notice.scheduledDate}`
      : notice.windowStart && notice.windowEnd
        ? `between ${notice.windowStart} and ${notice.windowEnd}`
        : "soon";

    const rows: [string, string | null][] = [
      ["Service", notice.serviceName],
      ["Customer", notice.clientName],
      ["Address", notice.clientAddress],
      ["When", when],
      ["Amount", notice.amount.toLocaleString("en-US", { style: "currency", currency: "USD" })],
    ];
    const table = rows
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<tr><td style="padding:3px 14px 3px 0;color:#6f675f;white-space:nowrap">${k}</td>` +
          `<td style="padding:3px 0"><strong>${escapeHtml(String(v))}</strong></td></tr>`,
      )
      .join("");

    await sendCustomerMessageViaGmail(
      {
        toEmail: sub.email,
        subject: `New job added: ${notice.serviceName} ${when} | ${company.name}`,
        html:
          `<!doctype html><html><body style="margin:0;background:#f7f5f1;font-family:Arial,sans-serif;color:#2b2118">` +
          `<div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;overflow:hidden">` +
          `<div style="background:#215343;color:#fff;padding:22px 28px"><h1 style="margin:0;font-size:19px">A job was added to your route</h1></div>` +
          `<div style="padding:24px 28px">` +
          `<p style="margin:0 0 18px">A customer accepted an estimate, so this was scheduled automatically.</p>` +
          `<table style="font-size:14px;border-collapse:collapse">${table}</table>` +
          `<p style="margin-top:22px;font-size:13px;color:#6f675f">It is already on your job list in the app. Nothing to accept — this is just so it does not appear without warning.</p>` +
          `</div></div></body></html>`,
      },
      proxy,
    );
  } catch (err) {
    logger.error({ err, jobId: notice.jobId, assignedToId }, "failed to notify sub of a new job");
  }
}
