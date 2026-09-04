import assert from "node:assert/strict";
import test from "node:test";
import type { PricingEquation } from "@workspace/db";
import { calculatePrice } from "../src/lib/helpers.ts";

const band = (
  upToSqft: number | null,
  basePrice: number,
  extra: Partial<PricingEquation> = {},
): PricingEquation => ({
  upToSqft,
  basePrice,
  baseSqft: 0,
  incrementPrice: 0,
  incrementSqft: 0,
  budgetedHours: null,
  budgetedCost: null,
  ...extra,
});

/** An empty row, as left behind by an "Add tier" click nobody filled in. */
const placeholder = (upToSqft: number | null = 0) => band(upToSqft, 0);

test("a band prices from the first ceiling the value fits under", () => {
  const matrix = [band(3999, 49), band(9999, 75), band(29999, 203.75)];
  assert.equal(calculatePrice(matrix, 3000).price, 49);
  assert.equal(calculatePrice(matrix, 3999).price, 49);
  assert.equal(calculatePrice(matrix, 4000).price, 75);
  assert.equal(calculatePrice(matrix, 25000).price, 203.75);
});

// This is the live bug, with his real numbers. Mowing carried 40 bands, 18 of
// them empty rows with no price. A 30,000 sqft property matched one of those
// empty rows and priced at $0.00 — so the estimate quoted nothing, and the
// invoice raised when that job completed would have billed nothing.
test("an empty band never prices a job at zero", () => {
  const matrix = [
    band(3999, 49),
    band(29999, 203.75),
    placeholder(31999), // "30000 | 31999 | 0 | — | —"
    placeholder(0),
    placeholder(0),
  ];

  for (const sqft of [30000, 31000, 33000, 50000]) {
    const { price } = calculatePrice(matrix, sqft);
    assert.ok(price > 0, `${sqft} sqft priced at ${price}, which bills the customer nothing`);
    assert.equal(price, 203.75, "falls back to the largest band that has a price");
  }
});

test("the reported band index points into the caller's array, not a filtered copy", () => {
  // Callers read budgetedHours back out of service.pricingEquations[index], so
  // an index into the filtered list would attribute the wrong hours to the job.
  const matrix = [placeholder(1), band(9999, 75, { budgetedHours: 0.5 }), placeholder(0)];
  const { price, equationIndex } = calculatePrice(matrix, 5000);
  assert.equal(price, 75);
  assert.equal(equationIndex, 1);
  assert.equal(matrix[equationIndex!].budgetedHours, 0.5);
});

test("an open-ended band still catches everything above the last ceiling", () => {
  const matrix = [band(9999, 75), band(null, 250)];
  assert.equal(calculatePrice(matrix, 500000).price, 250);
});

test("increment pricing still applies on the matched band", () => {
  const matrix = [band(null, 100, { baseSqft: 5000, incrementSqft: 1000, incrementPrice: 10 })];
  // 8000 sqft: 3000 over the base, three increments of $10 on top of $100.
  assert.equal(calculatePrice(matrix, 8000).price, 130);
});

test("a matrix that is entirely empty prices nothing and says so", () => {
  // Nothing to charge from, so zero is the honest answer — but the null index
  // tells the caller no band was chosen, rather than pointing at a real one.
  const { price, equationIndex } = calculatePrice([placeholder(1000), placeholder(0)], 500);
  assert.equal(price, 0);
  assert.equal(equationIndex, null);
});

test("an empty matrix is unchanged", () => {
  assert.deepEqual(calculatePrice([], 5000), { price: 0, equationIndex: null });
});
