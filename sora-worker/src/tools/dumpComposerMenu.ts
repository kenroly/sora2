#!/usr/bin/env node
import '../browser/initFingerprint.js';

import { join } from 'node:path';
import { cac } from 'cac';
import { runtimeConfig } from '../config.js';
import { launchBrowser } from '../browser/launch.js';
import { ensureAuthenticated } from '../sora/flow.js';
import { MongoProfileStore } from '../storage/mongoProfileStore.js';
import { logger } from '../logger.js';

const cli = cac('dump-composer-menu');

cli
  .option('--profile <name>', 'Profile identifier', {
    default: 'acc01'
  })
  .option('--skip-auth-check', 'Skip auth check if session already stored', {
    default: true
  })
  .help();

async function dumpMenu(profileName: string, skipAuthCheck: boolean): Promise<void> {
  const profileStore = new MongoProfileStore({
    mongoUri: runtimeConfig.MONGODB_URI,
    databaseName: runtimeConfig.MONGODB_DATABASE,
    profileRoot: runtimeConfig.PROFILE_ROOT,
    machineId: runtimeConfig.MACHINE_ID
  });

  await profileStore.connect();
  const profile = await profileStore.ensureProfile(profileName);

  logger.info({ profile: profile.name }, 'Launching browser to inspect composer menu');

  const { context, page, artifactsDir } = await launchBrowser({
    userDataDir: profile.userDataDir,
    proxy: profile.proxy,
    fingerprint: profile.fingerprint,
    onFingerprintPersist: async (fingerprint) => {
      await profileStore.setFingerprint(profile.name, fingerprint);
    }
  });

  try {
    await ensureAuthenticated(
      page,
      runtimeConfig.SORA_BASE_URL,
      false,
      artifactsDir,
      skipAuthCheck
    );

    const draftsUrl = new URL('/drafts', runtimeConfig.SORA_BASE_URL).toString();
    await page.goto(draftsUrl, { waitUntil: 'domcontentloaded' });

    const settingsButton = page.getByRole('button', { name: /^settings$/i }).last();
    await settingsButton.click();
    await page.waitForTimeout(1000);

    const menuLocator = page.locator('[role="menu"]').first();
    const menuHtml = await menuLocator.evaluate((el) => el.outerHTML).catch(() => null);
    const menuItems = await page.getByRole('menuitem').all();
    const menuTexts = await Promise.all(
      menuItems.map(async (item) => {
        try {
          return await item.textContent();
        } catch {
          return null;
        }
      })
    );

    logger.info(
      { htmlLength: menuHtml?.length ?? 0, menuTexts: menuTexts.filter(Boolean) },
      'Composer menu dump'
    );

    if (artifactsDir) {
      const screenshotPath = join(artifactsDir, 'composer-menu.png');
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      logger.info({ screenshotPath }, 'Saved composer menu screenshot');
    }

    if (menuHtml) {
      console.log('----- ROOT MENU HTML START -----');
      console.log(menuHtml);
      console.log('----- ROOT MENU HTML END -----');
    } else {
      console.log('Could not capture root menu HTML');
    }

    const durationTrigger = page.getByRole('menuitem', { name: /^Duration/i }).first();
    if (await durationTrigger.isVisible().catch(() => false)) {
      await durationTrigger.click();
      await page.waitForTimeout(500);
      const durationMenu = page.locator('[role="menu"]').last();
      const durationHtml = await durationMenu.evaluate((el) => el.outerHTML).catch(() => null);
      const durationItems = await durationMenu
        .getByRole('menuitem')
        .allTextContents()
        .catch(() => []);
      logger.info({ durationItems }, 'Duration submenu items');
      if (durationHtml) {
        console.log('----- DURATION MENU HTML START -----');
        console.log(durationHtml);
        console.log('----- DURATION MENU HTML END -----');
      } else {
        console.log('Could not capture duration menu HTML');
      }

      const option10 = durationMenu
        .getByRole('menuitemradio', { name: /10\s*(seconds|sec|s)?/i })
        .first();
      if (await option10.isVisible().catch(() => false)) {
        await option10.click();
        await page.waitForTimeout(500);
        logger.info('Selected 10s option successfully');
      } else {
        logger.warn('Could not find 10s option to select');
      }

      // Reopen menu to show current selection
      await durationTrigger.click();
      await page.waitForTimeout(200);
      const updatedHtml = await durationMenu.evaluate((el) => el.outerHTML).catch(() => null);
      if (updatedHtml) {
        console.log('----- DURATION MENU HTML AFTER SELECTION START -----');
        console.log(updatedHtml);
        console.log('----- DURATION MENU HTML AFTER SELECTION END -----');
      }
    } else {
      console.log('Duration trigger not visible');
    }
  } finally {
    await context.close();
    await profileStore.disconnect();
  }
}

const parsed = cli.parse();
const flags = parsed.options as { profile: string; skipAuthCheck?: boolean };
const profile = flags.profile ?? 'acc01';
const skipAuthCheck = flags.skipAuthCheck !== false;

dumpMenu(profile, skipAuthCheck)
  .then(() => {
    logger.info('Composer menu inspection finished');
    process.exit(0);
  })
  .catch((error) => {
    logger.error({ error }, 'Composer menu inspection failed');
    process.exit(1);
  });

