/**
 * Light seed data for development. Run with:
 *   pnpm --filter @workspace/api-server exec tsx src/seed.ts
 * Idempotent: skips if clients already exist.
 */
import {
  db,
  pool,
  clientsTable,
  servicesTable,
  packagesTable,
  estimateFieldsTable,
} from "@workspace/db";

async function main() {
  const existing = await db.select({ id: clientsTable.id }).from(clientsTable).limit(1);
  if (existing.length > 0) {
    console.log("Seed skipped: data already present");
    return;
  }

  await db.insert(servicesTable).values([
    {
      name: "Weekly Mowing",
      description: "Mow, trim, edge, and blow",
      quantity: 1,
      rate: 45,
      billableHours: 0.75,
      pricingEquations: [
        { upToSqft: 5000, basePrice: 45, baseSqft: 5000, incrementPrice: 0, incrementSqft: 1 },
        { upToSqft: null, basePrice: 45, baseSqft: 5000, incrementPrice: 5, incrementSqft: 1000 },
      ],
    },
    {
      name: "Spring Sprinkler Turn-On",
      description: "Activate system, check zones and heads",
      quantity: 1,
      rate: 85,
      billableHours: 0.5,
      pricingEquations: [],
    },
    {
      name: "Aeration",
      description: "Core aeration",
      quantity: 1,
      rate: 60,
      billableHours: 1,
      pricingEquations: [
        { upToSqft: null, basePrice: 60, baseSqft: 4000, incrementPrice: 10, incrementSqft: 1000 },
      ],
    },
  ]);

  await db.insert(packagesTable).values([
    { name: "Full Season Care", description: "Mowing + aeration bundle", serviceIds: [1, 3] },
  ]);

  await db.insert(estimateFieldsTable).values([
    { label: "Turf Sqft", fieldType: "calculable", pricePerUnit: 2, unitSize: 100, sortOrder: 1 },
    { label: "Sprinkler Zones", fieldType: "calculable", pricePerUnit: 12, unitSize: 1, sortOrder: 2 },
    { label: "Bed Sqft", fieldType: "calculable", pricePerUnit: 3, unitSize: 100, sortOrder: 3 },
    { label: "Gate Code", fieldType: "text", sortOrder: 4 },
    { label: "Dog", fieldType: "boolean", sortOrder: 5 },
    { label: "Hours", fieldType: "number", sortOrder: 6 },
  ]);

  await db.insert(clientsTable).values([
    {
      name: "Sarah Thompson",
      status: "client",
      serviceAddress: "412 W Maple Ave",
      city: "Bozeman",
      lat: 45.6793,
      lng: -111.0447,
      email: "sarah.t@example.com",
      phone: "406-555-0142",
      propertyData: { "Turf Sqft": "6200", "Gate Code": "4417", Dog: "Yes" },
    },
    {
      name: "Mike Reynolds",
      status: "lead",
      serviceAddress: "88 Sourdough Rd",
      city: "Bozeman",
      lat: 45.6519,
      lng: -111.0201,
      phone: "406-555-0177",
      propertyData: { "Sprinkler Zones": "8" },
    },
  ]);

  console.log("Seeded services, package, estimate fields, and clients");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
