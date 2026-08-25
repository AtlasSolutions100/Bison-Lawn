import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { BrowserContext, Page } from "playwright-core";
import {
  db,
  pool,
  usersTable,
  clientsTable,
  jobsTable,
  ticketsTable,
  fieldNotesTable,
  weatherRulesTable,
  suggestedActionsTable,
  auditEventsTable,
} from "@workspace/db";
import { eq, inArray, like } from "drizzle-orm";
import { startHarness, setStubForecast, type Harness } from "../src/harness.ts";

const stamp = Date.now();
const CLIENT_NAME = `E2E Browser Client ${stamp}`;
const RULE_NAME = `__e2e_rule_${stamp}__`;
const NOTE_TEXT = `Sprinkler head cracked ${stamp}`;

/** Local (browser + server share this process's timezone) date, offset in days. */
function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const TODAY = isoDate(0);
// Far-future date so the weather check only ever sees this suite's job.
const WEATHER_DATE = isoDate(400);
const RESCHEDULE_DAYS = 2;

let harness: Harness;
let admin: { id: number };
let contractor: { id: number };
let client: { id: number };
let noteJobId: number;
let weatherJobId: number;
let adminContext: BrowserContext;

/**
 * Removes anything this suite created, including leftovers from a run that was
 * interrupted before its cleanup (the tests share the dev database).
 */
async function purgeSuiteData(): Promise<void> {
  // clients cascade to their jobs, tickets, field notes, suggestions and audit rows
  await db.delete(clientsTable).where(like(clientsTable.name, "E2E Browser Client %"));
  await db.delete(weatherRulesTable).where(like(weatherRulesTable.name, "__e2e_rule_%"));
  // weather-rule audit rows carry no clientId, so they are matched by name
  await db.delete(auditEventsTable).where(like(auditEventsTable.description, "%__e2e_rule_%"));
  await db.delete(usersTable).where(like(usersTable.clerkId, "e2e_admin_%"));
  await db.delete(usersTable).where(like(usersTable.clerkId, "e2e_contractor_%"));
}

before(async () => {
  await purgeSuiteData();

  const [a, c] = await db
    .insert(usersTable)
    .values([
      { clerkId: `e2e_admin_${stamp}`, name: `E2E Admin ${stamp}`, role: "admin", roleSource: "owner_assigned" },
      { clerkId: `e2e_contractor_${stamp}`, name: `E2E Contractor ${stamp}`, role: "contractor" },
    ])
    .returning();
  admin = a;
  contractor = c;

  const [cl] = await db
    .insert(clientsTable)
    .values({
      name: CLIENT_NAME,
      status: "client",
      serviceAddress: "1200 Prairie Way",
      city: "Dallas",
      lat: 32.78,
      lng: -96.8,
    })
    .returning();
  client = cl;

  const [noteJob, weatherJob] = await db
    .insert(jobsTable)
    .values([
      {
        clientId: client.id,
        status: "scheduled",
        dispatched: true,
        visibleToContractor: true,
        scheduledDate: TODAY,
        assignedToId: contractor.id,
        amount: 45,
      },
      {
        clientId: client.id,
        status: "scheduled",
        dispatched: true,
        visibleToContractor: true,
        scheduledDate: WEATHER_DATE,
        assignedToId: contractor.id,
        amount: 60,
      },
    ])
    .returning();
  noteJobId = noteJob.id;
  weatherJobId = weatherJob.id;

  harness = await startHarness();
  adminContext = await harness.contextForUser(admin.id);
});

after(async () => {
  await harness?.close();
  await purgeSuiteData();
  await pool.end();
});

test("contractor records a field note on a job and the office sees the ticket", async () => {
  const contractorContext = await harness.contextForUser(contractor.id);
  const page: Page = await contractorContext.newPage();
  await page.goto(`${harness.webUrl}/my/jobs`, { waitUntil: "domcontentloaded" });

  await page.getByRole("heading", { name: CLIENT_NAME }).waitFor({ timeout: 90_000 });

  await page.getByRole("button", { name: /Add Note for Office/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText(`Note for the office — ${CLIENT_NAME}`).waitFor();

  // Dictation is optional: when the browser has no SpeechRecognition the dialog
  // must fall back to a plain typed note, which is what this flow relies on.
  const supportsVoice = await page.evaluate(
    () => "SpeechRecognition" in globalThis || "webkitSpeechRecognition" in globalThis,
  );
  const micButton = dialog.getByRole("button", { name: /Dictate Note/i });
  const noteField = dialog.locator("textarea");
  if (supportsVoice) {
    assert.equal(await micButton.count(), 1, "dictation button should be offered when supported");
  } else {
    assert.equal(await micButton.count(), 0, "no dictation button without speech support");
    assert.equal(await noteField.getAttribute("placeholder"), "Type your note...");
  }

  await noteField.fill(NOTE_TEXT);
  await dialog.getByRole("button", { name: /Send to Office/i }).click();
  await page.getByText("Sent to the office for review").waitFor();

  const [savedNote] = await db.select().from(fieldNotesTable).where(eq(fieldNotesTable.jobId, noteJobId));
  assert.ok(savedNote, "field note should be persisted");
  assert.equal(savedNote.transcript, NOTE_TEXT);
  assert.equal(savedNote.authorId, contractor.id);
  assert.ok(savedNote.ticketId, "field note should create an office ticket");

  // The office side: the ticket shows up on the admin task board.
  const adminPage = await adminContext.newPage();
  await adminPage.goto(`${harness.webUrl}/tickets`, { waitUntil: "domcontentloaded" });
  await adminPage.getByRole("heading", { name: `Field note: ${NOTE_TEXT}` }).waitFor({ timeout: 90_000 });
  await adminPage.getByText(NOTE_TEXT, { exact: false }).first().waitFor();
  await adminPage.close();
});

test("admin creates a weather rule, runs a check and approves the reschedule", async () => {
  setStubForecast({ precipitationMm: 18, windKph: 10, maxTempC: 24, minTempC: 14 });

  const page = await adminContext.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto(`${harness.webUrl}/automation`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Automation Review" }).waitFor({ timeout: 90_000 });

  // --- create the rule through the UI
  await page.getByRole("button", { name: /New Rule/i }).click();
  const ruleDialog = page.getByRole("dialog");
  await ruleDialog.getByText("New Weather Rule").waitFor();
  await ruleDialog.locator("input").first().fill(RULE_NAME);
  await ruleDialog.locator("select").first().selectOption("rain");
  await ruleDialog.locator('input[type="number"]').first().fill("5");
  await ruleDialog.locator("select").nth(1).selectOption("reschedule");
  await ruleDialog.locator('input[type="number"]').nth(1).fill(String(RESCHEDULE_DAYS));
  await ruleDialog.getByRole("button", { name: "Save Rule" }).click();
  await ruleDialog.waitFor({ state: "detached" });
  await page.getByText(RULE_NAME).first().waitFor();

  // --- run the check for the job's date (forecast is stubbed above)
  await page.locator('input[type="date"]').first().fill(WEATHER_DATE);
  await page.getByRole("button", { name: /Check Weather/i }).click();
  await page.getByText(/Checked \d+ job\(s\); prepared \d+ suggestion\(s\)/).waitFor({ timeout: 60_000 });

  const card = page
    .locator("div.bg-card.rounded-lg")
    .filter({ hasText: `Rule: ${RULE_NAME}` })
    .filter({ hasText: `Job #${weatherJobId}` })
    .first();
  await card.waitFor();
  const expectedNewDate = (() => {
    const d = new Date(`${WEATHER_DATE}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + RESCHEDULE_DAYS);
    return d.toISOString().slice(0, 10);
  })();
  await card.getByText(`→ New date: ${expectedNewDate}`).waitFor();

  // --- approve it (the page asks for confirmation first)
  await card.getByRole("button", { name: /Approve & Apply/i }).click();
  await card.waitFor({ state: "detached" });

  const [suggestion] = await db
    .select()
    .from(suggestedActionsTable)
    .where(eq(suggestedActionsTable.jobId, weatherJobId));
  assert.equal(suggestion.status, "approved");
  assert.equal(suggestion.reviewedById, admin.id);

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, weatherJobId));
  assert.equal(job.scheduledDate, expectedNewDate, "approving a reschedule moves the job");
  assert.equal(job.dispatched, true);

  // the approved suggestion is still reviewable under the "approved" filter
  await page.locator("select").first().selectOption("approved");
  const approvedCard = page
    .locator("div.bg-card.rounded-lg")
    .filter({ hasText: `Rule: ${RULE_NAME}` })
    .filter({ hasText: `Job #${weatherJobId}` })
    .first();
  await approvedCard.getByText("APPROVED", { exact: false }).waitFor();
  await page.close();

  setStubForecast(null);
});
