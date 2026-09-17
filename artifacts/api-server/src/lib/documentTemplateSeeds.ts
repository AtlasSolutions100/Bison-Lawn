import { db, auditEventsTable, documentTemplatesTable, servicesTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logAudit } from "./helpers";

/**
 * The owner's own documents, transcribed from what he actually sends.
 *
 * Kept verbatim, including his phrasing and his `[token]` spelling. These are
 * not our drafts of his letters — they are his letters, and the value of
 * seeding them is that he opens the app and finds his own words rather than
 * something he has to rewrite before it can go out.
 *
 * Seeded once and marked `isSeeded`, so an edit he makes is never overwritten
 * by a later ship of this file.
 */
export type DocumentCategory = "client" | "marketing" | "estimate";

type Seed = {
  key: string;
  name: string;
  kind: string;
  /**
   * His folders: client (notices and bills to a customer), marketing (goes to
   * everybody), estimate (wraps or chases a quote). The editor tabs and the
   * automation picker group on this, so a seed that lands in the wrong folder
   * is a seed he cannot find.
   */
  category: DocumentCategory;
  /** Matched against the service catalogue by name, case-insensitive substring. */
  serviceMatch?: RegExp;
  subject: string | null;
  body: string;
};

const COMPANY_FOOTER = `Thank you for your business!

[companyaddress]
[companycity], [companystate] [companyzip]

[companyphonenumber] | [companyemail] [companywebsite]`;

const ADDRESS_BLOCK = `[clientname]
[physicaladdress1]
[physicaladdress2]
[physicalcity], [physicalstate] [physicalzip]`;

const SIGN_OFF = `[signatureline]

[companyname]

[companyphonenumber]
[companyemail]`;

/**
 * The contract and payment disclosure he appends below every quote. Held as its
 * own template rather than inlined into the two estimate documents so that
 * changing his late-fee percentage is one edit, not a hunt through every
 * document that happens to quote it.
 */
const CONTRACT_BODY = `Lawn Care Service Contract:

This Agreement is entered into as of the date of accepting the estimate between [companyname], with a business address at [companyaddress], [companycity], [companystate] [companyzip], referred to as the "Service Provider," and the Client, with the address listed above. Both parties hereby agree to the terms and conditions outlined herein for the provision of lawn care services.

Services: The Service Provider agrees to provide lawn care services for the Client as listed in the accepted proposal.

Fees: The Client agrees to pay the Service Provider the agreed-upon fees for the services rendered. The fee structure is outlined in the accepted proposal or as agreed upon separately.

Payment Terms: Payments are due upon receipt of the invoice. Late payments may incur late fees as discussed in the Payment Disclosure below.

Client Responsibilities: The Client shall:
~Provide access to the lawn and any necessary utilities required for the provision of services.
~Inform the Service Provider of any specific requirements or concerns related to the lawn care.

Termination: Either party may terminate this Agreement by providing written notice to the other party within 30 days.

Indemnification: The Client agrees to indemnify and hold harmless the Service Provider against any claims, damages, or liabilities arising out of the Client's negligence or failure to comply with this Agreement.

Governing Law: This Agreement shall be governed by and construed in accordance with the laws of the state where the job is performed.

Entire Agreement: This Agreement constitutes the entire understanding between the Service Provider and the Client and supersedes any prior agreements or understandings.

Signature: In witness whereof, the parties hereto execute this Agreement as of the date the proposal is accepted, until written termination from either party.

Payment Disclosure:

Payment Terms: The client agrees to adhere to the payment terms specified in the agreement. Invoices are sent after the last completed job of the month.

Late Payments: In the event of late payment, a late fee of 3% may be applied to the outstanding balance. Late fees will accrue for each month the payment remains outstanding.

Suspension of Services: Failure to make timely payments may result in the suspension of lawn care services until the outstanding balance, including any accrued late fees, is settled.

Collections Procedures: If payment remains outstanding for 45 days after the due date, the client agrees that the service provider may take necessary actions to collect the overdue amount. This may include engaging a collections agency or pursuing legal means to recover the debt.

Additional Costs: The client shall be responsible for any additional costs incurred by the service provider in the process of collections, including but not limited to collection agency fees, legal fees, and court costs.

Communication: The service provider agrees to communicate with the client regarding any overdue payments before taking further collections action.

Acknowledgment: By agreeing to the proposal of services, the client acknowledges and agrees to the terms outlined in this payment disclosure.`;

export const DOCUMENT_TEMPLATE_SEEDS: Seed[] = [
  {
    key: "aeration-notice",
    name: "Aeration notice",
    kind: "notice",
    category: "client",
    serviceMatch: /aerat/i,
    subject: "Your upcoming aeration | [companyname]",
    body: `${ADDRESS_BLOCK}

Dear [clientfname],

We are scheduled to perform an Aeration on your property _____________. Please make sure all sprinklers are marked that are more than 6" from edge of turf. If your sprinkler system isn't pressurized to check, please let us know.

We would appreciate all animal feces and debris (toys, ext) pickup if possible.

Should you have any inquiries, please feel free to contact us at [companyphonenumber].

Thank you for entrusting us with your business.

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
  {
    key: "mow-care-welcome",
    name: "Mow care welcome",
    kind: "notice",
    category: "client",
    serviceMatch: /mow/i,
    subject: "Your weekly mowing service | [companyname]",
    body: `${ADDRESS_BLOCK}

Dear [clientfname],

We eagerly anticipate our weekly visits to your property. Kindly note that your scheduled mow day will be on Thursday.

To ensure optimal mowing quality for your property, we kindly request that you adjust your sprinkler system accordingly. If assistance is needed in this regard, we are more than happy to schedule a timer adjustment service for you.

As we continue to expand our clientele and enhance our services, there may be occasions when we need to adjust your designated day. Rest assured, we are committed to promptly communicating any changes to you.

We extend our heartfelt gratitude for your patronage and the positive impact you contribute to [companyname]. Your business is invaluable to us, and we welcome any referrals you may provide to your friends and family.

Thank you for entrusting us with your lawn care needs.

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
  {
    key: "estimate-proposal",
    name: "Estimate proposal",
    kind: "estimate_cover",
    category: "estimate",
    subject: "Your estimate from [companyname]",
    body: `${ADDRESS_BLOCK}

Dear [clientfname],

Below, you will find the estimate of services tailored to your property.

To proceed with the services you desire, simply check the box corresponding to each service. Conversely, if there's a service you prefer not to accept, please uncheck the respective box.

Once you have made your selections, kindly indicate your approval by clicking the "Accept Proposal" button below.

Please note that while this estimate is provided with careful consideration, it remains subject to change based on any additional services or adjustments you may require. Our unwavering commitment to transparent pricing and exceptional service is upheld for all our valued customers.

We are genuinely excited about the opportunity to collaborate with you and ensure the health and beauty of your lawn.

Thank you once again for considering [companyname].

${SIGN_OFF}

[Bison_Full_Service]

Total Estimated Cost: [quotetotal]`,
  },
  {
    key: "sprinkler-repair-proposal",
    name: "Sprinkler repair proposal",
    kind: "estimate_cover",
    category: "estimate",
    serviceMatch: /sprinkler|irrigation/i,
    subject: "Your irrigation system estimate | [companyname]",
    body: `${ADDRESS_BLOCK}

Dear [clientfname],

Thank you for entrusting us with the responsibility of turning on your sprinklers this season.

As part of our service, we conduct a thorough inspection of your irrigation system to ensure everything is operating efficiently.

During our inspection, we identified some issues that require attention, and we are pleased to offer our assistance in resolving them.

Attached, you will find an estimate detailing the cost of addressing the issues we identified.

To proceed with the services you desire, simply check the box corresponding to each service. Conversely, if there's a service you prefer not to accept, please uncheck the respective box.

Once you have made your selections, kindly indicate your approval by clicking the "Accept Proposal" button below.

Thank you for considering us for your irrigation system maintenance needs.

We are committed to providing you with prompt and professional service to ensure the continued functionality of your sprinkler system.

${SIGN_OFF}

[Estimate_Bundle:_Estimate_Description_Only]

Total Estimated Cost: [quotetotal]`,
  },
  {
    key: "service-contract",
    name: "Service contract and payment disclosure",
    kind: "contract",
    category: "estimate",
    subject: null,
    body: CONTRACT_BODY,
  },

  // ---- the rest of his document list, from the 2026-09-15 walkthrough ----
  // Named as he names them in Service Autopilot so he recognises each one.
  // The bodies are our first drafts in his voice; every one is editable and
  // none is used by anything until he turns the matching automation on.
  {
    key: "bison-bill",
    name: "Bison Bill",
    kind: "notice",
    category: "client",
    subject: "Invoice #[invoicenumber] from [companyname]",
    body: `${ADDRESS_BLOCK}

Dear [clientfname],

Thank you for your business! Your invoice #[invoicenumber], dated [invoicedate], is attached.

Amount due: [invoicebalance]
Due date: [invoiceduedate]

You can pay by check, card, or online. Please put your invoice number on your payment so we can apply it to the right account.

Payment Disclosure: Invoices are sent after the last completed job of the month. Late payments may incur a late fee of 3% per month on the outstanding balance, and service may be paused until the balance is settled. If you have any questions about this bill, just reply to this email or call us at [companyphonenumber].

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
  {
    key: "past-due",
    name: "Past Due",
    kind: "notice",
    category: "client",
    subject: "Past due: invoice #[invoicenumber] | [companyname]",
    body: `${ADDRESS_BLOCK}

Dear [clientfname],

This is a friendly reminder that invoice #[invoicenumber] for [invoicebalance] was due on [invoiceduedate] and is now [daysoverdue] days past due.

If you have already sent payment, thank you — please disregard this notice. If not, we would appreciate payment at your earliest convenience. You can pay by check, card, or online, and please include your invoice number.

If something about this bill looks wrong, or you need to make arrangements, please reply to this email or call us at [companyphonenumber]. We are happy to work with you.

Thank you for your business.

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
  {
    key: "final-notice",
    name: "Final Notice",
    kind: "notice",
    category: "client",
    subject: "Final notice: invoice #[invoicenumber] | [companyname]",
    body: `${ADDRESS_BLOCK}

Dear [clientfname],

This is our final notice for invoice #[invoicenumber] in the amount of [invoicebalance], which was due on [invoiceduedate] and is now [daysoverdue] days past due.

Per our payment disclosure, a late fee of 3% may be applied to the outstanding balance for each month it remains unpaid, and service may be suspended until the balance is settled. If payment is not received within 10 days of this notice, the account may be referred for collections, and any collection costs become the responsibility of the account holder.

We would much rather sort this out with you directly. Please send payment, or reply to this email or call us at [companyphonenumber] to make arrangements.

Thank you,

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
  {
    key: "sprinkler-blowout-day",
    name: "Sprinkler Blow Out Day",
    kind: "notice",
    category: "client",
    serviceMatch: /blow.?out|winteriz/i,
    subject: "Your sprinkler blow out is scheduled | [companyname]",
    body: `${ADDRESS_BLOCK}

Dear [clientfname],

Your sprinkler blow out is scheduled for [servicedate].

You do not need to be home. Please make sure we can reach your backflow and the shut-off, and that your timer is set to OFF before we arrive. If your system is inside a locked area, let us know how to get in.

If that day does not work, or your system has already been blown out, please reply to this email or call us at [companyphonenumber] as soon as you can.

Thank you for entrusting us with your business.

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
  {
    key: "welcome-to-the-herd",
    name: "Welcome to The Herd",
    kind: "notice",
    category: "client",
    subject: "Welcome to the herd! | [companyname]",
    body: `${ADDRESS_BLOCK}

Dear [clientfname],

Welcome to the herd! We are glad to have you as a [companyname] customer.

Here is what to expect: we will email you before each visit that needs anything from you, invoices go out after the last completed job of the month, and you can always reach the office at [companyphonenumber] or [companyemail] with questions.

If you ever have a concern about a visit, tell us right away and we will make it right. And if you know someone who could use a hand with their lawn, we would be grateful for the referral.

Thank you for choosing us.

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
  {
    key: "estimate-follow-up",
    name: "Estimate Follow up",
    kind: "notice",
    category: "estimate",
    subject: "Following up on your estimate | [companyname]",
    body: `Dear [clientfname],

We sent over an estimate for your property on [estimatesentdate] and wanted to make sure it reached you.

If you have any questions about the services or the pricing, we are happy to walk through it with you. To accept, just use the link in the estimate email and check the services you would like.

Thank you for considering [companyname].

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
  {
    key: "dont-forget-us",
    name: "Don't Forget Us",
    kind: "notice",
    category: "estimate",
    subject: "Don't forget us! | [companyname]",
    body: `Dear [clientfname],

Just checking in one more time on the estimate we sent on [estimatesentdate].

Our schedule fills up fast this time of year, so if you would like to get on the calendar, now is a great time. If the timing is not right, no problem at all — just let us know and we will check back with you later in the season.

Either way, thank you for thinking of [companyname].

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
  {
    key: "spring-letter",
    name: "Spring Letter",
    kind: "notice",
    category: "marketing",
    subject: "Spring is here | [companyname]",
    body: `Dear [clientfname],

Spring is here and the herd is back out on the lawns!

Now is the time to get on the schedule for sprinkler turn-ons, backflow tests, spring clean-ups and aeration. Mowing starts as soon as the grass does. If your services from last year should carry over the same way, you do not need to do anything — we will reach out with your dates.

If you want to add, change or drop a service this season, reply to this email or call us at [companyphonenumber].

Thank you for another season with us.

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
  {
    key: "turn-up-your-sprinklers",
    name: "Turn Up Your Sprinklers",
    kind: "notice",
    category: "marketing",
    subject: "Time to turn up your sprinklers | [companyname]",
    body: `Dear [clientfname],

The heat is here. Lawns in our area need more water from now through August than the spring setting gives them, so this is a good week to turn up your sprinkler timer.

A good rule of thumb is about an inch to an inch and a half of water per week, split across early-morning runs. If you are seeing brown patches, footprints that stay in the grass, or a bluish tint, it is thirsty.

If you would like us to adjust the timer for you, or check a zone that is not covering, reply to this email or call us at [companyphonenumber] and we will get you on the schedule.

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
  {
    key: "fall-notice",
    name: "Fall Notice",
    kind: "notice",
    category: "marketing",
    subject: "Fall is coming — blow outs and fall services | [companyname]",
    body: `Dear [clientfname],

Fall is coming, and with it the first freeze. Sprinkler blow outs start in the next few weeks, and everyone on the blow-out list will get an email with their day.

If you are not on the list yet and want to be, or you would like fall aeration, a fall clean-up, or a final fertilizer application, reply to this email or call us at [companyphonenumber] so we can get you on the schedule before the freeze.

Thank you for a great season.

${SIGN_OFF}

${COMPANY_FOOTER}`,
  },
];

/**
 * Insert any seed template that is not already present, matching it to a
 * service where its name implies one.
 *
 * Keyed on `key`, so re-running is a no-op and a template the office deleted
 * on purpose does come back — which is the right trade for a document library:
 * losing his aeration letter is worse than an unwanted row he can delete again.
 */
export async function ensureDocumentTemplates(): Promise<number> {
  const services = await db
    .select({ id: servicesTable.id, name: servicesTable.name })
    .from(servicesTable);

  await backfillSeedCategories();

  let inserted = 0;
  for (const seed of DOCUMENT_TEMPLATE_SEEDS) {
    const [existing] = await db
      .select({ id: documentTemplatesTable.id })
      .from(documentTemplatesTable)
      .where(eq(documentTemplatesTable.key, seed.key))
      .limit(1);
    if (existing) continue;

    const match = seed.serviceMatch
      ? services.find((s) => seed.serviceMatch!.test(s.name))
      : undefined;

    await db.insert(documentTemplatesTable).values({
      key: seed.key,
      name: seed.name,
      kind: seed.kind,
      serviceId: match?.id ?? null,
      subject: seed.subject,
      body: seed.body,
      isSeeded: true,
      category: seed.category,
      updatedAt: sql`now()`,
    });
    inserted += 1;
  }
  return inserted;
}

const CATEGORY_BACKFILL_MARKER = "document_template_categories_backfilled";

/**
 * The five original seeds went in before templates had folders, so every one
 * of them sits in "client" — including the two estimate documents and the
 * contract. Move those once. Marked in the audit trail rather than re-run on
 * every start, because after the first pass a seeded template's folder is his
 * to choose, and a restart must not keep putting it back.
 */
async function backfillSeedCategories(): Promise<void> {
  const [done] = await db
    .select({ id: auditEventsTable.id })
    .from(auditEventsTable)
    .where(eq(auditEventsTable.action, CATEGORY_BACKFILL_MARKER))
    .limit(1);
  if (done) return;

  for (const seed of DOCUMENT_TEMPLATE_SEEDS) {
    if (seed.category === "client") continue;
    await db
      .update(documentTemplatesTable)
      .set({ category: seed.category })
      .where(
        and(
          eq(documentTemplatesTable.key, seed.key),
          eq(documentTemplatesTable.isSeeded, true),
          eq(documentTemplatesTable.category, "client"),
        ),
      );
  }
  await logAudit({
    action: CATEGORY_BACKFILL_MARKER,
    description: "Sorted the built-in documents into the client / marketing / estimate folders",
  });
}

let ensuredThisProcess: Promise<number> | null = null;

/**
 * Run the seed once per server process, and share the one run between callers.
 *
 * A fresh install used to have no templates at all until someone ran the demo
 * seed — so his own letters were missing from the very screen built to show
 * them. Startup and the first list request both call this; whichever arrives
 * first does the work and the other waits on the same promise, so the seeds
 * cannot race each other into duplicate keys.
 */
export function ensureDocumentTemplatesOnce(): Promise<number> {
  if (!ensuredThisProcess) {
    ensuredThisProcess = ensureDocumentTemplates().catch((err) => {
      // Let the next caller try again rather than pinning a failure for the
      // life of the process.
      ensuredThisProcess = null;
      throw err;
    });
  }
  return ensuredThisProcess;
}
