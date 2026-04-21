import { query } from '../config/database';

interface TagKeyword {
  tagName: string;
  keywords: string[];
}

export class AutoTagService {
  private tagKeywords: TagKeyword[] = [
    {
      tagName: 'fatura',
      keywords: ['fatura', 'invoice', 'ödeme', 'payment', 'tahsilat', 'dekont'],
    },
    {
      tagName: 'teklif',
      keywords: ['teklif', 'proposal', 'quotation', 'quote', 'öneri', 'offer'],
    },
    {
      tagName: 'müşteri',
      keywords: ['müşteri', 'customer', 'client', 'destek', 'support', 'talep'],
    },
  ];

  async autoTagMail(
    mailId: number,
    subject: string,
    bodyPreview: string,
    tenantId: number
  ): Promise<void> {
    try {
      const content = `${subject} ${bodyPreview}`.toLowerCase();
      const matchedTags = this.findMatchingTags(content);

      if (matchedTags.length === 0) {
        return;
      }

      const tagIds = await this.getTagIds(matchedTags, tenantId);

      for (const tagId of tagIds) {
        await this.addTagToMail(mailId, tagId, tenantId);
      }

      console.log(`✓ Auto-tagged mail ${mailId} with ${tagIds.length} tags`);
    } catch (error) {
      console.error('Error in auto-tagging:', error);
    }
  }

  private findMatchingTags(content: string): string[] {
    const matched: string[] = [];

    for (const tagKeyword of this.tagKeywords) {
      const hasMatch = tagKeyword.keywords.some((keyword) =>
        content.includes(keyword.toLowerCase())
      );

      if (hasMatch && !matched.includes(tagKeyword.tagName)) {
        matched.push(tagKeyword.tagName);
      }
    }

    return matched;
  }

  private async getTagIds(tagNames: string[], tenantId: number): Promise<number[]> {
    try {
      const placeholders = tagNames.map((_, i) => `$${i + 2}`).join(', ');
      const result = await query(
        `SELECT id FROM tags WHERE name IN (${placeholders}) AND tenant_id = $1`,
        [tenantId, ...tagNames]
      );

      return result.rows.map((row) => row.id);
    } catch (error) {
      console.error('Error getting tag IDs:', error);
      return [];
    }
  }

  private async addTagToMail(
    mailId: number,
    tagId: number,
    tenantId: number
  ): Promise<void> {
    try {
      await query(
        `INSERT INTO mail_tags (mail_id, tag_id, tenant_id) 
         VALUES ($1, $2, $3) 
         ON CONFLICT DO NOTHING`,
        [mailId, tagId, tenantId]
      );
    } catch (error) {
      console.error('Error adding tag to mail:', error);
    }
  }

  addCustomKeywords(tagName: string, keywords: string[]): void {
    const existing = this.tagKeywords.find((tk) => tk.tagName === tagName);
    if (existing) {
      existing.keywords.push(...keywords);
    } else {
      this.tagKeywords.push({ tagName, keywords });
    }
  }

  getKeywords(): TagKeyword[] {
    return this.tagKeywords;
  }
}
