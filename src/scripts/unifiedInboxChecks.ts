/**
 * Unit-style checks for unified inbox helpers (no DB / no real send).
 * Run: npx ts-node src/scripts/unifiedInboxChecks.ts
 */
import assert from 'assert';
import {
  normalizeMessageId,
  parseReferencesHeader,
  sanitizeNoteContent,
  isConversationStatus,
  isConversationPriority,
} from '../services/conversationService';
import { canAdvanceOutboundStatus } from '../whatsapp/whatsappConversationWindow';

function run() {
  assert.strictEqual(normalizeMessageId('abc@x.com'), '<abc@x.com>');
  assert.strictEqual(normalizeMessageId('<Abc@X.COM>'), '<abc@x.com>');

  const refs = parseReferencesHeader('<a@1> <b@2>');
  assert.deepStrictEqual(refs, ['<a@1>', '<b@2>']);

  const note = sanitizeNoteContent('<script>alert(1)</script>Merhaba');
  assert.ok(!note.includes('<script>'));
  assert.ok(note.includes('Merhaba'));

  assert.ok(isConversationStatus('OPEN'));
  assert.ok(!isConversationStatus('openish'));
  assert.ok(isConversationPriority('URGENT'));
  assert.ok(!isConversationPriority('SUPER'));

  assert.ok(canAdvanceOutboundStatus('SENT', 'DELIVERED'));
  assert.ok(!canAdvanceOutboundStatus('READ', 'DELIVERED'));

  console.log('✓ unifiedInboxChecks passed');
}

run();
