#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { runtimeConfig } from './config.js';
import { launchBrowser } from './browser/launch.js';
import { MongoProfileStore } from './storage/mongoProfileStore.js';
import { logger } from './logger.js';
import { checkCredits } from './sora/flow.js';
loadEnv({ path: resolve(process.cwd(), '../../.env') });
loadEnv({ path: resolve(process.cwd(), '.env') });
async function testCreditCheck() {
    const profileName = process.argv[2] || 'acc02';
    logger.info({ profileName }, 'Starting credit check test');
    const profileStore = new MongoProfileStore({
        mongoUri: runtimeConfig.MONGODB_URI,
        databaseName: runtimeConfig.MONGODB_DATABASE,
        profileRoot: runtimeConfig.PROFILE_ROOT
    });
    await profileStore.connect();
    const profile = await profileStore.getProfile(profileName);
    if (!profile) {
        logger.error({ profileName }, 'Profile not found');
        await profileStore.disconnect();
        return;
    }
    logger.info({ profileName, proxy: profile.proxy }, 'Profile loaded');
    const { context, page } = await launchBrowser({
        userDataDir: profile.userDataDir,
        proxy: profile.proxy,
        fingerprint: profile.fingerprint,
        onFingerprintPersist: async (fingerprint) => {
            await profileStore.setFingerprint(profile.name, fingerprint);
        }
    });
    try {
        // Go to drafts page
        logger.info('Navigating to drafts page...');
        await page.goto(runtimeConfig.SORA_BASE_URL + '/drafts', { waitUntil: 'networkidle', timeout: 60_000 });
        await page.waitForTimeout(3_000);
        logger.info('Page loaded, attempting credit check...');
        // Check credits
        const creditInfo = await checkCredits(page, runtimeConfig.SORA_BASE_URL);
        if (creditInfo) {
            const creditRemaining = creditInfo?.rate_limit_and_credit_balance && typeof creditInfo.rate_limit_and_credit_balance === 'object'
                ? creditInfo.rate_limit_and_credit_balance.estimated_num_videos_remaining
                : undefined;
            if (typeof creditRemaining === 'number') {
                logger.info({ creditRemaining }, '✅ Credit check successful!');
                await profileStore.updateCredit(profile.name, creditRemaining);
                logger.info('Credit updated in database');
            }
            else {
                logger.warn({ creditInfo }, 'Credit info retrieved but could not extract number');
            }
        }
        else {
            logger.error('Failed to retrieve credit information');
        }
        logger.info('Test completed. Browser will stay open for 10 seconds for inspection...');
        await page.waitForTimeout(10_000);
    }
    catch (error) {
        logger.error({ error }, 'Error during credit check test');
    }
    finally {
        await context.close();
        await profileStore.disconnect();
    }
}
testCreditCheck().catch((error) => {
    logger.error({ error }, 'Test failed');
    process.exit(1);
});
