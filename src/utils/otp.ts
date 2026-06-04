import twilio from 'twilio';

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio credentials not configured');
  return twilio(sid, token);
}

function getServiceSid() {
  const sid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!sid) throw new Error('TWILIO_VERIFY_SERVICE_SID not configured');
  return sid;
}

export async function sendOtp(phone: string): Promise<void> {
  await getClient().verify.v2
    .services(getServiceSid())
    .verifications.create({ to: phone, channel: 'sms' });
}

export async function checkOtp(phone: string, code: string): Promise<boolean> {
  const result = await getClient().verify.v2
    .services(getServiceSid())
    .verificationChecks.create({ to: phone, code });
  return result.status === 'approved';
}
