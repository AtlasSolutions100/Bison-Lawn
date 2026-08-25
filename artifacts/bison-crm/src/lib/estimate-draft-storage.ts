/**
 * Local (per-browser, per-admin) persistence for the in-progress estimate builder.
 *
 * The builder's work otherwise lives only in React state, so a crash, an
 * accidental window close or a laptop going to sleep threw away everything
 * typed so far. The builder mirrors its state here as it changes and the
 * Estimates page offers to restore or discard it on the next visit.
 *
 * Anything read back is treated as untrusted: a draft written by an older
 * version of the app (or hand-edited) is dropped rather than half-applied.
 */

const STORAGE_PREFIX = 'bison-crm:estimate-draft:v1';

export type StoredSelection = { id: number; selected: boolean; value: string };
export type StoredCustomLine = { label: string; value: string; price: string };

export type EstimateDraft = {
  /** `null` for a brand new estimate, otherwise the draft estimate being edited. */
  estimateId: number | null;
  clientId: string;
  notes: string;
  savePropertyData: boolean;
  fields: StoredSelection[];
  services: StoredSelection[];
  customLines: StoredCustomLine[];
  /** ISO timestamp of the last local save, shown in the restore prompt. */
  savedAt: string;
};

/** Drafts are scoped to the signed-in admin so a shared browser never leaks work. */
export const estimateDraftStorageKey = (userId: number) => `${STORAGE_PREFIX}:${userId}`;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Private-mode / blocked storage: persistence is a best-effort nicety.
    return null;
  }
}

const isString = (value: unknown): value is string => typeof value === 'string';

function parseSelections(raw: unknown): StoredSelection[] | null {
  if (!Array.isArray(raw)) return null;
  const result: StoredSelection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const { id, selected, value } = entry as Record<string, unknown>;
    if (typeof id !== 'number' || !Number.isFinite(id)) return null;
    if (typeof selected !== 'boolean' || !isString(value)) return null;
    result.push({ id, selected, value });
  }
  return result;
}

function parseCustomLines(raw: unknown): StoredCustomLine[] | null {
  if (!Array.isArray(raw)) return null;
  const result: StoredCustomLine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const { label, value, price } = entry as Record<string, unknown>;
    if (!isString(label) || !isString(value) || !isString(price)) return null;
    result.push({ label, value, price });
  }
  return result;
}

export function parseEstimateDraft(raw: unknown): EstimateDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const draft = raw as Record<string, unknown>;
  const { estimateId, clientId, notes, savePropertyData, savedAt } = draft;
  if (estimateId !== null && (typeof estimateId !== 'number' || !Number.isFinite(estimateId))) return null;
  if (!isString(clientId) || !isString(notes) || !isString(savedAt)) return null;
  if (typeof savePropertyData !== 'boolean') return null;
  const fields = parseSelections(draft.fields);
  const services = parseSelections(draft.services);
  const customLines = parseCustomLines(draft.customLines);
  if (!fields || !services || !customLines) return null;
  return { estimateId, clientId, notes, savePropertyData, fields, services, customLines, savedAt };
}

export function readEstimateDraft(key: string): EstimateDraft | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(key);
  if (!raw) return null;
  try {
    return parseEstimateDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeEstimateDraft(key: string, draft: EstimateDraft): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(draft));
  } catch {
    // Quota exceeded — losing the local copy must never break the builder.
  }
}

export function clearEstimateDraft(key: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

/** "2 minutes ago" style label for the restore prompt. */
export function describeDraftAge(savedAt: string, now: number = Date.now()): string {
  const saved = Date.parse(savedAt);
  if (!Number.isFinite(saved)) return 'a moment ago';
  const minutes = Math.floor(Math.max(0, now - saved) / 60_000);
  if (minutes < 1) return 'moments ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
