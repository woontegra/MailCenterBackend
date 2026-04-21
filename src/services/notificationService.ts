import { pool } from '../config/database'

export async function createNotification(
  userId: number,
  tenantId: number,
  type: string,
  title: string,
  message: string,
  data?: any
) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, tenant_id, type, title, message, data) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, tenantId, type, title, message, JSON.stringify(data || {})]
    )
  } catch (error) {
    console.error('Failed to create notification:', error)
  }
}

export async function notifyNewMail(tenantId: number, mailId: number, subject: string, from: string) {
  try {
    const users = await pool.query('SELECT id FROM users WHERE tenant_id = $1 AND is_active = true', [tenantId])
    
    for (const user of users.rows) {
      await createNotification(
        user.id,
        tenantId,
        'new_mail',
        'Yeni Mail',
        `${from} tarafından: ${subject}`,
        { mailId }
      )
    }
  } catch (error) {
    console.error('Failed to notify new mail:', error)
  }
}
