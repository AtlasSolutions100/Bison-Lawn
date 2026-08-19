import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { User } from "@workspace/db";

function isConfiguredOwner(email: string | null | undefined): boolean {
  const ownerEmail = process.env.APP_OWNER_EMAIL?.trim().toLowerCase();
  return Boolean(ownerEmail && email?.trim().toLowerCase() === ownerEmail);
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
 * Requires a Clerk session and just-in-time provisions a local app user.
 * The first user ever created becomes an admin; later users default to contractor.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const auth = getAuth(req);
    const clerkId = auth?.userId;
    if (!clerkId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    let [user] = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId));
    if (!user) {
      let name = "New User";
      let email: string | null = null;
      try {
        const cu = await clerkClient.users.getUser(clerkId);
        name =
          [cu.firstName, cu.lastName].filter(Boolean).join(" ") ||
          cu.primaryEmailAddress?.emailAddress ||
          "New User";
        email = cu.primaryEmailAddress?.emailAddress ?? null;
      } catch (err) {
        req.log.warn({ err }, "failed to fetch clerk user profile");
      }
      const existing = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
      const role = isConfiguredOwner(email) || existing.length === 0 ? "admin" : "contractor";
      [user] = await db
        .insert(usersTable)
        .values({ clerkId, name, email, role })
        .onConflictDoNothing({ target: usersTable.clerkId })
        .returning();
      if (!user) {
        [user] = await db.select().from(usersTable).where(eq(usersTable.clerkId, clerkId));
      }
    }

    // A configured owner email is the durable source of truth for owner access.
    // This also repairs an existing owner account that was provisioned as a
    // contractor because a test or another user reached production first.
    if (user && user.role !== "admin" && isConfiguredOwner(user.email)) {
      [user] = await db
        .update(usersTable)
        .set({ role: "admin" })
        .where(eq(usersTable.id, user.id))
        .returning();
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
