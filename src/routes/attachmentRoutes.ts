import { Router, Response } from 'express'
import { pool } from '../config/database'
import { authenticate, AuthRequest } from '../middleware/auth'
import multer from 'multer'
import path from 'path'
import fs from 'fs'

const router = Router()

const storage = multer.diskStorage({
  destination: (req: any, file: any, cb: any) => {
    const uploadDir = path.join(__dirname, '../../uploads')
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }
    cb(null, uploadDir)
  },
  filename: (req: any, file: any, cb: any) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, uniqueSuffix + '-' + file.originalname)
  }
})

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
})

router.post('/upload', authenticate, upload.single('file'), async (req: AuthRequest & { file?: Express.Multer.File }, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' })
    }

    const { mailId } = req.body
    
    const result = await pool.query(
      `INSERT INTO attachments (mail_id, filename, content_type, size_bytes, storage_path, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [mailId, req.file.originalname, req.file.mimetype, req.file.size, req.file.path, req.user!.tenantId]
    )

    res.json({ success: true, data: result.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to upload attachment' })
  }
})

router.get('/mail/:mailId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM attachments WHERE mail_id = $1 AND tenant_id = $2',
      [req.params.mailId, req.user!.tenantId]
    )
    res.json({ success: true, data: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch attachments' })
  }
})

router.get('/download/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM attachments WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.user!.tenantId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Attachment not found' })
    }

    const attachment = result.rows[0]
    res.download(attachment.storage_path, attachment.filename)
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to download attachment' })
  }
})

export default router
