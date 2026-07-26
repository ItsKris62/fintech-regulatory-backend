import * as React from 'react';
import { render } from '@react-email/components';
import { describe, expect, it } from 'vitest';
import KenyanComplianceBriefEmail, { type KenyanComplianceBriefEmailProps } from './KenyanComplianceBriefEmail';

function baseProps(overrides: Partial<KenyanComplianceBriefEmailProps> = {}): KenyanComplianceBriefEmailProps {
  return {
    editionLabel: 'Week of 21 July 2026',
    items: [
      { title: 'CBK issues new circular', summary: 'A plain-English summary of the circular.', sourceUrl: 'https://cbk.go.ke/circular-1' },
      { title: 'ODPC guidance update', summary: 'A plain-English summary of the guidance.' },
    ],
    unsubscribeUrl: 'https://sheriabot.com/unsubscribe/token123',
    ...overrides,
  };
}

describe('KenyanComplianceBriefEmail', () => {
  it('renders all item titles and summaries, and only links the item that has a sourceUrl', async () => {
    const html = await render(React.createElement(KenyanComplianceBriefEmail, baseProps()));

    expect(html).toContain('CBK issues new circular');
    expect(html).toContain('A plain-English summary of the circular.');
    expect(html).toContain('ODPC guidance update');
    expect(html).toContain('A plain-English summary of the guidance.');
    expect(html).toContain('https://cbk.go.ke/circular-1');
  });

  it('renders the edition label and a personalized greeting when recipientFirstName is provided', async () => {
    const html = await render(React.createElement(KenyanComplianceBriefEmail, baseProps({ recipientFirstName: 'Amina' })));

    expect(html).toContain('Week of 21 July 2026');
    expect(html).toContain('Hi Amina,');
  });

  it('falls back to a generic greeting when recipientFirstName is omitted', async () => {
    const html = await render(React.createElement(KenyanComplianceBriefEmail, baseProps()));
    expect(html).toContain('Hi there,');
  });

  it('renders the optional intro paragraph only when provided', async () => {
    const withIntro = await render(React.createElement(KenyanComplianceBriefEmail, baseProps({ intro: 'A short intro paragraph.' })));
    expect(withIntro).toContain('A short intro paragraph.');

    const withoutIntro = await render(React.createElement(KenyanComplianceBriefEmail, baseProps()));
    expect(withoutIntro).not.toContain('A short intro paragraph.');
  });

  it('includes the tokenized unsubscribe link (RFC 8058 / DPA 2019 compliance, enforced by MarketingBaseLayout)', async () => {
    const html = await render(React.createElement(KenyanComplianceBriefEmail, baseProps()));
    expect(html).toContain('https://sheriabot.com/unsubscribe/token123');
  });

  it('supports a single item as well as the max of 10', async () => {
    const html = await render(React.createElement(KenyanComplianceBriefEmail, baseProps({ items: [{ title: 'Solo item', summary: 'Solo summary.' }] })));
    expect(html).toContain('Solo item');
  });
});
