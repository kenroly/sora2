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
  PORT: z.coerce.number().default(4100),
  HOST: z.string().default('0.0.0.0'),
  AUTH_TOKEN: z.string().optional(),
  ARTIFACTS_DIR: z.string().default(resolve(process.cwd(), '../../artifacts/monitor'))
});

export type RuntimeConfig = z.infer<typeof schema>;

export const runtimeConfig: RuntimeConfig = schema.parse({
  PORT: process.env.MONITOR_GATEWAY_PORT,
  HOST: process.env.MONITOR_GATEWAY_HOST,
  AUTH_TOKEN: process.env.MONITOR_GATEWAY_TOKEN,
  ARTIFACTS_DIR: process.env.MONITOR_ARTIFACTS_DIR
});


