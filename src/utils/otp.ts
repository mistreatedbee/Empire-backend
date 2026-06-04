export function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function otpExpiresAt(): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 10);
  return d;
}

// Replace this with Africa's Talking, Twilio, or any SMS provider
export async function sendOtp(phone: string, otp: string, purpose: string): Promise<void> {
  console.log(`[OTP] Phone: ${phone} | Code: ${otp} | Purpose: ${purpose}`);
  // TODO: integrate SMS provider
  // await smsClient.send({ to: phone, message: `Your Empire Deliveries code is ${otp}` });
}
