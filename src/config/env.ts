import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env if present
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: parseInt(process.env.DB_PORT || '5433', 10),
  DB_USER: process.env.DB_USER || 'metering_user',
  DB_PASSWORD: process.env.DB_PASSWORD || 'metering_pass',
  DB_NAME: process.env.DB_NAME || 'usage_metering',
  DATABASE_URL:
    process.env.DATABASE_URL ||
    `postgres://${process.env.DB_USER || 'metering_user'}:${process.env.DB_PASSWORD || 'metering_pass'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5433'}/${process.env.DB_NAME || 'usage_metering'}`,
  ADMIN_API_KEY: process.env.ADMIN_API_KEY || 'admin_dev_secret_key_123',
} as const;
