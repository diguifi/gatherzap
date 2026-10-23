import {
  createWebhookObjectClient,
  unsafeSecretLiteral,
} from '@gathertown/webhook-object-sdk';
import { validateGatherSettings } from './gather-settings.js';

// Credentials come from the browser setup screen and stay in server memory.
export function createGatherClient({ signal, credentials } = {}) {
  const settings = validateGatherSettings(credentials);
  return createWebhookObjectClient({ url: settings.url, secret: unsafeSecretLiteral(settings.secret), signal });
}
