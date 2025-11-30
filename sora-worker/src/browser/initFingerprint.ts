// This file MUST be imported BEFORE any playwright-with-fingerprints imports
// It ensures FINGERPRINT_CWD is set before engine initialization

import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// CRITICAL: Load .env FIRST before reading FINGERPRINT_WORKDIR
// Load from project root
const envPaths = [
  resolve(process.cwd(), '../.env'),      // Parent directory (most likely)
  resolve(process.cwd(), '../../.env'),   // Old structure fallback
  resolve(process.cwd(), '.env')          // Current directory fallback
];

let loaded = false;
for (const envPath of envPaths) {
  const result = loadEnv({ path: envPath });
  if (!result.error) {
    loaded = true;
    break;
  }
}

// Get the directory where this file is located (sora-worker/src/browser)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const soraWorkerDir = resolve(__dirname, '../..');

// ALWAYS set FINGERPRINT_CWD from FINGERPRINT_WORKDIR if available
// Priority: FINGERPRINT_WORKDIR (from .env) > default to sora-worker/.fingerprint-engine
let fingerprintDir: string;
if (process.env.FINGERPRINT_WORKDIR) {
  fingerprintDir = resolve(process.env.FINGERPRINT_WORKDIR);
} else {
  // Default to sora-worker/.fingerprint-engine (not process.cwd() which might be orchestrator)
  fingerprintDir = resolve(soraWorkerDir, '.fingerprint-engine');
}

// ALWAYS set FINGERPRINT_CWD (override any existing value to ensure correctness)
process.env.FINGERPRINT_CWD = fingerprintDir;

// Export the path for use in launch.ts
export const FINGERPRINT_ENGINE_DIR = fingerprintDir;

