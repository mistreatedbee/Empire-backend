import nodemailer from 'nodemailer';
import { pool } from '../db';

const DEV_CODE = '123456';

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

function randomCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// identifier = email address
export async function sendOtp(identifier: string): Promise<void> {
  // Clean up old codes for this identifier
  await pool.query(`DELETE FROM otps WHERE phone = $1`, [identifier]);

  const code = hasSmtp() ? randomCode() : DEV_CODE;

  await pool.query(
    `INSERT INTO otps (phone, otp, purpose, expires_at, used)
     VALUES ($1, $2, 'any', NOW() + INTERVAL '15 minutes', false)`,
    [identifier, code]
  );

  if (!hasSmtp()) {
    console.warn(`[DEV] Verification code for ${identifier}: ${code}`);
    return;
  }

  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;
  await makeTransport().sendMail({
    from: `Empire Deliveries <${from}>`,
    to: identifier,
    subject: 'Your Empire Deliveries verification code',
    text: `Your verification code is: ${code}\n\nThis code expires in 15 minutes.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0A0A0A">Verify your email</h2>
        <p style="color:#6B6B6B">Use the code below to complete your sign-up.</p>
        <div style="font-size:36px;font-weight:900;letter-spacing:8px;color:#C9A227;padding:24px 0">
          ${code}
        </div>
        <p style="color:#A3A3A3;font-size:13px">Expires in 15 minutes. Do not share this code.</p>
      </div>
    `,
  });
}

export async function checkOtp(identifier: string, code: string): Promise<boolean> {
  const row = await pool.query(
    `SELECT id FROM otps
     WHERE phone = $1 AND otp = $2 AND used = false AND expires_at > NOW()
     LIMIT 1`,
    [identifier, code]
  );
  if (!row.rows.length) return false;
  await pool.query(`UPDATE otps SET used = true WHERE id = $1`, [row.rows[0].id]);
  return true;
}
