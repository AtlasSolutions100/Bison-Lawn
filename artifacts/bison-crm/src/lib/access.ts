import { useGetCurrentUser, type AccessArea, type AccessLevel, type AppUser } from '@workspace/api-client-react';
import { e2eAuthBypass } from '@/lib/e2e-auth';

/**
 * Who can open what, on the web side.
 *
 * The server works out `areas` for the signed-in person (lib/access.ts on the
 * API) and the page only reads it. That way the sidebar, the route guard and
 * the API refusals can never disagree about whether someone gets the books.
 */
export type Area = AccessArea;

export const AREA_LABELS: Record<Area, string> = {
  dispatch: 'Dispatch',
  clients: 'Clients',
  invoices: 'Invoices',
  quickbooks: 'QuickBooks',
  reports: 'Reports',
  settings: 'Settings',
  team: 'Team',
  documents: 'Documents',
};

export const AREAS: Area[] = ['dispatch', 'clients', 'invoices', 'quickbooks', 'reports', 'settings', 'team', 'documents'];

/** What an office user gets before anything is granted; mirrors the server. */
export const OFFICE_BASE: Area[] = ['dispatch', 'clients', 'invoices', 'documents'];

/** The three levels, in the words Adam used, with what each one means. */
export const LEVELS: { value: AccessLevel; label: string; explain: string }[] = [
  {
    value: 'full',
    label: 'Full user',
    explain: 'Every office screen. Untick a box below to keep one part away from them (for example, no QuickBooks).',
  },
  {
    value: 'office',
    label: 'Office user',
    explain: 'Dispatch, clients, invoices and documents. Tick a box below to hand them more (reports, the books, settings, the team list).',
  },
  {
    value: 'mobile',
    label: 'Mobile only',
    explain: 'The phone app and nothing else: their jobs, their route, clock in and out, photos, notes.',
  },
];

/** The ['me'] key is the app-wide convention for the current user; reuse it. */
export function useMe() {
  return useGetCurrentUser({
    query: { queryKey: ['me'], retry: false, enabled: true },
  });
}

/**
 * True once the current user is known to be able to open `area`. False while
 * loading, so a screen never flashes before the sidebar has decided.
 */
export function useCan(area: Area): boolean {
  const { data: me } = useMe();
  return canOpen(me, area);
}

export function canOpen(me: AppUser | undefined | null, area: Area): boolean {
  if (!me) return false;
  return (me.areas ?? []).includes(area);
}

/** The route each area lives under, for polite redirects and the sidebar. */
export const AREA_HOME: Record<Area, string> = {
  dispatch: '/dispatch',
  clients: '/clients',
  invoices: '/invoices',
  quickbooks: '/books',
  reports: '/reports',
  settings: '/settings',
  team: '/team',
  documents: '/spring-letters',
};

/**
 * Whether the dev e2e bypass is on. Exported here so layout code has one
 * place to ask instead of importing the flag from two modules.
 */
export const authBypass = e2eAuthBypass;
