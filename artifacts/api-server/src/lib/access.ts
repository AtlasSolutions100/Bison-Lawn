import type { Request, Response, NextFunction } from "express";

/**
 * Who can open what.
 *
 * Adam's words from the walkthrough: a FULL user (himself, and a second person
 * who runs the office but must never see QuickBooks), a partial OFFICE user
 * (a crew lead who dispatches and looks up customers but does not touch the
 * money side), and a MOBILE-only contractor who just gets the phone app.
 *
 * `role` stays the shell switch the rest of the app already checks (admin =
 * office screens, contractor = phone app). The level and the per-area
 * permissions sit on top of it. Nothing here is a third role: ownerAccess.ts
 * would reset an unknown role to contractor on the next request.
 */
export const AREAS = [
  "dispatch",
  "clients",
  "invoices",
  "quickbooks",
  "reports",
  "settings",
  "team",
  "documents",
] as const;
export type Area = (typeof AREAS)[number];

export const ACCESS_LEVELS = ["full", "office", "mobile"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/**
 * What an office user gets without being handed anything extra: the day-to-day
 * work. Money reports, the books, company settings and the team list are the
 * owner's side of the desk, so they have to be granted on purpose.
 */
const OFFICE_BASE: readonly Area[] = ["dispatch", "clients", "invoices", "documents"];

export function isArea(value: unknown): value is Area {
  return typeof value === "string" && (AREAS as readonly string[]).includes(value);
}

export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === "string" && (ACCESS_LEVELS as readonly string[]).includes(value);
}

/** The shape `can` needs; a full `User` row satisfies it. */
export type AccessSubject = {
  role: string;
  roleSource: string;
  accessLevel: string;
  permissions: string[] | null;
  active?: boolean;
};

/** The role that goes with a level: mobile people live in the phone app. */
export function roleForLevel(level: AccessLevel): "admin" | "contractor" {
  return level === "mobile" ? "contractor" : "admin";
}

/**
 * The level that actually applies to a person.
 *
 * A stored level can disagree with the role: every row already in the database
 * when the column was added got a level of its own, so his subcontractors read
 * as contractors carrying "full". The role is the shell switch the whole app
 * turns on, so it wins — a contractor is mobile whatever the column says.
 * Without this the Team page would show them as full users and saving the row
 * for any reason would hand a subcontractor the whole office.
 */
export function effectiveLevel(user: AccessSubject | null | undefined): AccessLevel {
  if (!user) return "mobile";
  if (user.roleSource === "owner") return "full";
  if (user.role !== "admin") return "mobile";
  return isAccessLevel(user.accessLevel) ? user.accessLevel : "mobile";
}

/**
 * Keeps a stored permission list honest: only known areas, each at most once,
 * and a denial beats a grant for the same area (a "!quickbooks" next to a
 * "quickbooks" means someone changed their mind, and the safe reading is no).
 */
export function normalizePermissions(raw: readonly string[] | null | undefined): string[] {
  const grants = new Set<Area>();
  const denials = new Set<Area>();
  for (const entry of raw ?? []) {
    const key = entry.trim().toLowerCase();
    if (key.startsWith("!")) {
      const area = key.slice(1);
      if (isArea(area)) denials.add(area);
    } else if (isArea(key)) {
      grants.add(key);
    }
  }
  for (const area of denials) grants.delete(area);
  return [...[...grants].sort(), ...[...denials].sort().map((a) => `!${a}`)];
}

export function can(user: AccessSubject | null | undefined, area: Area): boolean {
  if (!user) return false;
  if (user.active === false) return false;
  // The configured owner can never be locked out of his own app, whatever
  // someone typed into permissions.
  if (user.roleSource === "owner") return true;
  const level = effectiveLevel(user);
  if (level === "mobile") return false;
  const perms = normalizePermissions(user.permissions);
  if (perms.includes(`!${area}`)) return false;
  if (level === "full") return true;
  if (level === "office") return OFFICE_BASE.includes(area) || perms.includes(area);
  return false;
}

/** Every area the person can open — what the sidebar and the Team page read. */
export function areasFor(user: AccessSubject | null | undefined): Area[] {
  return AREAS.filter((area) => can(user, area));
}

/**
 * Route guard. Sits after requireAuth (it needs req.appUser). A denied person
 * gets a plain answer instead of "Admin access required", because they may
 * well be an admin — just not for this part.
 */
export function requireArea(area: Area) {
  return function requireAreaMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!req.appUser) return res.status(401).json({ error: "Unauthorized" });
    if (!can(req.appUser, area)) {
      return res.status(403).json({
        error: `${AREA_LABELS[area]} is not turned on for your account. Ask Adam if you need it.`,
      });
    }
    return next();
  };
}

export const AREA_LABELS: Record<Area, string> = {
  dispatch: "Dispatch",
  clients: "Clients",
  invoices: "Invoices",
  quickbooks: "QuickBooks",
  reports: "Reports",
  settings: "Settings",
  team: "Team",
  documents: "Documents",
};
