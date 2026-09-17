import { Router, type IRouter } from "express";
import { db, clientContactsTable, clientsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import { CreateClientContactBody, UpdateClientContactBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireArea } from "../lib/access";
import { logAudit } from "../lib/helpers";

/**
 * Extra people on an account — the CPA who gets the bill, the HOA president,
 * a spouse, the son who handles payment. His old system kept these apart from
 * the customer's own phone and email, and so do we: a contact is somebody the
 * office may need to call about the account, not the account itself.
 */
const router: IRouter = Router();

// Only these paths, not all of /clients: clientsRouter already guards the rest,
// and requireAuth looks the user up each time it runs.
router.use(["/clients/:id/contacts", "/client-contacts"], requireAuth, requireArea("clients"));

/**
 * Birthdays are for a card, not for arithmetic. Year optional because nobody
 * asks a customer's CPA what year she was born; month-day is enough to know
 * when to send something.
 */
function birthdayError(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (!/^(\d{4}-)?\d{2}-\d{2}$/.test(value)) {
    return "Birthday must be yyyy-mm-dd, or mm-dd when the year is not known.";
  }
  const [mm, dd] = value.slice(-5).split("-").map(Number);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return "That is not a real birthday.";
  return null;
}

const clean = (value: string | null | undefined) => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

function describe(contact: { name: string; role: string | null }) {
  return contact.role ? `"${contact.name}" (${contact.role})` : `"${contact.name}"`;
}

router.get("/clients/:id/contacts", async (req, res) => {
  const rows = await db
    .select()
    .from(clientContactsTable)
    .where(eq(clientContactsTable.clientId, Number(req.params.id)))
    .orderBy(asc(clientContactsTable.name), asc(clientContactsTable.id));
  return res.json(rows);
});

router.post("/clients/:id/contacts", async (req, res) => {
  const body = CreateClientContactBody.parse(req.body);
  const clientId = Number(req.params.id);
  const [client] = await db.select({ id: clientsTable.id }).from(clientsTable).where(eq(clientsTable.id, clientId));
  if (!client) return res.status(404).json({ error: "Client not found" });
  const name = body.name.trim();
  if (!name) return res.status(400).json({ error: "A contact needs a name." });
  const problem = birthdayError(body.birthday);
  if (problem) return res.status(400).json({ error: problem });

  const [contact] = await db
    .insert(clientContactsTable)
    .values({
      clientId,
      name,
      role: clean(body.role),
      phone: clean(body.phone),
      email: clean(body.email),
      birthday: clean(body.birthday),
      notes: clean(body.notes),
    })
    .returning();
  await logAudit({
    clientId,
    actorName: req.appUser?.name,
    action: "contact_added",
    description: `Added contact ${describe(contact)}`,
  });
  return res.status(201).json(contact);
});

router.patch("/client-contacts/:id", async (req, res) => {
  const body = UpdateClientContactBody.parse(req.body);
  const id = Number(req.params.id);
  const [current] = await db.select().from(clientContactsTable).where(eq(clientContactsTable.id, id));
  if (!current) return res.status(404).json({ error: "Contact not found" });
  if (body.name != null && !body.name.trim()) return res.status(400).json({ error: "A contact needs a name." });
  const problem = birthdayError(body.birthday);
  if (problem) return res.status(400).json({ error: problem });

  const changes = {
    ...(body.name != null ? { name: body.name.trim() } : {}),
    ...("role" in body ? { role: clean(body.role) } : {}),
    ...("phone" in body ? { phone: clean(body.phone) } : {}),
    ...("email" in body ? { email: clean(body.email) } : {}),
    ...("birthday" in body ? { birthday: clean(body.birthday) } : {}),
    ...("notes" in body ? { notes: clean(body.notes) } : {}),
  };
  // A save with nothing in it hands the contact back unchanged instead of
  // blowing up: an empty update is a no-op, not an error the office caused.
  if (Object.keys(changes).length === 0) return res.json(current);

  const [contact] = await db
    .update(clientContactsTable)
    .set(changes)
    .where(eq(clientContactsTable.id, id))
    .returning();
  await logAudit({
    clientId: contact.clientId,
    actorName: req.appUser?.name,
    action: "contact_updated",
    description: `Updated contact ${describe(contact)}`,
  });
  return res.json(contact);
});

router.delete("/client-contacts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [current] = await db.select().from(clientContactsTable).where(eq(clientContactsTable.id, id));
  if (!current) return res.status(404).json({ error: "Contact not found" });
  await db.delete(clientContactsTable).where(eq(clientContactsTable.id, id));
  await logAudit({
    clientId: current.clientId,
    actorName: req.appUser?.name,
    action: "contact_removed",
    description: `Removed contact ${describe(current)}`,
  });
  return res.status(204).end();
});

export default router;
