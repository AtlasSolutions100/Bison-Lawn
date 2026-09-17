import {
  clientsTable,
  clientServicesTable,
  db,
  letterSendsTable,
  letterTemplatesTable,
  servicesTable,
  type Client,
  type CompanyProfile,
} from "@workspace/db";
import { asc, eq, inArray } from "drizzle-orm";
import { roundMoney } from "./helpers";
import { sendClientEmailViaGmail } from "./clientEmail";
import { getCompanyProfile } from "./companyProfile";
import { brandAssetUrl, companyAddressLines, companyContactLine } from "./estimateDocument";
import { firstNameOf } from "./mergeTokens";

export const DEFAULT_LETTER_TEMPLATE = {
  name: "Spring renewal letter",
  subject: "Your lawn care services for the coming season | {{companyName}}",
  // Just the body he would type. The address block, sign-off and footer are
  // furniture that every one of his letters carries, so they are added at
  // render time and are not his to retype or accidentally delete.
  body: `Dear {{clientFirstName}},

Thank you for trusting us with your lawn care. Your services and pricing for the coming season are:

{{servicesTable}}

Total: {{total}}

Please contact us if you have any questions. We look forward to serving you this season.`,
};

export async function getOrCreateLetterTemplate() {
  const [existing] = await db.select().from(letterTemplatesTable).orderBy(asc(letterTemplatesTable.id)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(letterTemplatesTable).values(DEFAULT_LETTER_TEMPLATE).returning();
  return created;
}

export function currentServiceAmount(
  clientService: Pick<typeof clientServicesTable.$inferSelect, "quantity">,
  service: Pick<typeof servicesTable.$inferSelect, "rate">,
) {
  return roundMoney(service.rate * clientService.quantity);
}

async function getLetterClient(clientId: number) {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, clientId));
  if (!client) return null;

  const rows = await db
    .select({ clientService: clientServicesTable, service: servicesTable })
    .from(clientServicesTable)
    .innerJoin(servicesTable, eq(clientServicesTable.serviceId, servicesTable.id))
    .where(eq(clientServicesTable.clientId, clientId))
    .orderBy(asc(servicesTable.name));

  return {
    client,
    services: rows.map(({ clientService, service }) => ({
      name: service.name,
      amount: currentServiceAmount(clientService, service),
    })),
  };
}

const currency = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);

function replaceToken(value: string, token: string, replacement: string) {
  return value.split(`{{${token}}}`).join(replacement);
}

/** The customer's address block, the way every one of his letters opens. */
function addressBlock(client: Client) {
  const cityLine = [[client.city, client.state].filter(Boolean).join(", "), client.postalCode]
    .filter(Boolean)
    .join(" ")
    .trim();
  return [client.name, client.serviceAddress, client.addressLine2, cityLine]
    .map((line) => (line ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/** His sign-off and the company block that follows it. */
function signOffBlock(company: CompanyProfile) {
  const block = [company.name, ...companyAddressLines(company), company.phone, company.email]
    .map((line) => (line ?? "").trim())
    .filter(Boolean);
  return [company.signatureLine.trim(), "", ...block].join("\n");
}

/** The closing footer. Plain text, so it cannot be centred the way the PDF is. */
function footerBlock(company: CompanyProfile) {
  const address = companyAddressLines(company);
  const contact = companyContactLine(company);
  return [
    "Thank you for your business!",
    ...(address.length ? ["", ...address] : []),
    ...(contact ? ["", contact] : []),
  ].join("\n");
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * The services and their prices, as a table rather than a run of text lines.
 *
 * This is the part of the letter the customer actually reads closely — it is the
 * price they are being asked to accept for the season — and it is exactly what
 * plain text renders worst, since name and amount drift apart at any width the
 * reader's mail client happens to use.
 */
function servicesTableHtml(services: { name: string; amount: number }[], includeTotal: boolean) {
  if (!services.length) {
    return `<p style="margin:0 0 18px;color:#6f675f">No services assigned</p>`;
  }
  const rows = services
    .map(
      (service) =>
        `<tr>` +
        `<td style="padding:10px 0;border-bottom:1px solid #e7e2dc">${escapeHtml(service.name)}</td>` +
        `<td style="padding:10px 0;border-bottom:1px solid #e7e2dc;text-align:right;white-space:nowrap">${escapeHtml(currency(service.amount))}</td>` +
        `</tr>`,
    )
    .join("");
  const total = roundMoney(services.reduce((sum, service) => sum + service.amount, 0));
  const totalRow = includeTotal
    ? `<tr>` +
      `<td style="padding:14px 0 0;font-weight:bold">Total</td>` +
      `<td style="padding:14px 0 0;text-align:right;font-weight:bold;font-size:18px;color:#215343;white-space:nowrap">${escapeHtml(currency(total))}</td>` +
      `</tr>`
    : "";
  return (
    `<table role="presentation" width="100%" style="border-collapse:collapse;margin:0 0 20px;font-size:15px">` +
    `<tbody>${rows}${totalRow}</tbody></table>`
  );
}

/** The author's own total line, given the weight the table's total row would have had. */
function totalLineHtml(label: string, total: string) {
  return (
    `<table role="presentation" width="100%" style="border-collapse:collapse;margin:0 0 18px;font-size:15px"><tbody><tr>` +
    `<td style="font-weight:bold">${escapeHtml(label)}</td>` +
    `<td style="text-align:right;font-weight:bold;font-size:18px;color:#215343;white-space:nowrap">${escapeHtml(total)}</td>` +
    `</tr></tbody></table>`
  );
}

/**
 * The author's body text as HTML.
 *
 * Escaped first, then tokens are substituted — escapeHtml leaves braces alone, so
 * `{{servicesTable}}` survives it and the table we build is inserted afterwards
 * rather than being escaped into visible markup.
 *
 * Blocks are split on blank lines. A block that is only the services token
 * becomes the table itself, because a <table> nested inside a <p> is invalid and
 * mail clients recover from it unpredictably.
 */
function bodyHtml(body: string, tokens: Record<string, string>, services: { name: string; amount: number }[]) {
  // Whether the table carries the total depends on whether the author already
  // placed one. The default template writes "Total: {{total}}" on its own line,
  // so a table that always totalled would print the figure twice for everyone —
  // and a letter that states a customer's price twice invites the reply "which
  // one is it?". Keyed on the token rather than on the wording around it, so
  // rephrasing the line cannot resurrect the duplicate.
  const authorPlacesTotal = body.replace("{{servicesTable}}", "").includes("{{total}}");

  return body
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      if (block.trim() === "{{servicesTable}}") return servicesTableHtml(services, !authorPlacesTotal);

      // A block that is only a label and the total token is the author's total
      // line; give it the weight it would have had inside the table.
      const totalOnly = block.trim().match(/^(.*?):?\s*\{\{total\}\}$/);
      if (totalOnly && !totalOnly[1].includes("{{")) {
        return totalLineHtml(totalOnly[1].trim() || "Total", tokens.total ?? "");
      }
      let html = escapeHtml(block).replace(/\r?\n/g, "<br />");
      for (const [token, replacement] of Object.entries(tokens)) {
        if (token === "servicesTable") continue;
        html = replaceToken(html, token, escapeHtml(replacement));
      }
      // A services token sharing a paragraph with prose still has to render, so
      // it falls back to inline lines rather than dropping the prices entirely.
      html = replaceToken(
        html,
        "servicesTable",
        services.map((s) => `${escapeHtml(s.name)}: ${escapeHtml(currency(s.amount))}`).join("<br />"),
      );
      return `<p style="margin:0 0 16px;line-height:1.65">${html}</p>`;
    })
    .join("");
}

function springLetterHtml(params: {
  client: Client;
  services: { name: string; amount: number }[];
  body: string;
  tokens: Record<string, string>;
  company: CompanyProfile;
}) {
  const { client, services, body, tokens, company } = params;
  const wordmark = brandAssetUrl("logo-wordmark.png");
  const emblem = brandAssetUrl("logo-emblem.png");
  const addressLines = companyAddressLines(company);
  const contactLine = companyContactLine(company);
  const recipient = addressBlock(client).split("\n").map(escapeHtml).join("<br />");

  return `<!doctype html><html><body style="margin:0;background:#f7f5f1;font-family:Arial,sans-serif;color:#2b2118">
    <div style="max-width:620px;margin:24px auto;background:#fff;border:1px solid #e7e2dc;border-radius:12px;overflow:hidden">
      <div style="padding:26px 32px 18px;text-align:center">
        ${
          wordmark
            ? `<img src="${escapeHtml(wordmark)}" alt="${escapeHtml(company.name)}" width="240" style="display:inline-block;width:240px;max-width:100%;height:auto;border:0" />`
            : ""
        }
      </div>
      <div style="background:#215343;color:#fff;padding:20px 32px">
        <h1 style="margin:0;font-size:22px">${escapeHtml(company.name)}</h1>
        <p style="margin:8px 0 0">Your services for the coming season</p>
      </div>
      <div style="padding:32px">
        <p style="margin:0 0 24px;font-size:13px;color:#6f675f;line-height:1.5">${recipient}</p>
        ${bodyHtml(body, tokens, services)}
        <p style="margin:24px 0 0;line-height:1.65">${escapeHtml(company.signatureLine)}<br /><br /><strong>${escapeHtml(company.name)}</strong>${
          contactLine ? `<br /><span style="color:#6f675f">${escapeHtml(contactLine)}</span>` : ""
        }</p>
      </div>
      <div style="background:#f7f5f1;padding:24px 32px;text-align:center;border-top:1px solid #e7e2dc">
        ${
          emblem
            ? `<img src="${escapeHtml(emblem)}" alt="" width="56" style="display:inline-block;width:56px;height:auto;border:0" />`
            : ""
        }
        <p style="margin:8px 0 0;font-weight:bold;color:#215343">Thank you for your business!</p>
        ${addressLines.length ? `<p style="margin:8px 0 0;font-size:12px;color:#6f675f">${addressLines.map(escapeHtml).join("<br />")}</p>` : ""}
        ${contactLine ? `<p style="margin:6px 0 0;font-size:12px;color:#6f675f">${escapeHtml(contactLine)}</p>` : ""}
      </div>
    </div>
  </body></html>`;
}

export async function renderSpringLetter(clientId: number) {
  const [template, details, company] = await Promise.all([
    getOrCreateLetterTemplate(),
    getLetterClient(clientId),
    getCompanyProfile(),
  ]);
  if (!details) return null;

  const servicesTable = details.services.length
    ? details.services.map((service) => `${service.name}: ${currency(service.amount)}`).join("\n")
    : "No services assigned";
  const total = currency(roundMoney(details.services.reduce((sum, service) => sum + service.amount, 0)));
  const tokens = {
    clientName: details.client.name,
    clientFirstName: firstNameOf(details.client.name),
    servicesTable,
    total,
    companyName: company.name,
    companyPhone: company.phone ?? "",
    companyEmail: company.email ?? "",
    companyWebsite: company.website ?? "",
    signatureLine: company.signatureLine,
  };
  let subject = template.subject;
  let body = template.body;
  for (const [token, replacement] of Object.entries(tokens)) {
    subject = replaceToken(subject, token, replacement);
    body = replaceToken(body, token, replacement);
  }

  // Built from the same tokens, before the plain-text furniture is bolted on:
  // the designed version lays the address block, sign-off and footer out itself
  // rather than inheriting text pretending to be a layout.
  const html = springLetterHtml({
    client: details.client,
    services: details.services,
    body: template.body,
    tokens,
    company,
  });

  body = [addressBlock(details.client), body.trim(), signOffBlock(company), footerBlock(company)]
    .filter(Boolean)
    .join("\n\n");

  return {
    clientId: details.client.id,
    clientName: details.client.name,
    email: details.client.email,
    subject,
    body,
    html,
  };
}

export type SpringLetterSendOutcome = {
  clientId: number;
  clientName: string;
  ok: boolean;
  error: string | null;
};

export async function deliverSpringLetters(clientIds: number[]) {
  const uniqueIds = [...new Set(clientIds)];
  const knownClients = uniqueIds.length
    ? await db
        .select({ id: clientsTable.id, name: clientsTable.name, doNotEmail: clientsTable.doNotEmail })
        .from(clientsTable)
        .where(inArray(clientsTable.id, uniqueIds))
    : [];
  const names = new Map(knownClients.map((client) => [client.id, client.name]));
  // His Do not email switch stops every bulk email, and the spring letter is
  // the biggest bulk email of the year. Decided before anything is rendered or
  // sent, and recorded by name so the run report says who was left out and why.
  const doNotEmail = new Set(knownClients.filter((client) => client.doNotEmail).map((client) => client.id));
  const outcomes: SpringLetterSendOutcome[] = [];

  // Deliberately sequential: each customer is an independent, recorded attempt.
  //
  // Every step below is inside a try/catch on purpose. The entire value of this
  // run is the office knowing exactly who was reached and who was not, so a
  // single customer blowing up — while rendering, while sending, or while
  // recording the attempt — must never abort the customers queued behind them,
  // and must never leave a customer with no outcome at all.
  for (const clientId of uniqueIds) {
    let clientName = names.get(clientId) ?? `Client #${clientId}`;
    let subject = "";
    let toEmail: string | null = null;
    let error: string | null = null;
    const skipped = doNotEmail.has(clientId);

    try {
      const rendered = skipped ? null : await renderSpringLetter(clientId);
      if (skipped) {
        error = "Do not email is on for this customer — bulk emails skip them";
      } else if (!rendered) {
        error = "Client not found";
      } else {
        clientName = rendered.clientName;
        subject = rendered.subject;
        toEmail = rendered.email?.trim() || null;
        if (!toEmail) {
          error = "No email address";
        } else {
          await sendClientEmailViaGmail({
            toEmail,
            subject: rendered.subject,
            body: rendered.body,
            html: rendered.html,
          });
        }
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Email delivery failed";
    }

    // Recording the attempt must not decide the run's fate either. If the mail
    // provider accepted the letter but the record failed to save, the customer
    // is reported as unconfirmed rather than as a success — an unverifiable
    // delivery is exactly the thing this screen exists to surface.
    try {
      await db.insert(letterSendsTable).values({
        clientId,
        subject: subject || "Spring letter",
        status: skipped ? "skipped" : error ? "failed" : "sent",
        error,
        sentToEmail: toEmail,
      });
    } catch (cause) {
      const note = cause instanceof Error ? cause.message : "unknown error";
      error = error
        ? `${error} (attempt could not be recorded: ${note})`
        : `Email was accepted but the attempt could not be recorded, so delivery is unconfirmed: ${note}`;
    }

    outcomes.push({ clientId, clientName, ok: error == null, error });
  }

  return {
    sent: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
    outcomes,
  };
}