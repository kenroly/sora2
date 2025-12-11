import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

// Load .env from project root
// .env is at project root, sora-worker is a subdirectory
// Try multiple paths in order of likelihood
const envPaths = [
  resolve(process.cwd(), '../.env'),      // Parent directory (most likely: sora-worker/.env -> ../.env)
  resolve(process.cwd(), '../../.env'),   // Old structure fallback
  resolve(process.cwd(), '.env')          // Current directory fallback
];

let loaded = false;
for (const envPath of envPaths) {
  const result = loadEnv({
    path: envPath,
    // Prefer .env values so refreshed keys override any shell exports
    override: true
  });
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
  MACHINE_ID: z.string().min(1, 'MACHINE_ID is required to identify which machine this profile belongs to'),
  FINGERPRINT_WORKDIR: z.string().min(1).default('.fingerprint-engine'),
  BROWSER_HEADLESS: z.preprocess(
    (val) => {
      if (val === undefined || val === null) return false;
      if (typeof val === 'boolean') return val;
      if (typeof val === 'string') {
        const lower = val.toLowerCase().trim();
        return lower === 'true' || lower === '1';
      }
      return false;
    },
    z.boolean().default(false)
  ),
  VIDEO_UPLOAD_WEBHOOK: z.string().url().optional(),
  MONITOR_GATEWAY_URL: z.string().url().optional(),
  MONITOR_GATEWAY_TOKEN: z.string().optional(),
  MONITOR_CAPTURE_INTERVAL_MS: z.coerce.number().default(1000)
});

export type RuntimeConfig = z.infer<typeof schema>;

let runtimeConfig: RuntimeConfig;
try {
  runtimeConfig = schema.parse({
    BABLOSOFT_API_KEY: process.env.BABLOSOFT_API_KEY,
    SORA_BASE_URL: process.env.SORA_BASE_URL,
    PROFILE_ROOT: process.env.PROFILE_DIR ?? process.env.PROFILE_ROOT,
    MONGODB_URI: process.env.MONGODB_URI,
    MONGODB_DATABASE: process.env.MONGODB_DATABASE,
    MACHINE_ID: process.env.MACHINE_ID,
    FINGERPRINT_WORKDIR: process.env.FINGERPRINT_WORKDIR ?? process.env.FINGERPRINT_ENGINE_DIR,
    BROWSER_HEADLESS: process.env.BROWSER_HEADLESS,
    VIDEO_UPLOAD_WEBHOOK: process.env.VIDEO_UPLOAD_WEBHOOK,
    MONITOR_GATEWAY_URL: process.env.MONITOR_GATEWAY_URL,
    MONITOR_GATEWAY_TOKEN: process.env.MONITOR_GATEWAY_TOKEN,
    MONITOR_CAPTURE_INTERVAL_MS: process.env.MONITOR_CAPTURE_INTERVAL_MS
  });
} catch (error) {
  if (error instanceof z.ZodError) {
    const missingFields = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    console.error(`[config] Configuration validation failed: ${missingFields}`);
    console.error(`[config] Please check your .env file. Loaded from paths:`, envPaths);
    if (!process.env.BABLOSOFT_API_KEY) {
      console.error(`[config] BABLOSOFT_API_KEY is missing. Please add it to your .env file.`);
    }
  }
  throw error;
}

export { runtimeConfig };
