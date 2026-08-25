import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { User } from "@workspace/db";
import { resolveOwnerAccess } from "../lib/ownerAccess";
import type { OwnerAccessDecision } from "../lib/ownerAccess";
import {
  mergeAccountsForEmail,
  normalizeEmailKey,
  resolveAccountForClerkId,
} from "../lib/userAccounts";

export type ClerkIdentity = {
  name: string;
  email: string | null;
  // Only a verified email proves the sign-in belongs to that person, so only a
  // verified one may join an existing app account.
  emailVerified: boolean;
};

const IDENTITY_CACHE_MS = 60_000;
const identityCache = new Map<string, { identity: ClerkIdentity; expiresAt: number }>();
const identityLoads = new Map<string, Promise<ClerkIdentity | null>>();

async function loadCurrentClerkIdentity(clerkId: string): Promise<ClerkIdentity | null> {
  const cached = identityCache.get(clerkId);
  if (cached && cached.expiresAt > Date.now()) return cached.identity;

  const existingLoad = identityLoads.get(clerkId);
  if (existingLoad) return existingLoad;

  const load = (async () => {
    try {
      const clerkUser = await clerkClient.users.getUser(clerkId);
      const identity = {
        name:
          [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
          clerkUser.primaryEmailAddress?.emailAddress ||
          "New User",
        email: clerkUser.primaryEmailAddress?.emailAddress ?? null,
        emailVerified: clerkUser.primaryEmailAddress?.verification?.status === "verified",
      };
      identityCache.set(clerkId, {
        identity,
        expiresAt: Date.now() + IDENTITY_CACHE_MS,
      });
      return identity;
    } catch {
      return null;
    } finally {
      identityLoads.delete(clerkId);
    }
  })();

  identityLoads.set(clerkId, load);
  return load;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      appUser?: User;
    }
  }
}

/**
 * Decides what access a signed-in Clerk identity gets.
 *
 * Owner access is a privilege grant, so it is only ever matched against an
 * email address Clerk has verified: anyone can put the owner's address on a new
 * Clerk identity, and an unverified one is not evidence that it is theirs.
 */
export function resolveIdentityAccess(
  identity: ClerkIdentity | null,
  current: { role: string; roleSource: string },
): OwnerAccessDecision {
  return resolveOwnerAccess({
    configuredOwnerEmails: [process.env.APP_OWNER_EMAIL, process.env.APP_SECONDARY_OWNER_EMAIL],
    currentPrimaryEmail: identity?.emailVerified ? identity.email : null,
    profileAvailable: identity != null,
    currentRole: current.role,
    currentRoleSource: current.roleSource,
  });
}

/**
 * Requires a Clerk session and just-in-time provisions a local app user.
 * Only Clerk identities matching configured owner-email secrets can bootstrap
 * owner access; everyone else starts as a contractor unless an owner assigned them.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    // Test-only escape hatch: integration tests identify themselves via the
    // x-test-user-id header plus a per-process random capability token that
    // only the test runner knows. Requires BOTH NODE_ENV=test and a matching
    // TEST_AUTH_TOKEN, so a misconfigured NODE_ENV alone can never open it.
    if (process.env.NODE_ENV === "test" && process.env.TEST_AUTH_TOKEN) {
      const token = req.headers["x-test-auth-token"];
      const testUserId = req.headers["x-test-user-id"];
      if (
        typeof token !== "string" ||
        token !== process.env.TEST_AUTH_TOKEN ||
        typeof testUserId !== "string" ||
        !/^\d+$/.test(testUserId)
      ) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const [testUser] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, Number(testUserId)));
      if (!testUser) return res.status(401).json({ error: "Unauthorized" });
      req.appUser = testUser;
      return next();
    }

    const auth = getAuth(req);
    const clerkId = auth?.userId;
    if (!clerkId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const identity = await loadCurrentClerkIdentity(clerkId);
    if (!identity) {
      req.log.warn({ clerkId }, "failed to fetch current Clerk user profile; access will fail closed");
    }

    // Accounts are keyed on the person (verified email), not on the individual
    // Clerk identity, so a second sign-in method joins the existing account
    // instead of quietly creating a parallel one with its own role.
    let user = await resolveAccountForClerkId(
      clerkId,
      identity,
      resolveIdentityAccess(identity, { role: "contractor", roleSource: "provisioned" }),
    );

    if (user) {
      const access = resolveIdentityAccess(identity, user);
      // Only a verified address is stored: an unverified one must never make
      // this account look like the same person as an existing one.
      const verifiedEmail = identity?.emailVerified ? identity.email : null;
      const profileChanged =
        identity != null && (user.email !== verifiedEmail || user.name !== identity.name);
      const accessChanged = user.role !== access.role || user.roleSource !== access.roleSource;

      if (profileChanged || accessChanged) {
        const [refreshed] = await db
          .update(usersTable)
          .set({
            ...(identity ? { name: identity.name, email: verifiedEmail } : {}),
            role: access.role,
            roleSource: access.roleSource,
          })
          .where(eq(usersTable.id, user.id))
          .returning();
        user = refreshed ?? user;
        // An email change can make this account a duplicate of another one.
        const emailKey = identity?.emailVerified ? normalizeEmailKey(user.email) : null;
        if (profileChanged && emailKey) {
          user = (await mergeAccountsForEmail(emailKey)) ?? user;
        }
      }
    }

    if (!user) {
      return res.status(500).json({ error: "Unable to provision local user" });
    }

    req.appUser = user;
    return next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.appUser?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  return next();
}
