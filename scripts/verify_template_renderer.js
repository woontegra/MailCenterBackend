/**
 * Template renderer unit checks (no DB, no SMTP).
 */
const {
  escapeHtml,
  renderTemplateContent,
  parseAddressList,
  assertNoHeaderInjection,
} = require('../dist/utils/templateRenderer.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const escaped = escapeHtml(`<script>alert("x")</script> & '"`);
assert(escaped.includes('&lt;script&gt;'), 'escape script open');
assert(!escaped.includes('<script>'), 'no raw script');

const rendered = renderTemplateContent({
  subject: 'Merhaba {{ad_soyad}}',
  htmlContent: '<p>Sipariş {{siparis_no}} — {{ad_soyad}}</p>',
  plainTextContent: 'Sipariş {{siparis_no}}',
  variables: ['ad_soyad', 'siparis_no'],
  values: {
    ad_soyad: '<b>Ali</b>',
    siparis_no: 'A-1',
  },
});

assert(rendered.subject === 'Merhaba <b>Ali</b>', 'subject not html-escaped');
assert(rendered.htmlContent.includes('&lt;b&gt;Ali&lt;/b&gt;'), 'html value escaped');
assert(rendered.htmlContent.includes('A-1'), 'order substituted');
assert(rendered.plainTextContent === 'Sipariş A-1', 'plain text ok');
assert(rendered.missingRequired.length === 0, 'no missing');

const missing = renderTemplateContent({
  subject: 'x',
  htmlContent: 'Hi {{ad_soyad}}',
  plainTextContent: '',
  variables: ['ad_soyad'],
  values: {},
});
assert(missing.missingRequired.includes('ad_soyad'), 'missing required detected');

const unknown = renderTemplateContent({
  subject: '{{ghost}}',
  htmlContent: '',
  plainTextContent: '',
  variables: ['ad_soyad'],
  values: { ghost: '1' },
});
assert(unknown.unknownInContent.includes('ghost'), 'unknown var detected');

let injectionBlocked = false;
try {
  assertNoHeaderInjection('a\nb', 'to');
} catch {
  injectionBlocked = true;
}
assert(injectionBlocked, 'header injection blocked');

const emails = parseAddressList('a@x.com, b@y.com', 'to');
assert(emails.length === 2, 'parse addresses');

console.log('✓ template renderer verification passed');
