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
  API_BASE_URL: z.string().url().default('https://media.furtalk.net/api/v1/tool'),
  API_KEY: z.string().min(1, 'API Key is required'),
  PRODUCT_CODE: z.string().default('sora-2-with-watermark'),
  MONGODB_URI: z.string().min(1, 'MongoDB URI is required'),
  MONGODB_DATABASE: z.string().min(1).default('sora'),
  MACHINE_ID: z.string().min(1, 'MACHINE_ID is required to identify which machine this orchestrator runs on'),
  PROFILE_ROOT: z.string().min(1).default('profiles'),
  FINGERPRINT_DIR_HOST: z.string().optional(),
  FINGERPRINT_WORKDIR: z.string().optional(),
  WORKER_ENTRY: z.string().optional(),
  TASK_TIMEOUT_MINUTES: z.coerce.number().default(25),
  POLL_INTERVAL_SECONDS: z.coerce.number().default(10),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  MONITOR_GATEWAY_URL: z.string().url().optional(),
  MONITOR_GATEWAY_TOKEN: z.string().optional(),
  MONITOR_CAPTURE_INTERVAL_MS: z.coerce.number().default(1000),
  MAX_CONCURRENT_WORKERS: z.coerce.number().min(1).default(1)
});

export type RuntimeConfig = z.infer<typeof schema>;

export const runtimeConfig: RuntimeConfig = schema.parse({
  API_BASE_URL: process.env.API_BASE_URL,
  API_KEY: process.env.API_KEY || process.env.TOOL_API_KEY,
  PRODUCT_CODE: process.env.PRODUCT_CODE,
  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DATABASE: process.env.MONGODB_DATABASE,
  MACHINE_ID: process.env.MACHINE_ID,
  PROFILE_ROOT: process.env.PROFILE_ROOT,
  FINGERPRINT_DIR_HOST: process.env.FINGERPRINT_DIR_HOST ?? resolve(process.cwd(), '../sora-worker/.fingerprint-engine'),
  FINGERPRINT_WORKDIR: process.env.FINGERPRINT_WORKDIR,
  WORKER_ENTRY: process.env.WORKER_ENTRY,
  TASK_TIMEOUT_MINUTES: process.env.TASK_TIMEOUT_MINUTES,
  POLL_INTERVAL_SECONDS: process.env.POLL_INTERVAL_SECONDS,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  MONITOR_GATEWAY_URL: process.env.MONITOR_GATEWAY_URL,
  MONITOR_GATEWAY_TOKEN: process.env.MONITOR_GATEWAY_TOKEN,
  MONITOR_CAPTURE_INTERVAL_MS: process.env.MONITOR_CAPTURE_INTERVAL_MS,
  MAX_CONCURRENT_WORKERS: process.env.MAX_CONCURRENT_WORKERS
});

