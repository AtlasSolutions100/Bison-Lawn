import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  doublePrecision,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------- users ----------
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkId: text("clerk_id").notNull().unique(),
  name: text("name").notNull(),
  email: text("email"),
  role: text("role").notNull().default("contractor"), // admin | contractor
  phone: text("phone"),
  baseAddress: text("base_address"),
  baseLat: doublePrecision("base_lat"),
  baseLng: doublePrecision("base_lng"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

// ---------- clients ----------
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

// ---------- estimates ----------
export type EstimateLine = {
  fieldId: number;
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
  sentAt: timestamp("sent_at"),
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
  amount: doublePrecision("amount").notNull(),
  method: text("method").notNull(), // check | venmo | zelle | credit_card | cash | other
  reference: text("reference"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type Payment = typeof paymentsTable.$inferSelect;

// ---------- tickets ----------
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
