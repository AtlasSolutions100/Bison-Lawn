import { LegalDocument, Section } from '@/components/legal/legal-document';

export default function Terms() {
  return (
    <LegalDocument title="Terms of Service" effectiveDate="August 27, 2026">
      <p>
        These terms govern use of the Bison Lawn Care customer and job
        management application at bisonlawncare.workoptional.tech ("the
        Application"), operated by Bison Lawn Care LLC ("we", "us").
      </p>

      <Section heading="Who may use it">
        <p>
          The Application is a private business tool, not a public service.
          Accounts are issued to Bison Lawn Care staff and to subcontractors
          performing work for us. There is no public sign-up that grants access
          to business data: a new account has no access to customer records
          until an owner grants it.
        </p>
        <p>
          If you have been given an account, you may use it only for Bison Lawn
          Care business, and you are responsible for what happens under it. Do
          not share your sign-in with anyone.
        </p>
      </Section>

      <Section heading="Customer information">
        <p>
          Customer records in the Application are confidential business
          information. If your account can see them, you may use them only to do
          the work you have been assigned. Do not copy, export, or retain them
          for any other purpose, and do not use them to contact customers for
          anything unrelated to the work.
        </p>
      </Section>

      <Section heading="Estimates and invoices sent from the Application">
        <p>
          An estimate emailed from the Application is an offer to perform the
          work described, at the stated price, on the terms discussed with the
          customer. Accepting it through the link in the email records the
          customer's approval. Prices in an estimate may be revised if the
          property differs materially from the details it was based on — for
          example if the measured area or number of sprinkler zones is not what
          was recorded.
        </p>
        <p>
          Invoices are due on the terms stated on the invoice. Nothing in the
          Application changes the underlying service agreement between Bison
          Lawn Care and its customer.
        </p>
      </Section>

      <Section heading="Scheduling">
        <p>
          Scheduled dates are targets, not guarantees. Work is routinely moved
          for weather, equipment, and access. Where the Application suggests
          rescheduling based on a forecast, that suggestion is reviewed by a
          person before any customer is notified.
        </p>
      </Section>

      <Section heading="Availability">
        <p>
          We provide the Application as-is and do not promise it will be
          available without interruption. We may change, suspend, or discontinue
          any part of it. We will avoid doing so in a way that loses business
          records.
        </p>
      </Section>

      <Section heading="Acceptable use">
        <p>
          Do not attempt to access accounts or data you have not been granted,
          probe or disrupt the service, or use it to send anything unlawful or
          misleading. We may suspend an account that does.
        </p>
      </Section>

      <Section heading="Limitation of liability">
        <p>
          To the extent permitted by law, Bison Lawn Care LLC is not liable for
          indirect or consequential losses arising from use of the Application.
          This does not limit our obligations to our customers under the service
          agreements we have with them.
        </p>
      </Section>

      <Section heading="Changes to these terms">
        <p>
          We may update these terms. The effective date above will change when
          we do, and continued use of the Application after that date means the
          updated terms apply.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          Bison Lawn Care LLC —{' '}
          <a className="underline underline-offset-2" href="mailto:bisonlawncarellc@gmail.com">
            bisonlawncarellc@gmail.com
          </a>
        </p>
      </Section>
    </LegalDocument>
  );
}
