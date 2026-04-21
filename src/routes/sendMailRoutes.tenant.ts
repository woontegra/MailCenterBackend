import { Router, Response } from 'express';
import { SmtpService } from '../services/smtpService';
import { SendMailRequest } from '../types';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
const smtpService = new SmtpService();

router.use(authenticate);

router.post('/send-mail', async (req: AuthRequest, res: Response) => {
  try {
    const { accountId, to, subject, text, html }: SendMailRequest = req.body;
    const tenantId = req.user!.tenantId;

    if (!accountId || !to || !subject) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: accountId, to, subject',
      });
    }

    if (!text && !html) {
      return res.status(400).json({
        success: false,
        error: 'Either text or html content is required',
      });
    }

    const mailRequest: SendMailRequest = {
      accountId,
      to,
      subject,
      text,
      html,
    };
    
    const result = await smtpService.sendMail(mailRequest, tenantId);

    if (result.success) {
      return res.status(200).json(result);
    } else {
      return res.status(400).json(result);
    }
  } catch (error: any) {
    console.error('Error in send-mail endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
});

export default router;
