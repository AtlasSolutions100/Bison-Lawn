import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { Server } from "node:http";
import { db, pool, usersTable, servicesTable, auditEventsTable, type PricingEquation } from "@workspace/db";
import { inArray, like } from "drizzle-orm";
import { calculatePrice, isPricedBand } from "../src/lib/helpers.ts";
import { addProductCost, matrixToCsv, parseMatrixCsv, splitCsvLine, productCostLabel } from "../src/lib/matrixIO.ts";

// 2026-09-28 notes, the rate matrix: X3 (copy a matrix and add a product cost
// that scales with square footage — "Aeration + seed = AE overseed", top
// dressing) and X4 / feedback #42 (take a matrix out to Excel and bring one
// back, with him seeing what was read before anything is saved).

process.env.NODE_ENV = "test";
const TEST_AUTH_TOKEN = `test_${Math.random().toString(36).slice(2)}${Date.now()}`;
process.env.TEST_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { default: app } = await import("../src/app.ts");

let server: Server;
let baseUrl: string;
const stamp = Date.now();
const ids = { users: [] as number[], services: [] as number[] };
let admin: { id: number };

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-test-user-id": String(admin.id),
      "x-test-auth-token": TEST_AUTH_TOKEN,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // The export is a CSV file, not JSON — the caller reads `text` for that.
  }
  return { status: res.status, body, text };
}

const band = (upToSqft: number | null, basePrice: number, extra: Partial<PricingEquation> = {}): PricingEquation => ({
  upToSqft,
  basePrice,
  baseSqft: 0,
  incrementPrice: 0,
  incrementSqft: 0,
  budgetedHours: null,
  budgetedCost: null,
  ...extra,
});

async function makeService(name: string, equations: PricingEquation[]) {
  const [svc] = await db
    .insert(servicesTable)
    .values({ name: `${name} ${stamp}`, pricingEquations: equations })
    .returning();
  ids.services.push(svc.id);
  return svc;
}

before(async () => {
  server = app.listen(0);
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const [a] = await db
    .insert(usersTable)
    .values({ clerkId: `test_matrixio_admin_${stamp}`, name: "Test Admin", role: "admin", roleSource: "owner_assigned" })
    .returning();
  admin = a;
  ids.users.push(a.id);
});

after(async () => {
  if (ids.services.length) await db.delete(servicesTable).where(inArray(servicesTable.id, ids.services));
  if (ids.users.length) await db.delete(usersTable).where(inArray(usersTable.id, ids.users));
  await db.delete(auditEventsTable).where(like(auditEventsTable.description, `%${stamp}%`));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ---------- X3: the product cost ----------

test("Aeration + seed: the product goes on by the band's own size, rounded up to whole bags", () => {
  // His example. Aeration is the matrix he has; seed is bags at $5 per 1,000
  // sqft. The "up to 3,999" band already charges every lawn in it the one
  // price, so it buys product for 3,999 sqft — four bags, because he cannot
  // buy four fifths of one.
  const aeration = [band(3999, 60), band(9999, 110), band(null, 200)];
  const { equations, added } = addProductCost(aeration, { amountPerUnit: 5, perUnits: 1000, flatAmount: 0, label: "seed" });
  assert.equal(added[0], 20, "3,999 sqft is four bags at $5");
  assert.equal(equations[0].basePrice, 80);
  assert.equal(added[1], 50, "9,999 sqft is ten bags");
  assert.equal(equations[1].basePrice, 160);
  assert.equal(aeration[0].basePrice, 60, "the source matrix is untouched");
});

test("the and-up band keeps buying product instead of paying for one guessed size", () => {
  // A flat "and up" band has no top, so a flat add would charge a 90,000 sqft
  // lawn the same seed as a 10,000 one. The product becomes the band's step.
  const withOpen = [band(9999, 110), band(null, 200)];
  const { equations } = addProductCost(withOpen, { amountPerUnit: 5, perUnits: 1000, flatAmount: 0 });
  const open = equations[1];
  assert.equal(open.incrementSqft, 1000);
  assert.equal(open.incrementPrice, 5);
  assert.equal(calculatePrice(equations, 20000).price, 300, "$200 of labour plus 20 bags");
  assert.equal(calculatePrice(equations, 40000).price, 400, "and twice the lawn buys twice the seed");
});

test("an and-up band that already steps gets the product added to its step, exactly", () => {
  // No rounding up per step: forty steps each rounded up to a whole bag would
  // invent money the product never cost.
  const stepping = [band(null, 100, { baseSqft: 5000, incrementSqft: 2000, incrementPrice: 10 })];
  const { equations, added } = addProductCost(stepping, { amountPerUnit: 5, perUnits: 1000, flatAmount: 0 });
  assert.equal(equations[0].incrementPrice, 20, "$10 of labour plus $10 of product per 2,000");
  assert.equal(added[0], 25, "the base covers 5,000 sqft, so five bags go in the base");
  assert.equal(equations[0].basePrice, 125);
});

test("top dressing: product by the square foot, plus delivery and the trailer once", () => {
  // "beagle to add topdressing cost, product cost/sqft + delivery + Trailer".
  // The flat part happens once however big the lawn is — and it happens on the
  // smallest job he takes, so the floor has to carry it too or he loses the
  // trailer on every minimum-charge job.
  const base = [band(5000, 150, { minPrice: 150, budgetedCost: 112.5 })];
  const { equations, added } = addProductCost(base, {
    amountPerUnit: 20,
    perUnits: 1000,
    flatAmount: 85,
    label: "top dressing",
  });
  assert.equal(added[0], 185, "five lots at $20 plus $85 to get it there");
  assert.equal(equations[0].basePrice, 335);
  assert.equal(equations[0].minPrice, 335, "the floor picks up the whole band's product, delivery and per-sqft both");
  assert.equal(equations[0].budgetedCost, 297.5, "product is a real cost, so it lands on the cost figure at face value");
});

test("a band the floor was already pricing still gets the product, not just the delivery", () => {
  // The floor goes on LAST, over the base and every step, so on a band where
  // the floor was the operative price anything the floor is not carrying is
  // product he hands over and never charges for. His $49 minimum band on a
  // $30 base: top dressing at $20 per 1,000 plus $85 to get it there used to
  // come back at $135 for a small lawn — $19 short, which is exactly what the
  // floor had been adding.
  const base = [band(3999, 30, { minPrice: 49, budgetedCost: 24 })];
  assert.equal(calculatePrice(base, 1000).price, 49, "the floor is what prices this lawn today");
  assert.equal(calculatePrice(base, 1000).minimumApplied, true);

  const { equations, added } = addProductCost(base, {
    amountPerUnit: 20,
    perUnits: 1000,
    flatAmount: 85,
    label: "top dressing",
  });
  assert.equal(added[0], 165, "four lots at $20 plus $85 to get it there");
  assert.equal(equations[0].basePrice, 195);
  assert.equal(equations[0].minPrice, 214, "$49 of labour plus the whole $165 of product");
  assert.equal(equations[0].budgetedCost, 189);
  const priced = calculatePrice(equations, 1000);
  assert.equal(priced.price, 214, "the floor still prices the small lawn, and now it pays for the product");
  assert.equal(priced.minimumApplied, true);
});

test("the and-up band's floor carries the flat part and whatever the base covers", () => {
  // The band he was blocked on: no base, $5 per 1,000 from the first square
  // foot, never less than $49. The floor is one number and the product climbs
  // with the lawn, so the floor can only carry the one-off part plus the
  // product for whatever the base itself covers — the rest rides on the step,
  // which is where it belongs. What it must NOT do is lose the $49.
  const blocked = [band(null, 0, { incrementSqft: 1000, incrementPrice: 5, minPrice: 49 })];
  const { equations, added } = addProductCost(blocked, { amountPerUnit: 5, perUnits: 1000, flatAmount: 85 });
  assert.equal(added[0], 85, "the base covers nothing, so only the delivery lands here");
  assert.equal(equations[0].basePrice, 85);
  assert.equal(equations[0].incrementPrice, 10, "$5 of labour plus $5 of seed per 1,000");
  assert.equal(equations[0].minPrice, 134, "$49 of labour plus the $85 that happens once");
  assert.equal(calculatePrice(equations, 1000).price, 134, "the floor, and it has the delivery in it");
  assert.equal(calculatePrice(equations, 20000).price, 285, "$85 + 20 steps of $10, well clear of the floor");

  // And with a base that does cover ground, the product for that ground goes
  // on the floor too.
  const withBase = [band(null, 0, { baseSqft: 5000, incrementSqft: 1000, incrementPrice: 5, minPrice: 49 })];
  const covered = addProductCost(withBase, { amountPerUnit: 5, perUnits: 1000, flatAmount: 85 });
  assert.equal(covered.added[0], 110, "$85 flat plus five bags for the 5,000 the base covers");
  assert.equal(covered.equations[0].minPrice, 159);
});

test("an empty row stays empty when a product cost is added", () => {
  // Same rule as copying a matrix: a placeholder left by an "Add tier" click
  // must not become a band that then prices a job.
  const matrix = [band(3999, 49), band(0, 0)];
  const { equations, added } = addProductCost(matrix, { amountPerUnit: 5, perUnits: 1000, flatAmount: 85 });
  assert.equal(added[1], null);
  assert.equal(equations[1].basePrice, 0);
  assert.ok(!isPricedBand(equations[1]));
});

test("a product cost that cannot be charged is refused instead of dividing by zero", () => {
  const matrix = [band(3999, 49)];
  for (const product of [
    { amountPerUnit: 5, perUnits: 0, flatAmount: 0 },
    { amountPerUnit: 0, perUnits: 1000, flatAmount: 0 },
    { amountPerUnit: -5, perUnits: 1000, flatAmount: 0 },
  ]) {
    assert.throws(
      () => addProductCost(matrix, product),
      (error: Error & { status?: number }) => error.status === 400,
      JSON.stringify(product),
    );
  }
});

test("the product line says what it is, for the preview and the history", () => {
  assert.equal(
    productCostLabel({ amountPerUnit: 5, perUnits: 1000, flatAmount: 85, label: "top dressing" }),
    "top dressing ($5 per 1,000 sqft + $85 flat)",
  );
  assert.equal(productCostLabel({ amountPerUnit: 0, perUnits: 1000, flatAmount: 85 }), "$85 flat");
});

// ---------- X4: out to a spreadsheet and back ----------

test("a matrix written out and read back in is the same matrix", () => {
  const matrix = [
    band(3999, 49, { minPrice: 49, budgetedHours: 0.5, budgetedCost: 36.75 }),
    band(9999, 75),
    band(null, 203.75, { baseSqft: 10000, incrementSqft: 1000, incrementPrice: 4.5, minPrice: 49 }),
  ];
  const read = parseMatrixCsv(matrixToCsv(matrix, { unit: "Turf Sqft" }));
  assert.deepEqual(read.errors, []);
  assert.equal(read.rowsRead, 3);
  // Blank hours and cost have to come back blank: "no estimate for this band"
  // is not the same as zero hours, and a round trip that quietly zeroed them
  // would tell job costing a mow takes no time.
  assert.deepEqual(read.bands, matrix);
  // And the prices still come out where they went in.
  for (const sqft of [1000, 3999, 5000, 12000, 30000]) {
    assert.equal(calculatePrice(read.bands, sqft).price, calculatePrice(matrix, sqft).price, `${sqft}`);
  }
});

test("a matrix with unfilled Add-tier rows in it exports to a file the importer takes back", () => {
  // Mowing's last row is one of those: an "Add tier" click he never filled in.
  // Those rows export with no size they stop at, and reading one as a second
  // "and up" band made the export refuse its own file — on exactly the
  // services that have the problem.
  const withPlaceholder = [band(3999, 49), band(null, 203.75), band(null, 0)];
  const read = parseMatrixCsv(matrixToCsv(withPlaceholder, { unit: "Turf Sqft" }));
  assert.deepEqual(read.errors, [], "his own exported file has to come back in");
  assert.equal(read.rowsRead, 2);
  assert.equal(read.rowsSkipped, 1, "the unfilled row is padding, not a band");
  assert.deepEqual(read.bands, [band(3999, 49), band(null, 203.75)]);

  // "Add tier" usually leaves a 0 in the To box rather than an empty one, and
  // the real Mowing matrix carries several in a row.
  const zeroes = [band(3999, 49), band(29999, 203.75), band(31999, 0), band(0, 0), band(0, 0)];
  const zeroRead = parseMatrixCsv(matrixToCsv(zeroes, { unit: "Turf Sqft" }));
  assert.deepEqual(zeroRead.errors, []);
  assert.equal(zeroRead.rowsSkipped, 2);
  assert.equal(zeroRead.rowsRead, 3, "the 31,999 row has a real size it stops at, so it stays a band");
  assert.ok(zeroRead.warnings.some((w) => /carries no price/.test(w)), zeroRead.warnings.join(" | "));
  for (const sqft of [1000, 5000, 40000]) {
    assert.equal(calculatePrice(zeroRead.bands, sqft).price, calculatePrice(zeroes, sqft).price, `${sqft}`);
  }
});

test("a row that carries money with no size it stops at is still a band, and still checked", () => {
  // The skip is for empty rows only. A row with a price in it and a To of 0 is
  // a mistake in the file and has to say so, not be quietly dropped.
  const zeroTo = parseMatrixCsv("To,Rate\n3999,49\n0,75\n");
  assert.ok(zeroTo.errors.some((e) => /a To of 0 is not a band/.test(e)), zeroTo.errors.join(" | "));
  const twoOpen = parseMatrixCsv("To,Rate\n,49\n,75\n");
  assert.ok(twoOpen.errors.some((e) => /Only the last band/.test(e)), twoOpen.errors.join(" | "));
  // And a file that is nothing but unfilled rows has no matrix in it at all.
  assert.throws(
    () => parseMatrixCsv("To,Rate\n0,0\n,0\n"),
    (error: Error & { status?: number }) => error.status === 400 && /no bands/.test(error.message),
  );
});

test("the exported file reads like his matrix, From column and all", () => {
  const csv = matrixToCsv([band(3999, 49), band(null, 203.75)], { unit: "Turf Sqft" });
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  assert.deepEqual(splitCsvLine(lines[0]), [
    "From (Turf Sqft)",
    "To (Turf Sqft)",
    "Rate",
    "Never less than",
    "Base covers (Turf Sqft)",
    "Price per step",
    "Step size (Turf Sqft)",
    "Budgeted hours",
    "Budgeted cost",
  ]);
  assert.equal(splitCsvLine(lines[1])[0], "0");
  assert.equal(splitCsvLine(lines[2])[0], "4000", "the next band starts where the last one stopped, plus one");
  assert.equal(splitCsvLine(lines[2])[1], "and up");
  assert.ok(csv.startsWith("﻿"), "Excel needs the marker to read it as UTF-8");
});

test("a field label with a comma does not split the header row in two", () => {
  const csv = matrixToCsv([band(4, 60)], { unit: "Zones, front" });
  const header = splitCsvLine(csv.replace(/^﻿/, "").split("\r\n")[0]);
  assert.equal(header.length, 9);
  assert.equal(header[1], "To (Zones, front)");
});

test("a file he retyped by hand still reads: his spellings, his money, his blanks", () => {
  const csv = [
    "to,price,min,b. cost",
    '"3,999",$49.00,49,36.75',
    "9999,  75 ,,",
    "and up,203.75,49,",
  ].join("\n");
  const read = parseMatrixCsv(csv);
  assert.deepEqual(read.errors, []);
  // An empty "min" cell leaves the floor off the band rather than setting it
  // to null, which is how a band that never had one is stored.
  assert.deepEqual(read.bands.map((b) => [b.upToSqft, b.basePrice, b.minPrice]), [
    [3999, 49, 49],
    [9999, 75, undefined],
    [null, 203.75, 49],
  ]);
  assert.equal(read.bands[0].budgetedCost, 36.75);
  assert.equal(read.bands[1].budgetedCost, null, "an empty cost cell is no estimate, not zero");
});

test("a column it does not know is ignored out loud, not guessed at", () => {
  const read = parseMatrixCsv("To,Rate,Notes from Disa\n3999,49,call first\n");
  assert.equal(read.bands.length, 1);
  assert.ok(read.warnings.some((w) => /Notes from Disa/.test(w)), read.warnings.join(" | "));
  assert.deepEqual(read.errors, []);
});

test("a number it cannot read is an error naming the row, never a quiet zero", () => {
  // A zero in the Rate column is how a 30,000 sqft mow came to quote $0.00
  // once already. Doing that silently across his whole catalogue is the worst
  // thing an import could do.
  const read = parseMatrixCsv("To,Rate\n3999,forty nine\n9999,75\n");
  assert.equal(read.errors.length, 1);
  assert.match(read.errors[0], /Row 2/);
  assert.match(read.errors[0], /forty nine/);
});

test("only the last band may be and up, and two of them is an error", () => {
  const read = parseMatrixCsv("To,Rate\n,49\n,75\n");
  assert.ok(read.errors.some((e) => /Only the last band/.test(e)), read.errors.join(" | "));
  const trailing = parseMatrixCsv("To,Rate\n,49\n9999,75\n");
  assert.ok(trailing.errors.some((e) => /has to be last/.test(e)), trailing.errors.join(" | "));
});

test("a file with no prices in it at all is refused", () => {
  const read = parseMatrixCsv("To,Rate\n3999,0\n9999,0\n");
  assert.ok(read.errors.some((e) => /not one band/i.test(e)), read.errors.join(" | "));
});

test("out-of-order ceilings are flagged, because the first match wins", () => {
  const read = parseMatrixCsv("To,Rate\n9999,75\n3999,49\n");
  assert.deepEqual(read.errors, []);
  assert.ok(read.warnings.some((w) => /out of order/.test(w)), read.warnings.join(" | "));
  // Worth warning about: the small band never gets reached, so every lawn
  // under 10,000 pays the big band's price.
  assert.equal(calculatePrice(read.bands, 1000).price, 75);
});

test("a file with nothing recognisable in it says so instead of saving nothing", () => {
  for (const text of ["", "hello\nworld\n", "a,b,c\n1,2,3\n"]) {
    assert.throws(
      () => parseMatrixCsv(text),
      (error: Error & { status?: number }) => error.status === 400,
      JSON.stringify(text),
    );
  }
  assert.throws(
    () => parseMatrixCsv("To,Rate\n"),
    (error: Error & { status?: number }) => error.status === 400 && /no bands/.test(error.message),
  );
});

test("the unit the file was written in is picked up, not thrown away with the brackets", () => {
  const read = parseMatrixCsv(matrixToCsv([band(4, 60)], { unit: "Sprinkler Zones" }));
  assert.equal(read.unitInFile, "Sprinkler Zones");
  // A file he typed himself usually has no unit in it, and that is not a problem
  // — it just means there is nothing to check against.
  assert.equal(parseMatrixCsv("To,Rate\n3999,49\n").unitInFile, null);
});

test("a pricing field he named with brackets in it does not break its own exported file", () => {
  // He names his own estimate fields. "Turf Sqft (mow area)" puts a bracket
  // inside the bracket the export writes — "To (Turf Sqft (mow area))" — and
  // matching the brackets by pattern stopped at the first ")" and left a stray
  // one behind, so the To, Base covers and Step size columns all stopped being
  // recognised and the app refused a file it had written itself.
  const matrix = [
    band(3999, 49, { minPrice: 49, budgetedHours: 0.5 }),
    band(null, 203.75, { baseSqft: 10000, incrementSqft: 1000, incrementPrice: 4.5 }),
  ];
  const read = parseMatrixCsv(matrixToCsv(matrix, { unit: "Turf Sqft (mow area)" }));
  assert.deepEqual(read.errors, []);
  assert.deepEqual(read.bands, matrix);
  assert.equal(read.unitInFile, "Turf Sqft (mow area)", "the whole label, not the half before the inner bracket");
  // The warning that would otherwise fire on his own file: the unit read back
  // has to match the one that went out, or the import tells him the file is
  // measured in something else.
  assert.deepEqual(read.warnings, []);
});

test("a negative Base covers or Step size is an error, not a quiet repricing", () => {
  // A stray minus sign in Excel: "Base covers -5,000" reads as a perfectly
  // good file and then charges six extra steps on a 1,000 sqft lawn. Nothing
  // here guesses, so it is an error naming the row — the same as a To of 0.
  const negBase = parseMatrixCsv("To,Rate,Base covers,Price per step,Step size\nand up,49,-5000,5,1000\n");
  assert.ok(negBase.errors.some((e) => /Row 2: Base covers cannot be negative/.test(e)), negBase.errors.join(" | "));
  const negStep = parseMatrixCsv("To,Rate,Base covers,Price per step,Step size\nand up,49,5000,5,-1000\n");
  assert.ok(negStep.errors.some((e) => /Row 2: Step size cannot be negative/.test(e)), negStep.errors.join(" | "));
  // What it would have charged if it had gone through: $49 of mowing read back
  // as $79.
  assert.equal(calculatePrice(negBase.bands, 1000).price, 79, "which is why it cannot be allowed to apply");
  const good = parseMatrixCsv("To,Rate,Base covers,Price per step,Step size\nand up,49,5000,5,1000\n");
  assert.deepEqual(good.errors, []);
  assert.equal(calculatePrice(good.bands, 1000).price, 49);
});

test("the services list counts a floor-only band as priced, the way the server does", async () => {
  // No browser here, so this is a guard on the code. The pricing cell on the
  // services list had its own idea of what a priced band is, so the band he
  // was blocked on — base 0, $5 per 1,000, never less than $49 — read as "$0"
  // and got counted in the red "with no price" warning, while the server
  // quoted $49 for it and the line underneath said "never less than $49".
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../bison-crm/src/pages/services.tsx", import.meta.url), "utf8");
  const predicates = src.match(/basePrice > 0 \|\| e\.incrementPrice > 0[^\n]*/g) ?? [];
  assert.ok(predicates.length >= 2, "the priced-band tests moved; re-check them against isPricedBand");
  for (const line of predicates) {
    assert.match(line, /minPrice/, `a priced-band test that ignores the floor: ${line}`);
  }
  // And the figure the cell shows has to be the one an estimate will charge.
  assert.match(src, /Math\.max\(e\.basePrice, e\.minPrice \?\? 0\)/);
  // The server's own answer for that band, so the two cannot drift apart
  // without this test noticing.
  const blocked = [band(null, 0, { baseSqft: 5000, incrementSqft: 1000, incrementPrice: 5, minPrice: 49 })];
  assert.ok(isPricedBand(blocked[0]));
  assert.equal(calculatePrice(blocked, 3000).price, 49);
  assert.equal(Math.max(blocked[0].basePrice, blocked[0].minPrice ?? 0), 49, "which is the number the list must show");
});

test("Excel's trailing blank rows are skipped, not read as bands", () => {
  const read = parseMatrixCsv("To,Rate\n3999,49\n,,\n,,\n");
  assert.equal(read.rowsRead, 1);
  assert.equal(read.rowsSkipped, 2);
});

// ---------- the endpoints, with the app running ----------

test("GET matrix-export hands back a CSV file named after the service", async () => {
  const svc = await makeService("Matrix Export", [band(3999, 49, { minPrice: 49 }), band(null, 203.75)]);
  const res = await fetch(`${baseUrl}/api/services/${svc.id}/matrix-export`, {
    headers: { "x-test-user-id": String(admin.id), "x-test-auth-token": TEST_AUTH_TOKEN },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="Matrix-Export-\d+-matrix\.csv"/);
  const text = await res.text();
  const read = parseMatrixCsv(text);
  assert.deepEqual(read.bands, svc.pricingEquations);

  const missing = await api(`/services/999999999/matrix-export`);
  assert.equal(missing.status, 404);
});

test("importing is two steps: it reads, he looks, then it writes", async () => {
  const svc = await makeService("Matrix Import", [band(3999, 49), band(null, 203.75)]);
  const csv = ["To,Rate,Never less than", "5000,59,59", "and up,250,59"].join("\n");

  const preview = await api(`/services/${svc.id}/import-matrix`, {
    method: "POST",
    body: JSON.stringify({ csv, fileName: "top-dressing.csv" }),
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.applied, false);
  assert.equal(preview.body.canApply, true);
  assert.equal(preview.body.rowsRead, 2);
  assert.equal(preview.body.existingBands, 2, "it says what it would be replacing");
  assert.deepEqual(preview.body.errors, []);
  assert.deepEqual(
    preview.body.columns.map((c: { header: string; field: string | null }) => [c.header, c.field]),
    [["To", "upToSqft"], ["Rate", "basePrice"], ["Never less than", "minPrice"]],
  );

  // Nothing has moved yet. This is the whole point of the two steps.
  const [untouched] = await db.select().from(servicesTable).where(inArray(servicesTable.id, [svc.id]));
  assert.deepEqual(untouched.pricingEquations, svc.pricingEquations);

  const applied = await api(`/services/${svc.id}/import-matrix`, {
    method: "POST",
    body: JSON.stringify({ csv, fileName: "top-dressing.csv", apply: true }),
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.applied, true);
  const [saved] = await db.select().from(servicesTable).where(inArray(servicesTable.id, [svc.id]));
  assert.equal(saved.pricingEquations.length, 2);
  assert.equal(saved.pricingEquations[0].minPrice, 59);
  // The live price proves the floor came through, not just the column.
  const priced = await api(`/services/${svc.id}/price`, { method: "POST", body: JSON.stringify({ sqft: 100 }) });
  assert.equal(priced.body.price, 59);

  // It moves money on every estimate and invoice this service touches, so it
  // is in the history with the file that did it.
  const events = await db.select().from(auditEventsTable).where(like(auditEventsTable.description, `%${stamp}%`));
  const line = events.find((e) => e.action === "service_matrix_imported");
  assert.ok(line, "the import is in the account history");
  assert.match(line!.description, /top-dressing\.csv/);
  assert.match(line!.description, /was 2 priced bands/);
});

test("a matrix measured in something else is flagged before it reprices the service", async () => {
  // Square feet onto a service priced by zones: every number in the file is a
  // perfectly good number, which is exactly why he would never spot it.
  const svc = await makeService("Matrix Import Wrong Unit", [band(3999, 49)]);
  const wrong = await api(`/services/${svc.id}/import-matrix`, {
    method: "POST",
    body: JSON.stringify({ csv: 'To (Sprinkler Zones),Rate\n4,60\n', fileName: "zones.csv" }),
  });
  assert.equal(wrong.status, 200);
  assert.equal(wrong.body.canApply, true, "it is a warning, not a refusal — he may be about to change Price By");
  assert.ok(
    wrong.body.warnings.some((w: string) => /Sprinkler Zones/.test(w) && /Turf Sqft/.test(w)),
    `expected a unit warning, got ${JSON.stringify(wrong.body.warnings)}`,
  );

  const right = await api(`/services/${svc.id}/import-matrix`, {
    method: "POST",
    body: JSON.stringify({ csv: 'To (turf sqft),Rate\n3999,49\n', fileName: "mow.csv" }),
  });
  assert.deepEqual(right.body.warnings, [], "the unit it was exported in is the unit it goes back into");
});

test("a file with a problem in it cannot be applied however hard the caller asks", async () => {
  const svc = await makeService("Matrix Import Refused", [band(3999, 49)]);
  const res = await api(`/services/${svc.id}/import-matrix`, {
    method: "POST",
    body: JSON.stringify({ csv: "To,Rate\n3999,forty nine\n", apply: true }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /was not saved/);
  const [untouched] = await db.select().from(servicesTable).where(inArray(servicesTable.id, [svc.id]));
  assert.deepEqual(untouched.pricingEquations, svc.pricingEquations, "the matrix he had is still the matrix he has");
});

test("copy-matrix previews the product cost before it writes it", async () => {
  const source = await makeService("Aeration Source", [band(3999, 60), band(null, 200)]);
  const target = await makeService("AE Overseed Target", []);

  const body = {
    targetServiceIds: [target.id],
    mode: "multiply",
    value: 1,
    productCost: { amountPerUnit: 5, perUnits: 1000, flatAmount: 0, label: "seed" },
  };
  const preview = await api(`/services/${source.id}/copy-matrix`, { method: "POST", body: JSON.stringify(body) });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.applied, false);
  assert.equal(preview.body.productCostLabel, "seed ($5 per 1,000 sqft)");
  // The flat band picked up $20 of seed. The and-up band picked up nothing
  // one-off, because its product went into the step instead and keeps
  // climbing with the lawn — that is what the 0 is saying.
  assert.deepEqual(preview.body.targets[0].productAdded, [20, 0]);
  assert.equal(preview.body.targets[0].equations[0].basePrice, 80);
  assert.equal(preview.body.targets[0].equations[1].incrementPrice, 5);

  const [stillEmpty] = await db.select().from(servicesTable).where(inArray(servicesTable.id, [target.id]));
  assert.deepEqual(stillEmpty.pricingEquations, []);

  const applied = await api(`/services/${source.id}/copy-matrix`, {
    method: "POST",
    body: JSON.stringify({ ...body, apply: true }),
  });
  assert.equal(applied.status, 200);
  const [saved] = await db.select().from(servicesTable).where(inArray(servicesTable.id, [target.id]));
  assert.equal(saved.pricingEquations[0].basePrice, 80);
  assert.equal(calculatePrice(saved.pricingEquations, 20000).price, 300);

  const events = await db.select().from(auditEventsTable).where(like(auditEventsTable.description, `%${stamp}%`));
  assert.ok(
    events.some((e) => e.action === "service_matrix_copied" && /plus seed/.test(e.description)),
    "the history says the seed went on, not just that a matrix was copied",
  );
});

test("the multiplier runs before the product, so he does not mark up a bag of seed", async () => {
  const source = await makeService("One Time Mow Source", [band(3999, 100)]);
  const target = await makeService("One Time Mow Target", []);
  const res = await api(`/services/${source.id}/copy-matrix`, {
    method: "POST",
    body: JSON.stringify({
      targetServiceIds: [target.id],
      mode: "multiply",
      value: 1.5,
      productCost: { amountPerUnit: 10, perUnits: 1000, flatAmount: 0 },
    }),
  });
  // $100 of labour becomes $150; four lots of $10 of product stay $40.
  assert.equal(res.body.targets[0].equations[0].basePrice, 190);
  assert.equal(res.body.targets[0].productAdded[0], 40);
});

test("a nonsense product cost is a message, not a 500", async () => {
  const source = await makeService("Bad Product Source", [band(3999, 60)]);
  const target = await makeService("Bad Product Target", []);
  const res = await api(`/services/${source.id}/copy-matrix`, {
    method: "POST",
    body: JSON.stringify({
      targetServiceIds: [target.id],
      productCost: { amountPerUnit: 0, perUnits: 1000, flatAmount: 0 },
    }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /costs nothing/);
});

test("the live tester says when the floor is what set the price", async () => {
  // "Show it in the live tester": X1 is the item he is blocked on, and seeing
  // the minimum do its job is how he will believe it.
  const svc = await makeService("Floor Tester", [
    band(null, 0, { incrementSqft: 1000, incrementPrice: 5, minPrice: 49 }),
  ]);
  const small = await api(`/services/${svc.id}/price`, { method: "POST", body: JSON.stringify({ sqft: 3000 }) });
  assert.equal(small.body.price, 49);
  assert.equal(small.body.minimumApplied, true);
  assert.equal(small.body.equationIndex, 0);
  const big = await api(`/services/${svc.id}/price`, { method: "POST", body: JSON.stringify({ sqft: 20000 }) });
  assert.equal(big.body.price, 100);
  assert.equal(big.body.minimumApplied, false);
});
