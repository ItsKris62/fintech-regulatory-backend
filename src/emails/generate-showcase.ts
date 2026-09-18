import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderEmailToHtml } from './render';
import { RegulatoryAlertEmail } from './templates/compliance/RegulatoryAlertEmail';
import { PolicyDocumentReadyEmail } from './templates/compliance/PolicyDocumentReadyEmail';
import { PaymentReceiptEmail } from './templates/billing/PaymentReceiptEmail';

async function main() {
  const outDir = path.resolve(__dirname, '../../../preview_emails');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const alertHtml = await renderEmailToHtml(
    React.createElement(RegulatoryAlertEmail, {
      recipientName: 'Wachira Maina',
      alertTitle: 'CBK Issues Mandatory Operational Resilience & Cloud Hosting Guidelines (2026)',
      alertSummary:
        'The Central Bank of Kenya has gazetted new operational directives requiring all licensed Payment Service Providers (PSPs) and Digital Credit Providers (DCPs) to maintain primary transaction ledgers within Kenyan data sovereignty boundaries.',
      alertBody:
        'Pursuant to Section 12(A) of the National Payment System Act and Section 50(1) of the Kenya Data Protection Act, 2019, all regulated payment service providers and financial institutions must ensure zero unencrypted cross-border exfiltration of customer transaction metadata. The deadline for submitting migration plans to the CBK Banking Supervision Department is 31 October 2026.',
      regulatoryBody: 'Central Bank of Kenya (CBK)',
      severity: 'CRITICAL',
      effectiveDate: '31 October 2026 (42 Days)',
      sourceUrl: 'https://sheriabot.com/regulators/cbk/circular-2026-08',
      alertUrl: 'https://sheriabot.com/compliance/alerts/cbk-2026-08',
      unsubscribeUrl: 'https://sheriabot.com/settings/notifications',
      statutoryCitations: [
        'National Payment System Act §12(A)',
        'Kenya DPA 2019 §50(1)',
        'Prudential Guidelines 2026',
      ],
    })
  );

  const policyHtml = await renderEmailToHtml(
    React.createElement(PolicyDocumentReadyEmail, {
      userName: 'Faith Mwangi',
      documentTitle: 'Data Protection & Retention Policy v2.4',
      documentType: 'Statutory Compliance Policy',
      documentUrl: 'https://sheriabot.com/audit/reports/rep_883204',
      generatedAt: '18 September 2026, 15:30 EAT',
      complianceScore: 74,
      criticalGapCount: 2,
      advisoryFlagCount: 5,
      compliantCount: 19,
      frameworks: [
        'Kenya Data Protection Act (2019)',
        'ODPC General Regulations (2021)',
        'ISO/IEC 27001:2022',
      ],
    })
  );

  const receiptHtml = await renderEmailToHtml(
    React.createElement(PaymentReceiptEmail, {
      userName: 'Apex Pay Compliance Team',
      invoiceNumber: 'SB-2026-9921',
      amount: '35,000.00',
      currency: 'KES',
      paymentDate: '18 September 2026',
      paymentMethod: 'M-PESA Paybill (Ref: QK8892LA10)',
      planName: 'Enterprise RegTech Co-Pilot (Annual)',
      billingPeriod: '18 Sep 2026 — 17 Sep 2027',
      receiptUrl: 'https://sheriabot.com/billing/invoices/SB-2026-9921.pdf',
      kraPin: 'P051928374Z',
      customerOrgName: 'Apex Pay Kenya Ltd',
      items: [
        {
          description: 'SheriaBot Enterprise Subscription (12 Months Access)',
          amount: 'KES 30,172.41',
        },
        { description: 'VAT (16% Kenya Statutory Standard)', amount: 'KES 4,827.59' },
      ],
    })
  );

  fs.writeFileSync(path.join(outDir, 'regulatory-alert.html'), alertHtml, 'utf8');
  fs.writeFileSync(path.join(outDir, 'policy-audit-ready.html'), policyHtml, 'utf8');
  fs.writeFileSync(path.join(outDir, 'payment-receipt.html'), receiptHtml, 'utf8');

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SheriaBot Email Design Showcase &amp; Live Previews</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0A0A0A;
      --card-bg: #141416;
      --border: #27272A;
      --emerald: #00875A;
      --emerald-light: #22C55E;
      --gold: #D4A843;
      --text: #F4F4F5;
      --text-muted: #A1A1AA;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', sans-serif;
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: #111113;
      border-bottom: 1px solid var(--border);
      padding: 16px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .logo-badge {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .logo-text {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .logo-text span {
      color: var(--emerald);
    }
    .badge {
      background: #1A2B4A;
      color: #93C5FD;
      font-size: 11px;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 4px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .nav-tabs {
      display: flex;
      gap: 8px;
      background: #1E1E22;
      padding: 4px;
      border-radius: 8px;
    }
    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      font-weight: 600;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .tab-btn:hover {
      color: #FFFFFF;
    }
    .tab-btn.active {
      background: var(--emerald);
      color: #FFFFFF;
      box-shadow: 0 2px 8px rgba(0, 135, 90, 0.4);
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .device-btn {
      background: #1E1E22;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .device-btn.active {
      border-color: var(--emerald);
      color: #FFFFFF;
      background: #182820;
    }
    main {
      flex: 1;
      padding: 32px 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      background: radial-gradient(circle at 50% 10%, #1A2A20 0%, #0A0A0A 60%);
    }
    .preview-container {
      width: 100%;
      max-width: 660px;
      transition: max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .preview-container.mobile {
      max-width: 395px;
    }
    .frame-wrapper {
      width: 100%;
      background: #F4F4F5;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.1);
      position: relative;
    }
    iframe {
      width: 100%;
      height: 900px;
      border: none;
      display: block;
      background: #F4F4F5;
    }
    .meta-footer {
      margin-top: 20px;
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>

  <header>
    <div class="logo-badge">
      <div class="logo-text">Sheria<span>Bot</span></div>
      <div class="badge">Live Email Previews</div>
    </div>

    <div class="nav-tabs">
      <button class="tab-btn active" onclick="switchTab('alert', this)">Template A: Regulatory Alert</button>
      <button class="tab-btn" onclick="switchTab('policy', this)">Template B: Gap Audit Ready</button>
      <button class="tab-btn" onclick="switchTab('receipt', this)">Template C: Tax Receipt</button>
    </div>

    <div class="controls">
      <button id="desktopBtn" class="device-btn active" onclick="setDevice('desktop')">💻 Desktop (600px)</button>
      <button id="mobileBtn" class="device-btn" onclick="setDevice('mobile')">📱 Mobile (375px)</button>
    </div>
  </header>

  <main>
    <div id="previewContainer" class="preview-container">
      <div class="frame-wrapper">
        <iframe id="previewFrame"></iframe>
      </div>
      <div class="meta-footer">
        Rendered with <strong>SheriaBot RegTech Design Tokens</strong> • Apple Mail, Gmail, &amp; Outlook MSO/VML Certified
      </div>
    </div>
  </main>

  <script>
    const emails = {
      alert: ${JSON.stringify(alertHtml)},
      policy: ${JSON.stringify(policyHtml)},
      receipt: ${JSON.stringify(receiptHtml)},
    };

    function switchTab(type, btn) {
      document.getElementById('previewFrame').srcdoc = emails[type];
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }

    function setDevice(type) {
      const container = document.getElementById('previewContainer');
      const deskBtn = document.getElementById('desktopBtn');
      const mobBtn = document.getElementById('mobileBtn');

      if (type === 'mobile') {
        container.classList.add('mobile');
        mobBtn.classList.add('active');
        deskBtn.classList.remove('active');
      } else {
        container.classList.remove('mobile');
        deskBtn.classList.add('active');
        mobBtn.classList.remove('active');
      }
    }

    // Initialize with Template A
    document.getElementById('previewFrame').srcdoc = emails.alert;
  </script>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml, 'utf8');
  console.log('SHOWCASE_GENERATED_SUCCESSFULLY');
}

main().catch(console.error);
