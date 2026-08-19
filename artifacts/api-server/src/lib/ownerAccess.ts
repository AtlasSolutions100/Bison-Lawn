export type AppRole = "admin" | "contractor";
export type RoleSource = "provisioned" | "owner" | "owner_assigned";

type ResolveOwnerAccessInput = {
  configuredOwnerEmail: string | undefined;
  currentPrimaryEmail: string | null;
  profileAvailable: boolean;
  currentRole: string;
  currentRoleSource: string;
};

export type OwnerAccessDecision = {
  role: AppRole;
  roleSource: RoleSource;
};

function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  return normalized || null;
}

/**
 * Resolves authorization from a freshly verified Clerk identity.
 *
 * Owner access fails closed when the owner setting or Clerk profile is
 * unavailable. Non-owner admins are preserved only when a verified owner
 * explicitly assigned that role.
 */
export function resolveOwnerAccess(input: ResolveOwnerAccessInput): OwnerAccessDecision {
  const ownerEmail = normalizeEmail(input.configuredOwnerEmail);
  const currentEmail = normalizeEmail(input.currentPrimaryEmail);

  if (!ownerEmail || !input.profileAvailable) {
    return { role: "contractor", roleSource: "provisioned" };
  }

  if (currentEmail === ownerEmail) {
    return { role: "admin", roleSource: "owner" };
  }

  if (input.currentRole === "admin" && input.currentRoleSource === "owner_assigned") {
    return { role: "admin", roleSource: "owner_assigned" };
  }

  return { role: "contractor", roleSource: "provisioned" };
}