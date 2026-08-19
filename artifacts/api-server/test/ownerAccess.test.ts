import assert from "node:assert/strict";
import test from "node:test";
import { resolveOwnerAccess } from "../src/lib/ownerAccess.ts";

test("a non-owner who signs up first remains a contractor", () => {
  assert.deepEqual(
    resolveOwnerAccess({
      configuredOwnerEmails: ["owner@example.com"],
      currentPrimaryEmail: "first@example.com",
      profileAvailable: true,
      currentRole: "contractor",
      currentRoleSource: "provisioned",
    }),
    { role: "contractor", roleSource: "provisioned" },
  );
});

test("the configured owner signs up as admin", () => {
  assert.deepEqual(
    resolveOwnerAccess({
      configuredOwnerEmails: [" Owner@Example.com "],
      currentPrimaryEmail: "owner@example.com",
      profileAvailable: true,
      currentRole: "contractor",
      currentRoleSource: "provisioned",
    }),
    { role: "admin", roleSource: "owner" },
  );
});

test("an existing contractor is promoted when the current Clerk email becomes the owner email", () => {
  assert.deepEqual(
    resolveOwnerAccess({
      configuredOwnerEmails: ["owner@example.com"],
      currentPrimaryEmail: "OWNER@example.com",
      profileAvailable: true,
      currentRole: "contractor",
      currentRoleSource: "provisioned",
    }),
    { role: "admin", roleSource: "owner" },
  );
});

test("owner bootstrap access fails closed when the Clerk profile is unavailable", () => {
  assert.deepEqual(
    resolveOwnerAccess({
      configuredOwnerEmails: ["owner@example.com"],
      currentPrimaryEmail: "owner@example.com",
      profileAvailable: false,
      currentRole: "admin",
      currentRoleSource: "provisioned",
    }),
    { role: "contractor", roleSource: "provisioned" },
  );
});

test("an admin explicitly assigned by the owner remains an admin after identity verification", () => {
  assert.deepEqual(
    resolveOwnerAccess({
      configuredOwnerEmails: ["owner@example.com"],
      currentPrimaryEmail: "manager@example.com",
      profileAvailable: true,
      currentRole: "admin",
      currentRoleSource: "owner_assigned",
    }),
    { role: "admin", roleSource: "owner_assigned" },
  );
});

test("a configured secondary owner signs in as an owner admin", () => {
  assert.deepEqual(
    resolveOwnerAccess({
      configuredOwnerEmails: ["primary@example.com", "secondary@example.com"],
      currentPrimaryEmail: "secondary@example.com",
      profileAvailable: true,
      currentRole: "contractor",
      currentRoleSource: "provisioned",
    }),
    { role: "admin", roleSource: "owner" },
  );
});