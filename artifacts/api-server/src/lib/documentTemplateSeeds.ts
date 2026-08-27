import { db, documentTemplatesTable, servicesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

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
type Seed = {
  key: string;
  name: string;
  kind: string;
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
    subject: null,
    body: CONTRACT_BODY,
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
      updatedAt: sql`now()`,
    });
    inserted += 1;
  }
  return inserted;
}
