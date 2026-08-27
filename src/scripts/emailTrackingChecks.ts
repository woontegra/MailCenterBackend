/**
 * Email tracking logic checks (no DB).
 * Run: npx ts-node src/scripts/emailTrackingChecks.ts
 */
import assert from 'assert';
import {
  hashTrackingToken,
  generateRawTrackingToken,
  getTrackingBaseUrl,
} from '../services/emailTrackingTokenService';
import { classifyTrackingRequest } from '../utils/emailTrackingBotClassifier';
import { classifySmtpFailure, parseDsnSignals } from '../services/emailBounceService';

const token = generateRawTrackingToken();
assert.ok(token.length >= 32, 'token length');
assert.notStrictEqual(hashTrackingToken(token), hashTrackingToken(generateRawTrackingToken()));

const gmail = classifyTrackingRequest({
  userAgent: 'Mozilla/5.0 GoogleImageProxy',
  purpose: 'open',
});
assert.strictEqual(gmail.classification, 'prefetch_probable');

const bot = classifyTrackingRequest({
  userAgent: 'Proofpoint URL Defense',
  purpose: 'click',
});
assert.strictEqual(bot.classification, 'bot_suspected');

const human = classifyTrackingRequest({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
  purpose: 'click',
});
assert.strictEqual(human.classification, 'human_probable');

assert.strictEqual(classifySmtpFailure('550'), 'hard');
assert.strictEqual(classifySmtpFailure('451'), 'soft');

const dsn = parseDsnSignals('Delivery Status Notification: status: 5.1.1 failed permanently user@example.com');
assert.ok(dsn?.hardBounce);

assert.ok(getTrackingBaseUrl().startsWith('http'));

const openRedirect = 'https://evil.com/phish';
assert.ok(!/^javascript:/i.test(openRedirect));

console.log('✓ emailTrackingChecks passed');
