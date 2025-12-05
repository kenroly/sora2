// CRITICAL: Import initFingerprint FIRST to set FINGERPRINT_CWD before any other imports
import './initFingerprint.js';
import { FINGERPRINT_ENGINE_DIR } from './initFingerprint.js';

import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { plugin } from 'playwright-with-fingerprints';
import type { Tag } from 'playwright-with-fingerprints';
// CRITICAL: Import ensureEngineCwd AFTER playwright-with-fingerprints to patch engine
import './ensureEngineCwd.js';
import { runtimeConfig } from '../config.js';
import { logger } from '../logger.js';

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  artifactsDir: string;
}

interface LaunchOptions {
  userDataDir: string;
  proxy: string;
  fingerprint?: string | null;
  onFingerprintPersist?: (fingerprint: string) => Promise<void> | void;
}

// Use the path from initFingerprint (already set in env)
const finalFingerprintDir = FINGERPRINT_ENGINE_DIR;

// Ensure env is set (should already be set by initFingerprint, but double-check)
process.env.FINGERPRINT_CWD = finalFingerprintDir;

// CRITICAL: Set working folder IMMEDIATELY after import
// This calls engine.setCwd() to ensure this.#cwd is set before any engine operations
// The FINGERPRINT_CWD env var should already be set by initFingerprint.ts before playwright-with-fingerprints was imported
// But we call setWorkingFolder to be absolutely sure
// IMPORTANT: Call setWorkingFolder BEFORE any plugin operations (fetch, useFingerprint, etc.)
plugin.setWorkingFolder(finalFingerprintDir);

// Set API key both via plugin method and environment variable (some engines require env var)
const apiKey = runtimeConfig.BABLOSOFT_API_KEY;
if (!apiKey || apiKey.trim().length === 0) {
  throw new Error('BABLOSOFT_API_KEY is required but is missing or empty. Please check your .env file.');
}
process.env.BABLOSOFT_API_KEY = apiKey;
process.env.SERVICE_KEY = apiKey; // Some engines use SERVICE_KEY
plugin.setServiceKey(apiKey);
logger.info({ 
  apiKeySet: true, 
  apiKeyLength: apiKey.length,
  apiKeyPrefix: apiKey.substring(0, 8) + '...'
}, 'Bablosoft API key configured');

const DEFAULT_TAGS: Tag[] = ['Microsoft Windows', 'Chrome'];

export async function launchBrowser(options: LaunchOptions): Promise<BrowserSession> {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'sora-artifacts-'));
  const userDataDir = resolve(options.userDataDir);
  await mkdir(userDataDir, { recursive: true });

  logger.info({ userDataDir, artifactsDir }, 'Launching Bablosoft fingerprinted browser');

  let fingerprint = options.fingerprint;
  if (!fingerprint) {
    logger.info({ tags: DEFAULT_TAGS }, 'Requesting fingerprint from FingerprintSwitcher');
    fingerprint = await plugin.fetch({ tags: DEFAULT_TAGS });
    if (options.onFingerprintPersist) {
      await options.onFingerprintPersist(fingerprint);
    }
  } else {
    logger.info('Reusing persisted fingerprint for this profile');
  }

  plugin.useFingerprint(fingerprint);
  // Only use proxy if provided and not empty
  if (options.proxy && options.proxy.trim()) {
    logger.info({ proxy: options.proxy }, 'Applying proxy from profile');
    plugin.useProxy(options.proxy, {
      changeGeolocation: true,
      changeBrowserLanguage: true,
      changeTimezone: true
    });
  } else {
    logger.warn('No proxy provided or proxy is empty - browser will run without proxy');
  }

  logger.info({ 
    headless: runtimeConfig.BROWSER_HEADLESS,
    userDataDir 
  }, 'Launching browser (headless=false means visible window)');

  const context = await plugin.launchPersistentContext(userDataDir, {
    headless: runtimeConfig.BROWSER_HEADLESS
  });

  logger.info({ 
    contextLaunched: true,
    pagesCount: context.pages().length 
  }, 'Browser context launched successfully');

  const page = context.pages()[0] ?? (await context.newPage());
  await mkdir(artifactsDir, { recursive: true });

  return { context, page, artifactsDir };
}

