import Redis from 'ioredis';

export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
});

redis.on('connect', () => {
  console.log('✓ Redis connected');
});

redis.on('error', (error) => {
  console.error('✗ Redis error:', error);
});

export default redis;
