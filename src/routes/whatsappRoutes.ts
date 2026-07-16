import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { badRequest, notFound } from '../utils/channelPlatform';
import { checkRecipientEligibility } from '../utils/recipientEligibility';
import { getTenantDefaultCountryCode } from '../utils/contactNormalize';
import { renderTemplateContent } from '../utils/templateRenderer';
import { hasOpenWhatsAppServiceWindow } from '../whatsapp/whatsappConversationWindow';
import { resolveEligibleWhatsAppSenderIdentity } from '../utils/senderIdentityAccess';

const router = Router();
router.use(authenticate);

router.post('/preview', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const brandId = req.body.brandId ?? req.body.brand_id ?? null;
    const senderIdentityId = req.body.senderIdentityId ?? req.body.sender_identity_id ?? null;
    const templateId = req.body.templateId ?? req.body.template_id ?? null;
    const recipient = req.body.recipient ?? req.body.to ?? null;
    const messageMode = String(
      req.body.messageMode ?? req.body.message_mode ?? (templateId ? 'TEMPLATE' : 'TEXT')
    ).toUpperCase();
    const templateVariables =
      req.body.templateVariables ?? req.body.template_variables ?? {};
    let messageContent = String(req.body.messageContent ?? req.body.message ?? '');

    let templateMeta: any = null;
    if (templateId) {
      const template = await query(
        `SELECT * FROM templates WHERE id = $1 AND tenant_id = $2`,
        [templateId, tenantId]
      );
      if (template.rows.length === 0) return notFound(res);
      const tpl = template.rows[0];
      if (tpl.channel_type && tpl.channel_type !== 'WHATSAPP') {
        return badRequest(res, 'Şablon WhatsApp kanalına ait değil');
      }
      const rendered = renderTemplateContent({
        subject: '',
        htmlContent: '',
        plainTextContent: tpl.plain_text_content || tpl.content || '',
        variables: tpl.variables || [],
        values: templateVariables,
      });
      messageContent = rendered.plainTextContent || tpl.provider_template_name || '';
      templateMeta = {
        id: tpl.id,
        name: tpl.name,
        provider_template_name: tpl.provider_template_name,
        provider_template_language: tpl.provider_template_language,
        provider_approval_status: tpl.provider_approval_status || 'UNKNOWN',
        approved: String(tpl.provider_approval_status || '').toUpperCase() === 'APPROVED',
      };
    }

    let preference: any = null;
    if (recipient) {
      const eligibility = await checkRecipientEligibility({
        tenantId,
        channelType: 'WHATSAPP',
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

    let serviceWindow: any = { open: false, reason: null };
    if (senderIdentityId && preference?.normalizedValue) {
      try {
        const resolved = await resolveEligibleWhatsAppSenderIdentity(
          Number(senderIdentityId),
          tenantId,
          brandId ? Number(brandId) : null
        );
        if (resolved) {
          const window = await hasOpenWhatsAppServiceWindow({
            tenantId,
            channelConnectionId: resolved.channel_connection_id,
            userPhoneDigits: preference.normalizedValue,
          });
          serviceWindow = {
            open: window.open,
            lastInboundAt: window.lastInboundAt,
            reason: window.open
              ? null
              : 'Serbest metin için 24 saatlik konuşma penceresi kapalı; onaylı şablon gerekli',
          };
        }
      } catch {
        serviceWindow = {
          open: false,
          reason: 'Gönderici doğrulanamadı',
        };
      }
    } else if (messageMode === 'TEXT') {
      serviceWindow = {
        open: false,
        reason:
          'Serbest metin için konuşma penceresi doğrulanamadı; onaylı şablon kullanın',
      };
    }

    const templateOk =
      messageMode !== 'TEMPLATE' || (templateMeta && templateMeta.approved);
    const textOk = messageMode !== 'TEXT' || serviceWindow.open;
    const canSend =
      Boolean(messageContent || templateMeta) &&
      (!preference || preference.eligible) &&
      templateOk &&
      textOk;

    res.json({
      success: true,
      data: {
        renderedText: messageContent,
        messageMode,
        template: templateMeta,
        preference,
        serviceWindow,
        canSend,
        blockReason: !canSend
          ? !preference?.eligible && preference
            ? preference.reason
            : !templateOk
              ? 'Şablon APPROVED değil'
              : !textOk
                ? serviceWindow.reason
                : 'Gönderim uygun değil'
          : null,
      },
    });
  } catch (error) {
    console.error('Error in whatsapp preview:', error);
    res.status(500).json({ success: false, error: 'Önizleme oluşturulamadı' });
  }
});

export default router;
