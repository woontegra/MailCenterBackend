/** Strip HTML and control characters; SMS is plain text only. */
export function sanitizeSmsPlainText(input: unknown): string {
  let text = String(input ?? '');
  // Reject / strip HTML tags
  text = text.replace(/<[^>]*>/g, ' ');
  // Control chars except LF/CR/TAB → space; then normalize newlines
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Collapse excessive spaces but keep single newlines
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .trim();
  return text;
}

export function containsHtml(input: unknown): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(String(input ?? ''));
}
