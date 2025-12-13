#!/usr/bin/env node
// Test script to upload an image file to Sora
import './browser/initFingerprint.js';

import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { launchBrowser } from './browser/launch.js';
import { ensureAuthenticated, dismissWelcomePopup } from './sora/flow.js';
import { logger } from './logger.js';
import { MongoProfileStore } from './storage/mongoProfileStore.js';
import { runtimeConfig } from './config.js';
import type { Page, Locator } from '@playwright/test';

async function uploadImageFile(page: Page, imagePath: string, artifactsDir: string): Promise<void> {
  logger.info({ imagePath }, 'Starting image upload test');
  
  // Find the attach media button
  const attachButton = page.locator('button:has(span.sr-only:has-text("Attach media"))').first();
  const buttonCount = await attachButton.count();
  const buttonVisible = buttonCount > 0 ? await attachButton.isVisible({ timeout: 5_000 }).catch(() => false) : false;
  
  logger.info({ buttonCount, buttonVisible }, 'Attach media button status');
  
  if (buttonCount === 0 || !buttonVisible) {
    logger.error('Attach media button not found or not visible');
    await page.screenshot({ path: join(artifactsDir, 'attach-button-not-found.png'), fullPage: true });
    throw new Error('Attach media button not found');
  }
  
  // Set up file chooser handler
  let fileChooserHandled = false;
  const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null);
  
  // Click the button
  logger.info('Clicking Attach media button...');
  await attachButton.click();
  
  // Wait for file chooser or timeout
  const fileChooser = await fileChooserPromise;
  if (fileChooser) {
    logger.info('File chooser dialog appeared');
    await fileChooser.setFiles(imagePath);
    fileChooserHandled = true;
    logger.info('File set via file chooser');
    await page.waitForTimeout(2_000);
  } else {
    logger.info('No file chooser appeared, will try to set file directly on input');
    await page.waitForTimeout(1_500);
  }
  
  // Check for agreement dialog
  const agreementDialog = page.locator('div[role="dialog"]:has-text("Media upload agreement"), div[role="dialog"]:has-text("agreement")').first();
  const hasDialog = await agreementDialog.isVisible({ timeout: 3_000 }).catch(() => false);
  
  if (hasDialog) {
    logger.info('Media upload agreement dialog detected, accepting...');
    await page.screenshot({ path: join(artifactsDir, 'agreement-dialog.png'), fullPage: true });
    
    // Tick all checkboxes
    const checkboxes = agreementDialog.locator('button[role="checkbox"]').all();
    const checkboxList = await checkboxes;
    
    for (let i = 0; i < checkboxList.length; i++) {
      const checkbox = checkboxList[i];
      const isChecked = await checkbox.getAttribute('aria-checked').catch(() => 'false');
      if (isChecked !== 'true') {
        logger.info({ index: i + 1 }, 'Clicking checkbox');
        await checkbox.click();
        await page.waitForTimeout(200);
      }
    }
    
    // Click Accept button
    const acceptButton = agreementDialog.locator('button:has-text("Accept"), button:has-text("accept")').first();
    if (await acceptButton.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await acceptButton.click();
      logger.info('Clicked Accept button');
      await page.waitForTimeout(1_000);
    }
  }
  
  // If file chooser was handled, skip direct file input setting
  if (fileChooserHandled) {
    logger.info('File was set via file chooser, skipping direct input setting');
    // Still check for image preview
  } else {
    // Wait for file input to be ready
    await page.waitForTimeout(2_000);
    
    // If dialog was shown, we might need to click button again to activate file input
    if (hasDialog) {
      logger.info('Dialog was shown, clicking attach button again to activate file input...');
      await attachButton.click();
      await page.waitForTimeout(1_000);
    }
  
    // Find all file inputs and try to set file on each one
    const allFileInputs = await page.locator('input[type="file"]').all();
    logger.info({ fileInputCount: allFileInputs.length }, 'Found file inputs');
    
    if (allFileInputs.length === 0) {
      logger.error('No file inputs found');
      await page.screenshot({ path: join(artifactsDir, 'file-input-not-found.png'), fullPage: true });
      throw new Error('File input not found');
    }
    
    // Try to set file on each input
    let fileSet = false;
    let fileInputHandle: Locator | null = null;
  for (let i = 0; i < allFileInputs.length; i++) {
    try {
      const input = allFileInputs[i];
      const accept = await input.getAttribute('accept').catch(() => '');
      logger.info({ index: i, accept }, 'Trying to set file on input');
      
      // Remove hidden class temporarily to make input accessible
      await input.evaluate((el: HTMLInputElement) => {
        el.classList.remove('hidden');
        el.style.display = 'block';
        el.style.visibility = 'visible';
        el.style.opacity = '1';
      });
      
      await page.waitForTimeout(200);
      
      // Try clicking the input first to "activate" it
      try {
        await input.click({ force: true });
        await page.waitForTimeout(300);
      } catch (error) {
        logger.debug({ index: i, error }, 'Could not click input, continuing anyway');
      }
      
      await input.setInputFiles(imagePath);
      
      // Restore hidden class
      await input.evaluate((el: HTMLInputElement) => {
        el.classList.add('hidden');
        el.style.display = '';
        el.style.visibility = '';
        el.style.opacity = '';
      });
      
      // Verify file was set
      const fileInfo = await input.evaluate((el: HTMLInputElement) => {
        const files = el.files;
        if (files && files.length > 0) {
          return {
            fileCount: files.length,
            fileName: files[0].name,
            fileSize: files[0].size
          };
        }
        return { fileCount: 0 };
      });
      
      logger.info({ index: i, fileInfo }, 'File input verification after set');
      
      if (fileInfo.fileCount > 0) {
        fileInputHandle = input;
        fileSet = true;
        logger.info({ index: i }, 'File successfully set on this input');
        break;
      }
    } catch (error) {
      logger.warn({ index: i, error }, 'Failed to set file on this input');
    }
  }
  
    if (!fileSet) {
      logger.error('Failed to set file on any input');
      await page.screenshot({ path: join(artifactsDir, 'file-set-failed.png'), fullPage: true });
      throw new Error('Failed to set file');
    }
    
    logger.info('File set via setInputFiles');
    
    // Verify file was set
    if (fileInputHandle) {
      try {
        const fileInfo = await fileInputHandle.evaluate((el: HTMLInputElement) => {
          const files = el.files;
          if (files && files.length > 0) {
            return {
              fileCount: files.length,
              fileName: files[0].name,
              fileSize: files[0].size,
              fileType: files[0].type
            };
          }
          return { fileCount: 0 };
        });
        logger.info({ fileInfo }, 'File input verification');
      } catch (error) {
        logger.warn({ error }, 'Failed to verify file input');
      }
      
      // Trigger change and input events
      try {
        await fileInputHandle.evaluate((el: HTMLInputElement) => {
          const changeEvent = new Event('change', { bubbles: true, cancelable: true });
          el.dispatchEvent(changeEvent);
          const inputEvent = new Event('input', { bubbles: true, cancelable: true });
          el.dispatchEvent(inputEvent);
        });
        logger.info('Triggered change and input events');
      } catch (error) {
        logger.warn({ error }, 'Failed to trigger events');
      }
    }
  }
  
  // Wait for upload to process
  await page.waitForTimeout(3_000);
  
  // Check for image preview
  const imagePreview = page.locator('img[src*="blob"], img[src*="data:"], img[alt*="upload"], [class*="image"], [class*="preview"]').first();
  const hasPreview = await imagePreview.isVisible({ timeout: 5_000 }).catch(() => false);
  
  if (hasPreview) {
    logger.info('Image preview found - upload successful!');
    await page.screenshot({ path: join(artifactsDir, 'upload-success.png'), fullPage: true });
  } else {
    logger.warn('No image preview found, but file was set');
    await page.screenshot({ path: join(artifactsDir, 'upload-no-preview.png'), fullPage: true });
  }
}

async function main() {
  const profileName = 'acc01';
  const imagePath = resolve('C:\\Users\\TheDat\\Downloads\\155270.jpg');
  const prompt = 'Continue this frame';
  
  // Verify file exists
  const { existsSync } = await import('node:fs');
  if (!existsSync(imagePath)) {
    logger.error({ imagePath }, 'Image file does not exist');
    throw new Error(`Image file not found: ${imagePath}`);
  }
  logger.info({ imagePath, exists: true }, 'Image file verified');
  
  // Try to load from MongoDB
  let userDataDir: string;
  let proxy: string;
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
    proxy = profile.proxy || '';
    fingerprint = profile.fingerprint;

    logger.info({ 
      profileName: profile.name,
      proxy: profile.proxy || '(empty - no proxy)',
      hasProxy: !!profile.proxy && profile.proxy.trim().length > 0
    }, 'Profile loaded from MongoDB');
    
    await profileStore.disconnect();
  } catch (error) {
    logger.warn({ error }, 'Failed to load from MongoDB, using direct path');
    userDataDir = resolve(runtimeConfig.PROFILE_ROOT, profileName);
    proxy = '';
    logger.info({ userDataDir }, 'Using direct profile path');
  }

  const { context, page, artifactsDir } = await launchBrowser({
    userDataDir,
    proxy,
    fingerprint: fingerprint || undefined,
    onFingerprintPersist: async (fingerprint) => {
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
    // Navigate to Sora
    logger.info('Navigating to Sora base URL...');
    await page.goto(runtimeConfig.SORA_BASE_URL, { waitUntil: 'domcontentloaded' });
    await dismissWelcomePopup(page, artifactsDir);
    await page.waitForTimeout(2_000);

    // Authenticate
    logger.info('Ensuring authentication...');
    await ensureAuthenticated(page, runtimeConfig.SORA_BASE_URL, false, artifactsDir, true);
    await page.waitForTimeout(2_000);

    // Navigate to drafts
    logger.info('Navigating to drafts page...');
    const draftsUrl = new URL('/drafts', runtimeConfig.SORA_BASE_URL).toString();
    await page.goto(draftsUrl, { waitUntil: 'domcontentloaded' });
    await dismissWelcomePopup(page, artifactsDir);
    await page.waitForTimeout(3_000);

    // Find prompt box
    const promptBox = page.getByPlaceholder('Describe your video...').first();
    await promptBox.waitFor({ state: 'visible', timeout: 30_000 });
    logger.info('Prompt box found');

    // Upload image
    await uploadImageFile(page, imagePath, artifactsDir);
    
    // Enter prompt
    logger.info({ prompt }, 'Entering prompt...');
    await promptBox.click();
    await page.waitForTimeout(500);
    await promptBox.fill(prompt);
    await page.waitForTimeout(1_000);
    
    // Capture final state
    await page.screenshot({ path: join(artifactsDir, 'final-state.png'), fullPage: true });
    const finalHtml = await page.content();
    await writeFile(join(artifactsDir, 'final-state.html'), finalHtml);
    
    logger.info(`Test completed! Artifacts saved to: ${artifactsDir}`);
    logger.info('Browser will stay open for 30 seconds for manual inspection...');
    await page.waitForTimeout(30_000);

  } catch (error) {
    logger.error({ error }, 'Error during test');
    await page.screenshot({ path: join(artifactsDir, 'error.png'), fullPage: true });
  } finally {
    await context.close();
    logger.info('Browser closed.');
  }
}

main().catch((error) => {
  logger.fatal({ error }, 'Fatal error in test script');
  process.exit(1);
});

