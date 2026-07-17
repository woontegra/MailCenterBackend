-- Idempotent: store full inbound email bodies separately from list preview
ALTER TABLE mails ADD COLUMN IF NOT EXISTS html_body TEXT;
ALTER TABLE mails ADD COLUMN IF NOT EXISTS text_body TEXT;
ALTER TABLE mails ADD COLUMN IF NOT EXISTS cc_address TEXT;
ALTER TABLE mails ADD COLUMN IF NOT EXISTS attachment_meta JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN mails.html_body IS 'Original text/html body (may contain cid: rewritten to data URLs)';
COMMENT ON COLUMN mails.text_body IS 'Original text/plain body';
COMMENT ON COLUMN mails.body_preview IS 'Short plain preview for conversation lists only';
COMMENT ON COLUMN mails.attachment_meta IS 'Non-inline attachment metadata from IMAP (no binary)';
