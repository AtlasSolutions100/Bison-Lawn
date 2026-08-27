import { LegalDocument, Section } from '@/components/legal/legal-document';

export default function Privacy() {
  return (
    <LegalDocument title="Privacy Policy" effectiveDate="August 27, 2026">
      <p>
        This policy covers the Bison Lawn Care customer and job management
        application at bisonlawncare.workoptional.tech ("the Application"),
        operated by Bison Lawn Care LLC ("we", "us").
      </p>

      <Section heading="Who uses this application">
        <p>
          The Application is an internal business tool. Its accounts belong to
          Bison Lawn Care staff and subcontractors. Our customers do not have
          accounts and do not sign in; they interact with us only by receiving
          email we send from the Application and, for estimates, by clicking an
          accept or decline link in that email.
        </p>
      </Section>

      <Section heading="Information we hold about our customers">
        <p>
          Staff enter and maintain customer records so we can quote, schedule,
          perform, and bill for lawn care work. Those records may include name,
          service address, email address, phone number, property details
          relevant to pricing (for example turf square footage or number of
          sprinkler zones), access notes such as a gate code, service history,
          invoices, and payments.
        </p>
        <p>
          This information comes from our customers themselves — by phone, by
          email, through our website's contact form, or in person — and from our
          own crews recording the work performed.
        </p>
      </Section>

      <Section heading="How we use it">
        <p>
          To run the business: producing estimates, scheduling and routing work,
          recording what was done, issuing invoices, recording payments, and
          corresponding with customers about their service.
        </p>
        <p>
          We do not sell customer information. We do not use it for advertising,
          and we do not share it with third parties except the service providers
          described below, or where we are required to by law.
        </p>
      </Section>

      <Section heading="Google account data">
        <p>
          The Application sends email — estimates, seasonal letters, and service
          notices — from a Google account belonging to Bison Lawn Care. To do
          this, an owner signs in with Google and grants a single permission:
        </p>
        <p className="rounded-md border bg-muted/40 px-4 py-3 font-mono text-sm">
          https://www.googleapis.com/auth/gmail.send
        </p>
        <p>
          That scope allows sending mail and nothing else. The Application
          <strong> cannot read, search, download, modify, or delete any message
          in that mailbox</strong>, and it does not request any scope that would
          allow it to. We request no access to Google Contacts, Drive, Calendar,
          or profile data beyond what is needed to complete sign-in.
        </p>
        <p>
          The authorization token is stored as a configuration secret on our own
          server and is used only to send mail on our behalf. It is never shared
          with anyone else, and revoking access at{' '}
          <a
            className="underline underline-offset-2"
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
          >
            myaccount.google.com/permissions
          </a>{' '}
          immediately stops the Application from sending.
        </p>
        <p>
          Our use of information received from Google APIs adheres to the{' '}
          <a
            className="underline underline-offset-2"
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. We do not transfer this data
          to others except as necessary to provide our service, we do not use it
          for advertising, and we do not allow humans to read it except with
          explicit permission from the account owner, for security purposes, to
          comply with applicable law, or where the data is aggregated and
          de-identified.
        </p>
      </Section>

      <Section heading="Service providers">
        <p>
          <strong>Clerk</strong> handles sign-in for staff accounts and stores
          the associated email address and name.
        </p>
        <p>
          <strong>Google (Gmail API)</strong> delivers the email we send, as
          described above.
        </p>
        <p>
          <strong>Our hosting provider</strong> runs the server and database on
          which the Application and its records are stored.
        </p>
        <p>
          Weather forecasts used to suggest rescheduling are retrieved from a
          public forecast service using a service address's approximate
          coordinates. No customer identity is sent with those requests.
        </p>
      </Section>

      <Section heading="Retention and security">
        <p>
          Business records are kept for as long as we need them to service the
          account and to meet our accounting and tax obligations. Access to the
          Application requires an individual sign-in, and staff see only what
          their role permits — subcontractors see the jobs assigned to them,
          not the full customer database.
        </p>
        <p>
          No system is perfectly secure, and we do not claim otherwise. We
          encrypt traffic in transit and limit who can sign in.
        </p>
      </Section>

      <Section heading="Your choices">
        <p>
          If you are a Bison Lawn Care customer and want to know what we hold
          about you, want it corrected, or want it deleted where we are not
          required to keep it, email{' '}
          <a className="underline underline-offset-2" href="mailto:bisonlawncarellc@gmail.com">
            bisonlawncarellc@gmail.com
          </a>{' '}
          and we will respond.
        </p>
      </Section>

      <Section heading="Children">
        <p>
          The Application is a business tool and is not directed to children. We
          do not knowingly collect information from anyone under 13.
        </p>
      </Section>

      <Section heading="Changes">
        <p>
          If this policy changes materially we will update the effective date
          above and, where the change affects how we handle customer
          information, tell affected customers directly.
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
