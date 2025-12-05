import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

// Load .env from project root
const envPaths = [
  resolve(process.cwd(), '../.env'),      // Parent directory (most likely)
  resolve(process.cwd(), '../../.env'),   // Old structure fallback
  resolve(process.cwd(), '.env')          // Current directory fallback
];

let loaded = false;
for (const envPath of envPaths) {
  const result = loadEnv({ path: envPath });
  if (!result.error) {
    console.log(`[config] Loaded .env from: ${envPath}`);
    loaded = true;
    break;
  }
}

if (!loaded) {
  console.warn(`[config] Could not load .env. Tried paths:`, envPaths);
}

const schema = z.object({
  BABLOSOFT_API_KEY: z.string().min(1, 'Bablosoft key is required'),
  SORA_BASE_URL: z.string().url().default('https://sora.chatgpt.com'),
  PROFILE_ROOT: z.string().min(1).default('profiles'),
  MONGODB_URI: z.string().min(1, 'MongoDB URI is required'),
  MONGODB_DATABASE: z.string().min(1).default('sora'),
  MACHINE_ID: z.string().min(1, 'MACHINE_ID is required to identify which machine this service runs on'),
  FINGERPRINT_WORKDIR: z.string().min(1).default('.fingerprint-engine'),
  // Run hourly by default
  UPDATE_INTERVAL_HOURS: z.coerce.number().default(1)
});

export type RuntimeConfig = z.infer<typeof schema>;

export const runtimeConfig: RuntimeConfig = schema.parse({
  BABLOSOFT_API_KEY: process.env.BABLOSOFT_API_KEY,
  SORA_BASE_URL: process.env.SORA_BASE_URL,
  PROFILE_ROOT: process.env.PROFILE_DIR ?? process.env.PROFILE_ROOT,
  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DATABASE: process.env.MONGODB_DATABASE,
  MACHINE_ID: process.env.MACHINE_ID,
  FINGERPRINT_WORKDIR: process.env.FINGERPRINT_WORKDIR ?? process.env.FINGERPRINT_ENGINE_DIR,
  UPDATE_INTERVAL_HOURS: process.env.UPDATE_INTERVAL_HOURS
});


