/**
 * Self-test: inbound HTML sanitize + MIME parse preserve HTML.
 * Run: npx ts-node src/tests/emailHtmlRender.selftest.ts
 */
import { sanitizeEmailHtmlFragment } from '../utils/emailHtmlSanitizer';
import { parseMimeMessageBuffer } from '../utils/mimeBodyParser';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

async function testSanitizeKeepsLayout() {
  const input = `
    <table style="background:#0ea5e9;padding:16px;border:2px solid #0369a1">
      <tr><td style="color:#fff;font-size:20px">Başlık</td></tr>
      <tr><td>
        <a href="https://example.com/cta" style="background:#fff;color:#0ea5e9;padding:8px 12px;border-radius:4px">Buton</a>
        <img src="https://example.com/logo.png" alt="logo" />
        <script>alert(1)</script>
        <a href="javascript:alert(1)">evil</a>
        <img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" />
      </td></tr>
    </table>
    <form action="https://evil.test"><input name="x" /></form>
  `;
  const out = sanitizeEmailHtmlFragment(input);
  assert(out.includes('background:#0ea5e9'), 'keeps inline background');
  assert(out.includes('font-size:20px'), 'keeps font size');
  assert(out.includes('https://example.com/cta'), 'keeps https link');
  assert(out.includes('https://example.com/logo.png'), 'keeps https image');
  assert(!/script/i.test(out), 'strips script');
  assert(!/javascript:/i.test(out), 'strips javascript urls');
  assert(!/<form/i.test(out), 'strips form');
  assert(!/data:text\/html/i.test(out), 'strips dangerous data url');
  assert(/rel="noopener noreferrer"/i.test(out), 'adds safe rel on links');
  console.log('✓ sanitize keeps layout and strips threats');
}

async function testMimeMultipartHtmlPreferred() {
  const boundary = 'BOUND123';
  const raw = Buffer.from(
    [
      'From: a@example.com',
      'To: b@example.com',
      'Cc: c@example.com',
      'Subject: Hello',
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain only text',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      '<div style="color:red"><h1>HTML Title</h1><p>Colored body</p></div>',
      `--${boundary}--`,
      '',
    ].join('\r\n')
  );

  const parsed = await parseMimeMessageBuffer(raw);
  assert(parsed.htmlBody && parsed.htmlBody.includes('HTML Title'), 'stores html body');
  assert(parsed.textBody && parsed.textBody.includes('Plain only text'), 'stores text body');
  assert(parsed.bodyPreview.length <= 200, 'preview capped');
  assert(!parsed.bodyPreview.includes('<h1>'), 'preview is plain');
  assert(parsed.ccAddress && parsed.ccAddress.includes('c@example.com'), 'parses cc');
  console.log('✓ multipart/alternative prefers html without losing text');
}

async function testPlainOnly() {
  const raw = Buffer.from(
    [
      'From: a@example.com',
      'To: b@example.com',
      'Subject: Plain',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Just plain text message',
      '',
    ].join('\r\n')
  );
  const parsed = await parseMimeMessageBuffer(raw);
  assert(!parsed.htmlBody, 'no fake html for plain');
  assert(parsed.textBody?.includes('Just plain text'), 'text body kept');
  console.log('✓ plain-only messages stay plain');
}

async function testCidInlineImage() {
  const boundary = 'REL1';
  const alt = 'ALT1';
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const raw = Buffer.from(
    [
      'From: a@example.com',
      'To: b@example.com',
      'Subject: CID',
      'MIME-Version: 1.0',
      `Content-Type: multipart/related; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      '',
      `--${alt}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'see image',
      `--${alt}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      '<img src="cid:logo@mail" alt="logo" />',
      `--${alt}--`,
      `--${boundary}`,
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo@mail>',
      'Content-Disposition: inline',
      '',
      pngBase64,
      `--${boundary}--`,
      '',
    ].join('\r\n')
  );

  const parsed = await parseMimeMessageBuffer(raw);
  assert(parsed.htmlBody?.includes('data:image/png;base64,'), 'rewrites cid to data url');
  assert(!parsed.htmlBody?.includes('cid:'), 'no leftover cid');
  console.log('✓ cid inline images rewritten to data URLs');
}

async function main() {
  await testSanitizeKeepsLayout();
  await testMimeMultipartHtmlPreferred();
  await testPlainOnly();
  await testCidInlineImage();
  console.log('\nAll email HTML render self-tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
