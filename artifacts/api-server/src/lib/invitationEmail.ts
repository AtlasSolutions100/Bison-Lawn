import type { CompanyProfile } from "@workspace/db";
import { getCompanyProfile } from "./companyProfile";
import { sendCustomerMessageViaGmail } from "./customerMessageDelivery";
import { defaultGmailProxy, type GmailProxy } from "./gmail";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const roleLabel = (role: string) => (role === "admin" ? "an admin" : "a contractor");

/** Where the invited person goes to create their sign-in. */
export function signUpUrl(): string {
  const base = (process.env.APP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  return base ? `${base}/sign-up` : "/sign-up";
}

export function invitationSubject(company: CompanyProfile | undefined) {
  const name = (company?.name ?? "").trim();
  return name ? `You have been added to ${name}` : "You have been added to the crew";
}

/**
 * The invitation email.
 *
 * The single most important line here is "use this email address". A role is
 * attached to the invited address and redeemed when someone signs in with that
 * address *verified* — sign up with a different one and the invitation is not
 * redeemed, so the person lands as a plain contractor with none of the access
 * they were given. That is invisible to them and confusing to the office, so
 * the email says it in the body rather than trusting anyone to guess.
 */
export function invitationHtml(input: {
  role: string;
  email: string;
  invitedByName: string | null;
  note: string | null;
  company: CompanyProfile | undefined;
}) {
  const company = (input.company?.name ?? "").trim() || "the team";
  const inviter = (input.invitedByName ?? "").trim();
  const url = signUpUrl();

  return `<!doctype html><html><body style="margin:0;background:#f7f5f1;font-family:Arial,sans-serif;color:#2b2118">
    <div style="max-width:560px;margin:0 auto;padding:28px 24px">
      <h1 style="margin:0 0 16px;font-size:20px;color:#215343">${escapeHtml(company)}</h1>
      <p style="font-size:15px;line-height:1.5;margin:0 0 14px">
        ${inviter ? `${escapeHtml(inviter)} has added you` : "You have been added"} to
        ${escapeHtml(company)} as ${roleLabel(input.role)}.
      </p>
      ${
        input.note?.trim()
          ? `<p style="font-size:15px;line-height:1.5;margin:0 0 14px;padding:10px 12px;background:#ebf1ee;border-radius:6px">${escapeHtml(
              input.note.trim(),
            )}</p>`
          : ""
      }
      <p style="font-size:15px;line-height:1.5;margin:0 0 20px">
        Create your sign-in to see your jobs:
      </p>
      <p style="margin:0 0 20px">
        <a href="${escapeHtml(url)}"
           style="display:inline-block;background:#215343;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:bold;font-size:15px">
          Set up your account
        </a>
      </p>
      <p style="font-size:14px;line-height:1.5;margin:0 0 14px;padding:10px 12px;background:#fdf6e3;border-left:3px solid #b4451f;border-radius:4px">
        <strong>Please sign up using ${escapeHtml(input.email)}.</strong>
        Your access is attached to that address — signing up with a different one
        will not give you the right access.
      </p>
      <p style="font-size:13px;color:#6f675f;line-height:1.5;margin:0">
        If you were not expecting this, you can ignore it. Nothing happens until
        you create an account.
      </p>
    </div>
  </body></html>`;
}

export type InvitationSendResult = { emailed: boolean; error: string | null };

/**
 * Email an invitation, reporting whether it actually went.
 *
 * Deliberately does not throw: the invitation row is worth keeping even when
 * the mail fails, because the role still applies the moment that person signs
 * in. But it does not swallow the failure either — the office was told the
 * invite had been sent when nothing had been sent at all, which is how a
 * contractor waits three days for an email that was never going to arrive.
 */
export async function sendInvitationEmail(
  input: { email: string; role: string; invitedByName: string | null; note: string | null },
  proxy: GmailProxy = defaultGmailProxy,
  loadCompany: () => Promise<CompanyProfile | undefined> = getCompanyProfile,
): Promise<InvitationSendResult> {
  try {
    const company = await loadCompany();
    await sendCustomerMessageViaGmail(
      {
        toEmail: input.email,
        subject: invitationSubject(company),
        html: invitationHtml({ ...input, company }),
      },
      proxy,
    );
    return { emailed: true, error: null };
  } catch (err) {
    return { emailed: false, error: err instanceof Error ? err.message : "Could not send the invitation email." };
  }
}
