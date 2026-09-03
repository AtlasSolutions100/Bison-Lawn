import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------- users ----------
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkId: text("clerk_id").notNull().unique(),
  name: text("name").notNull(),
  email: text("email"),
  role: text("role").notNull().default("contractor"), // admin | contractor
  roleSource: text("role_source").notNull().default("provisioned"), // provisioned | owner | owner_assigned
  phone: text("phone"),
  baseAddress: text("base_address"),
  baseLat: doublePrecision("base_lat"),
  baseLng: doublePrecision("base_lng"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

export const userIdentitiesTable = pgTable("user_identities", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  clerkId: text("clerk_id").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const clientsTable = pgTable("clients", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("lead"), // lead | client | former_client
  // serviceAddress is the street line the app has always shown. The owner's
  // letter templates address the parts separately ([physicaladdress1],
  // [physicaladdress2], [physicalcity], [physicalstate], [physicalzip]), so the
  // remaining parts are stored alongside rather than parsed back out of one
  // string — parsing addresses is guesswork and gets names like
  // "Ridgeline Property Group, Suite 2" wrong.
  serviceAddress: text("service_address"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  accountBalance: doublePrecision("account_balance").notNull().default(0),
  email: text("email"),
  phone: text("phone"),
  additionalContact: text("additional_contact"),
  mapNote: text("map_note"),
  // The identifier this record had in the system it was imported from — Service
  // Autopilot's UserName, e.g. DUPL1001. Kept so a re-import updates the same
  // customer instead of creating a second one, which on a 698-row file is not a
  // mistake anyone unpicks by hand. Null for customers created here.
  externalId: text("external_id"),
  // Route zone shorthand, e.g. "PF" for Post Falls. His old system put this on
  // the client card and colour-coded the board by it, so it is a first-class
  // column rather than another property detail: routing reads it constantly.
  mapCode: text("map_code"),
  // Which water purveyor serves the property. Drives backflow-test paperwork and
  // blow-out scheduling, since each district sets its own rules and deadlines.
  waterDistrict: text("water_district"),
  propertyData: jsonb("property_data").$type<Record<string, string>>().notNull().default({}),
  lastServiceDate: text("last_service_date"),
  // ---- billing ----
  // His invoices carry a Bill To block that is routinely NOT the service
  // address: property managers, second homes and commercial accounts are billed
  // somewhere else entirely. Collapsing the two, which is what one address per
  // client amounted to, sends the bill to the lawn.
  //
  // Every column below is a column in his Service Autopilot customer export, so
  // the names are his, not ours, and a re-import maps straight across.
  nameOnInvoice: text("name_on_invoice"),
  billingAddressLine1: text("billing_address_line1"),
  billingAddressLine2: text("billing_address_line2"),
  billingCity: text("billing_city"),
  billingState: text("billing_state"),
  billingPostalCode: text("billing_postal_code"),
  /** Where invoices go when it differs from the contact address. */
  billingEmail: text("billing_email"),
  /** Account number the customer quotes when paying, e.g. DUPL1001. */
  accountNumber: text("account_number"),
  /** Payment window, e.g. "Net 15" — snapshotted onto each invoice at issue. */
  billingTerms: text("billing_terms"),
  /** How often this customer is invoiced, e.g. "Monthly" | "Per Service". */
  invoiceFrequency: text("invoice_frequency"),
  /** "email" | "print" | "both" — how the invoice reaches them. */
  invoiceDelivery: text("invoice_delivery"),
  /** "commercial" | "residential". Drives the mowing edging policy, among others. */
  accountType: text("account_type"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertClientSchema = createInsertSchema(clientsTable).omit({ id: true, createdAt: true });
export type InsertClient = z.infer<typeof insertClientSchema>;
export type Client = typeof clientsTable.$inferSelect;

// ---------- client notes ----------
export const clientNotesTable = pgTable("client_notes", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  authorName: text("author_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type ClientNote = typeof clientNotesTable.$inferSelect;

// ---------- audit events ----------
export const auditEventsTable = pgTable("audit_events", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").references(() => clientsTable.id, { onDelete: "cascade" }),
  actorName: text("actor_name"),
  action: text("action").notNull(),
  description: text("description").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type AuditEvent = typeof auditEventsTable.$inferSelect;

// ---------- services ----------
/**
 * One band of a service's rate matrix.
 *
 * `upToSqft` is the band's upper bound; the lower bound is the previous band's
 * upper bound, so the office enters only the "To" value and the "From" follows.
 * Read every *Sqft name as "units of the field this service is priced by" —
 * they predate `pricingFieldId` and were never really about square feet.
 *
 * The flat case — a band with one rate and no increment — is what Adam's old
 * system called a Rate Matrix, and it is the common one. base+increment is a
 * superset kept because services already priced that way must not change.
 *
 * budgetedHours/budgetedCost are per band because the work scales with the
 * property: a 4,000 sqft mow is not the same job as a 19,000 sqft mow, and a
 * single figure on the service cannot say so. Both are optional — services
 * priced before these existed simply have no estimate of their own.
 */
export type PricingEquation = {
  upToSqft: number | null;
  basePrice: number;
  baseSqft: number;
  incrementPrice: number;
  incrementSqft: number;
  budgetedHours?: number | null;
  budgetedCost?: number | null;
};

export const servicesTable = pgTable("services", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // Same purpose as clients.externalId. Service Autopilot's own service Code,
  // e.g. LAWN — stable across exports, unlike the name, which he edits.
  externalId: text("external_id"),
  description: text("description"),
  quantity: doublePrecision("quantity").notNull().default(1),
  rate: doublePrecision("rate").notNull().default(0),
  billableHours: doublePrecision("billable_hours"),
  teamSize: integer("team_size"),
  minDays: integer("min_days"),
  defaultStartDate: text("default_start_date"),
  defaultEndDate: text("default_end_date"),
  renewDate: text("renew_date"),
  pricingEquations: jsonb("pricing_equations").$type<PricingEquation[]>().notNull().default([]),
  // office-controlled: contractors may offer this as one-time extra work on site
  contractorOfferable: boolean("contractor_offerable").notNull().default(false),
  contractorPrice: doublePrecision("contractor_price"),
  // Set when an outside company performs this work (e.g. a spray contractor) and
  // invoices the office. Those jobs are never worked by our own crew, so they are
  // completed in bulk from the vendor's own invoice rather than from a phone.
  vendorName: text("vendor_name"),
  // Which property measurement drives this service's pricing equations. Null
  // means turf square footage, which is what every equation meant before this
  // column existed — so existing services keep behaving exactly as they did.
  // Set it to e.g. the "Sprinkler Zones" field and the same equations are then
  // evaluated against zone count instead: a blow-out is priced per zone, not
  // per square foot. The equation columns are still named *Sqft for that
  // reason; read them as "units of the selected field".
  pricingFieldId: integer("pricing_field_id").references(() => estimateFieldsTable.id, {
    onDelete: "set null",
  }),
});
export type Service = typeof servicesTable.$inferSelect;

// ---------- packages ----------
// A package is a collection of services plus the scheduling defaults its members
// inherit. Assigning a package copies these onto each client_services row by
// value, so editing the package later never rewrites work already scheduled for
// a client, and the office can still customise quantity/dates per client.
export const packagesTable = pgTable("packages", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  serviceIds: jsonb("service_ids").$type<number[]>().notNull().default([]),
  // Inherited scheduling defaults (all optional; null means "ask at assign time")
  scheduleType: text("schedule_type"), // window | recurring | one_time
  startDate: text("start_date"),
  endDate: text("end_date"),
  frequencyWeeks: integer("frequency_weeks"),
  seasonEndDate: text("season_end_date"),
  renewDate: text("renew_date"),
});
export type ServicePackage = typeof packagesTable.$inferSelect;

// ---------- estimate fields ----------
export const estimateFieldsTable = pgTable("estimate_fields", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  fieldType: text("field_type").notNull().default("text"), // calculable | text | number | boolean
  pricePerUnit: doublePrecision("price_per_unit"),
  unitSize: doublePrecision("unit_size"),
  sortOrder: integer("sort_order"),
});
export type EstimateField = typeof estimateFieldsTable.$inferSelect;

// ---------- charge presets ----------
// Office-wide templates for the one-off charges typed into an estimate's custom
// lines (haul-away, dump fee, seasonal discount). Inserting one copies its label
// and price onto the estimate, so renaming or deleting a preset later never
// touches an estimate that was already built or sent.
export const chargePresetsTable = pgTable("charge_presets", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  defaultPrice: doublePrecision("default_price").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type ChargePreset = typeof chargePresetsTable.$inferSelect;

// ---------- estimates ----------
export type EstimateLine = {
  fieldId?: number | null;
  serviceId?: number | null;
  label: string;
  value: string;
  calculatedPrice?: number | null;
};

export const estimatesTable = pgTable("estimates", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("draft"), // draft | sent | accepted | declined
  total: doublePrecision("total").notNull().default(0),
  notes: text("notes"),
  // Optional letter that leads the estimate document (introduction, meet-and-greet).
  coverNote: text("cover_note"),
  // When true the estimate document spells out what each quoted service includes,
  // using the service descriptions as they read at send time.
  includeServiceDescriptions: boolean("include_service_descriptions").notNull().default(false),
  lines: jsonb("lines").$type<EstimateLine[]>().notNull().default([]),
  // Optimistic-concurrency counter for admin edits: every accepted edit of the
  // draft's contents bumps it, so a PATCH built from an older snapshot fails.
  version: integer("version").notNull().default(1),
  // Which lines the customer actually accepted, as indexes into `lines`.
  //
  // His proposal invites exactly this: "check the box corresponding to each
  // service ... uncheck the respective box". Stored separately from `lines`
  // rather than mutating them, so the estimate still shows what was quoted
  // alongside what was bought — the office needs both to understand a decline.
  //
  // NULL means "every line", which is what an estimate accepted before this
  // existed means. Anything reading it must treat NULL as all-accepted or it
  // will silently drop work that was genuinely sold.
  acceptedLines: jsonb("accepted_lines").$type<number[] | null>(),
  // What they agreed to pay, which is `total` only when nothing was unchecked.
  acceptedTotal: doublePrecision("accepted_total"),
  sentAt: timestamp("sent_at"),
  sentToEmail: text("sent_to_email"),
  responseTokenHash: text("response_token_hash").unique(),
  pendingResponseTokenHash: text("pending_response_token_hash").unique(),
  respondedAt: timestamp("responded_at"),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  deliveryState: text("delivery_state").notNull().default("idle"), // idle | sending | provider_accepted | sent | failed
  providerAcceptedAt: timestamp("provider_accepted_at"),
  lastDeliveryError: text("last_delivery_error"),
  gmailMessageId: text("gmail_message_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type Estimate = typeof estimatesTable.$inferSelect;

// ---------- client services (assigned services) ----------
export const clientServicesTable = pgTable("client_services", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  serviceId: integer("service_id").notNull().references(() => servicesTable.id),
  packageId: integer("package_id"),
  quantity: doublePrecision("quantity").notNull().default(1),
  amount: doublePrecision("amount").notNull().default(0),
  scheduleType: text("schedule_type").notNull(), // window | recurring | one_time
  startDate: text("start_date"),
  endDate: text("end_date"),
  frequencyWeeks: integer("frequency_weeks"),
  firstServiceDate: text("first_service_date"),
  seasonEndDate: text("season_end_date"),
  renewDate: text("renew_date"),
  budgetedHours: doublePrecision("budgeted_hours"),
  // Stamped when the season rollover repriced this row, so the office can see at a
  // glance who has already been carried into the new year and who still has last
  // year's price.
  lastRenewedAt: timestamp("last_renewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type ClientService = typeof clientServicesTable.$inferSelect;

// ---------- jobs ----------
export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  clientServiceId: integer("client_service_id").references(() => clientServicesTable.id, { onDelete: "set null" }),
  serviceId: integer("service_id").references(() => servicesTable.id),
  // scheduled | on_the_way | in_progress | completed | skipped
  //
  // "skipped" means the crew was there (or was due) and deliberately did not do
  // the work — too wet, gate locked, dog out. It is terminal for this visit but
  // explicitly NOT completed: no invoice is raised, so a skipped job must never
  // go through the complete endpoint.
  status: text("status").notNull().default("scheduled"),
  // Why it was skipped, and when. Kept on the job rather than in a note because
  // the office needs to see it on the dispatch board without opening anything.
  skipReason: text("skip_reason"),
  skippedAt: timestamp("skipped_at"),
  /**
   * Whether this skip is still chargeable under his one-free-skip-a-year rule.
   *
   * His mowing terms: "Client will have the option to skip one scheduled mow per
   * year without charge... Any additional skips outside of the one allowed per
   * year will be considered unpaid and will still be billed as a completed
   * service." Stored rather than derived, because the answer depends on how many
   * skips already existed at the moment this one was taken — recomputing later,
   * after another skip is added or removed, would silently restate a decision
   * the customer was already told about.
   *
   * Null on a job that was never skipped, and a flag only: it marks the skip for
   * the office to bill deliberately, and never raises a charge on its own.
   */
  skipBillable: boolean("skip_billable"),
  dispatched: boolean("dispatched").notNull().default(false),
  scheduledDate: text("scheduled_date"),
  windowStart: text("window_start"),
  windowEnd: text("window_end"),
  routeOrder: integer("route_order"),
  assignedToId: integer("assigned_to_id").references(() => usersTable.id),
  mapNote: text("map_note"),
  budgetedHours: doublePrecision("budgeted_hours"),
  amount: doublePrecision("amount").notNull().default(0),
  notes: text("notes"),
  notesImportant: boolean("notes_important").notNull().default(false),
  visibleToContractor: boolean("visible_to_contractor").notNull().default(true),
  invoiceId: integer("invoice_id"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type Job = typeof jobsTable.$inferSelect;

// ---------- job products ----------
export const jobProductsTable = pgTable("job_products", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  price: doublePrecision("price").notNull().default(0),
  quantity: doublePrecision("quantity").notNull().default(1),
  // set when the line came from a contractor adding offerable extra work on site
  serviceId: integer("service_id").references(() => servicesTable.id, { onDelete: "set null" }),
});
export type JobProduct = typeof jobProductsTable.$inferSelect;

// ---------- invoices ----------
export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  jobId: integer("job_id"),
  status: text("status").notNull().default("open"), // open | paid | partial | void
  total: doublePrecision("total").notNull().default(0),
  amountPaid: doublePrecision("amount_paid").notNull().default(0),
  notes: text("notes"),
  // The number the customer sees and quotes back on the phone. Deliberately not
  // the primary key: his existing invoices are already numbered in the four
  // thousands (#4848 on the sample he sent), so the sequence has to start from
  // wherever his last one ended rather than from 1. Null on rows created before
  // numbering existed, and backfilled from `id` on first read.
  // The UNIQUE constraint is added by hand at deploy, not by `drizzle-kit push`.
  // push refuses to add a unique constraint to a non-empty table without
  // offering to TRUNCATE it first, and `push --force` accepts that offer
  // silently. Multiple NULLs are legal in a Postgres unique constraint, so the
  // ALTER TABLE in DEPLOY.md is safe on existing rows and the prompt is wrong.
  number: integer("number").unique(),
  // Date-only strings, not timestamps. An invoice is dated by the office's
  // calendar day; storing an instant would make the same invoice read as a
  // different date depending on who opens it and from where.
  invoiceDate: text("invoice_date"),
  dueDate: text("due_date"),
  // Free text, e.g. "Net 15" — copied from the client's billingTerms at the
  // moment of issue. Snapshotted rather than joined because changing a
  // customer's terms must not silently restate an invoice already sent.
  terms: text("terms"),
  // The customer's own purchase-order reference. Commercial and property-manager
  // accounts will not pay an invoice that omits it.
  poNumber: text("po_number"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type Invoice = typeof invoicesTable.$inferSelect;

/**
 * The billed lines of one invoice.
 *
 * His invoices itemise Description / Date-Time / Quantity / Price / Total; ours
 * carried a single `total` and no detail at all, so a customer asking "what is
 * this $340 for?" could not be answered from the invoice. `serviceDate` is per
 * line because a monthly invoice covers several visits on different days — that
 * column is the whole reason the format is worth matching.
 *
 * Kept as its own table rather than jsonb because payments, disputes and the
 * job-costing reports all need to reach individual lines.
 */
export const invoiceLineItemsTable = pgTable("invoice_line_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id")
    .notNull()
    .references(() => invoicesTable.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  /** Date-only string for the visit this line bills, or null for a fee/adjustment. */
  serviceDate: text("service_date"),
  quantity: doublePrecision("quantity").notNull().default(1),
  unitPrice: doublePrecision("unit_price").notNull().default(0),
  /**
   * quantity x unitPrice, stored rather than derived. A line whose price was
   * negotiated to a round number must stay at that number; recomputing on read
   * would reintroduce the floating-point cents the office had already settled.
   */
  total: doublePrecision("total").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
});
export type InvoiceLineItem = typeof invoiceLineItemsTable.$inferSelect;

// ---------- payments ----------
export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  invoiceId: integer("invoice_id").references(() => invoicesTable.id, { onDelete: "set null" }),
  // job the payment was collected for (on-site payments); lets completion attach it to the job's invoice
  jobId: integer("job_id").references(() => jobsTable.id, { onDelete: "set null" }),
  amount: doublePrecision("amount").notNull(),
  // portion of amount that is a card processing surcharge; added to the invoice total when attached
  cardFee: doublePrecision("card_fee").notNull().default(0),
  method: text("method").notNull(), // check | venmo | zelle | credit_card | cash | other
  reference: text("reference"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type Payment = typeof paymentsTable.$inferSelect;

export const billingSettingsTable = pgTable("billing_settings", {
  id: serial("id").primaryKey(),
  cardFeeEnabled: boolean("card_fee_enabled").notNull().default(false),
  cardFeePercent: doublePrecision("card_fee_percent").notNull().default(3),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const fieldNotesTable = pgTable("field_notes", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  authorId: integer("author_id").references(() => usersTable.id),
  transcript: text("transcript").notNull(),
  source: text("source").notNull().default("typed"), // voice | typed
  ticketId: integer("ticket_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type FieldNote = typeof fieldNotesTable.$inferSelect;

// ---------- weather rules ----------
export const weatherRulesTable = pgTable("weather_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  conditionType: text("condition_type").notNull(), // rain | wind | heat | cold
  threshold: doublePrecision("threshold").notNull(),
  actionType: text("action_type").notNull().default("reschedule"), // skip | reschedule
  rescheduleDays: integer("reschedule_days").notNull().default(1),
  messageTemplate: text("message_template"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type WeatherRule = typeof weatherRulesTable.$inferSelect;

// ---------- suggested actions (human-reviewed automation queue) ----------
export const suggestedActionsTable = pgTable("suggested_actions", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(), // weather | field_note
  ruleId: integer("rule_id").references(() => weatherRulesTable.id, { onDelete: "set null" }),
  jobId: integer("job_id").references(() => jobsTable.id, { onDelete: "cascade" }),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  actionType: text("action_type").notNull(), // skip | reschedule
  reason: text("reason").notNull(),
  targetDate: text("target_date"),
  newDate: text("new_date"),
  customerMessage: text("customer_message"),
  status: text("status").notNull().default("pending"), // pending | approved | rejected
  // Delivery of the approved customer message by email.
  // pending_review | not_applicable (no message) | no_email (client has none) | sending | sent | failed
  // | abandoned (claimed "sending" but the request/server died before an outcome was written)
  messageDeliveryState: text("message_delivery_state").notNull().default("pending_review"),
  // When the approving transaction claimed delivery; used to age out abandoned claims.
  messageDeliveryClaimedAt: timestamp("message_delivery_claimed_at"),
  messageSentToEmail: text("message_sent_to_email"),
  messageSentAt: timestamp("message_sent_at"),
  messageDeliveryError: text("message_delivery_error"),
  messageGmailId: text("message_gmail_id"),
  reviewedById: integer("reviewed_by_id").references(() => usersTable.id),
  reviewedAt: timestamp("reviewed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // A recovered weather run can overlap an evaluator that has not yet stopped.
  // Only one pending suggestion may exist for any weather rule/job pair; after
  // an admin acts on it, a subsequent check can prepare a new suggestion.
  uniqueIndex("suggested_actions_pending_weather_job_rule_idx")
    .on(t.jobId, t.ruleId)
    .where(sql`${t.source} = 'weather' AND ${t.status} = 'pending' AND ${t.jobId} IS NOT NULL AND ${t.ruleId} IS NOT NULL`),
]);
export type SuggestedAction = typeof suggestedActionsTable.$inferSelect;

export const automationRunsTable = pgTable(
  "automation_runs",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull().default("weather"),
    trigger: text("trigger").notNull(), // scheduled | manual
    runDate: text("run_date"), // local calendar day a scheduled run claimed
    datesChecked: text("dates_checked").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").notNull().default("running"), // running | succeeded | failed
    jobsChecked: integer("jobs_checked").notNull().default(0),
    suggestionsCreated: integer("suggestions_created").notNull().default(0),
    summary: text("summary"),
    error: text("error"),
    triggeredBy: text("triggered_by"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    // Renewed by an active worker. A NULL value belongs to a legacy/manual
    // row and is eligible for recovery immediately.
    leaseExpiresAt: timestamp("lease_expires_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    uniqueIndex("automation_runs_scheduled_day_idx")
      .on(t.kind, t.runDate)
      .where(sql`${t.trigger} = 'scheduled'`),
  ],
);
export const ticketsTable = pgTable("tickets", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").references(() => clientsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("open"), // open | done
  assignedToId: integer("assigned_to_id").references(() => usersTable.id),
  dueDate: text("due_date"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type Ticket = typeof ticketsTable.$inferSelect;

// ---------- letter templates ----------
// The seasonal letter the office mails every customer. Body is plain text holding
// merge tokens ({{clientName}}, {{servicesTable}}, {{total}}) that are filled per
// customer at send time. Kept as a single editable row rather than a library,
// because the office writes one letter a year.
export const letterTemplatesTable = pgTable("letter_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type LetterTemplate = typeof letterTemplatesTable.$inferSelect;

// One row per customer per send attempt. A failed letter has to stay visible —
// the whole point of the run is knowing nobody was missed.
export const letterSendsTable = pgTable("letter_sends", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  subject: text("subject").notNull(),
  status: text("status").notNull(), // sent | failed
  error: text("error"),
  sentToEmail: text("sent_to_email"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type LetterSend = typeof letterSendsTable.$inferSelect;

// ---------- inbound web requests ----------
// Service requests arriving from the public website. Stored raw first and matched
// to a client second, so a request is never lost because the sender could not be
// identified. externalId de-duplicates repeated webhook deliveries.
export const webRequestsTable = pgTable("web_requests", {
  id: serial("id").primaryKey(),
  source: text("source").notNull().default("squarespace"),
  externalId: text("external_id").unique(),
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  message: text("message"),
  rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull().default({}),
  status: text("status").notNull().default("new"), // new | converted | dismissed
  clientId: integer("client_id").references(() => clientsTable.id, { onDelete: "set null" }),
  ticketId: integer("ticket_id").references(() => ticketsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type WebRequest = typeof webRequestsTable.$inferSelect;

// ---------- invitations ----------
// An owner invites someone by email before that person has ever signed in.
//
// Deliberately NOT a placeholder row in `users`: an app account represents a
// person identified by a Clerk-*verified* email, and a row created from an
// address nobody has proved they control would be exactly the unverified
// account the identity model forbids. Instead the invitation sits here until
// someone signs up whose verified primary email matches, at which point they
// are provisioned with the invited role (as `owner_assigned`, since an owner
// did assign it) and the invitation is marked accepted.
//
// Consequence worth knowing: inviting an address grants nothing on its own.
// Whoever proves control of that address gets the role.
export const invitationsTable = pgTable("invitations", {
  id: serial("id").primaryKey(),
  // Stored normalized (trimmed, lowercased) so matching a sign-in is a plain
  // equality check rather than a case-folding comparison at read time.
  email: text("email").notNull().unique(),
  role: text("role").notNull().default("contractor"), // admin | contractor
  invitedById: integer("invited_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  invitedByName: text("invited_by_name"),
  note: text("note"),
  acceptedAt: timestamp("accepted_at"),
  acceptedByUserId: integer("accepted_by_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type Invitation = typeof invitationsTable.$inferSelect;

// ---------- scheduling rules ----------
// What happens automatically when a customer accepts an estimate.
//
// These are rows, not code, because the office is still working out the policy
// and wants to change it without a deploy. Each accepted estimate line is
// matched to the rule for its service; the first enabled rule wins, and a rule
// with a null serviceId is the catch-all fallback.
export const schedulingRulesTable = pgTable("scheduling_rules", {
  id: serial("id").primaryKey(),
  // Null = the fallback applied to any accepted line with no service-specific rule.
  serviceId: integer("service_id").references(() => servicesTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  // dispatch  — put straight on the dispatch board, offsetDays from acceptance
  //             (sprinkler repair: "schedule it for the next day")
  // route_fit — dispatch it and let the route optimiser place it in the day
  //             that fits best (mowing)
  // waiting_list — hold it in the window below until the office dispatches it
  //             (packages: spring/fall clean-ups, aerations)
  // none      — record the acceptance and do nothing
  action: text("action").notNull().default("waiting_list"),
  // For dispatch/route_fit: how many days after acceptance to schedule.
  offsetDays: integer("offset_days").notNull().default(1),
  // For waiting_list: the window the job sits in. Month-day strings ("03-01")
  // so a rule written once keeps working next season without editing.
  windowStartMonthDay: text("window_start_month_day"),
  windowEndMonthDay: text("window_end_month_day"),
  // Optional default assignee for the created job.
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }),
  // Shown to the office on the dispatch board / waiting list so it is obvious
  // the job arrived automatically rather than being entered by hand.
  jobNote: text("job_note"),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type SchedulingRule = typeof schedulingRulesTable.$inferSelect;

// ---------- company profile ----------
// Who the business is, in one editable row.
//
// Every one of these was hardcoded — "Bison Lawn Care LLC" appeared verbatim in
// seven places across three files, and the address, phone, website and email
// existed nowhere at all. The owner's letter templates address all of them by
// merge token ([companyname], [companyaddress], [companywebsite] ...), so they
// have to become data before a single template can render.
//
// A singleton, like billing_settings: exactly one row, created on first read.
// Kept separate from billing_settings on purpose — card-fee policy and business
// identity change for unrelated reasons and by different people.
export const companyProfileTable = pgTable("company_profile", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().default("Bison Lawn Care LLC"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  // Sign-off above the company block, e.g. "Your Friendly Bison,". The owner
  // uses this verbatim in every letter and it is part of the brand voice.
  signatureLine: text("signature_line").notNull().default("Your Friendly Bison,"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type CompanyProfile = typeof companyProfileTable.$inferSelect;

// ---------- document templates ----------
// The letters and proposals the office sends, with the owner's own merge tokens.
//
// Supersedes the single-row letter_templates table, which held one spring letter
// and understood three tokens. The owner works from at least four distinct
// documents (aeration notice, mow-care welcome, estimate proposal, sprinkler
// repair) and expects ~17 tokens. letter_templates is left in place so the
// existing spring-letter run keeps working untouched; new work uses this.
export const documentTemplatesTable = pgTable("document_templates", {
  id: serial("id").primaryKey(),
  // Stable slug so code can fetch a specific document without matching on a
  // name the office is free to rename.
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  // notice        — standalone letter about upcoming work (aeration, mow care)
  // estimate_cover — the body wrapped around a quote
  // contract      — terms appended below a quote
  kind: text("kind").notNull().default("notice"),
  // Attaches the template to a service, so sending for that service picks it up
  // without the office choosing from a list every time. Null = general purpose.
  serviceId: integer("service_id").references(() => servicesTable.id, { onDelete: "set null" }),
  subject: text("subject"),
  body: text("body").notNull(),
  // Seeded rows are marked so a future update can tell "the office wrote this"
  // from "we shipped this", and never overwrite the former.
  isSeeded: boolean("is_seeded").notNull().default(false),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type DocumentTemplate = typeof documentTemplatesTable.$inferSelect;

// ---------- QuickBooks connection ----------
// The owner asked to "see the data from quickbooks without logging into quick
// books. Mostly expenses and P&L statement".
//
// Read-only by intent: this stores an Intuit OAuth grant so the app can pull
// reports, and nothing in the app ever writes back. Bookkeeping stays in
// QuickBooks, where his accountant expects to find it.
//
// A singleton in practice — one business, one QuickBooks company — but keyed on
// realmId so reconnecting to a different company is a visible new row rather
// than a silent overwrite of the one his numbers came from.
export const quickbooksConnectionTable = pgTable("quickbooks_connection", {
  id: serial("id").primaryKey(),
  // Intuit's id for the company file. Every API path includes it.
  realmId: text("realm_id").notNull().unique(),
  companyName: text("company_name"),
  accessToken: text("access_token").notNull(),
  // Access tokens last an hour; the refresh token is the thing worth protecting
  // and the thing that expires (100 days) if nobody uses the integration.
  refreshToken: text("refresh_token").notNull(),
  accessTokenExpiresAt: timestamp("access_token_expires_at").notNull(),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  // sandbox | production. Development keys only reach Intuit's sandbox, so the
  // environment has to travel with the grant — pointing a sandbox token at the
  // production API fails in a way that looks like a permissions problem.
  environment: text("environment").notNull().default("sandbox"),
  connectedByName: text("connected_by_name"),
  connectedAt: timestamp("connected_at").notNull().defaultNow(),
  lastSyncedAt: timestamp("last_synced_at"),
  lastError: text("last_error"),
});
export type QuickbooksConnection = typeof quickbooksConnectionTable.$inferSelect;

// ---------- feedback ----------
// In-app feedback from whoever is using the system, captured where they hit the
// problem rather than in a separate email thread that loses its context.
//
// The submitter's name and email are copied in by value, not just referenced:
// feedback has to stay readable after someone leaves and their user row is
// removed, and "who said this" is most of the value.
export const feedbackTable = pgTable("feedback", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  userName: text("user_name"),
  userEmail: text("user_email"),
  // Role at the time of writing. A contractor complaining about the job board
  // and an admin complaining about the job board usually mean different things.
  userRole: text("user_role"),
  // Where they were when they hit submit, e.g. "/dispatch". The single most
  // useful field for reproducing anything, and the one nobody types in by hand.
  page: text("page"),
  category: text("category").notNull().default("idea"), // idea | problem | other
  message: text("message").notNull(),
  status: text("status").notNull().default("new"), // new | read | done
  adminNote: text("admin_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type Feedback = typeof feedbackTable.$inferSelect;

export type BillingSettings = typeof billingSettingsTable.$inferSelect;

export type AutomationRun = typeof automationRunsTable.$inferSelect;
export type UserIdentity = typeof userIdentitiesTable.$inferSelect;

// ---------- time on site ----------
/**
 * One clock-in/clock-out pair for one person on one job.
 *
 * Asked for as "clock in and out with time stamp of them being there". The
 * coordinates are the reason it is worth more than a pair of times: a timestamp
 * alone proves someone pressed a button, not that anyone went to the property.
 * Both are nullable because a phone can refuse location and the work still
 * happened — a missing fix must never block a crew from clocking in.
 *
 * clockOutAt null means still on site. A row is never deleted on clock-out; the
 * open row is closed, so the history stays auditable.
 */
export const jobTimeEntriesTable = pgTable("job_time_entries", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  clockInAt: timestamp("clock_in_at").notNull().defaultNow(),
  clockOutAt: timestamp("clock_out_at"),
  clockInLat: doublePrecision("clock_in_lat"),
  clockInLng: doublePrecision("clock_in_lng"),
  clockOutLat: doublePrecision("clock_out_lat"),
  clockOutLng: doublePrecision("clock_out_lng"),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type JobTimeEntry = typeof jobTimeEntriesTable.$inferSelect;

// ---------- job photos ----------
/**
 * A photo taken on a job, kept so it can be found again later.
 *
 * clientId is denormalised from the job on purpose: the owner's ask was to
 * "take pictures that we can come back to later in the future", and later means
 * after the job is long closed — most often while looking at the customer, not
 * the visit. Copying it keeps that lookup a single index instead of a join
 * through a job that may since have been deleted.
 *
 * `kind` exists because before/after is the pair he wants to send customers; it
 * is a label on the photo rather than two tables, since which one a photo is
 * only becomes clear once both exist.
 *
 * The bytes live in the file store, not here. storageKey is the handle.
 */
export const jobPhotosTable = pgTable("job_photos", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").references(() => jobsTable.id, { onDelete: "set null" }),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  uploadedById: integer("uploaded_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  storageKey: text("storage_key").notNull(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  // before | after | other
  kind: text("kind").notNull().default("other"),
  caption: text("caption"),
  takenAt: timestamp("taken_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type JobPhoto = typeof jobPhotosTable.$inferSelect;
