import { db, companyProfileTable, type CompanyProfile } from "@workspace/db";
import { asc } from "drizzle-orm";

/**
 * The single company-profile row, created on first read.
 *
 * Lazily created rather than seeded, for the same reason billing settings are:
 * a deployment that has never opened the settings page still needs a profile
 * the moment it renders its first letter, and a migration that inserts a row
 * cannot run again for an install that already exists.
 *
 * Defaults come from the column defaults, so a fresh install renders
 * "Bison Lawn Care LLC" with empty contact details rather than an empty name.
 */
export async function getCompanyProfile(): Promise<CompanyProfile> {
  const [existing] = await db
    .select()
    .from(companyProfileTable)
    .orderBy(asc(companyProfileTable.id))
    .limit(1);
  if (existing) return existing;

  const [created] = await db.insert(companyProfileTable).values({}).returning();
  return created!;
}
