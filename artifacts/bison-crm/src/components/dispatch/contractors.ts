import { useMemo } from 'react';
import { useListUsers } from '@workspace/api-client-react';

export type ContractorOption = { id: number; name: string };

/**
 * The short name he set on the person, never the account name. A contractor
 * who signed up by email has their email address as the account name, and
 * "the dispatch board shows an email, not a name" is on his checklist.
 */
export function contractorLabel(u: { name: string; displayName?: string | null }): string {
  return u.displayName?.trim() || u.name;
}

/**
 * Everyone who can be put on a job, by the name he wants to read.
 *
 * "Accepted contractor not popping up on dispatch board": this list used to
 * ask for role 'contractor' only, and the role is not something he picks — it
 * follows the access level. Invite someone as a full or office user (which is
 * what Adam Eich accepted on 2026-09-14) and the account comes back as an
 * admin, so the one person he had just added was the one person the board
 * would not offer. He is the only office there is and he mows himself, so
 * "admin" was never going to mean "does not work jobs" here.
 *
 * The rule now: anyone with a live account can be sent to a job. Subs come
 * first because they are who he assigns nine times out of ten, then everyone
 * else in name order. Someone he switched off stays out — GET /users already
 * drops them unless the Team page asks for them by name.
 */
export function useContractors(): ContractorOption[] {
  const { data: users } = useListUsers();
  return useMemo(() => {
    const live = (users ?? []).filter((u) => (u as { active?: boolean }).active !== false);
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    const subs = live.filter((u) => u.role === 'contractor').map((u) => ({ id: u.id, name: contractorLabel(u) }));
    const office = live.filter((u) => u.role !== 'contractor').map((u) => ({ id: u.id, name: contractorLabel(u) }));
    return [...subs.sort(byName), ...office.sort(byName)];
  }, [users]);
}
