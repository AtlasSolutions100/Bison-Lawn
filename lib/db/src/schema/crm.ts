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
  serviceAddress: text("service_address"),
  city: text("city"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  accountBalance: doublePrecision("account_balance").notNull().default(0),
  email: text("email"),
  phone: text("phone"),
  additionalContact: text("additional_contact"),
  mapNote: text("map_note"),
  propertyData: jsonb("property_data").$type<Record<string, string>>().notNull().default({}),
  lastServiceDate: text("last_service_date"),
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
export type PricingEquation = {
  upToSqft: number | null;
  basePrice: number;
  baseSqft: number;
  incrementPrice: number;
  incrementSqft: number;
};

export const servicesTable = pgTable("services", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
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
});
export type Service = typeof servicesTable.$inferSelect;

// ---------- packages ----------
export const packagesTable = pgTable("packages", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  serviceIds: jsonb("service_ids").$type<number[]>().notNull().default([]),
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
  lines: jsonb("lines").$type<EstimateLine[]>().notNull().default([]),
  // Optimistic-concurrency counter for admin edits: every accepted edit of the
  // draft's contents bumps it, so a PATCH built from an older snapshot fails.
  version: integer("version").notNull().default(1),
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type ClientService = typeof clientServicesTable.$inferSelect;

// ---------- jobs ----------
export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  clientServiceId: integer("client_service_id").references(() => clientServicesTable.id, { onDelete: "set null" }),
  serviceId: integer("service_id").references(() => servicesTable.id),
  status: text("status").notNull().default("scheduled"), // scheduled | on_the_way | in_progress | completed
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type Invoice = typeof invoicesTable.$inferSelect;

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

export type BillingSettings = typeof billingSettingsTable.$inferSelect;

export type AutomationRun = typeof automationRunsTable.$inferSelect;
export type UserIdentity = typeof userIdentitiesTable.$inferSelect;
