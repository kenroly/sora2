import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';
loadEnv({ path: resolve(process.cwd(), '../../.env') });
loadEnv({ path: resolve(process.cwd(), '.env') });
const schema = z.object({
    PORT: z.coerce.number().default(4100),
    HOST: z.string().default('0.0.0.0'),
    AUTH_TOKEN: z.string().optional(),
    ARTIFACTS_DIR: z.string().default(resolve(process.cwd(), '../../artifacts/monitor'))
});
export const runtimeConfig = schema.parse({
    PORT: process.env.MONITOR_GATEWAY_PORT,
    HOST: process.env.MONITOR_GATEWAY_HOST,
    AUTH_TOKEN: process.env.MONITOR_GATEWAY_TOKEN,
    ARTIFACTS_DIR: process.env.MONITOR_ARTIFACTS_DIR
});
