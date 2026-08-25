import {
  clientsTable,
  clientServicesTable,
  db,
  letterSendsTable,
  letterTemplatesTable,
  servicesTable,
} from "@workspace/db";
import { asc, eq, inArray } from "drizzle-orm";
import { roundMoney } from "./helpers";
import { sendClientEmailViaGmail } from "./clientEmail";

export const DEFAULT_LETTER_TEMPLATE = {
  name: "Spring renewal letter",
  subject: "Your lawn care services for the coming season",
  body: `Hello {{clientName}},

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

export async function renderSpringLetter(clientId: number) {
  const [template, details] = await Promise.all([getOrCreateLetterTemplate(), getLetterClient(clientId)]);
  if (!details) return null;

  const servicesTable = details.services.length
    ? details.services.map((service) => `${service.name}: ${currency(service.amount)}`).join("\n")
    : "No services assigned";
  const total = currency(roundMoney(details.services.reduce((sum, service) => sum + service.amount, 0)));
  const tokens = {
    clientName: details.client.name,
    servicesTable,
    total,
  };
  let subject = template.subject;
  let body = template.body;
  for (const [token, replacement] of Object.entries(tokens)) {
    subject = replaceToken(subject, token, replacement);
    body = replaceToken(body, token, replacement);
  }

  return {
    clientId: details.client.id,
    clientName: details.client.name,
    email: details.client.email,
    subject,
    body,
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
    ? await db.select({ id: clientsTable.id, name: clientsTable.name }).from(clientsTable).where(inArray(clientsTable.id, uniqueIds))
    : [];
  const names = new Map(knownClients.map((client) => [client.id, client.name]));
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

    try {
      const rendered = await renderSpringLetter(clientId);
      if (!rendered) {
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
        status: error ? "failed" : "sent",
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