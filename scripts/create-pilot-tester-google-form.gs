/**
 * Creates a Google Form for SheriaBot pilot tester signups.
 *
 * Run this inside Google Apps Script:
 * https://script.google.com
 */
function createPilotTesterSignupForm() {
  const form = FormApp.create('SheriaBot Pilot Tester Signup');
  form
    .setDescription(
      [
        'SheriaBot is inviting selected fintech founders, compliance teams, legal teams, and regulated financial-service operators in Kenya to join our pilot programme.',
        '',
        "Pilot testers get temporary access to SheriaBot's regulatory intelligence tools, including compliance Q&A, policy generation, gap analysis, checklists, and regulatory alerts.",
        '',
        'Please complete this form if you would like to be considered. We will review your submission and contact selected participants by email.',
      ].join('\n')
    )
    .setConfirmationMessage(
      'Thank you for applying to become a SheriaBot pilot tester. We have received your details and will contact selected applicants by email with next steps.'
    )
    .setCollectEmail(false)
    .setAllowResponseEdits(false)
    .setLimitOneResponsePerUser(false)
    .setProgressBar(true);

  form.addTextItem()
    .setTitle('Full name')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Work email address')
    .setRequired(true)
    .setValidation(
      FormApp.createTextValidation()
        .requireTextIsEmail()
        .setHelpText('Please enter a valid email address.')
        .build()
    );

  form.addTextItem()
    .setTitle('Phone number or WhatsApp number')
    .setRequired(false);

  form.addTextItem()
    .setTitle('Organization or company name')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Your role')
    .setChoiceValues([
      'Founder / CEO',
      'Compliance officer',
      'Legal counsel',
      'Operations / risk lead',
      'Product / technology lead',
      'Regulator / public sector',
      'Consultant / advisor',
    ])
    .showOtherOption(true)
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Organization type')
    .setChoiceValues([
      'Fintech startup',
      'Digital credit provider',
      'Payments / PSP',
      'SACCO / microfinance',
      'Bank / financial institution',
      'Insurtech / insurance',
      'Capital markets / investment',
      'Law firm / consultancy',
      'Regulator / public sector',
    ])
    .showOtherOption(true)
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle('Which regulatory areas are most relevant to you?')
    .setChoiceValues([
      'CBK licensing and supervision',
      'Digital credit provider compliance',
      'Payments and money remittance',
      'AML / CFT and KYC',
      'Data protection and ODPC compliance',
      'Consumer protection',
      'Regulatory sandbox applications',
      'Cybersecurity and operational resilience',
      'Capital markets compliance',
      'Insurance / IRA compliance',
    ])
    .showOtherOption(true)
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('What would you like SheriaBot to help you with during the pilot?')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How soon would you be ready to test SheriaBot?')
    .setChoiceValues([
      'Immediately',
      'Within 1 week',
      'Within 2-4 weeks',
      'Later than 1 month',
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How many people from your team may need pilot access?')
    .setChoiceValues([
      'Just me',
      '2-3 users',
      '4-10 users',
      'More than 10 users',
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Are you willing to share feedback during or after the pilot?')
    .setChoiceValues([
      'Yes, via a short call',
      'Yes, via email or form',
      'Maybe',
      'No',
    ])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How did you hear about SheriaBot?')
    .setChoiceValues([
      'LinkedIn',
      'Referral',
      'Search engine',
      'Event / webinar',
      'Partner / accelerator',
      'Existing contact with SheriaBot',
    ])
    .showOtherOption(true)
    .setRequired(false);

  form.addParagraphTextItem()
    .setTitle('Anything else we should know?')
    .setRequired(false);

  form.addCheckboxItem()
    .setTitle('Consent')
    .setChoiceValues([
      'I agree that SheriaBot may contact me about the pilot programme and process my submitted information for pilot evaluation and onboarding.',
    ])
    .setRequired(true);

  const spreadsheet = SpreadsheetApp.create('SheriaBot Pilot Tester Signup Responses');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, spreadsheet.getId());

  Logger.log('Published form URL: ' + form.getPublishedUrl());
  Logger.log('Edit form URL: ' + form.getEditUrl());
  Logger.log('Responses spreadsheet URL: ' + spreadsheet.getUrl());

  return {
    publishedFormUrl: form.getPublishedUrl(),
    editFormUrl: form.getEditUrl(),
    responsesSpreadsheetUrl: spreadsheet.getUrl(),
  };
}
