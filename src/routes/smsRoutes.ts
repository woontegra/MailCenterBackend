import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { badRequest, notFound } from '../utils/channelPlatform';
import { renderTemplateContent } from '../utils/templateRenderer';
import { sanitizeSmsPlainText, containsHtml } from '../sms/smsContent';
import { analyzeSmsContent, assertSmsLengthAllowed } from '../sms/smsSegmentCounter';
import { checkRecipientEligibility } from '../utils/recipientEligibility';
import { getTenantDefaultCountryCode } from '../utils/contactNormalize';

const router = Router();
router.use(authenticate);

router.post('/preview', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const templateId = req.body.templateId ?? req.body.template_id ?? null;
    const templateVariables =
      req.body.templateVariables ?? req.body.template_variables ?? {};
    let messageContent = req.body.messageContent ?? req.body.message ?? '';
    const recipient = req.body.recipient ?? req.body.to ?? null;
    const brandId = req.body.brandId ?? req.body.brand_id ?? null;

    if (containsHtml(messageContent) && !templateId) {
      return badRequest(res, 'SMS içeriği HTML olamaz');
    }

    if (templateId) {
      const template = await query(
        `SELECT id, plain_text_content, body, variables, channel_type
         FROM templates
         WHERE id = $1 AND tenant_id = $2 AND COALESCE(is_active, true) = true`,
        [templateId, tenantId]
      );
      if (template.rows.length === 0) return notFound(res);
      const tpl = template.rows[0];
      if (tpl.channel_type && tpl.channel_type !== 'SMS') {
        return badRequest(res, 'Şablon SMS kanalına ait değil');
      }
      const rendered = renderTemplateContent({
        subject: '',
        htmlContent: '',
        plainTextContent: tpl.plain_text_content || tpl.body || messageContent || '',
        variables: tpl.variables || [],
        values: templateVariables,
      });
      messageContent = rendered.plainTextContent;
    }

    messageContent = sanitizeSmsPlainText(messageContent);
    const info = analyzeSmsContent(messageContent);
    const lengthCheck = assertSmsLengthAllowed(messageContent);

    let preference: any = null;
    if (recipient) {
      const eligibility = await checkRecipientEligibility({
        tenantId,
        channelType: 'SMS',
        value: String(recipient),
        brandId: brandId ? Number(brandId) : null,
        countryCode: req.body.country_code || (await getTenantDefaultCountryCode(tenantId)),
        strictPreference: true,
      });
      preference = {
        eligible: eligibility.eligible,
        status: eligibility.preferenceStatus || 'UNKNOWN',
        reason: eligibility.reason || null,
        code: eligibility.code || null,
        contactId: eligibility.contactId || null,
        normalizedValue: eligibility.normalizedValue || null,
      };
    }

    res.json({
      success: true,
      data: {
        renderedText: messageContent,
        characterCount: info.characterCount,
        encoding: info.encoding,
        segmentCount: info.segmentCount,
        charsPerSegment: info.charsPerSegment,
        remainingInSegment: info.remainingInSegment,
        canSend: lengthCheck.ok && (!preference || preference.eligible),
                lengthError: lengthCheck.ok === false ? lengthCheck.error : null,
        preference,
        // No fake cost
        cost: null,
      },
    });
  } catch (error) {
    console.error('Error in sms preview:', error);
    res.status(500).json({ success: false, error: 'Önizleme oluşturulamadı' });
  }
});

export default router;
