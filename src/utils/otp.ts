import twilio from 'twilio';

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

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

  await client.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE_NUMBER!,
    to: phone,
  });
}
