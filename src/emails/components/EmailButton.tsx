import * as React from 'react';
import { EMAIL_THEME, SHERIA_EMAIL_PALETTE } from '../theme';

export interface EmailButtonProps {
  href: string;
  children?: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'gold' | 'navy';
  align?: 'left' | 'center' | 'right';
  style?: React.CSSProperties;
}

/**
 * Bulletproof MSO/VML + HTML Email CTA Button
 * Ensures pixel-perfect rendering across Outlook (MS Word engine), Apple Mail, and Gmail.
 */
export function EmailButton({
  href,
  children,
  variant = 'primary',
  align = 'center',
  style,
}: EmailButtonProps) {
  const getButtonColors = () => {
    switch (variant) {
      case 'danger':
        return {
          bg: EMAIL_THEME.colors.danger,
          text: '#FFFFFF',
          border: `1px solid ${EMAIL_THEME.colors.danger}`,
        };
      case 'gold':
        return {
          bg: SHERIA_EMAIL_PALETTE.brand.gold,
          text: '#0A0A0A',
          border: `1px solid ${SHERIA_EMAIL_PALETTE.brand.gold}`,
        };
      case 'navy':
        return {
          bg: SHERIA_EMAIL_PALETTE.brand.navy,
          text: '#FFFFFF',
          border: `1px solid ${SHERIA_EMAIL_PALETTE.brand.navy}`,
        };
      case 'secondary':
        return {
          bg: 'transparent',
          text: SHERIA_EMAIL_PALETTE.brand.primary,
          border: `1.5px solid ${SHERIA_EMAIL_PALETTE.brand.primary}`,
        };
      case 'primary':
      default:
        return {
          bg: SHERIA_EMAIL_PALETTE.brand.primary, // #00875A
          text: '#FFFFFF',
          border: `1px solid ${SHERIA_EMAIL_PALETTE.brand.primary}`,
        };
    }
  };

  const { bg, text, border } = getButtonColors();
  const textLabel = typeof children === 'string' ? children : 'Click Here';

  // Construct MSO VML fallback block
  const vmlMarkup = `<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:44px;v-text-anchor:middle;width:240px;" arcsize="14%" stroke="${variant === 'secondary' ? 't' : 'f'}" ${variant === 'secondary' ? `strokecolor="${bg}"` : ''} fillcolor="${bg}">
  <w:anchorlock/>
  <center style="color:${text};font-family:'Inter',Helvetica,Arial,sans-serif;font-size:14px;font-weight:bold;letter-spacing:0.02em;">
    ${textLabel}
  </center>
</v:roundrect>
<![endif]-->`;

  return (
    <table
      border={0}
      cellPadding={0}
      cellSpacing={0}
      width="100%"
      style={{ margin: '20px 0', ...style }}
    >
      <tbody>
        <tr>
          <td align={align}>
            {/* Outlook MSO VML conditional markup */}
            <div dangerouslySetInnerHTML={{ __html: vmlMarkup }} />

            {/* Standard Email Clients (Apple Mail, Gmail, Webmail) */}
            {/*[if !mso]><!-- */}
            <a
              href={href}
              style={
                {
                  backgroundColor: bg,
                  color: text,
                  border,
                  borderRadius: '6px',
                  fontFamily: EMAIL_THEME.fonts.body,
                  fontSize: '14px',
                  fontWeight: '700',
                  padding: '13px 28px',
                  textDecoration: 'none',
                  display: 'inline-block',
                  cursor: 'pointer',
                  letterSpacing: '0.01em',
                  lineHeight: '1.2',
                  msoHide: 'all',
                } as React.CSSProperties
              }
            >
              {children}
            </a>
            {/*<![endif]*/}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
