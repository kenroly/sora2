import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const schema = z.object({
  BABLOSOFT_API_KEY: z.string().min(1, 'Bablosoft key is required'),
  SORA_BASE_URL: z.string().url().default('https://sora.chatgpt.com'),
  PROFILE_ROOT: z.string().min(1).default('profiles'),
  MONGODB_URI: z.string().min(1, 'MongoDB URI is required'),
  MONGODB_DATABASE: z.string().min(1).default('sora'),
  FINGERPRINT_WORKDIR: z.string().min(1).default('.fingerprint-engine'),
  UPDATE_INTERVAL_HOURS: z.coerce.number().default(24)
});

export type RuntimeConfig = z.infer<typeof schema>;

export const runtimeConfig: RuntimeConfig = schema.parse({
  BABLOSOFT_API_KEY: process.env.BABLOSOFT_API_KEY,
  SORA_BASE_URL: process.env.SORA_BASE_URL,
  PROFILE_ROOT: process.env.PROFILE_DIR ?? process.env.PROFILE_ROOT,
  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DATABASE: process.env.MONGODB_DATABASE,
  FINGERPRINT_WORKDIR: process.env.FINGERPRINT_WORKDIR ?? process.env.FINGERPRINT_ENGINE_DIR,
  UPDATE_INTERVAL_HOURS: process.env.UPDATE_INTERVAL_HOURS
});


