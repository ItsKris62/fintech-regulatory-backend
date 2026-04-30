import * as React from 'react';
import { Button, Section } from '@react-email/components';
import { EMAIL_THEME } from '../theme';

/**
 * MarketingEmailButton
 *
 * Sibling to EmailButton — do NOT modify EmailButton.
 * Used exclusively in marketing templates (Phase B2+).
 *
 * Variants:
 *   primary — filled green (#15803D), white text
 *   outline — transparent background, green border + text
 */

export interface MarketingEmailButtonProps {
  href: string;
  children: React.ReactNode;
  variant?: 'primary' | 'outline';
}

export function MarketingEmailButton({
  href,
  children,
  variant = 'primary',
}: MarketingEmailButtonProps) {
  const isPrimary = variant === 'primary';

  const buttonStyle: React.CSSProperties = {
    backgroundColor: isPrimary ? '#15803D' : 'transparent',
    color:           isPrimary ? '#FFFFFF' : '#15803D',
    border:          isPrimary ? 'none' : '2px solid #15803D',
    borderRadius:    '6px',
    fontFamily:      EMAIL_THEME.fonts.body,
    fontSize:        '15px',
    fontWeight:      '600',
    padding:         '14px 28px',
    textDecoration:  'none',
    display:         'inline-block',
    cursor:          'pointer',
  };

  return (
    <Section style={{ textAlign: 'center', margin: '24px 0' }}>
      <Button href={href} style={buttonStyle}>
        {children}
      </Button>
    </Section>
  );
}
