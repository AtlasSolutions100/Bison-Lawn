/**
 * Realistic demo dataset for showing the CRM to the business owner.
 *
 * Distinct from seed.ts, which is a minimal fixture for development. This one
 * fills every screen the owner will click through: clients and leads, a waiting
 * list, invoices in each state, a spray vendor to reconcile, a ticket, an
 * inbound web request, and season pricing for the spring-letter run.
 *
 * Run:
 *   pnpm dlx tsx artifacts/api-server/src/seed-demo.ts
 *   pnpm dlx tsx artifacts/api-server/src/seed-demo.ts --reset
 *
 * --reset clears existing business data first. It never touches users or
 * user_identities: wiping those would lock the owner out of their own app.
 */
import {
  db,
  pool,
  clientsTable,
  clientNotesTable,
  clientServicesTable,
  servicesTable,
  packagesTable,
  estimateFieldsTable,
  estimatesTable,
  jobsTable,
  invoicesTable,
  paymentsTable,
  ticketsTable,
  webRequestsTable,
  letterTemplatesTable,
  auditEventsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";

const RESET = process.argv.includes("--reset");

/** Spread addresses around Bozeman so the route optimiser has real distances. */
const BOZEMAN = { lat: 45.6796, lng: -111.0386 };
function near(i: number) {
  return {
    lat: BOZEMAN.lat + (((i * 37) % 100) - 50) / 2000,
    lng: BOZEMAN.lng + (((i * 53) % 100) - 50) / 2000,
  };
}

async function main() {
  if (RESET) {
    // Children before parents.
    await db.delete(paymentsTable);
    await db.delete(invoicesTable);
    await db.delete(jobsTable);
    await db.delete(clientServicesTable);
    await db.delete(estimatesTable);
    await db.delete(ticketsTable);
    await db.delete(webRequestsTable);
    await db.delete(clientNotesTable);
    await db.delete(auditEventsTable);
    await db.delete(clientsTable);
    await db.delete(packagesTable);
    await db.delete(servicesTable);
    await db.delete(estimateFieldsTable);
    await db.delete(letterTemplatesTable);
    console.log("cleared existing business data (users left intact)");
  } else {
    const existing = await db.select({ id: clientsTable.id }).from(clientsTable).limit(1);
    if (existing.length > 0) {
      console.log("Seed skipped: clients already exist. Re-run with --reset to replace.");
      return;
    }
  }

  // ---------- services ----------
  const services = await db
    .insert(servicesTable)
    .values([
      {
        name: "Weekly Mowing",
        description: "Mow, trim, edge, and blow. Weekly through the season.",
        quantity: 1,
        rate: 45,
        billableHours: 0.75,
        teamSize: 2,
        defaultStartDate: "2026-04-15",
        defaultEndDate: "2026-10-15",
        renewDate: "2027-03-01",
        pricingEquations: [
          { upToSqft: 5000, basePrice: 45, baseSqft: 5000, incrementPrice: 0, incrementSqft: 1 },
          { upToSqft: null, basePrice: 45, baseSqft: 5000, incrementPrice: 5, incrementSqft: 1000 },
        ],
      },
      {
        name: "Spring Sprinkler Turn-On",
        description: "Activate the system, pressure-test each zone, adjust heads.",
        quantity: 1,
        rate: 85,
        billableHours: 0.5,
        teamSize: 1,
        defaultStartDate: "2026-04-01",
        defaultEndDate: "2026-05-15",
        renewDate: "2027-03-01",
        pricingEquations: [],
      },
      {
        name: "Sprinkler Blow-Out",
        description: "Winterize the system, clear every zone with compressed air.",
        quantity: 1,
        rate: 95,
        billableHours: 0.5,
        teamSize: 1,
        defaultStartDate: "2026-10-01",
        defaultEndDate: "2026-11-15",
        renewDate: "2027-09-01",
        pricingEquations: [],
      },
      {
        name: "Aeration",
        description: "Core aeration, spring or fall.",
        quantity: 1,
        rate: 60,
        billableHours: 1,
        teamSize: 1,
        pricingEquations: [
          { upToSqft: null, basePrice: 60, baseSqft: 4000, incrementPrice: 10, incrementSqft: 1000 },
        ],
      },
      {
        name: "Fall Clean-Up",
        description: "Leaf removal, bed clean-out, haul away.",
        quantity: 1,
        rate: 220,
        billableHours: 3,
        teamSize: 2,
        defaultStartDate: "2026-10-01",
        defaultEndDate: "2026-11-30",
        pricingEquations: [],
        contractorOfferable: true,
        contractorPrice: 220,
      },
      {
        name: "Fertilizer Application",
        description: "Performed by an outside spray company and billed back to us.",
        quantity: 1,
        rate: 75,
        vendorName: "Acme Spray",
        pricingEquations: [],
      },
    ])
    .returning();

  const svc = Object.fromEntries(services.map((s) => [s.name, s.id])) as Record<string, number>;

  await db.insert(packagesTable).values([
    {
      name: "Sprinkler Package",
      description: "Turn-on in spring, blow-out in fall.",
      serviceIds: [svc["Spring Sprinkler Turn-On"], svc["Sprinkler Blow-Out"]],
      scheduleType: "window",
      renewDate: "2027-03-01",
    },
    {
      name: "Full Season Care",
      description: "Weekly mowing plus spring aeration.",
      serviceIds: [svc["Weekly Mowing"], svc["Aeration"]],
      scheduleType: "recurring",
      frequencyWeeks: 1,
      startDate: "2026-04-15",
      seasonEndDate: "2026-10-15",
      renewDate: "2027-03-01",
    },
  ]);

  // ---------- estimate fields ----------
  await db.insert(estimateFieldsTable).values([
    { label: "Turf Sqft", fieldType: "calculable", pricePerUnit: 2, unitSize: 100, sortOrder: 1 },
    { label: "Sprinkler Zones", fieldType: "calculable", pricePerUnit: 12, unitSize: 1, sortOrder: 2 },
    { label: "Bed Sqft", fieldType: "calculable", pricePerUnit: 3, unitSize: 100, sortOrder: 3 },
    { label: "Driveway Sqft", fieldType: "calculable", pricePerUnit: 2, unitSize: 100, sortOrder: 4 },
    { label: "Gate Code", fieldType: "text", sortOrder: 5 },
    { label: "Dog", fieldType: "boolean", sortOrder: 6 },
    { label: "Backflow Devices", fieldType: "number", sortOrder: 7 },
  ]);

  // ---------- clients: 4 clients + 5 leads ----------
  // Annotated rather than inferred: without this, TS unions the propertyData
  // object literals and every key missing from one row becomes `undefined`,
  // which does not satisfy Record<string, string>.
  type SeedClient = {
    name: string;
    status: string;
    serviceAddress: string;
    city: string;
    email?: string;
    phone?: string;
    additionalContact?: string;
    propertyData: Record<string, string>;
    mapNote?: string;
  };

  const clientRows: SeedClient[] = [
    {
      name: "Sarah Thompson",
      status: "client",
      serviceAddress: "412 W Maple Ave",
      city: "Bozeman",
      email: "sarah.t@example.com",
      phone: "406-555-0142",
      propertyData: { "Turf Sqft": "6200", "Gate Code": "4417", Dog: "Yes" },
      mapNote: "Park on Maple, gate is on the alley side.",
    },
    {
      name: "Dale Hutchins",
      status: "client",
      serviceAddress: "88 Sourdough Rd",
      city: "Bozeman",
      email: "dale.hutchins@example.com",
      phone: "406-555-0177",
      propertyData: { "Turf Sqft": "9100", "Sprinkler Zones": "8" },
      mapNote: "Steep driveway, back the trailer in.",
    },
    {
      name: "Ridgeline Property Group",
      status: "client",
      serviceAddress: "1200 Baxter Ln",
      city: "Bozeman",
      email: "ops@ridgelineproperty.example.com",
      phone: "406-555-0188",
      additionalContact: "Ally Bremer, portfolio manager",
      propertyData: { "Turf Sqft": "14500", "Sprinkler Zones": "12" },
      mapNote: "One email covers 40 properties. Notify each one individually.",
    },
    {
      name: "Marcy Olander",
      status: "client",
      serviceAddress: "77 Kagy Blvd",
      city: "Bozeman",
      email: "marcy.olander@example.com",
      phone: "406-555-0101",
      propertyData: { "Turf Sqft": "4800", Dog: "No" },
    },
    {
      name: "Trent Kovacs",
      status: "lead",
      serviceAddress: "206 Willow Creek Ln",
      city: "Bozeman",
      email: "trent.kovacs@example.com",
      phone: "406-555-0198",
      propertyData: { "Turf Sqft": "5400" },
    },
    {
      name: "Nina Ruiz",
      status: "lead",
      serviceAddress: "915 Durston Rd",
      city: "Bozeman",
      email: "nina.ruiz@example.com",
      phone: "406-555-5421",
      propertyData: {},
    },
    {
      name: "Cedar Hollow HOA",
      status: "lead",
      serviceAddress: "202 Cedar Hollow Way",
      city: "Bozeman",
      email: "board@cedarhollow.example.com",
      phone: "406-555-0233",
      propertyData: { "Turf Sqft": "22000" },
    },
    {
      name: "Pete Quinlan",
      status: "lead",
      serviceAddress: "101 Story Mill Rd",
      city: "Bozeman",
      email: "pete.quinlan@example.com",
      phone: "406-555-0244",
      propertyData: {},
    },
    {
      name: "Susan Delacroix",
      status: "lead",
      serviceAddress: "530 N Rouse Ave",
      city: "Bozeman",
      email: "susan.d@example.com",
      phone: "406-555-0255",
      propertyData: { "Turf Sqft": "3300" },
    },
  ];

  const clients = await db
    .insert(clientsTable)
    .values(clientRows.map((c, i) => ({ ...c, ...near(i) })))
    .returning();
  const cid = Object.fromEntries(clients.map((c) => [c.name, c.id])) as Record<string, number>;

  // ---------- assigned services: drives the spring-letter renew list ----------
  await db.insert(clientServicesTable).values([
    {
      clientId: cid["Sarah Thompson"], serviceId: svc["Weekly Mowing"], quantity: 1, amount: 130,
      scheduleType: "recurring", frequencyWeeks: 1, firstServiceDate: "2026-04-20",
      seasonEndDate: "2026-10-15", renewDate: "2027-03-01", budgetedHours: 0.75,
    },
    {
      clientId: cid["Sarah Thompson"], serviceId: svc["Aeration"], quantity: 1, amount: 60,
      scheduleType: "window", startDate: "2026-09-01", endDate: "2026-10-15", renewDate: "2027-03-01",
    },
    {
      clientId: cid["Dale Hutchins"], serviceId: svc["Spring Sprinkler Turn-On"], quantity: 1, amount: 85,
      scheduleType: "window", startDate: "2026-04-01", endDate: "2026-05-15", renewDate: "2027-03-01",
    },
    {
      clientId: cid["Dale Hutchins"], serviceId: svc["Sprinkler Blow-Out"], quantity: 1, amount: 95,
      scheduleType: "window", startDate: "2026-10-01", endDate: "2026-11-15", renewDate: "2027-09-01",
    },
    {
      clientId: cid["Ridgeline Property Group"], serviceId: svc["Weekly Mowing"], quantity: 1, amount: 260,
      scheduleType: "recurring", frequencyWeeks: 1, firstServiceDate: "2026-04-20",
      seasonEndDate: "2026-10-15", renewDate: "2027-03-01", budgetedHours: 2,
    },
    {
      clientId: cid["Marcy Olander"], serviceId: svc["Fertilizer Application"], quantity: 1, amount: 75,
      scheduleType: "window", startDate: "2026-08-01", endDate: "2026-09-15", renewDate: "2027-03-01",
    },
    {
      clientId: cid["Cedar Hollow HOA"], serviceId: svc["Fertilizer Application"], quantity: 1, amount: 75,
      scheduleType: "window", startDate: "2026-08-01", endDate: "2026-09-15", renewDate: "2027-03-01",
    },
  ]);

  // ---------- waiting list: dispatched = false ----------
  await db.insert(jobsTable).values([
    {
      clientId: cid["Sarah Thompson"], serviceId: svc["Weekly Mowing"], amount: 130,
      dispatched: false, windowStart: "2026-09-07", windowEnd: "2026-09-14",
      budgetedHours: 0.75, notes: "Confirm gate code before the first visit.",
    },
    {
      clientId: cid["Dale Hutchins"], serviceId: svc["Sprinkler Blow-Out"], amount: 95,
      dispatched: false, windowStart: "2026-10-05", windowEnd: "2026-10-19",
      budgetedHours: 0.5, notes: "8 zones.", notesImportant: true,
    },
    {
      clientId: cid["Ridgeline Property Group"], serviceId: svc["Fall Clean-Up"], amount: 220,
      dispatched: false, windowStart: "2026-10-12", windowEnd: "2026-11-06", budgetedHours: 3,
    },
  ]);

  // ---------- invoices and payments ----------
  const invoices = await db
    .insert(invoicesTable)
    .values([
      {
        clientId: cid["Cedar Hollow HOA"], status: "open", total: 75, amountPaid: 0,
        notes: "Fertilizer application, Acme Spray run",
      },
      {
        clientId: cid["Marcy Olander"], status: "open", total: 75, amountPaid: 0,
        notes: "Fertilizer application, Acme Spray run",
      },
      {
        clientId: cid["Sarah Thompson"], status: "paid", total: 190, amountPaid: 190,
        notes: "Weekly mowing and aeration",
      },
      {
        clientId: cid["Dale Hutchins"], status: "paid", total: 85, amountPaid: 85,
        notes: "Spring sprinkler turn-on",
      },
      {
        clientId: cid["Ridgeline Property Group"], status: "paid", total: 260, amountPaid: 260,
        notes: "Weekly mowing, August",
      },
      {
        clientId: cid["Marcy Olander"], status: "void", total: 200, amountPaid: 0,
        notes: "Duplicate of the Acme Spray invoice. Voided.",
      },
    ])
    .returning();

  await db.insert(paymentsTable).values([
    { clientId: cid["Sarah Thompson"], invoiceId: invoices[2].id, amount: 190, method: "check", reference: "2841" },
    { clientId: cid["Dale Hutchins"], invoiceId: invoices[3].id, amount: 85, method: "venmo", reference: "dale-h" },
    { clientId: cid["Ridgeline Property Group"], invoiceId: invoices[4].id, amount: 260, method: "check", reference: "50912" },
  ]);

  // Balance is always invoices minus payments. Compute it rather than hardcode,
  // so the seeded numbers agree with what the app recalculates on the next write.
  await db.execute(sql`
    UPDATE clients c SET account_balance = COALESCE((
      SELECT COALESCE(SUM(i.total), 0) FROM invoices i
      WHERE i.client_id = c.id AND i.status <> 'void'
    ), 0) - COALESCE((
      SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.client_id = c.id
    ), 0)
  `);

  // ---------- a draft estimate ----------
  await db.insert(estimatesTable).values([
    {
      clientId: cid["Trent Kovacs"],
      status: "draft",
      total: 193,
      notes: "Measured 5,400 sqft of turf. Quoted mowing plus a one-time aeration.",
      coverNote: "Thanks for reaching out. Here is what we would recommend for your property.",
      includeServiceDescriptions: true,
      lines: [
        { serviceId: null, label: "Turf Sqft", value: "5400", calculatedPrice: 108 },
        { serviceId: svc["Aeration"], label: "Aeration", value: "5400", calculatedPrice: 85 },
      ],
    },
  ]);

  // ---------- ticket ----------
  await db.insert(ticketsTable).values([
    {
      clientId: cid["Nina Ruiz"],
      title: "Follow up with Nina Ruiz",
      description: "Asked for a weekly mowing quote. 915 Durston Rd, 406-555-5421.",
      status: "open",
      dueDate: "2026-08-28",
    },
  ]);

  // ---------- inbound web request ----------
  await db.insert(webRequestsTable).values([
    {
      source: "squarespace",
      name: "Gary Whitfield",
      email: "gary.whitfield@example.com",
      phone: "406-555-8888",
      address: "640 S 3rd Ave, Bozeman",
      message: "Looking for a quote on weekly mowing and a fall clean-up.",
      rawPayload: { form: "Contact", submittedAt: "2026-08-26T10:21:00Z" },
      status: "new",
    },
  ]);

  // ---------- spring letter template ----------
  await db.insert(letterTemplatesTable).values([
    {
      name: "Spring letter",
      subject: "Your lawn care services for the coming season",
      body:
        "Hello {{clientName}},\n\n" +
        "Thank you for trusting us with your lawn care. Your services and pricing " +
        "for the coming season are:\n\n" +
        "{{servicesTable}}\n\n" +
        "Total: {{total}}\n\n" +
        "Please contact us if you have any questions. We look forward to serving " +
        "you this season.\n\n" +
        "Bison Lawn Care LLC",
    },
  ]);

  const counts = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM clients WHERE status = 'client')             AS clients,
      (SELECT count(*) FROM clients WHERE status = 'lead')               AS leads,
      (SELECT count(*) FROM jobs WHERE dispatched = false)               AS waiting_list,
      (SELECT count(*) FROM invoices WHERE status = 'open')              AS open_invoices,
      (SELECT COALESCE(SUM(total),0) FROM invoices WHERE status='open')  AS open_total,
      (SELECT count(*) FROM tickets WHERE status = 'open')               AS open_tickets,
      (SELECT count(*) FROM services)                                    AS services,
      (SELECT count(*) FROM estimates)                                   AS estimates,
      (SELECT count(*) FROM web_requests)                                AS web_requests
  `);
  console.log("Seeded demo data:", counts.rows[0]);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
