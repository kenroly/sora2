// This file MUST be imported BEFORE any playwright-with-fingerprints imports
// It ensures FINGERPRINT_CWD is set before engine initialization
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// CRITICAL: Load .env FIRST before reading FINGERPRINT_WORKDIR
// Load from project root (parent of services/)
loadEnv({ path: resolve(process.cwd(), '../../.env') });
// Also try current directory
loadEnv({ path: resolve(process.cwd(), '.env') });
// Get the directory where this file is located (sora-worker/src/browser)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const soraWorkerDir = resolve(__dirname, '../..');
// ALWAYS set FINGERPRINT_CWD from FINGERPRINT_WORKDIR if available
// Priority: FINGERPRINT_WORKDIR (from .env) > default to sora-worker/.fingerprint-engine
let fingerprintDir;
if (process.env.FINGERPRINT_WORKDIR) {
    fingerprintDir = resolve(process.env.FINGERPRINT_WORKDIR);
}
else {
    // Default to sora-worker/.fingerprint-engine (not process.cwd() which might be orchestrator)
    fingerprintDir = resolve(soraWorkerDir, '.fingerprint-engine');
}
// ALWAYS set FINGERPRINT_CWD (override any existing value to ensure correctness)
process.env.FINGERPRINT_CWD = fingerprintDir;
// Export the path for use in launch.ts
export const FINGERPRINT_ENGINE_DIR = fingerprintDir;
