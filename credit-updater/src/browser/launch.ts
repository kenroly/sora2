import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { plugin } from 'playwright-with-fingerprints';
import type { Tag } from 'playwright-with-fingerprints';
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

const fingerprintEngineDir = resolve(runtimeConfig.FINGERPRINT_WORKDIR);
plugin.setWorkingFolder(fingerprintEngineDir);
plugin.setServiceKey(runtimeConfig.BABLOSOFT_API_KEY);

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
  plugin.useProxy(options.proxy, {
    changeGeolocation: true,
    changeBrowserLanguage: true,
    changeTimezone: true
  });

  const context = await plugin.launchPersistentContext(userDataDir, {
    headless: false
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await mkdir(artifactsDir, { recursive: true });

  return { context, page, artifactsDir };
}

