import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { db, webRequestsTable, clientsTable, ticketsTable } from "@workspace/db";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  CreateWebRequestBody,
  ListWebRequestsQueryParams,
  ReceiveWebRequestBody,
  UpdateWebRequestBody,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";

const router: IRouter = Router();

// NOTE: the public webhook at /inbound/web-request must be declared ABOVE the
// requireAuth guard below. The website posting to it has no Clerk session; it
// authenticates with a shared secret header instead.
const WEBHOOK_SECRET_HEADER = "x-web-request-secret";

function secretMatches(received: string | undefined): boolean {
  const configured = process.env.WEB_REQUEST_WEBHOOK_SECRET;
  // Hashing both values gives timingSafeEqual fixed-size buffers. It also makes
  // mismatched secret lengths indistinguishable to the comparison operation.
  const expectedDigest = createHash("sha256").update(configured ?? "").digest();
  const receivedDigest = createHash("sha256").update(received ?? "").digest();
  const equal = timingSafeEqual(expectedDigest, receivedDigest);
  return Boolean(configured && received && equal);
}

type WebRequestInput = ReturnType<typeof CreateWebRequestBody.parse>;

function usefulString(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function interpretedInput(body: WebRequestInput, original: Record<string, unknown>) {
  const entries = [
    ...Object.entries(original),
    ...(body.raw ? Object.entries(body.raw) : []),
  ];
  const values = new Map<string, unknown>();
  for (const [key, value] of entries) {
    const normalized = key.toLowerCase().replace(/[\s_-]/g, "");
    if (!values.has(normalized)) values.set(normalized, value);
  }
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = usefulString(values.get(key.toLowerCase()));
      if (value) return value;
    }
    return undefined;
  };

  return {
    source: usefulString(body.source) ?? pick("source") ?? "squarespace",
    externalId: usefulString(body.externalId) ?? pick("externalId"),
    name: usefulString(body.name) ?? pick("name", "fullName"),
    email: usefulString(body.email) ?? pick("email"),
    phone: usefulString(body.phone) ?? pick("phone", "telephone"),
    address: usefulString(body.address) ?? pick("address"),
    message: usefulString(body.message) ?? pick("message", "comments", "details"),
    rawPayload: original,
  };
}

async function storeRequest(body: WebRequestInput, original: Record<string, unknown>) {
  const values = interpretedInput(body, original);
  if (values.externalId) {
    const [created] = await db
      .insert(webRequestsTable)
      .values(values)
      .onConflictDoNothing({ target: webRequestsTable.externalId })
      .returning();
    if (created) return { record: created, duplicate: false };

    const [existing] = await db
      .select()
      .from(webRequestsTable)
      .where(eq(webRequestsTable.externalId, values.externalId));
    if (existing) return { record: existing, duplicate: true };
    throw new Error("Could not store web request");
  }

  const [record] = await db.insert(webRequestsTable).values(values).returning();
  return { record, duplicate: false };
}

function rawObject(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

router.post("/inbound/web-request", async (req, res) => {
  const received = req.get(WEBHOOK_SECRET_HEADER);
  if (!secretMatches(received)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const original = rawObject(req);
  const body = ReceiveWebRequestBody.parse(original);
  const { record, duplicate } = await storeRequest(body, original);
  return res.status(202).json({ id: record.id, status: record.status, duplicate });
});

router.use(["/web-requests"], requireAuth, requireAdmin);

async function hydrate(rows: (typeof webRequestsTable.$inferSelect)[]) {
  const clientIds = [...new Set(rows.map(row => row.clientId).filter((id): id is number => id != null))];
  const clients = clientIds.length
    ? await db
        .select({ id: clientsTable.id, name: clientsTable.name })
        .from(clientsTable)
        .where(inArray(clientsTable.id, clientIds))
    : [];
  const names = new Map(clients.map(client => [client.id, client.name]));
  return rows.map(row => ({
    ...row,
    clientName: row.clientId ? names.get(row.clientId) ?? null : null,
  }));
}

router.get("/web-requests", async (req, res) => {
  const { status } = ListWebRequestsQueryParams.parse(req.query);
  // The value, not the secret, is deliberately readable by the authenticated UI.
  // This keeps the response body exactly as declared by the API contract.
  res.cookie(
    "web_request_webhook_configured",
    process.env.WEB_REQUEST_WEBHOOK_SECRET ? "1" : "0",
    { sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/" },
  );
  const rows = await db
    .select()
    .from(webRequestsTable)
    .where(status ? eq(webRequestsTable.status, status) : undefined)
    .orderBy(desc(webRequestsTable.createdAt));
  return res.json(await hydrate(rows));
});

router.post("/web-requests", async (req, res) => {
  const original = rawObject(req);
  const body = CreateWebRequestBody.parse(original);
  // A blank hand-entered request is a slip, not a record worth keeping. The page
  // disables its own button, but a disabled button is not a server guard — the
  // endpoint has to refuse an empty submission itself. The public webhook is
  // deliberately not held to this: it stores whatever the website sent so that a
  // renamed form field can never lose a real customer's request.
  const enteredSomething = [body.name, body.email, body.phone, body.address, body.message]
    .some((value) => usefulString(value) !== undefined);
  if (!enteredSomething) {
    return res.status(400).json({
      error: "Enter at least a name, email, phone, address or message.",
    });
  }
  const { record } = await storeRequest(
    { ...body, source: usefulString(body.source) ?? "manual" },
    original,
  );
  return res.status(201).json((await hydrate([record]))[0]);
});

router.patch("/web-requests/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid request id" });
  const body = UpdateWebRequestBody.parse(req.body);

  const updated = await db.transaction(async tx => {
    const [request] = await tx
      .select()
      .from(webRequestsTable)
      .where(eq(webRequestsTable.id, id))
      .for("update");
    if (!request) return null;

    let clientId = request.clientId;
    let ticketId = request.ticketId;

    if (body.convertToClient && !clientId) {
      if (request.email) {
        const normalizedEmail = request.email.trim().toLowerCase();
        const [matchingClient] = await tx
          .select()
          .from(clientsTable)
          .where(sql`lower(trim(${clientsTable.email})) = ${normalizedEmail}`)
          .limit(1);
        clientId = matchingClient?.id ?? null;
      }
      if (!clientId) {
        const [client] = await tx
          .insert(clientsTable)
          .values({
            name: request.name ?? request.email ?? request.phone ?? `Web request #${request.id}`,
            status: "lead",
            email: request.email,
            phone: request.phone,
            serviceAddress: request.address,
          })
          .returning();
        clientId = client.id;
      }
    }

    if (body.createTicket && !ticketId) {
      const contact = request.name ?? request.email ?? request.phone ?? `request #${request.id}`;
      const details = [
        request.message,
        request.address ? `Address: ${request.address}` : null,
        request.email ? `Email: ${request.email}` : null,
        request.phone ? `Phone: ${request.phone}` : null,
        `Source: ${request.source}`,
      ].filter((line): line is string => Boolean(line));
      const [ticket] = await tx
        .insert(ticketsTable)
        .values({
          clientId,
          title: `Follow up with ${contact}`,
          description: details.join("\n"),
        })
        .returning();
      ticketId = ticket.id;
    }

    const status = body.status ?? (body.convertToClient ? "converted" : request.status);
    const [saved] = await tx
      .update(webRequestsTable)
      .set({ status, clientId, ticketId })
      .where(eq(webRequestsTable.id, id))
      .returning();
    return saved;
  });

  if (!updated) return res.status(404).json({ error: "Web request not found" });
  return res.json((await hydrate([updated]))[0]);
});

export default router;
