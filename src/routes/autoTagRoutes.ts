import { Router, Response } from 'express';
import { AutoTagService } from '../services/autoTagService';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();
const autoTagService = new AutoTagService();

router.use(authenticate);

router.get('/auto-tag/keywords', async (req: AuthRequest, res: Response) => {
  try {
    const keywords = autoTagService.getKeywords();
    res.json(keywords);
  } catch (error) {
    console.error('Error fetching keywords:', error);
    res.status(500).json({ error: 'Failed to fetch keywords' });
  }
});

router.post('/auto-tag/keywords', async (req: AuthRequest, res: Response) => {
  try {
    const { tagName, keywords } = req.body;

    if (!tagName || !keywords || !Array.isArray(keywords)) {
      return res.status(400).json({ 
        error: 'tagName and keywords array are required' 
      });
    }

    autoTagService.addCustomKeywords(tagName, keywords);
    
    res.json({ 
      success: true, 
      message: `Added ${keywords.length} keywords to ${tagName}` 
    });
  } catch (error) {
    console.error('Error adding keywords:', error);
    res.status(500).json({ error: 'Failed to add keywords' });
  }
});

export default router;
