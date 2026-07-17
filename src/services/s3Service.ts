import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

export class S3Service {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
      endpoint: process.env.S3_ENDPOINT,
    });
    this.bucket = process.env.S3_BUCKET || 'mailcenter-attachments';
  }

  async uploadFile(file: Buffer, filename: string, contentType: string): Promise<string> {
    const key = `${crypto.randomUUID()}-${filename}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file,
        ContentType: contentType,
      })
    );

    return key;
  }

  /**
   * Upload a tenant-scoped public object for email template media.
   * Object must be reachable via S3_PUBLIC_BASE_URL (public bucket / CDN).
   */
  async uploadTenantPublicFile(params: {
    tenantId: number;
    folder: string;
    extension: string;
    file: Buffer;
    contentType: string;
  }): Promise<string> {
    const safeFolder = params.folder.replace(/[^a-z0-9/_-]/gi, '');
    const safeExt = params.extension.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    const key = `tenants/${params.tenantId}/${safeFolder}/${crypto.randomUUID()}.${safeExt}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: params.file,
        ContentType: params.contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );

    return key;
  }

  /** Permanent HTTPS URL for email clients (requires public bucket or CDN base). */
  getPublicObjectUrl(key: string): string {
    const base = String(process.env.S3_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (!base) {
      throw new Error(
        'S3_PUBLIC_BASE_URL yapılandırılmamış. Şablon görselleri için kalıcı public URL üretilemiyor.'
      );
    }
    const encodedKey = key
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    return `${base}/${encodedKey}`;
  }

  isConfigured(): boolean {
    return Boolean(
      process.env.AWS_ACCESS_KEY_ID &&
        process.env.AWS_SECRET_ACCESS_KEY &&
        process.env.S3_BUCKET
    );
  }

  async getFileUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return await getSignedUrl(this.client, command, { expiresIn });
  }

  async deleteFile(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }
}

export default new S3Service();
