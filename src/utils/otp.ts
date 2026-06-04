import twilio from 'twilio';

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio credentials not configured');
  return twilio(sid, token);
}

export function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function otpExpiresAt(): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 10);
  return d;
}

export async function sendOtp(phone: string, otp: string, purpose: string): Promise<void> {
  const message = purpose === 'password_reset'
    ? `Your Empire Deliveries password reset code is: ${otp}. Valid for 10 minutes.`
    : `Your Empire Deliveries verification code is: ${otp}. Valid for 10 minutes.`;

  await getClient().messages.create({
    body: message,
    from: process.env.TWILIO_PHONE_NUMBER!,
    to: phone,
  });
}
