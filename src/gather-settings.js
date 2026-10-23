import { WebhookObjectError, unsafeSecretLiteral } from '@gathertown/webhook-object-sdk';

export function validateGatherSettings(value) {
  const url = typeof value?.url === 'string' ? value.url.trim() : '';
  const secret = typeof value?.secret === 'string' ? value.secret.trim() : '';
  let parsed;
  try { parsed = new URL(url); } catch {}
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || url.length > 4096) {
    throw new WebhookObjectError('invalid_url', 'Enter a valid HTTPS webhook URL.');
  }
  if (secret.length > 4096) throw new WebhookObjectError('invalid_secret', 'Enter a valid Gather signing secret.');
  unsafeSecretLiteral(secret);
  return { url, secret };
}
