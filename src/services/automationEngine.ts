import { pool } from '../config/database'

interface Condition {
  field: 'subject' | 'from' | 'to' | 'body'
  operator: 'contains' | 'equals' | 'starts_with' | 'ends_with'
  value: string
}

interface Action {
  type: 'add_tag' | 'mark_read' | 'star' | 'assign' | 'set_status'
  value: any
}

interface Rule {
  id: number
  conditions: Condition[]
  actions: Action[]
}

export async function applyAutomationRules(mailId: number, tenantId: number) {
  try {
    const rulesResult = await pool.query(
      'SELECT * FROM automation_rules WHERE tenant_id = $1 AND is_active = true',
      [tenantId]
    )

    const mailResult = await pool.query(
      'SELECT * FROM mails WHERE id = $1',
      [mailId]
    )

    const mail = mailResult.rows[0]
    if (!mail) return

    for (const rule of rulesResult.rows) {
      const conditions: Condition[] = rule.conditions
      const actions: Action[] = rule.actions

      if (checkConditions(mail, conditions)) {
        await executeActions(mailId, tenantId, actions)
      }
    }
  } catch (error) {
    console.error('Automation error:', error)
  }
}

function checkConditions(mail: any, conditions: Condition[]): boolean {
  return conditions.every(condition => {
    const fieldValue = mail[condition.field]?.toLowerCase() || ''
    const conditionValue = condition.value.toLowerCase()

    switch (condition.operator) {
      case 'contains':
        return fieldValue.includes(conditionValue)
      case 'equals':
        return fieldValue === conditionValue
      case 'starts_with':
        return fieldValue.startsWith(conditionValue)
      case 'ends_with':
        return fieldValue.endsWith(conditionValue)
      default:
        return false
    }
  })
}

async function executeActions(mailId: number, tenantId: number, actions: Action[]) {
  for (const action of actions) {
    try {
      switch (action.type) {
        case 'add_tag':
          await pool.query(
            'INSERT INTO mail_tags (mail_id, tag_id, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [mailId, action.value, tenantId]
          )
          break
        case 'mark_read':
          await pool.query(
            'UPDATE mails SET is_read = true WHERE id = $1',
            [mailId]
          )
          break
        case 'star':
          await pool.query(
            'UPDATE mails SET is_starred = true WHERE id = $1',
            [mailId]
          )
          break
        case 'assign':
          await pool.query(
            'UPDATE mails SET assigned_to = $1 WHERE id = $2',
            [action.value, mailId]
          )
          break
        case 'set_status':
          await pool.query(
            'UPDATE mails SET status = $1 WHERE id = $2',
            [action.value, mailId]
          )
          break
      }
    } catch (error) {
      console.error('Action execution error:', error)
    }
  }
}
