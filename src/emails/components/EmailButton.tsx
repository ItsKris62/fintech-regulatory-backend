import * as React from 'react';
import { Button } from '@react-email/components';
import { EMAIL_THEME } from '../theme';

interface EmailButtonProps {
  href: string;
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
}

export function EmailButton({ href, children, variant = 'primary' }: EmailButtonProps) {
  const bgColor =
    variant === 'primary'
      ? EMAIL_THEME.colors.primary
      : variant === 'danger'
        ? EMAIL_THEME.colors.danger
        : 'transparent';

  const textColor =
    variant === 'secondary' ? EMAIL_THEME.colors.primary : '#FFFFFF';

  const border =
    variant === 'secondary' ? `2px solid ${EMAIL_THEME.colors.primary}` : 'none';

  return (
    <Button
      href={href}
      style={{
        backgroundColor: bgColor,
        color: textColor,
        border,
        borderRadius: '6px',
        fontFamily: EMAIL_THEME.fonts.body,
        fontSize: '15px',
        fontWeight: '600',
        padding: '14px 28px',
        textDecoration: 'none',
        display: 'inline-block',
        cursor: 'pointer',
      }}
    >
      {children}
    </Button>
  );
}
