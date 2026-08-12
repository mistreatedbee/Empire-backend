import crypto from 'crypto';
import {
  PAYFAST_CHECKOUT_FIELD_ORDER,
  buildPayFastCheckoutSignature,
} from './payfast';

const TTL_MS = 15 * 60 * 1000;

function checkoutSecret(): string {
  return process.env.JWT_ACCESS_SECRET ?? process.env.PAYFAST_CHECKOUT_SECRET ?? 'empire-payfast-dev';
}

export interface PayfastCheckoutSession {
  params: Record<string, string>;
  actionUrl: string;
  signature?: string;
}

export function createPayfastCheckoutToken(session: PayfastCheckoutSession): string {
  const body = JSON.stringify({
    params: session.params,
    actionUrl: session.actionUrl,
    signature: session.signature,
    exp: Date.now() + TTL_MS,
  });
  const sig = crypto.createHmac('sha256', checkoutSecret()).update(body).digest('hex');
  return Buffer.from(JSON.stringify({ body, sig })).toString('base64url');
}

export function parsePayfastCheckoutToken(token: string): PayfastCheckoutSession | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
      body: string;
      sig: string;
    };
    const expected = crypto.createHmac('sha256', checkoutSecret()).update(parsed.body).digest('hex');
    if (parsed.sig !== expected) return null;

    const data = JSON.parse(parsed.body) as {
      params: Record<string, string>;
      actionUrl: string;
      signature?: string;
      exp: number;
    };
    if (!data.params || !data.actionUrl || typeof data.exp !== 'number' || data.exp < Date.now()) {
      return null;
    }

    return { params: data.params, actionUrl: data.actionUrl, signature: data.signature };
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Auto-submit POST form — PayFast's documented checkout integration path. */
export function buildPayFastCheckoutFormHtml(
  actionUrl: string,
  params: Record<string, string>,
  signature: string,
): string {
  const fields: string[] = [];

  for (const key of PAYFAST_CHECKOUT_FIELD_ORDER) {
    const raw = params[key];
    if (raw === undefined || raw === '') continue;
    fields.push(
      `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(raw).trim())}" />`,
    );
  }
  fields.push(`<input type="hidden" name="signature" value="${escapeHtml(signature)}" />`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Redirecting to PayFast…</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #fafafa; color: #333; }
    .box { text-align: center; padding: 24px; max-width: 320px; }
    button { font: inherit; padding: 12px 20px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="box">
    <p>Redirecting to PayFast…</p>
    <noscript>
      <p>JavaScript is required for automatic redirect.</p>
    </noscript>
    <p><button type="submit" form="payfast-form">Continue to PayFast</button></p>
  </div>
  <form id="payfast-form" action="${escapeHtml(actionUrl)}" method="post">
    ${fields.join('\n    ')}
  </form>
  <script>
    (function () {
      var form = document.getElementById('payfast-form');
      if (form) form.submit();
    })();
  </script>
</body>
</html>`;
}

export function buildPayfastCheckoutPage(
  params: Record<string, string>,
  actionUrl: string,
  options?: { signature?: string; passphrase?: string },
): string {
  const signature = options?.signature
    ?? buildPayFastCheckoutSignature(params, options?.passphrase);
  return buildPayFastCheckoutFormHtml(actionUrl, params, signature);
}
