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

// ---- copying a matrix: scalePrice / scaleEquations ----

import { scalePrice, scaleEquations, bandsFromRule, MAX_RULE_BANDS } from "../src/lib/helpers.ts";

test("a one-time mow is the mowing matrix at 1.5x", () => {
  // "one-time mow = 1.5x mowing" — his own example.
  const mowing = [band(3999, 49, { budgetedCost: 36.75, budgetedHours: 0.5 }), band(9999, 75), band(null, 203.75)];
  const oneTime = scaleEquations(mowing, { mode: "multiply", value: 1.5 }, { scaleCost: true });
  assert.deepEqual(oneTime.map((e) => e.basePrice), [73.5, 112.5, 305.63]);
  assert.deepEqual(oneTime.map((e) => e.upToSqft), [3999, 9999, null], "the measurements travel untouched");
  assert.equal(oneTime[0].budgetedCost, 55.13, "cost follows the rate");
  assert.equal(oneTime[0].budgetedHours, 0.5, "hours never change — the job takes as long as it takes");
  assert.deepEqual(mowing[0].basePrice, 49, "the source is not modified");
});

test("round-to snaps the copied prices to something he would quote", () => {
  assert.equal(scalePrice(49, { mode: "multiply", value: 1.5, roundTo: 1 }), 74);
  assert.equal(scalePrice(49, { mode: "multiply", value: 1.5, roundTo: 0.5 }), 73.5);
  assert.equal(scalePrice(49, { mode: "add", value: 5 }), 54);
  assert.equal(scalePrice(49, { mode: "percent", value: 10 }), 53.9);
  assert.equal(scalePrice(10, { mode: "add", value: -25 }), 0, "never below zero");
});

test("an empty band stays empty when the matrix is copied", () => {
  // "add $5" must not turn a placeholder row into a $5 band that then prices a job.
  const matrix = [band(3999, 49), placeholder(5999), placeholder(0)];
  const copied = scaleEquations(matrix, { mode: "add", value: 5 });
  assert.equal(copied[0].basePrice, 54);
  assert.equal(copied[1].basePrice, 0);
  assert.equal(copied[2].basePrice, 0);
  assert.equal(calculatePrice(copied, 5000).price, 54, "still falls back to the priced band");
});

test("add mode leaves the per-step increment and the cost alone", () => {
  const matrix = [band(null, 100, { baseSqft: 5000, incrementSqft: 1000, incrementPrice: 10, budgetedCost: 75 })];
  const added = scaleEquations(matrix, { mode: "add", value: 20 }, { scaleCost: true });
  assert.equal(added[0].basePrice, 120);
  assert.equal(added[0].incrementPrice, 10, "adding $20 to every step would compound on a big property");
  assert.equal(added[0].budgetedCost, 75);
  const doubled = scaleEquations(matrix, { mode: "multiply", value: 2 }, { scaleCost: true });
  assert.equal(doubled[0].incrementPrice, 20);
  assert.equal(doubled[0].budgetedCost, 150);
});

// ---- filling a matrix from a rule ----

test("$X per 1000 sqft up to Y becomes one band per step", () => {
  // "$49 to start, then $5 per 1000 sqft up to 5000" — the mowing rule.
  const bands = bandsFromRule({ startPrice: 49, firstTier: { pricePerStep: 5, stepSize: 1000, upTo: 5000 } });
  assert.deepEqual(bands.map((b) => [b.upToSqft, b.basePrice]), [
    [1000, 49],
    [2000, 54],
    [3000, 59],
    [4000, 64],
    [5000, 69],
  ]);
  assert.equal(calculatePrice(bands, 3500).price, 64);
  assert.equal(calculatePrice(bands, 1000).price, 49, "the start price covers the whole first step");
});

test("a Bison application steps every 500 and a second tier takes over above the ceiling", () => {
  // "$X per 500 up to Y", then "$4.50 per 2k above 20k".
  const bands = bandsFromRule({
    startPrice: 40,
    firstTier: { pricePerStep: 2, stepSize: 500, upTo: 2000 },
    secondTier: { pricePerStep: 4.5, stepSize: 2000, upTo: 6000 },
    costPercent: 75,
  });
  assert.deepEqual(bands.map((b) => [b.upToSqft, b.basePrice]), [
    [500, 40],
    [1000, 42],
    [1500, 44],
    [2000, 46],
    [4000, 50.5],
    [6000, 55],
  ]);
  assert.equal(bands[0].budgetedCost, 30, "cost filled at 75% of the rate");
  assert.equal(bands[4].budgetedCost, 37.88);
});

test("a ceiling that is not a multiple of the step gets a short last band", () => {
  const bands = bandsFromRule({ startPrice: 10, firstTier: { pricePerStep: 1, stepSize: 1000, upTo: 2500 } });
  assert.deepEqual(bands.map((b) => b.upToSqft), [1000, 2000, 2500]);
});

test("no ceiling makes one 'and up' band that keeps stepping", () => {
  const bands = bandsFromRule({
    startPrice: 49,
    firstTier: { pricePerStep: 5, stepSize: 1000, upTo: 3000 },
    secondTier: { pricePerStep: 4.5, stepSize: 2000, upTo: null },
  });
  const last = bands[bands.length - 1];
  assert.equal(last.upToSqft, null);
  assert.equal(last.baseSqft, 3000);
  assert.equal(last.basePrice, 59, "starts from the price at the ceiling");
  assert.equal(last.incrementSqft, 2000);
  assert.equal(last.incrementPrice, 4.5);
  // 3000 sqft is still the last flat band; 3001-5000 is one step up; 7000 is two.
  assert.equal(calculatePrice(bands, 3000).price, 59);
  assert.equal(calculatePrice(bands, 3001).price, 63.5);
  assert.equal(calculatePrice(bands, 7000).price, 68);
});

test("a first ceiling inside the first step still builds bands instead of an error", () => {
  // "$60 covers the first 4 zones, then $5 a zone after" — the blow-out rule.
  // The whole first tier fits in one step, so the start-price band IS that
  // tier; it used to come back as "must be above where the previous one
  // stopped" and build nothing.
  const blowout = bandsFromRule({
    startPrice: 60,
    firstTier: { pricePerStep: 5, stepSize: 4, upTo: 4 },
    secondTier: { pricePerStep: 5, stepSize: 1, upTo: null },
  });
  assert.deepEqual(blowout.map((b) => [b.upToSqft, b.basePrice]), [
    [4, 60],
    [null, 60],
  ]);
  assert.equal(calculatePrice(blowout, 4).price, 60, "four zones is the start price");
  assert.equal(calculatePrice(blowout, 5).price, 65);
  assert.equal(calculatePrice(blowout, 7).price, 75);

  // One tier on its own, ceiling exactly one step: a single flat band.
  const oneStep = bandsFromRule({ startPrice: 49, firstTier: { pricePerStep: 5, stepSize: 1000, upTo: 1000 } });
  assert.deepEqual(oneStep.map((b) => [b.upToSqft, b.basePrice]), [[1000, 49]]);

  // Ceiling lower than one step: the band stops at the ceiling.
  const shortTier = bandsFromRule({ startPrice: 49, firstTier: { pricePerStep: 5, stepSize: 1000, upTo: 500 } });
  assert.deepEqual(shortTier.map((b) => [b.upToSqft, b.basePrice]), [[500, 49]]);
});

test("a rule that would make hundreds of bands is refused, not built", () => {
  assert.throws(
    () => bandsFromRule({ startPrice: 1, firstTier: { pricePerStep: 1, stepSize: 1, upTo: MAX_RULE_BANDS * 10 } }),
    (error: Error & { status?: number }) => error.status === 400 && /bands/.test(error.message),
  );
  assert.throws(
    () => bandsFromRule({ startPrice: 1, firstTier: { pricePerStep: 1, stepSize: 1000, upTo: 5000 }, secondTier: { pricePerStep: 1, stepSize: 1000, upTo: 4000 } }),
    (error: Error & { status?: number }) => error.status === 400,
    "a second tier below the first tier's ceiling",
  );
  assert.throws(
    () => bandsFromRule({ startPrice: 1, firstTier: { pricePerStep: 1, stepSize: 1000, upTo: null }, secondTier: { pricePerStep: 1, stepSize: 1000, upTo: 9000 } }),
    (error: Error & { status?: number }) => error.status === 400,
    "an and-up first tier leaves no room for a second",
  );
});
