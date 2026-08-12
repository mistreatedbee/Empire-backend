import nodemailer from 'nodemailer';
import { logger } from './logger';

function hasSmtp(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function makeTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendTransactionalEmail(
  to: string,
  subject: string,
  text: string,
  html?: string
): Promise<void> {
  if (!hasSmtp()) {
    logger.warn({ to, subject }, '[DEV] Transactional email skipped (SMTP not configured)');
    return;
  }

  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;
  await makeTransport().sendMail({
    from: `Empire Deliveries <${from}>`,
    to,
    subject,
    text,
    html: html ?? `<div style="font-family:sans-serif;max-width:480px;margin:0 auto"><p>${text.replace(/\n/g, '<br/>')}</p></div>`,
  });
}
