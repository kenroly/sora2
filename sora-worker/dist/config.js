import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
// Load .env from project root (parent of services/)
loadEnv({ path: resolve(process.cwd(), '../../.env') });
// Also try current directory
loadEnv({ path: resolve(process.cwd(), '.env') });
const schema = z.object({
    BABLOSOFT_API_KEY: z.string().min(1, 'Bablosoft key is required'),
    SORA_BASE_URL: z.string().url().default('https://sora.chatgpt.com'),
    PROFILE_ROOT: z.string().min(1).default('profiles'),
    MONGODB_URI: z.string().min(1, 'MongoDB URI is required'),
    MONGODB_DATABASE: z.string().min(1).default('sora'),
    FINGERPRINT_WORKDIR: z.string().min(1).default('.fingerprint-engine'),
    BROWSER_HEADLESS: z.preprocess((val) => {
        if (val === undefined || val === null)
            return false;
        if (typeof val === 'boolean')
            return val;
        if (typeof val === 'string') {
            const lower = val.toLowerCase().trim();
            return lower === 'true' || lower === '1';
        }
        return false;
    }, z.boolean().default(false)),
    VIDEO_UPLOAD_WEBHOOK: z.string().url().optional(),
    MONITOR_GATEWAY_URL: z.string().url().optional(),
    MONITOR_GATEWAY_TOKEN: z.string().optional(),
    MONITOR_CAPTURE_INTERVAL_MS: z.coerce.number().default(1000)
});
export const runtimeConfig = schema.parse({
    BABLOSOFT_API_KEY: process.env.BABLOSOFT_API_KEY,
    SORA_BASE_URL: process.env.SORA_BASE_URL,
    PROFILE_ROOT: process.env.PROFILE_DIR ?? process.env.PROFILE_ROOT,
    MONGODB_URI: process.env.MONGODB_URI,
    MONGODB_DATABASE: process.env.MONGODB_DATABASE,
    FINGERPRINT_WORKDIR: process.env.FINGERPRINT_WORKDIR ?? process.env.FINGERPRINT_ENGINE_DIR,
    BROWSER_HEADLESS: process.env.BROWSER_HEADLESS,
    VIDEO_UPLOAD_WEBHOOK: process.env.VIDEO_UPLOAD_WEBHOOK,
    MONITOR_GATEWAY_URL: process.env.MONITOR_GATEWAY_URL,
    MONITOR_GATEWAY_TOKEN: process.env.MONITOR_GATEWAY_TOKEN,
    MONITOR_CAPTURE_INTERVAL_MS: process.env.MONITOR_CAPTURE_INTERVAL_MS
});
