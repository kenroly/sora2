#!/usr/bin/env node
import { runtimeConfig } from './config.js';
import { logger } from './logger.js';
import { launchBrowser } from './browser/launch.js';
import { checkCredits } from './sora/flow.js';
import { MongoProfileStore, type ProfileRecord } from './storage/mongoProfileStore.js';


async function updateCreditsForProfile(profile: ProfileRecord, profileStore: MongoProfileStore): Promise<void> {
  logger.info({ profileName: profile.name }, 'Updating credits for profile');

  try {
    const { context, page } = await launchBrowser({
      userDataDir: profile.userDataDir,
      proxy: profile.proxy,
      fingerprint: profile.fingerprint,
      onFingerprintPersist: async (fingerprint) => {
        await profileStore.setFingerprint(profile.name, fingerprint);
      }
    });

    try {
      await page.goto(runtimeConfig.SORA_BASE_URL, { waitUntil: 'domcontentloaded' });

      // Check if logged in
      const loggedIn = await page
        .locator('button:has-text("New video"), [data-testid="composer-textarea"]')
        .first()
        .elementHandle({ timeout: 5_000 })
        .catch(() => null);

      if (!loggedIn) {
        logger.warn({ profileName: profile.name }, 'Profile not logged in, skipping credit check');
        return;
      }

      // Check credits
      const creditInfo = await checkCredits(page, runtimeConfig.SORA_BASE_URL);

      if (creditInfo) {
        const creditRemaining =
          creditInfo?.rate_limit_and_credit_balance && typeof creditInfo.rate_limit_and_credit_balance === 'object'
            ? (creditInfo.rate_limit_and_credit_balance as Record<string, unknown>).estimated_num_videos_remaining
            : undefined;

        if (typeof creditRemaining === 'number') {
          await profileStore.updateCredit(profile.name, creditRemaining);
          logger.info({ profileName: profile.name, creditRemaining }, 'Updated credit info');
        } else {
          logger.warn({ profileName: profile.name }, 'Could not extract credit info');
        }
      } else {
        logger.warn({ profileName: profile.name }, 'Credit check returned no data');
      }
    } finally {
      await context.close();
    }
  } catch (error) {
    logger.error({ error, profileName: profile.name }, 'Error updating credits for profile');
  }
}

async function updateAllCredits(): Promise<void> {
  const profileStore = new MongoProfileStore({
    mongoUri: runtimeConfig.MONGODB_URI,
    databaseName: runtimeConfig.MONGODB_DATABASE,
    profileRoot: runtimeConfig.PROFILE_ROOT
  });

  await profileStore.connect();

  try {
    const profiles = await profileStore.getAllProfiles();
    logger.info({ count: profiles.length }, 'Updating credits for all profiles');

    for (const profile of profiles) {
      if (profile.status === 'disabled' || profile.status === 'blocked') {
        logger.info({ profileName: profile.name, status: profile.status }, 'Skipping profile');
        continue;
      }

      await updateCreditsForProfile(profile, profileStore);
      
      // Small delay between profiles
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }

    // Reset daily run counts
    await profileStore.resetDailyCounts();

    logger.info('Credit update cycle completed');
  } finally {
    await profileStore.disconnect();
  }
}

async function main(): Promise<void> {
  logger.info('Starting credit updater service');

  const updateInterval = runtimeConfig.UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;

  // Run immediately on start
  await updateAllCredits();

  // Then run on interval
  setInterval(async () => {
    try {
      await updateAllCredits();
    } catch (error) {
      logger.error({ error }, 'Error in credit update cycle');
    }
  }, updateInterval);

  logger.info({ intervalHours: runtimeConfig.UPDATE_INTERVAL_HOURS }, 'Credit updater running on schedule');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down credit updater');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down credit updater');
  process.exit(0);
});

main().catch((error) => {
  logger.fatal({ error }, 'Fatal error in credit updater');
  process.exit(1);
});

