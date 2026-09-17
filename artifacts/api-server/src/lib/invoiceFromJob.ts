import { eq } from "drizzle-orm";
import { db, clientsTable, invoicesTable, invoiceLineItemsTable } from "@workspace/db";
import { dueDateFrom, nextInvoiceNumber, todayISO } from "./invoiceNumbers";
import { roundMoney } from "./helpers";

type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type JobInvoiceInput = {
  clientId: number;
  jobId: number;
  /** The service line's own amount, before products and fees. */
  serviceAmount: number;
  serviceName: string | null;
  /**
   * What prints on the bill for the service, when the service has its own
   * invoice description (his INVOICE DESCRIPTION field). Falls back to the
   * service name.
   */
  invoiceDescription?: string | null;
  /** Date-only string for the visit, used as each line's service date. */
  serviceDate?: string | null;
  products: { name: string; price: number; quantity: number }[];
  /** Card surcharges from payments taken before completion. */
  pendingFees: number;
  /**
   * Set when the service line was priced from the clock: the line then reads
   * "hours x rate" with the hours as its quantity, so the customer sees what
   * they are paying for. `serviceAmount` is already hours x hourlyRate.
   */
  timeBilled?: { hours: number; hourlyRate: number } | null;
  /**
   * A discount on the assigned service. Printed as its own negative line —
   * "Loyalty discount  -$5.00" — rather than folded into the rate, which is
   * how he shows it and how the customer expects to see it.
   */
  discount?: { label: string; amount: number } | null;
  /** A remark for the office on the invoice's notes, e.g. no time was clocked. */
  note?: string | null;
};

/**
 * Create the invoice for a completed job, itemised and numbered.
 *
 * Both completion paths — a crew finishing a job on the phone, and a vendor run
 * closing a batch — went through their own `insert(invoicesTable)` with a total
 * and a one-sentence note. That produced invoices with no number and no detail,
 * which is most of the invoices the business issues. Sharing one builder is the
 * only way the two paths cannot drift apart again.
 *
 * The total is the sum of the lines it writes, so the printed detail and the
 * amount owed are the same arithmetic rather than two computations that agree
 * until one of them changes.
 */
export async function createInvoiceForJob(tx: Executor, input: JobInvoiceInput) {
  const [client] = await tx.select().from(clientsTable).where(eq(clientsTable.id, input.clientId));
  const invoiceDate = input.serviceDate?.trim() || todayISO();
  const terms = client?.billingTerms?.trim() || null;

  const lines: {
    description: string;
    serviceDate: string | null;
    quantity: number;
    unitPrice: number;
    total: number;
    sortOrder: number;
  }[] = [];

  const push = (description: string, quantity: number, unitPrice: number, total?: number) => {
    lines.push({
      description,
      serviceDate: invoiceDate,
      quantity,
      unitPrice,
      total: total ?? roundMoney(quantity * unitPrice),
      sortOrder: lines.length,
    });
  };

  const serviceLabel = input.invoiceDescription?.trim() || input.serviceName || "Service";
  // The service itself is a line even when the amount is zero — a $0 line on a
  // package visit tells the customer the work happened and is covered, which is
  // exactly the question a zero-total invoice otherwise prompts.
  if (input.timeBilled) {
    // Quantity is the hours and the unit price the rate, so the arithmetic on
    // the page is the arithmetic that set the amount. The total is passed
    // through rather than recomputed so it matches the job to the cent.
    push(
      `${serviceLabel} — ${input.timeBilled.hours} hr @ $${input.timeBilled.hourlyRate.toFixed(2)}/hr`,
      input.timeBilled.hours,
      input.timeBilled.hourlyRate,
      roundMoney(input.serviceAmount),
    );
  } else {
    push(serviceLabel, 1, input.serviceAmount);
  }
  for (const product of input.products) push(product.name, product.quantity, product.price);
  if (input.pendingFees > 0) push("Card processing fee", 1, input.pendingFees);
  // Last, and negative: the customer reads the work, then what came off it.
  // Never more than the bill itself — a discount cannot make an invoice pay
  // the customer.
  if (input.discount && input.discount.amount > 0) {
    const billed = roundMoney(lines.reduce((sum, line) => sum + line.total, 0));
    const off = roundMoney(Math.min(input.discount.amount, Math.max(0, billed)));
    if (off > 0) push(input.discount.label, 1, -off);
  }

  const total = roundMoney(lines.reduce((sum, line) => sum + line.total, 0));

  const notes = [input.serviceName ? `Invoice for ${input.serviceName}` : null, input.note?.trim() || null]
    .filter(Boolean)
    .join(" ");

  const [invoice] = await tx
    .insert(invoicesTable)
    .values({
      clientId: input.clientId,
      jobId: input.jobId,
      // Needs verification first (2026-09-15 walkthrough): he checks what the
      // crew did before a bill goes anywhere. Verify on the Invoices page
      // moves it to open and into the email / print queue.
      status: "pending",
      total,
      number: await nextInvoiceNumber(tx),
      invoiceDate,
      terms,
      dueDate: dueDateFrom(invoiceDate, terms),
      notes: notes || null,
    })
    .returning();

  await tx.insert(invoiceLineItemsTable).values(lines.map((line) => ({ ...line, invoiceId: invoice.id })));

  return invoice;
}
