#!/usr/bin/env node
// Test script to capture HTML structure of Sora composer
import './browser/initFingerprint.js';

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { launchBrowser } from './browser/launch.js';
import { ensureAuthenticated } from './sora/flow.js';
import { logger } from './logger.js';
import { MongoProfileStore } from './storage/mongoProfileStore.js';
import { runtimeConfig } from './config.js';

async function main() {
  const profileName = 'acc01';
  
  // Try to load from MongoDB, but fallback to direct path if MongoDB fails
  let userDataDir: string;
  let proxy: string | undefined;
  let fingerprint: string | null = null;
  
  try {
    const profileStore = new MongoProfileStore({
      mongoUri: runtimeConfig.MONGODB_URI,
      databaseName: runtimeConfig.MONGODB_DATABASE,
      profileRoot: runtimeConfig.PROFILE_ROOT,
      machineId: runtimeConfig.MACHINE_ID
    });

    await profileStore.connect();
    const profile = await profileStore.ensureProfile(profileName);
    userDataDir = profile.userDataDir;
    proxy = profile.proxy;
    fingerprint = profile.fingerprint;

    logger.info({ 
      profileName: profile.name,
      proxy: profile.proxy || '(empty - no proxy)',
      hasProxy: !!profile.proxy && profile.proxy.trim().length > 0
    }, 'Profile loaded from MongoDB');
    
    await profileStore.disconnect();
  } catch (error) {
    logger.warn({ error }, 'Failed to load from MongoDB, using direct path');
    // Fallback: use direct path
    const { resolve } = await import('node:path');
    userDataDir = resolve(runtimeConfig.PROFILE_ROOT, profileName);
    proxy = undefined;
    logger.info({ userDataDir }, 'Using direct profile path');
  }

  const { context, page, artifactsDir } = await launchBrowser({
    userDataDir,
    proxy,
    fingerprint: fingerprint || undefined,
    onFingerprintPersist: async (fingerprint) => {
      // Try to save to MongoDB if available, but don't fail if it's not
      try {
        const profileStore = new MongoProfileStore({
          mongoUri: runtimeConfig.MONGODB_URI,
          databaseName: runtimeConfig.MONGODB_DATABASE,
          profileRoot: runtimeConfig.PROFILE_ROOT,
          machineId: runtimeConfig.MACHINE_ID
        });
        await profileStore.connect();
        await profileStore.setFingerprint(profileName, fingerprint);
        await profileStore.disconnect();
      } catch (error) {
        logger.warn({ error }, 'Failed to save fingerprint to MongoDB');
      }
    }
  });

  try {
    // Authenticate
    await ensureAuthenticated(
      page,
      runtimeConfig.SORA_BASE_URL,
      false, // requireManualLogin
      artifactsDir,
      true // skipAuthCheck
    );

    // Navigate to drafts
    const draftsUrl = new URL('/drafts', runtimeConfig.SORA_BASE_URL).toString();
    await page.goto(draftsUrl, { waitUntil: 'networkidle', timeout: 120_000 });
    logger.info({ draftsUrl }, 'Opened drafts workspace');

    // Wait for composer to be ready
    await page.waitForTimeout(3_000);

    // Find the prompt box
    const promptBox = page.getByPlaceholder('Describe your video...').first();
    await promptBox.waitFor({ state: 'visible', timeout: 30_000 });
    logger.info('Prompt box found');

    // Capture full page HTML
    const fullHtml = await page.content();
    await writeFile(join(artifactsDir, 'full-page.html'), fullHtml);
    logger.info({ path: join(artifactsDir, 'full-page.html') }, 'Saved full page HTML');

    // Capture composer area HTML
    const composerContainer = promptBox.locator('xpath=ancestor::div[contains(@class, "composer") or contains(@class, "popover")]').first();
    const composerCount = await composerContainer.count();
    
    if (composerCount > 0) {
      const composerHtml = await composerContainer.innerHTML();
      await writeFile(join(artifactsDir, 'composer-area.html'), composerHtml);
      logger.info({ path: join(artifactsDir, 'composer-area.html') }, 'Saved composer area HTML');
    }

    // Find all buttons near the prompt box
    const buttonsNearPrompt = page.locator('button').all();
    const buttonList = await buttonsNearPrompt;
    logger.info({ buttonCount: buttonList.length }, 'Found buttons on page');

    // Try to find attach media button by different methods
    logger.info('=== Testing different selectors for Attach media button ===');
    
    // Method 1: SVG icon
    const buttonBySvg1 = page.locator('button:has(svg path[d*="M12 6a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H7a1 1 0 1 1 0-2h4V7a1 1 0 0 1 1-1"])').first();
    const count1 = await buttonBySvg1.count();
    logger.info({ method: 'SVG full path', count: count1, visible: count1 > 0 ? await buttonBySvg1.isVisible().catch(() => false) : false });

    // Method 2: SVG shorter path
    const buttonBySvg2 = page.locator('button:has(svg path[d*="M12 6"])').first();
    const count2 = await buttonBySvg2.count();
    logger.info({ method: 'SVG short path', count: count2, visible: count2 > 0 ? await buttonBySvg2.isVisible().catch(() => false) : false });

    // Method 3: aria-label
    const buttonByAria = page.locator('button:has(span.sr-only:has-text("Attach media"))').first();
    const count3 = await buttonByAria.count();
    logger.info({ method: 'aria-label', count: count3, visible: count3 > 0 ? await buttonByAria.isVisible().catch(() => false) : false });

    // Method 4: In flex-wrap container
    const flexContainer = page.locator('div.flex.flex-wrap').first();
    const flexCount = await flexContainer.count();
    if (flexCount > 0) {
      const buttonInFlex = flexContainer.locator('button:has(svg path[d*="M12"])').first();
      const count4 = await buttonInFlex.count();
      logger.info({ method: 'In flex-wrap', count: count4, visible: count4 > 0 ? await buttonInFlex.isVisible().catch(() => false) : false });
      
      if (count4 > 0) {
        const buttonHtml = await buttonInFlex.innerHTML();
        await writeFile(join(artifactsDir, 'attach-button.html'), buttonHtml);
        logger.info({ path: join(artifactsDir, 'attach-button.html') }, 'Saved attach button HTML');
      }
    }

    // Find all file inputs
    const fileInputs = page.locator('input[type="file"]').all();
    const fileInputList = await fileInputs;
    logger.info({ fileInputCount: fileInputList.length }, 'Found file inputs');
    
    for (let i = 0; i < fileInputList.length; i++) {
      const input = fileInputList[i];
      const accept = await input.getAttribute('accept').catch(() => '');
      const className = await input.getAttribute('class').catch(() => '');
      const isVisible = await input.isVisible().catch(() => false);
      logger.info({ 
        index: i + 1, 
        accept, 
        class: className,
        visible: isVisible 
      }, 'File input details');
    }

    // Take screenshot
    await page.screenshot({ path: join(artifactsDir, 'composer-screenshot.png'), fullPage: true });
    logger.info({ path: join(artifactsDir, 'composer-screenshot.png') }, 'Saved screenshot');

    logger.info('Test completed. Check artifacts folder for HTML files.');
    logger.info({ artifactsDir }, 'Artifacts directory');

    // Test clicking the attach media button
    logger.info('=== Testing Attach media button click ===');
    
    // Find button by sr-only span (most reliable)
    const attachButton = page.locator('button:has(span.sr-only:has-text("Attach media"))').first();
    const buttonCount = await attachButton.count();
    const buttonVisible = buttonCount > 0 ? await attachButton.isVisible({ timeout: 5_000 }).catch(() => false) : false;
    
    logger.info({ buttonCount, buttonVisible }, 'Attach media button status');
    
    if (buttonCount > 0 && buttonVisible) {
      logger.info('Attempting to click Attach media button...');
      
      try {
        await attachButton.click();
        logger.info('Clicked Attach media button successfully');
        await page.waitForTimeout(2_000);
        
        // Check if agreement dialog appears
        const agreementDialog = page.locator('div[role="dialog"]:has-text("Media upload agreement"), div[role="dialog"]:has-text("agreement")').first();
        const hasDialog = await agreementDialog.isVisible({ timeout: 3_000 }).catch(() => false);
        
        if (hasDialog) {
          logger.info('✅ Agreement dialog appeared after click!');
          
          // Count checkboxes
          const checkboxes = await agreementDialog.locator('button[role="checkbox"]').all();
          logger.info({ checkboxCount: checkboxes.length }, 'Found checkboxes in dialog');
          
          // Try to tick all checkboxes
          for (let i = 0; i < checkboxes.length; i++) {
            const checkbox = checkboxes[i];
            const isChecked = await checkbox.getAttribute('aria-checked').catch(() => 'false');
            logger.info({ index: i + 1, isChecked }, 'Checkbox status');
            
            if (isChecked !== 'true') {
              logger.info({ index: i + 1 }, 'Clicking checkbox...');
              await checkbox.click();
              await page.waitForTimeout(300);
            }
          }
          
          // Find Accept button
          const acceptButton = agreementDialog.locator('button:has-text("Accept"), button:has-text("accept")').first();
          const acceptVisible = await acceptButton.isVisible({ timeout: 2_000 }).catch(() => false);
          const acceptDisabled = acceptVisible ? await acceptButton.getAttribute('data-disabled').catch(() => 'true') : 'true';
          
          logger.info({ acceptVisible, acceptDisabled }, 'Accept button status');
          
          if (acceptVisible && acceptDisabled !== 'true') {
            logger.info('Clicking Accept button...');
            await acceptButton.click();
            await page.waitForTimeout(1_000);
            logger.info('✅ Clicked Accept button');
          } else {
            logger.warn('Accept button not visible or disabled');
          }
          
          // Capture screenshot after dialog interaction
          await page.screenshot({ path: join(artifactsDir, 'after-dialog-interaction.png'), fullPage: true });
          logger.info('Saved screenshot after dialog interaction');
          
          // Wait for dialog to close
          await page.waitForTimeout(2_000);
          
          // Check if dialog is still visible
          const dialogStillVisible = await agreementDialog.isVisible({ timeout: 1_000 }).catch(() => false);
          logger.info({ dialogStillVisible }, 'Dialog still visible after Accept');
          
          // Capture HTML after dialog closes
          const htmlAfterDialog = await page.content();
          await writeFile(join(artifactsDir, 'after-dialog-close.html'), htmlAfterDialog);
          logger.info('Saved HTML after dialog closed');
          
          // Check attach button status after dialog
          const attachButtonAfter = page.locator('button:has(span.sr-only:has-text("Attach media"))').first();
          const buttonCountAfter = await attachButtonAfter.count();
          const buttonVisibleAfter = buttonCountAfter > 0 ? await attachButtonAfter.isVisible({ timeout: 2_000 }).catch(() => false) : false;
          const buttonDisabled = buttonVisibleAfter ? await attachButtonAfter.getAttribute('data-disabled').catch(() => 'false') : 'unknown';
          const buttonAriaDisabled = buttonVisibleAfter ? await attachButtonAfter.getAttribute('aria-disabled').catch(() => 'false') : 'unknown';
          const buttonClass = buttonVisibleAfter ? await attachButtonAfter.getAttribute('class').catch(() => '') : '';
          
          logger.info({ 
            buttonCountAfter, 
            buttonVisibleAfter, 
            buttonDisabled,
            buttonAriaDisabled,
            hasDisabledClass: buttonClass?.includes('disabled') || false
          }, 'Attach button status after dialog');
          
          // Try to click again
          if (buttonVisibleAfter && buttonDisabled !== 'true' && buttonAriaDisabled !== 'true') {
            logger.info('Attempting to click attach button again...');
            try {
              await attachButtonAfter.click();
              logger.info('✅ Successfully clicked attach button again!');
              await page.waitForTimeout(2_000);
              
              // Check if file input is now accessible
              const fileInput = page.locator('input[type="file"][accept*="image"]').first();
              const inputCount = await fileInput.count();
              const inputVisible = inputCount > 0 ? await fileInput.isVisible().catch(() => false) : false;
              logger.info({ inputCount, inputVisible }, 'File input status after second click');
              
            } catch (clickError) {
              logger.error({ clickError }, 'Failed to click attach button again');
            }
          } else {
            logger.warn('Attach button is disabled or not clickable after dialog');
          }
          
        } else {
          logger.info('No agreement dialog appeared, checking for file input...');
          
          // Check if file input is now accessible
          const fileInput = page.locator('input[type="file"][accept*="image"]').first();
          const inputCount = await fileInput.count();
          logger.info({ inputCount }, 'File input count after click');
        }
        
        // Capture screenshot after click
        await page.screenshot({ path: join(artifactsDir, 'after-button-click.png'), fullPage: true });
        logger.info('Saved screenshot after button click');
        
        // Capture final HTML
        const finalHtml = await page.content();
        await writeFile(join(artifactsDir, 'final-state.html'), finalHtml);
        logger.info('Saved final state HTML');
        
      } catch (error) {
        logger.error({ error }, 'Error clicking attach button');
        await page.screenshot({ path: join(artifactsDir, 'click-error.png'), fullPage: true });
      }
    } else {
      logger.warn('Attach media button not found or not visible, cannot test click');
    }
    
    // Keep browser open for 30 seconds so you can inspect
    logger.info('Keeping browser open for 30 seconds for manual inspection...');
    await page.waitForTimeout(30_000);

  } catch (error) {
    logger.error({ error }, 'Error during test');
    // Try to capture error screenshot
    try {
      await page.screenshot({ path: join(artifactsDir, 'error-screenshot.png'), fullPage: true });
      logger.info({ path: join(artifactsDir, 'error-screenshot.png') }, 'Saved error screenshot');
    } catch (screenshotError) {
      logger.warn({ screenshotError }, 'Failed to capture error screenshot');
    }
    throw error;
  } finally {
    try {
      await context.close();
    } catch (closeError) {
      logger.warn({ closeError }, 'Error closing browser context');
    }
  }
}

main().catch((error) => {
  logger.fatal({ 
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    name: error instanceof Error ? error.name : undefined
  }, 'Fatal error in test script');
  console.error('Full error:', error);
  process.exit(1);
});

