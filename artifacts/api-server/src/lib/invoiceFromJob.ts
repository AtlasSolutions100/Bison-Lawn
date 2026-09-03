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
  /** Date-only string for the visit, used as each line's service date. */
  serviceDate?: string | null;
  products: { name: string; price: number; quantity: number }[];
  /** Card surcharges from payments taken before completion. */
  pendingFees: number;
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

  const push = (description: string, quantity: number, unitPrice: number) => {
    lines.push({
      description,
      serviceDate: invoiceDate,
      quantity,
      unitPrice,
      total: roundMoney(quantity * unitPrice),
      sortOrder: lines.length,
    });
  };

  // The service itself is a line even when the amount is zero — a $0 line on a
  // package visit tells the customer the work happened and is covered, which is
  // exactly the question a zero-total invoice otherwise prompts.
  push(input.serviceName ?? "Service", 1, input.serviceAmount);
  for (const product of input.products) push(product.name, product.quantity, product.price);
  if (input.pendingFees > 0) push("Card processing fee", 1, input.pendingFees);

  const total = roundMoney(lines.reduce((sum, line) => sum + line.total, 0));

  const [invoice] = await tx
    .insert(invoicesTable)
    .values({
      clientId: input.clientId,
      jobId: input.jobId,
      total,
      number: await nextInvoiceNumber(tx),
      invoiceDate,
      terms,
      dueDate: dueDateFrom(invoiceDate, terms),
      notes: input.serviceName ? `Invoice for ${input.serviceName}` : null,
    })
    .returning();

  await tx.insert(invoiceLineItemsTable).values(lines.map((line) => ({ ...line, invoiceId: invoice.id })));

  return invoice;
}
