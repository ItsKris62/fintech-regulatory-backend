import { render } from '@react-email/components';
import * as React from 'react';

/**
 * Render a React Email component to an HTML string.
 * @param component The React element to render
 * @returns HTML string
 */
export async function renderEmailToHtml(component: React.ReactElement): Promise<string> {
  return render(component);
}

/**
 * Render a React Email component to a plain text string.
 * @param component The React element to render
 * @returns Plain text string
 */
export async function renderEmailToText(component: React.ReactElement): Promise<string> {
  return render(component, { plainText: true });
}
