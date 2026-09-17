import type { QueryClient } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';

/**
 * Bits every billing screen shares — the Invoices page, the invoice window,
 * and the Accounting panel on the customer's page — so the two pages show a
 * status the same colour and refresh the same lists after a payment.
 */

export const money = (n: number | null | undefined) =>
  `$${(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** His calendar: Post Falls, Coeur d'Alene and Hayden are Pacific. */
const OFFICE_TIME_ZONE = 'America/Los_Angeles';

/**
 * The day something happened, on his calendar, as YYYY-MM-DD.
 *
 * Payment times come back as UTC, so cutting the front off the string dated a
 * cheque keyed at 6 pm as the next day — in the list, in the statement (where
 * it also sorted it after the next day's invoices) and in the CSV. Date-only
 * values are passed straight through: there is no time in them to shift.
 */
export const officeDay = (value: string | null | undefined) => {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  if (!/[T ]\d{2}:/.test(raw)) return raw.slice(0, 10);
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return raw.slice(0, 10);
  // en-CA formats as YYYY-MM-DD, the shape the date columns already hold.
  return new Intl.DateTimeFormat('en-CA', { timeZone: OFFICE_TIME_ZONE }).format(at);
};

/** A date as he reads it, without the timezone shifting it a day. */
export const dayLabel = (value: string | null | undefined) => {
  if (!value) return '—';
  try {
    return format(parseISO(officeDay(value)), 'MMM d, yyyy');
  } catch {
    return value;
  }
};

export const momentLabel = (value: string | null | undefined) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : format(d, 'MMM d, yyyy h:mm a');
};

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Needs verification',
  open: 'Open',
  partial: 'Partly paid',
  paid: 'Paid',
  void: 'Void',
};

export const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-accent/20 text-accent-foreground border-accent/30',
  open: 'bg-destructive/10 text-destructive border-destructive/20',
  partial: 'bg-accent/20 text-accent-foreground border-accent/30',
  paid: 'bg-primary/10 text-primary border-primary/20',
  void: 'bg-muted text-muted-foreground border-border',
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-block whitespace-nowrap px-2.5 py-1 text-xs font-semibold rounded-full border ${
        STATUS_CLASS[status] ?? STATUS_CLASS.open
      }`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export const METHOD_LABEL: Record<string, string> = {
  check: 'Check',
  venmo: 'Venmo',
  zelle: 'Zelle',
  credit_card: 'Credit card',
  cash: 'Cash',
  ach: 'ACH',
  other: 'Other',
};

export const methodLabel = (m: string | null | undefined) => (m ? (METHOD_LABEL[m] ?? m.replace(/_/g, ' ')) : '—');

export const PAYMENT_METHODS = ['check', 'credit_card', 'venmo', 'zelle', 'cash', 'other'] as const;

export const DELIVERY_LABEL: Record<string, string> = {
  email: 'Email',
  print: 'Print',
  both: 'Email + print',
};

/**
 * After anything that moves money: the invoice lists (every queue), the
 * payments list, the customers (balances), and that one customer's page.
 */
export function invalidateBilling(queryClient: QueryClient, clientId?: number | null, invoiceId?: number | null) {
  void queryClient.invalidateQueries({ queryKey: ['/api/invoices'] });
  void queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
  void queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
  void queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
  void queryClient.invalidateQueries({ queryKey: ['/api/waiting-list'] });
  if (clientId != null) {
    void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}`] });
    void queryClient.invalidateQueries({ queryKey: ['/api/clients', clientId, 'audit'] });
    void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/jobs`] });
    void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/audit`] });
  }
  if (invoiceId != null) {
    void queryClient.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}`] });
    void queryClient.invalidateQueries({ queryKey: [`/api/invoices/${invoiceId}/audit`] });
  }
}

export const errorText = (error: unknown, fallback = 'Please try again.') =>
  error instanceof Error && error.message ? error.message : fallback;

/** Opens a PDF the API serves inline, in a new tab, the way the office previews a bill. */
export function openPdf(path: string) {
  window.open(path, '_blank', 'noopener,noreferrer');
}

/** Builds a CSV file in the browser and hands it to the download folder. */
export function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const cell = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
