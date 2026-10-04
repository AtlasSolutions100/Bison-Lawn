import { randomBytes } from "node:crypto";
import { Router, type IRouter } from "express";
import {
  db,
  clientsTable,
  clientNotesTable,
  auditEventsTable,
  emailSendsTable,
  clientServicesTable,
  servicesTable,
  packagesTable,
  jobsTable,
  invoicesTable,
  paymentsTable,
  type PackageItem,
} from "@workspace/db";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import {
  CreateClientBody,
  UpdateClientBody,
  CreateClientNoteBody,
  CreateClientServiceBody,
  UpdateClientServiceBody,
  EmailClientBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireArea } from "../lib/access";
import { logAudit, calculatePrice, type Executor } from "../lib/helpers";
import { plainBodyHtml, sendClientEmailViaGmail } from "../lib/clientEmail";
import { openPixelUrl } from "../lib/documentSend";

const router: IRouter = Router();

router.use(["/clients", "/client-services"], requireAuth, requireArea("clients"));

/**
 * One round trip per customer, the same as it always was: the list route calls
 * this once for each of the 709 rows, so the master-account figures ride along
 * in the credit query as scalar subselects rather than adding two more trips.
 *
 * relatedBalanceTotal is the property manager's number — his own balance plus
 * every property under him — because "the master sees the total balance" is
 * the whole reason master accounts exist. Each property still owns its own
 * invoices; nothing here moves money between accounts.
 */
async function hydrateClient<T extends typeof clientsTable.$inferSelect>(client: T) {
  // Raw SQL with an explicit outer alias: inside a drizzle select, a column
  // reference in a sql`` fragment renders unqualified ("id", not "clients"."id"),
  // so a correlated subselect on the same table silently compared the inner
  // row to itself and every master read as owing nothing.
  const result = await db.execute(sql`
    select
      coalesce((select sum(p.amount) from payments p where p.client_id = o.id and p.invoice_id is null), 0) as "unappliedCredit",
      (select m.name from clients m where m.id = o.parent_client_id) as "parentClientName",
      (select r.name from clients r where r.id = o.referred_by_client_id) as "referredByClientName",
      (select count(*) from clients c where c.parent_client_id = o.id) as "relatedPropertyCount",
      o.account_balance + coalesce((select sum(c.account_balance) from clients c where c.parent_client_id = o.id), 0) as "relatedBalanceTotal"
    from clients o
    where o.id = ${client.id}
  `);
  const extra = result.rows[0] as
    | {
        unappliedCredit: string | number;
        parentClientName: string | null;
        referredByClientName: string | null;
        relatedPropertyCount: string | number;
        relatedBalanceTotal: string | number;
      }
    | undefined;
  return {
    ...client,
    unappliedCredit: Number(extra?.unappliedCredit ?? 0),
    parentClientName: extra?.parentClientName ?? null,
    referredByClientName: extra?.referredByClientName ?? null,
    relatedPropertyCount: Number(extra?.relatedPropertyCount ?? 0),
    relatedBalanceTotal: Number(extra?.relatedBalanceTotal ?? client.accountBalance),
  };
}

/**
 * Alphanumeric order, the way he asked for the sub accounts to be listed: the
 * numbers in a name count as numbers, so 2 Oak comes before 10 Oak instead of
 * after it. Plain text ordering — which is what the database gives — sorts
 * "1200 N 4th" above "615 E 18th", and a property manager's list is almost all
 * street numbers.
 */
const alphanumeric = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * The links one customer can carry to another, checked before anything is
 * written. Master accounts go one level deep and no further: a property under
 * a master cannot be a master itself, and a master with properties cannot be
 * tucked under someone else. Deeper than that and "what does this manager owe
 * in all" stops having one answer.
 *
 * `status` is where this account will stand once the write lands, because
 * "former clients — restrict ability to add to as sub account" cuts both ways
 * and he meant it both ways: a customer he has finished with does not get
 * filed under a property manager, and a property manager he has finished with
 * does not get new properties filed under him. Either one leaves a dead
 * account quietly carrying live work.
 */
async function clientLinkError(
  body: { parentClientId?: number | null; referredByClientId?: number | null },
  selfId: number | null,
  status: string,
): Promise<string | null> {
  if (body.parentClientId != null) {
    if (body.parentClientId === selfId) return "A customer cannot be their own master account.";
    if (status === "former_client") {
      return "This is a former client, so it can't be added under a master account. Set it back to Active first.";
    }
    const [master] = await db
      .select({
        id: clientsTable.id,
        name: clientsTable.name,
        status: clientsTable.status,
        parentClientId: clientsTable.parentClientId,
      })
      .from(clientsTable)
      .where(eq(clientsTable.id, body.parentClientId));
    if (!master) return "That master account does not exist.";
    if (master.status === "former_client") {
      return `${master.name} is a former client, so nothing can be added under it. Set ${master.name} back to Active first.`;
    }
    if (master.parentClientId != null) {
      return `${master.name} is already a property under another master account — a property cannot be a master.`;
    }
    if (selfId != null) {
      const [own] = await db
        .select({ count: sql<string>`count(*)` })
        .from(clientsTable)
        .where(eq(clientsTable.parentClientId, selfId));
      if (Number(own?.count ?? 0) > 0) {
        return "This account is a master with properties under it. Take those properties off first.";
      }
    }
  }
  if (body.referredByClientId != null) {
    if (body.referredByClientId === selfId) return "A customer cannot refer themselves.";
    const [referrer] = await db
      .select({ id: clientsTable.id })
      .from(clientsTable)
      .where(eq(clientsTable.id, body.referredByClientId));
    if (!referrer) return "That referring customer does not exist.";
  }
  return null;
}

/**
 * A mistyped pin sends a crew to the wrong side of the world. Both halves must
 * be given together: a latitude with no longitude is not half a location.
 */
function coordinateError(body: { lat?: number | null; lng?: number | null }): string | null {
  const hasLat = "lat" in body;
  const hasLng = "lng" in body;
  if (!hasLat && !hasLng) return null;
  const lat = body.lat ?? null;
  const lng = body.lng ?? null;
  if ((lat == null) !== (lng == null)) return "Latitude and longitude go together — give both, or clear both.";
  if (lat != null && (lat < -90 || lat > 90)) return "Latitude must be between -90 and 90.";
  if (lng != null && (lng < -180 || lng > 180)) return "Longitude must be between -180 and 180.";
  return null;
}

router.get("/clients", async (req, res) => {
  const { status, search, subAccounts } = req.query as {
    status?: string;
    search?: string;
    subAccounts?: string;
  };
  const conds = [];
  if (status) conds.push(eq(clientsTable.status, status));
  // "When adding a sub account, have the previous one unviewable instead of
  // greyed out": once a property sits under a master, its own standalone row in
  // the customer list is the row that confuses him, so the list asks for `hide`
  // and reads those properties off the master instead. Default is `all` —
  // every other screen that asks for customers (dispatch, estimates, search)
  // still gets all 709.
  if (subAccounts === "hide") conds.push(isNull(clientsTable.parentClientId));
  if (subAccounts === "only") conds.push(sql`${clientsTable.parentClientId} is not null`);
  if (search)
    conds.push(
      or(
        ilike(clientsTable.name, `%${search}%`),
        ilike(clientsTable.serviceAddress, `%${search}%`),
        ilike(clientsTable.city, `%${search}%`),
        ilike(clientsTable.email, `%${search}%`),
        ilike(clientsTable.phone, `%${search}%`),
        // Route zone and water purveyor are how the office asks about a group of
        // properties ("who is on PF?", "who is on Whitworth Water?"), so typing
        // one into the same search box has to find them.
        ilike(clientsTable.mapCode, `%${search}%`),
        ilike(clientsTable.waterDistrict, `%${search}%`),
        // Tags are how he wants to find a group later — "ability to add custom
        // tags to clients for specific look up in the future, example = above
        // ground back flow, inside turn on/off" — so they belong in the same box
        // he already types into rather than behind a separate control.
        sql`exists (select 1 from jsonb_array_elements_text(${clientsTable.tags}) tag where tag ilike ${`%${search}%`})`,
      ),
    );
  const rows = await db
    .select()
    .from(clientsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(clientsTable.name);
  return res.json(await Promise.all(rows.map(hydrateClient)));
});

router.post("/clients", async (req, res) => {
  const body = CreateClientBody.parse(req.body);
  // The status the row will have once it is created: the database default is
  // "lead" when nothing is sent.
  const linkProblem = await clientLinkError(body, null, body.status ?? "lead");
  if (linkProblem) return res.status(400).json({ error: linkProblem });
  const pinProblem = coordinateError(body);
  if (pinProblem) return res.status(400).json({ error: pinProblem });
  const [client] = await db.insert(clientsTable).values(body).returning();
  await logAudit({
    clientId: client.id,
    actorName: req.appUser?.name,
    action: "client_created",
    description: `Created ${client.status === "lead" ? "lead" : "client"} "${client.name}"`,
  });
  return res.status(201).json(await hydrateClient(client));
});

// Ahead of /clients/:id, or Express reads "sources" as a customer id.
//
// The list is the customers' own answers, not a settings screen: his old system
// made him maintain a Client Source list, and the map-code precedent here
// (values come from the rows) has worked better. Typing a new source on one
// customer is what adds it to the list everyone else is offered.
router.get("/clients/sources", async (_req, res) => {
  const rows = await db
    .selectDistinct({ source: clientsTable.source })
    .from(clientsTable)
    .where(sql`${clientsTable.source} is not null and ${clientsTable.source} <> ''`)
    .orderBy(clientsTable.source);
  return res.json(rows.map((r) => r.source));
});

router.get("/clients/:id", async (req, res) => {
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, Number(req.params.id)));
  if (!client) return res.status(404).json({ error: "Client not found" });
  return res.json(await hydrateClient(client));
});

router.post("/clients/:id/email", async (req, res) => {
  const body = EmailClientBody.parse(req.body);
  const [client] = await db
    .select()
    .from(clientsTable)
    .where(eq(clientsTable.id, Number(req.params.id)));
  if (!client) return res.status(404).json({ error: "Client not found" });

  // The customer's own address is the default, but the office can send to a
  // different one — "ability to delete email address when sending email to
  // customer and the ability to add a different email and or CC, BCC". A
  // customer with no address on file is no longer a dead end, as long as one is
  // typed in.
  const toEmail = (body.toEmail ?? client.email ?? "").trim();
  if (!toEmail) {
    return res.status(400).json({ error: "No email address — add one to the customer, or type one in." });
  }
  const cc = (body.cc ?? []).map((a) => a.trim()).filter(Boolean);
  const bcc = (body.bcc ?? []).map((a) => a.trim()).filter(Boolean);

  // Checked here as well as in the sender, so a bad address the office typed
  // comes back as a 400 naming the field rather than the generic 500 the
  // unhandled-error handler produces. "Something went wrong, please try again"
  // is actively misleading advice when retrying cannot possibly help.
  const offending = [
    ...(/[\r\n]/.test(toEmail) ? ["To"] : []),
    ...(cc.some((a) => /[\r\n]/.test(a)) ? ["Cc"] : []),
    ...(bcc.some((a) => /[\r\n]/.test(a)) ? ["Bcc"] : []),
  ];
  if (offending.length) {
    return res.status(400).json({
      error: `That ${offending.join(" and ")} address is not a valid email address.`,
    });
  }

  // "Post unopened email to account." An email he types here used to leave
  // nothing behind but an audit line, so it never showed up as an email on the
  // customer's timeline and there was no way to tell whether it was ever
  // opened. It is logged like every other send now, with the open pixel on it,
  // and the attempt is recorded whether Gmail took it or not.
  //
  // No public address means no pixel can be built, and then there is nothing in
  // the email to tell us it was opened — so no token is stored either. A token
  // with no pixel reads as "we asked and heard nothing" to the unopened-email
  // alert, which would report an email the customer read as never opened.
  const token = randomBytes(16).toString("base64url");
  const pixelUrl = openPixelUrl(token);
  const openToken = pixelUrl ? token : null;
  let gmailMessageId: string | null = null;
  let sendError: string | null = null;
  try {
    const sent = await sendClientEmailViaGmail({
      toEmail,
      subject: body.subject,
      body: body.body,
      html: plainBodyHtml(body.body, pixelUrl),
      cc,
      bcc,
    });
    gmailMessageId = sent.id ?? null;
  } catch (cause) {
    sendError = (cause instanceof Error ? cause.message : "Email delivery failed").slice(0, 500);
  }
  await db
    .insert(emailSendsTable)
    .values({
      clientId: client.id,
      sentById: req.appUser?.id ?? null,
      source: "client_page",
      toEmail,
      subject: body.subject,
      status: sendError ? "failed" : "sent",
      error: sendError,
      gmailMessageId,
      openToken: sendError ? null : openToken,
      sentAt: sendError ? null : new Date(),
    })
    // The letter matters more than our record of it: a log we could not write
    // must not turn an email the customer already has into an error.
    .catch(() => undefined);
  if (sendError) {
    return res.status(502).json({ error: `That email did not send — ${sendError}` });
  }
  await logAudit({
    clientId: client.id,
    actorName: req.appUser?.name,
    action: "client_email_sent",
    // Cc is recorded because it is part of who saw this; Bcc is recorded as a
    // count only, since writing the hidden addresses into an audit trail the
    // whole office reads defeats the point of blind copying.
    description:
      `Sent email to ${toEmail}` +
      (cc.length ? `, cc ${cc.join(", ")}` : "") +
      (bcc.length ? `, plus ${bcc.length} bcc` : ""),
  });
  return res.json({ sent: true, to: toEmail, cc, bcc });
});

/**
 * Column names leak straight into the audit trail, which the office reads —
 * "Updated mapCode, propertyData" tells Adam nothing about his own account.
 * Only the fields whose column name reads badly need an entry here.
 */
const CLIENT_FIELD_LABELS: Record<string, string> = {
  serviceAddress: "service address",
  addressLine2: "address line 2",
  postalCode: "postal code",
  additionalContact: "additional contact",
  mapNote: "map / crew note",
  mapCode: "map code",
  waterDistrict: "water district",
  propertyData: "custom fields",
  officeNote: "office note",
  nameOnInvoice: "name on invoice",
  billingAddressLine1: "billing address",
  billingAddressLine2: "billing address line 2",
  billingCity: "billing city",
  billingState: "billing state",
  billingPostalCode: "billing ZIP",
  billingEmail: "billing email",
  accountNumber: "account number",
  billingTerms: "terms",
  invoiceFrequency: "how often invoiced",
  invoiceDelivery: "how invoices are sent",
  accountType: "account type",
  preferredPaymentMethod: "how they pay",
  parentClientId: "master account",
  doNotEmail: "do not email",
  referredByClientId: "referred by",
  lat: "latitude",
  lng: "longitude",
  email: "notification email",
};

/**
 * `propertyData` is one JSON document and is replaced wholesale, not merged —
 * that is what makes deleting a detail possible at all. Callers must send the
 * complete map they want stored; sending only the changed key wipes the rest.
 */
router.patch("/clients/:id", async (req, res) => {
  const body = UpdateClientBody.parse(req.body);
  const id = Number(req.params.id);
  const [current] = await db.select().from(clientsTable).where(eq(clientsTable.id, id));
  if (!current) return res.status(404).json({ error: "Client not found" });

  const linkProblem = await clientLinkError(body, id, body.status ?? current.status);
  if (linkProblem) return res.status(400).json({ error: linkProblem });
  const pinProblem = coordinateError(body);
  if (pinProblem) return res.status(400).json({ error: pinProblem });

  // An invoice set to go by email with nowhere to send it sits in "to email"
  // forever. Checked only when the office actually changes the delivery or an
  // address: hundreds of imported rows already break this rule, and saving a
  // map code — or a phone number on a card that resends the email box
  // untouched — must not be refused for a problem it did not create.
  const deliveryKeys = ["invoiceDelivery", "billingEmail", "email"] as const;
  const touchesDelivery = deliveryKeys.some(
    (k) => k in body && (body as Record<string, unknown>)[k] !== (current as Record<string, unknown>)[k],
  );
  if (touchesDelivery) {
    const merged = { ...current, ...body };
    const delivery = merged.invoiceDelivery;
    const hasAddress = Boolean(merged.billingEmail?.trim() || merged.email?.trim());
    if ((delivery === "email" || delivery === "both") && !hasAddress) {
      return res.status(400).json({
        error: "Sending invoices by email needs a billing email or a notification email. Add one, or switch to Print.",
      });
    }
  }

  const [client] = await db.update(clientsTable).set(body).where(eq(clientsTable.id, id)).returning();
  if (!client) return res.status(404).json({ error: "Client not found" });

  // The master link and the do-not-email switch get their own lines: "Updated
  // master account" does not say which way it went, and both are the kind of
  // change the office asks about later ("who took them off the HOA?").
  if ("parentClientId" in body && body.parentClientId !== current.parentClientId) {
    const nameOf = async (clientId: number | null) => {
      if (clientId == null) return null;
      const [row] = await db.select({ name: clientsTable.name }).from(clientsTable).where(eq(clientsTable.id, clientId));
      return row?.name ?? `#${clientId}`;
    };
    const was = await nameOf(current.parentClientId);
    const now = await nameOf(client.parentClientId);
    await logAudit({
      clientId: client.id,
      actorName: req.appUser?.name,
      action: now ? "master_account_set" : "master_account_removed",
      description: now
        ? `Put this property under master account "${now}"${was ? ` (was "${was}")` : ""}`
        : `Took this property off master account "${was}"`,
    });
    if (now && client.parentClientId != null) {
      await logAudit({
        clientId: client.parentClientId,
        actorName: req.appUser?.name,
        action: "related_property_added",
        description: `Added "${client.name}" as a property under this master account`,
      });
    }
    if (was && current.parentClientId != null) {
      await logAudit({
        clientId: current.parentClientId,
        actorName: req.appUser?.name,
        action: "related_property_removed",
        description: `Took "${client.name}" off this master account`,
      });
    }
  }
  if ("doNotEmail" in body && body.doNotEmail !== current.doNotEmail) {
    await logAudit({
      clientId: client.id,
      actorName: req.appUser?.name,
      action: client.doNotEmail ? "do_not_email_on" : "do_not_email_off",
      description: client.doNotEmail
        ? "Turned on Do not email — bulk emails skip this customer, invoices still go out"
        : "Turned off Do not email — bulk emails reach this customer again",
    });
  }

  const changed = Object.keys(body)
    .filter((field) => !(field === "parentClientId" || field === "doNotEmail"))
    .map((field) => CLIENT_FIELD_LABELS[field] ?? field)
    .join(", ");
  if (changed) {
    await logAudit({
      clientId: client.id,
      actorName: req.appUser?.name,
      action: "client_updated",
      description: `Updated ${changed}`,
    });
  }
  return res.json(await hydrateClient(client));
});

/**
 * The properties under a master account, each with its own balance. Each one
 * is a full customer — its own invoices, its own jobs — so the master page
 * links through rather than trying to show everything in one place.
 *
 * "List sub account in alpha numeric order." A property manager's list is
 * street numbers, so the sort has to read 2 Oak as two and not as the letter
 * before 10 — see `alphanumeric` above.
 */
router.get("/clients/:id/related", async (req, res) => {
  const id = Number(req.params.id);
  const [master] = await db.select({ id: clientsTable.id }).from(clientsTable).where(eq(clientsTable.id, id));
  if (!master) return res.status(404).json({ error: "Client not found" });
  const rows = await db.select().from(clientsTable).where(eq(clientsTable.parentClientId, id));
  rows.sort((a, b) => alphanumeric.compare(a.name, b.name));
  return res.json(await Promise.all(rows.map(hydrateClient)));
});

router.delete("/clients/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [existing] = await db.select().from(clientsTable).where(eq(clientsTable.id, id));
  if (!existing) return res.status(404).json({ error: "Client not found" });

  // Money history has to stay: an invoice or a payment on the books belongs to
  // the year's numbers, and deleting the customer would cascade it away. The
  // customer who is really gone gets marked Former instead.
  const [{ invoices }] = await db
    .select({ invoices: sql<number>`count(*)::int` })
    .from(invoicesTable)
    .where(eq(invoicesTable.clientId, id));
  const [{ payments }] = await db
    .select({ payments: sql<number>`count(*)::int` })
    .from(paymentsTable)
    .where(eq(paymentsTable.clientId, id));
  if (invoices > 0 || payments > 0) {
    return res.status(409).json({
      error: `${existing.name} has invoices or payments on the books, so they can't be deleted. Set status to Former instead.`,
    });
  }

  await db.delete(clientsTable).where(eq(clientsTable.id, id));
  // No clientId on this line: the row it would point at is gone, and the audit
  // table drops its events with the customer.
  await logAudit({
    actorName: req.appUser?.name,
    action: "client_deleted",
    description: `Deleted customer ${existing.name}`,
  });
  return res.status(204).end();
});

router.get("/clients/:id/notes", async (req, res) => {
  const rows = await db
    .select()
    .from(clientNotesTable)
    .where(eq(clientNotesTable.clientId, Number(req.params.id)))
    .orderBy(desc(clientNotesTable.createdAt));
  return res.json(rows);
});

router.post("/clients/:id/notes", async (req, res) => {
  const body = CreateClientNoteBody.parse(req.body);
  const clientId = Number(req.params.id);
  const [note] = await db
    .insert(clientNotesTable)
    // Open means "still waiting on me"; it stays on the dashboard until closed.
    .values({ clientId, body: body.body, authorName: req.appUser?.name ?? null, status: body.status ?? "closed" })
    .returning();
  await logAudit({
    clientId,
    actorName: req.appUser?.name,
    action: "note_added",
    description: "Added a note",
  });
  return res.status(201).json(note);
});

router.get("/clients/:id/audit", async (req, res) => {
  const clientId = Number(req.params.id);
  const rows = await db
    .select()
    .from(auditEventsTable)
    .where(eq(auditEventsTable.clientId, clientId))
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(200);
  return res.json(rows.map((r) => ({ ...r, clientName: null })));
});

// ---- client services ----
// Assigned services moved to routes/client-services.ts (2026-09-15 walkthrough):
// cadence, contractor, discount, crew notes, pause/resume, renewals.

export default router;
