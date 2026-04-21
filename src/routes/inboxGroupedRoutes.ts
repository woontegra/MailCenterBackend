import { Router, Response } from 'express'
import { pool } from '../config/database'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/grouped', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { company_name } = req.query

    let accountsQuery = `
      SELECT id, name, email, company_name
      FROM mail_accounts
      WHERE tenant_id = $1 AND is_active = true
    `
    const params: any[] = [req.user!.tenantId]

    if (company_name) {
      accountsQuery += ` AND company_name = $2`
      params.push(company_name)
    }

    accountsQuery += ` ORDER BY company_name, name`

    const accountsResult = await pool.query(accountsQuery, params)
    const accounts = accountsResult.rows

    const groupedByCompany = accounts.reduce((acc: any, account: any) => {
      const company = account.company_name || 'Diğer'
      if (!acc[company]) {
        acc[company] = {
          companyName: company,
          accounts: [],
          accountIds: []
        }
      }
      acc[company].accounts.push(account)
      acc[company].accountIds.push(account.id)
      return acc
    }, {})

    for (const company in groupedByCompany) {
      const accountIds = groupedByCompany[company].accountIds

      const mailsResult = await pool.query(`
        SELECT m.*, ma.email as account_email, ma.name as account_name,
          json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color)) FILTER (WHERE t.id IS NOT NULL) as tags
        FROM mails m
        LEFT JOIN mail_accounts ma ON m.account_id = ma.id
        LEFT JOIN mail_tags mt ON m.id = mt.mail_id
        LEFT JOIN tags t ON mt.tag_id = t.id
        WHERE m.tenant_id = $1 AND m.account_id = ANY($2) AND m.is_deleted = false
        GROUP BY m.id, ma.email, ma.name
        ORDER BY m.date DESC
        LIMIT 50
      `, [req.user!.tenantId, accountIds])

      groupedByCompany[company].mails = mailsResult.rows
      groupedByCompany[company].mailCount = mailsResult.rows.length
      delete groupedByCompany[company].accountIds
    }

    const result = Object.values(groupedByCompany)

    res.json({ success: true, data: result })
  } catch (error) {
    console.error('Error fetching grouped inbox:', error)
    res.status(500).json({ success: false, error: 'Failed to fetch grouped inbox' })
  }
})

router.get('/companies', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        COALESCE(company_name, 'Diğer') as company_name,
        COUNT(*) as account_count,
        json_agg(json_build_object('id', id, 'name', name, 'email', email)) as accounts
      FROM mail_accounts
      WHERE tenant_id = $1 AND is_active = true
      GROUP BY company_name
      ORDER BY company_name
    `, [req.user!.tenantId])

    res.json({ success: true, data: result.rows })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch companies' })
  }
})

router.get('/companies/:companyName/stats', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { companyName } = req.params
    
    const accountsResult = await pool.query(
      'SELECT id FROM mail_accounts WHERE tenant_id = $1 AND company_name = $2 AND is_active = true',
      [req.user!.tenantId, companyName]
    )

    const accountIds = accountsResult.rows.map(r => r.id)

    if (accountIds.length === 0) {
      return res.json({ success: true, data: { totalMails: 0, unreadMails: 0, starredMails: 0 } })
    }

    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_mails,
        COUNT(*) FILTER (WHERE is_read = false) as unread_mails,
        COUNT(*) FILTER (WHERE is_starred = true) as starred_mails
      FROM mails
      WHERE tenant_id = $1 AND account_id = ANY($2) AND is_deleted = false
    `, [req.user!.tenantId, accountIds])

    res.json({ success: true, data: statsResult.rows[0] })
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch company stats' })
  }
})

export default router
