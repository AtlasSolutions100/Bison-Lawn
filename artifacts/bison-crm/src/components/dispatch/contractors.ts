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

/** Everyone who can be put on a job, by the name he wants to read. */
export function useContractors(): ContractorOption[] {
  const { data: users } = useListUsers();
  return useMemo(
    () =>
      (users ?? [])
        .filter((u) => u.role === 'contractor' && (u as { active?: boolean }).active !== false)
        .map((u) => ({ id: u.id, name: contractorLabel(u) })),
    [users],
  );
}
