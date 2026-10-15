/**
 * Safe synthetic pilot policies for controlled Gap Analysis validation across jurisdictions.
 * Synthetic test fixtures only — NO customer confidential data.
 */

export interface SyntheticPolicyFixture {
  jurisdiction: 'KE' | 'RW' | 'MW' | 'NG';
  frameworkSlug: string;
  name: string;
  type: 'PARTIALLY_ALIGNED' | 'DELIBERATE_GAPS' | 'AMBIGUOUS';
  description: string;
  content: string;
}

export const PILOT_SYNTHETIC_POLICIES: SyntheticPolicyFixture[] = [
  // =========================================================================
  // KENYA (KE) — Framework: dpa-2019 (Data Protection Act 2019)
  // =========================================================================
  {
    jurisdiction: 'KE',
    frameworkSlug: 'dpa-2019',
    name: 'RafikiPay Kenya Data Protection & Privacy Policy',
    type: 'PARTIALLY_ALIGNED',
    description: 'Aligned fintech policy with explicit DPO, 72h breach notification, consent, lawful bases, and subject access rights.',
    content: `# RafikiPay Kenya Limited — Customer Data Protection & Privacy Policy

1. PRINCIPLES OF DATA PROCESSING
RafikiPay Kenya processes personal data in accordance with the principles set out in Section 3 of the Kenya Data Protection Act, 2019:
- Lawfulness, fairness, and transparency: Personal data is collected only with valid legal bases, including explicit data subject consent and performance of contracts.
- Purpose limitation: Data collected for digital wallet and payments processing shall not be repurposed without additional authorization.
- Data minimization: Only personal identity, MSISDN, and KYC data necessary for transaction processing are collected.
- Accuracy: Data subjects maintain the right to rectify inaccurate or incomplete records without undue delay.
- Storage limitation: Transactional data is retained for 7 years to satisfy statutory anti-money laundering requirements and subsequently anonymized.
- Integrity and confidentiality: Strong encryption in transit (TLS 1.3) and at rest (AES-256) protects all customer data.

2. DATA PROTECTION OFFICER (DPO)
In compliance with Section 24 of the Act, RafikiPay has designated a Data Protection Officer:
Email: dpo@rafikipay.co.ke | Physical Office: Nairobi, Kenya.
The DPO reports directly to the Board of Directors and monitors regulatory compliance with the Office of the Data Protection Commissioner (ODPC).

3. DATA SUBJECT RIGHTS
Customers may exercise their statutory rights under the Data Protection Act:
- Right to be informed of the collection and processing of personal data.
- Right of access to personal data held by RafikiPay.
- Right to object to processing for direct marketing.
- Right to erasure (deletion) of personal data where no legal retention requirement exists.
- Right to data portability in structured, machine-readable format.

4. DATA BREACH NOTIFICATION
In the event of a personal data breach impacting customer rights:
- RafikiPay notifies the Office of the Data Protection Commissioner (ODPC) within 72 hours of becoming aware of the breach.
- Affected data subjects are notified immediately where there is a high risk to their rights and freedoms.

5. CROSS-BORDER DATA TRANSFERS
Personal data is processed primarily within servers hosted in Kenya. Any cross-border data transfer complies with Section 48 of the Act, requiring adequate proof of safeguards or consent from the data subject.
`,
  },
  {
    jurisdiction: 'KE',
    frameworkSlug: 'dpa-2019',
    name: 'RafikiPay Kenya Quick Terms',
    type: 'DELIBERATE_GAPS',
    description: 'Fintech policy with deliberate omissions: no DPO, no breach notification to ODPC, and unconstrained cross-border data transfer.',
    content: `# RafikiPay Kenya — Terms & Data Usage

1. DATA COLLECTION
We collect your name, phone number, and transaction records when you use our mobile payment application.

2. DATA SHARING
We may transfer, sell, or share customer information with global marketing partners, credit agencies, and offshore server facilities at our sole discretion without notice.

3. RETENTION
Customer data is stored indefinitely for analytics, business intelligence, and future credit scoring.

4. WITHDRAWAL
You cannot withdraw consent once you download our app.
`,
  },
  {
    jurisdiction: 'KE',
    frameworkSlug: 'dpa-2019',
    name: 'RafikiPay Kenya General Privacy Statement',
    type: 'AMBIGUOUS',
    description: 'Vague generic policy lacking specific operational commitments under the Data Protection Act 2019.',
    content: `# RafikiPay Kenya — Privacy Statement

We value your privacy. We process personal information in a safe manner as permitted by applicable laws.
We implement reasonable technical and organizational measures to ensure your data is secure.
If you have questions about your privacy, contact our general customer care support team.
`,
  },

  // =========================================================================
  // RWANDA (RW) — Framework: rw-dpa-2021 (Law N° 058/2021 on Personal Data)
  // =========================================================================
  {
    jurisdiction: 'RW',
    frameworkSlug: 'rw-dpa-2021',
    name: 'KigaliFin Rwanda Data Privacy & Security Policy',
    type: 'PARTIALLY_ALIGNED',
    description: 'Aligned policy under Rwanda Law N° 058/2021 with NCSA registration, 48h breach notification, and data subject rights.',
    content: `# KigaliFin Technologies Rwanda — Personal Data Protection Policy

1. STATUTORY COMPLIANCE & LEGAL BASIS
KigaliFin Technologies operates as a registered data controller and processor in Rwanda under Law N° 058/2021 of 13/10/2021 relating to the protection of personal data and privacy.
All personal data is processed lawfully based on:
- Freely given, specific, informed, and unambiguous consent of the data subject (Article 17);
- Performance of digital financial services contracts;
- Compliance with legal obligations under National Bank of Rwanda (BNR) regulations.

2. RIGHTS OF THE DATA SUBJECT
In accordance with Chapter III (Articles 18 to 28) of the Law:
- Right to information and transparency prior to processing;
- Right of access to personal data and processing details;
- Right to rectify inaccurate or misleading data within thirty (30) days;
- Right to erasure (right to be forgotten) without undue delay;
- Right to restrict or object to processing;
- Right to data portability in an interoperable format.

3. DATA PROTECTION OFFICER & GOVERNANCE
KigaliFin has appointed an in-country Data Protection Officer registered with the National Cyber Security Authority (NCSA).
Contact: dpo@kigalifin.rw.

4. SECURITY & BREACH NOTIFICATION (48 HOURS)
- Appropriate technical and organisational security measures are deployed, including role-based access control and end-to-end encryption.
- In the event of a personal data breach, KigaliFin notifies the National Cyber Security Authority (NCSA) within forty-eight (48) hours of becoming aware of the breach, pursuant to Article 43.
- When the breach is likely to result in high risk to data subjects, affected individuals are informed without delay.

5. INTERNATIONAL TRANSFERS
Cross-border transfer of personal data outside Rwanda requires prior authorization from the supervisory authority (NCSA) or proof of an adequate level of protection in accordance with Article 48.
`,
  },
  {
    jurisdiction: 'RW',
    frameworkSlug: 'rw-dpa-2021',
    name: 'KigaliFin Rwanda Legacy Privacy Notice',
    type: 'DELIBERATE_GAPS',
    description: 'Policy with deliberate gaps: fails to establish 48-hour NCSA breach notification, lacks international transfer authorizations, and omits DPO.',
    content: `# KigaliFin Rwanda — Legacy Privacy Notice

1. COLLECTION
We collect user identification numbers and telephone records to facilitate digital remittances.

2. SECURITY
Our engineering team applies password protection to databases. If an incident occurs, we will resolve it internally within a reasonable timeframe.

3. THIRD PARTIES
We may send your data to overseas cloud service providers across Europe and Asia at our convenience.
`,
  },
  {
    jurisdiction: 'RW',
    frameworkSlug: 'rw-dpa-2021',
    name: 'KigaliFin Rwanda App Notice',
    type: 'AMBIGUOUS',
    description: 'Ambiguous policy with insufficient specification under Rwanda Law N° 058/2021.',
    content: `# KigaliFin App Privacy Notice

We collect basic account details to enable payments in Rwanda. We respect user privacy and do not sell data without good reason.
For concerns regarding data privacy, please write to our support desk.
`,
  },

  // =========================================================================
  // MALAWI (MW) — Framework: mw-cybersecurity-2016 (Electronic Transactions & Cyber Security Act)
  // =========================================================================
  {
    jurisdiction: 'MW',
    frameworkSlug: 'mw-cybersecurity-2016',
    name: 'LakePay Malawi Electronic Transactions & Cyber Security Governance Policy',
    type: 'PARTIALLY_ALIGNED',
    description: 'Aligned fintech policy under Malawi Electronic Transactions and Cyber Security Act 2016 covering risk management, MACRA reporting, and electronic signature integrity.',
    content: `# LakePay Malawi Limited — Electronic Transactions & Cyber Security Governance Policy

1. REGULATORY BASIS & SCOPE
This Policy governs all electronic communications, consumer transactions, and digital payment operations conducted by LakePay Malawi Limited in compliance with the Electronic Transactions and Cyber Security Act, 2016 (Act No. 33 of 2016).

2. ELECTRONIC TRANSACTIONS & SIGNATURE INTEGRITY
Pursuant to Part IV of the Act:
- LakePay recognizes secure electronic signatures and electronic records as having full legal effect and admissibility.
- Cryptographic verification protocols ensure message integrity, non-repudiation, and authentication of financial transfers.

3. CONSUMER PROTECTION & COMMERCIAL COMMUNICATIONS
Under Part VI of the Act:
- LakePay provides consumers with clear, accurate information regarding transaction fees, terms of service, and refund procedures prior to transaction finalization.
- Unsolicited commercial communications (opt-out mechanisms) are strictly enforced; customers may opt out of promotional messages at any time without fee.

4. CYBERSECURITY RISK MANAGEMENT & INCIDENT NOTIFICATION
In adherence to cybersecurity standards supervised by the Malawi Communications Regulatory Authority (MACRA):
- LakePay maintains an operational security operations center (SOC) with intrusion detection, multi-factor authentication, and segmented network architecture.
- Critical cybersecurity incidents, unauthorized system access, or significant service disruptions are reported to MACRA and the National Computer Emergency Response Team (CERT) within 24 hours of detection.

5. PROTECTION OF PERSONAL DATA IN ELECTRONIC TRANSACTIONS
Pursuant to Part VIII:
- Personal data collected electronically is processed fairly and lawfully with customer consent.
- Personal information is safeguarded against unlawful access, alteration, destruction, or disclosure.

6. PROHIBITED CONDUCT & COMPUTER OFFENCES
Under Part XI, strict access governance prevents unauthorized access, data interference, denial of service, and cyber fraud. Suspected criminal interference is escalated to law enforcement authorities.
`,
  },
  {
    jurisdiction: 'MW',
    frameworkSlug: 'mw-cybersecurity-2016',
    name: 'LakePay Malawi Digital Terms',
    type: 'DELIBERATE_GAPS',
    description: 'Policy with deliberate gaps: no incident reporting to MACRA/CERT, no secure signature validation, and lacks cyber risk controls.',
    content: `# LakePay Malawi — Terms of Service

1. TRANSACTIONS
Users may send money electronically. We are not responsible for message tampering or transmission errors.

2. CYBERSECURITY
Users assume all risks associated with internet transactions, phishing, and malware. We do not report internal security failures to external regulators.
`,
  },
  {
    jurisdiction: 'MW',
    frameworkSlug: 'mw-cybersecurity-2016',
    name: 'LakePay Malawi Basic IT Guidelines',
    type: 'AMBIGUOUS',
    description: 'Vague IT statement with ambiguous controls under Malawi cyber law.',
    content: `# LakePay Malawi — IT Guidelines

LakePay strives to maintain secure systems for our electronic services in Malawi.
Users should use strong passwords and keep their devices safe.
`,
  },

  // =========================================================================
  // NIGERIA (NG) — Framework: ndpa-2023 (Nigeria Data Protection Act 2023)
  // =========================================================================
  {
    jurisdiction: 'NG',
    frameworkSlug: 'ndpa-2023',
    name: 'NaijaPay Nigeria Data Governance & Privacy Policy',
    type: 'PARTIALLY_ALIGNED',
    description: 'Aligned policy under Nigeria Data Protection Act (NDPA) 2023 with Section 24 principles, 72h NDPC breach notification, DPO, and cross-border safeguards.',
    content: `# NaijaPay Limited — Comprehensive Data Protection & Governance Policy

1. PRINCIPLES OF DATA PROCESSING (SECTION 24, NDPA 2023)
NaijaPay Limited processes personal data strictly in compliance with the Nigeria Data Protection Act, 2023:
- Lawfulness, fairness, and transparency: Data is collected only where lawful bases exist under Section 25 (consent, contractual necessity, legal obligation, or legitimate interest).
- Purpose limitation: Personal data collected for payments, credit underwriting, and KYC shall not be processed for incompatible purposes.
- Data adequacy and minimization: Only data strictly necessary for provision of licensed financial services is collected.
- Accuracy: Systems maintain accurate records with data subject mechanisms for correction.
- Storage limitation: Data is retained only for the duration required by statutory mandates (CBN guidelines and Money Laundering Prevention Act) and securely erased thereafter.
- Integrity and confidentiality: High-grade encryption, role-based access control, and vulnerability management prevent unauthorized processing.

2. DATA PROTECTION OFFICER (DPO) (SECTION 32)
As a Data Controller of Major Importance under Nigerian law, NaijaPay has designated a qualified Data Protection Officer:
Contact: dpo@naijapay.ng | Lagos, Nigeria.
The DPO liaises with the Nigeria Data Protection Commission (NDPC) and monitors continuous compliance.

3. DATA SUBJECT RIGHTS (SECTION 34)
Data subjects enjoy enforceable statutory rights:
- Right to confirm whether personal data is being processed;
- Right of access to personal data and details of processing;
- Right to rectification of inaccurate or incomplete data;
- Right to erasure (deletion) without undue delay;
- Right to restrict or object to processing, including automated decision-making and profiling;
- Right to data portability.

4. DATA BREACH MANAGEMENT & NOTIFICATION (SECTION 40)
Where a personal data breach occurs that is likely to result in a risk to data subjects:
- NaijaPay notifies the Nigeria Data Protection Commission (NDPC) within seventy-two (72) hours of becoming aware of the breach.
- Affected data subjects are informed immediately when the breach poses a high risk to their rights and freedoms.

5. CROSS-BORDER DATA TRANSFERS (SECTION 41-43)
Personal data is stored primarily within data centers in the Federal Republic of Nigeria. Any transfer to foreign jurisdictions must satisfy NDPA transfer criteria (adequacy decisions, standard contractual clauses, or explicit consent).
`,
  },
  {
    jurisdiction: 'NG',
    frameworkSlug: 'ndpa-2023',
    name: 'NaijaPay Nigeria Merchant Terms',
    type: 'DELIBERATE_GAPS',
    description: 'Policy with deliberate gaps: fails to establish 72-hour NDPC notification, omits DPO appointment, and claims unrestricted transfer of Nigerian personal data.',
    content: `# NaijaPay Nigeria — Merchant Processing Terms

1. DATA SHARING
Merchant and customer transaction records may be shared with overseas marketing syndicates and analytics vendors without restriction.

2. DPO & REGISTRATION
NaijaPay does not maintain a designated Data Protection Officer and is not subject to external data commission oversight.

3. INCIDENTS
In the event of a database compromise or ransomware incident, NaijaPay reserves the right to withhold notification to regulatory agencies.
`,
  },
  {
    jurisdiction: 'NG',
    frameworkSlug: 'ndpa-2023',
    name: 'NaijaPay Nigeria Short Privacy Notice',
    type: 'AMBIGUOUS',
    description: 'Ambiguous policy lacking specific statutory mechanisms under NDPA 2023.',
    content: `# NaijaPay Nigeria — Privacy Notice

We take privacy seriously for all our Nigerian users. We collect information to deliver our financial products.
We comply with general privacy standards and implement reasonable computer security.
`,
  },
];

/**
 * Deep-only synthetic fixtures deliberately combine aligned language, gaps,
 * ambiguity, a direct internal contradiction, and absent implementation
 * evidence. They contain no customer data.
 */
export const DEEP_VALIDATION_SYNTHETIC_POLICIES = (['KE', 'RW', 'MW', 'NG'] as const).map((jurisdiction) => {
  const base = PILOT_SYNTHETIC_POLICIES.find((fixture) =>
    fixture.jurisdiction === jurisdiction && fixture.type === 'DELIBERATE_GAPS',
  )!;
  return {
    ...base,
    name: `${jurisdiction} Deep Reasoning Conflict Fixture`,
    description: 'Synthetic mixed-compliance policy with ambiguity, conflicting clauses, and missing implementation evidence.',
    content: `${base.content}

DEEP VALIDATION ADDENDUM
- Compliant section: Requests for access and correction are acknowledged and tracked by the privacy team.
- Deliberate gap: No owner or deadline is assigned for deletion requests.
- Ambiguous wording: Material incidents may be reported promptly where appropriate.
- Conflicting clauses: Section A requires regulator notification within 72 hours; Section B prohibits external notification without executive approval.
- Missing implementation evidence: The policy asserts annual control testing, but provides no test record, owner, date, or remediation evidence.
`,
    validationFeatures: ['COMPLIANT', 'DELIBERATE_GAP', 'AMBIGUOUS', 'CONTRADICTION', 'MISSING_IMPLEMENTATION_EVIDENCE'] as const,
  };
});
