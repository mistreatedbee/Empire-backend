import crypto from 'crypto';

/** Match PHP urlencode() — required for PayFast signature verification. */
export function phpUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/~/g, '%7E')
    .replace(/%20/g, '+');
}

/**
 * Field order for custom checkout integration (NOT alphabetical — see PayFast docs Step 2).
 * https://developers.payfast.co.za/docs#step-2-create-security-signature
 */
export const PAYFAST_CHECKOUT_FIELD_ORDER = [
  'merchant_id',
  'merchant_key',
  'return_url',
  'cancel_url',
  'notify_url',
  'fica_idnumber',
  'name_first',
  'name_last',
  'email_address',
  'cell_number',
  'm_payment_id',
  'amount',
  'item_name',
  'item_description',
  'custom_int1',
  'custom_int2',
  'custom_int3',
  'custom_int4',
  'custom_int5',
  'custom_str1',
  'custom_str2',
  'custom_str3',
  'custom_str4',
  'custom_str5',
  'email_confirmation',
  'confirmation_address',
  'payment_method',
] as const;

export function buildPayFastCheckoutSignature(
  params: Record<string, string>,
  passphrase?: string,
): string {
  let pfOutput = '';

  for (const key of PAYFAST_CHECKOUT_FIELD_ORDER) {
    const raw = params[key];
    if (raw === undefined || raw === '') continue;
    pfOutput += `${key}=${phpUrlEncode(String(raw).trim())}&`;
  }

  pfOutput = pfOutput.slice(0, -1);

  const pass = passphrase?.trim();
  if (pass) {
    pfOutput += `&passphrase=${phpUrlEncode(pass)}`;
  }

  return crypto.createHash('md5').update(pfOutput).digest('hex');
}

/** Build the redirect/process query string using the same encoding as the signature. */
export function buildPayFastCheckoutQuery(
  params: Record<string, string>,
  signature: string,
): string {
  const parts: string[] = [];

  for (const key of PAYFAST_CHECKOUT_FIELD_ORDER) {
    const raw = params[key];
    if (raw === undefined || raw === '') continue;
    parts.push(`${key}=${phpUrlEncode(String(raw).trim())}`);
  }

  parts.push(`signature=${signature}`);
  return parts.join('&');
}

/** ITN/webhook signatures use POST field order and stop at the signature key. */
export function buildPayFastItnSignature(
  data: Record<string, string>,
  passphrase?: string,
): string {
  let pfParamString = '';

  for (const key of Object.keys(data)) {
    if (key === 'signature') break;
    const raw = data[key];
    if (raw === undefined) continue;
    pfParamString += `${key}=${phpUrlEncode(String(raw).trim())}&`;
  }

  pfParamString = pfParamString.slice(0, -1);

  const pass = passphrase?.trim();
  if (pass) {
    pfParamString += `&passphrase=${phpUrlEncode(pass)}`;
  }

  return crypto.createHash('md5').update(pfParamString).digest('hex');
}
