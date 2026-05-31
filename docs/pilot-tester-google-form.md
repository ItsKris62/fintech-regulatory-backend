# SheriaBot Pilot Tester Signup Google Form

Use this form to collect pilot tester applications before manually provisioning accepted users in the SheriaBot admin pilot dashboard.

## Form Setup

- Title: `SheriaBot Pilot Tester Signup`
- Description:

```text
SheriaBot is inviting selected fintech founders, compliance teams, legal teams, and regulated financial-service operators in Kenya to join our pilot programme.

Pilot testers get temporary access to SheriaBot's regulatory intelligence tools, including compliance Q&A, policy generation, gap analysis, checklists, and regulatory alerts.

Please complete this form if you would like to be considered. We will review your submission and contact selected participants by email.
```

- Confirmation message:

```text
Thank you for applying to become a SheriaBot pilot tester. We have received your details and will contact selected applicants by email with next steps.
```

## Questions

1. Full name
   - Type: Short answer
   - Required: Yes

2. Work email address
   - Type: Short answer
   - Required: Yes
   - Validation: Email address

3. Phone number or WhatsApp number
   - Type: Short answer
   - Required: No

4. Organization or company name
   - Type: Short answer
   - Required: Yes

5. Your role
   - Type: Multiple choice
   - Required: Yes
   - Options:
     - Founder / CEO
     - Compliance officer
     - Legal counsel
     - Operations / risk lead
     - Product / technology lead
     - Regulator / public sector
     - Consultant / advisor
     - Other

6. Organization type
   - Type: Multiple choice
   - Required: Yes
   - Options:
     - Fintech startup
     - Digital credit provider
     - Payments / PSP
     - SACCO / microfinance
     - Bank / financial institution
     - Insurtech / insurance
     - Capital markets / investment
     - Law firm / consultancy
     - Regulator / public sector
     - Other

7. Which regulatory areas are most relevant to you?
   - Type: Checkboxes
   - Required: Yes
   - Options:
     - CBK licensing and supervision
     - Digital credit provider compliance
     - Payments and money remittance
     - AML / CFT and KYC
     - Data protection and ODPC compliance
     - Consumer protection
     - Regulatory sandbox applications
     - Cybersecurity and operational resilience
     - Capital markets compliance
     - Insurance / IRA compliance
     - Other

8. What would you like SheriaBot to help you with during the pilot?
   - Type: Paragraph
   - Required: Yes

9. How soon would you be ready to test SheriaBot?
   - Type: Multiple choice
   - Required: Yes
   - Options:
     - Immediately
     - Within 1 week
     - Within 2-4 weeks
     - Later than 1 month

10. How many people from your team may need pilot access?
    - Type: Multiple choice
    - Required: Yes
    - Options:
      - Just me
      - 2-3 users
      - 4-10 users
      - More than 10 users

11. Are you willing to share feedback during or after the pilot?
    - Type: Multiple choice
    - Required: Yes
    - Options:
      - Yes, via a short call
      - Yes, via email or form
      - Maybe
      - No

12. How did you hear about SheriaBot?
    - Type: Multiple choice
    - Required: No
    - Options:
      - LinkedIn
      - Referral
      - Search engine
      - Event / webinar
      - Partner / accelerator
      - Existing contact with SheriaBot
      - Other

13. Anything else we should know?
    - Type: Paragraph
    - Required: No

14. Consent
    - Type: Checkboxes
    - Required: Yes
    - Options:
      - I agree that SheriaBot may contact me about the pilot programme and process my submitted information for pilot evaluation and onboarding.

## Creating The Form

The companion Apps Script at `fintech-regulatory-backend/scripts/create-pilot-tester-google-form.gs` creates the Google Form and a linked response spreadsheet automatically.

1. Open https://script.google.com in the Google account that should own the form.
2. Create a new Apps Script project.
3. Paste the contents of `fintech-regulatory-backend/scripts/create-pilot-tester-google-form.gs`.
4. Click `Run` on `createPilotTesterSignupForm`.
5. Approve the requested Google Forms and Sheets permissions.
6. Open `Executions` or `Logs` to copy the published form URL and spreadsheet URL.
