#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { runtimeConfig } from './config.js';
import { launchBrowser } from './browser/launch.js';
import { MongoProfileStore } from './storage/mongoProfileStore.js';
import { logger } from './logger.js';
import { writeFile } from 'node:fs/promises';

loadEnv({ path: resolve(process.cwd(), '../../.env') });
loadEnv({ path: resolve(process.cwd(), '.env') });

async function inspectElements() {
  const profileName = process.argv[2] || 'acc02';
  
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
    await page.goto(runtimeConfig.SORA_BASE_URL + '/drafts', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);

    // Find all buttons
    const allButtons = await page.locator('button').all();
    logger.info({ count: allButtons.length }, 'Found buttons');

    const buttonInfo = [];
    for (let i = 0; i < allButtons.length; i++) {
      const button = allButtons[i];
      try {
        const text = await button.textContent().catch(() => '');
        const ariaLabel = await button.getAttribute('aria-label').catch(() => '');
        const dataTestId = await button.getAttribute('data-testid').catch(() => '');
        const className = await button.getAttribute('class').catch(() => '');
        const box = await button.boundingBox().catch(() => null);
        
        const info = {
          index: i,
          text: text?.trim() || '',
          ariaLabel: ariaLabel || '',
          dataTestId: dataTestId || '',
          className: className || '',
          visible: await button.isVisible().catch(() => false),
          position: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
          isBottomLeft: box ? box.y > page.viewportSize()!.height * 0.7 && box.x < page.viewportSize()!.width * 0.3 : false
        };
        
        buttonInfo.push(info);
        
        if (info.isBottomLeft || (text && text.toLowerCase().includes('setting')) || (ariaLabel && ariaLabel.toLowerCase().includes('setting'))) {
          logger.info(info, `Button ${i} - potential settings button`);
        }
      } catch (error) {
        // Skip
      }
    }

    // Save button info to file
    await writeFile('button-inspect.json', JSON.stringify(buttonInfo, null, 2));
    logger.info('Saved button info to button-inspect.json');

    // Take screenshot
    await page.screenshot({ path: 'drafts-page.png', fullPage: true });
    logger.info('Saved screenshot to drafts-page.png');

    // Try to find and click settings button (user can see which one)
    logger.info('Please inspect the page and tell me which button is the settings button');
    logger.info('Press Enter in terminal when done inspecting...');
    
    // Wait for user input
    await new Promise((resolve) => {
      process.stdin.once('data', () => resolve(null));
    });

    // After user confirms, try to open settings modal
    const potentialSettingsButtons = buttonInfo.filter(
      b => b.isBottomLeft || 
           (b.text && b.text.toLowerCase().includes('setting')) || 
           (b.ariaLabel && b.ariaLabel.toLowerCase().includes('setting'))
    );

    if (potentialSettingsButtons.length > 0) {
      logger.info({ count: potentialSettingsButtons.length }, 'Trying potential settings buttons');
      
      for (const btnInfo of potentialSettingsButtons) {
        try {
          const button = allButtons[btnInfo.index];
          await button.click();
          await page.waitForTimeout(2_000);
          
          // Check if modal appeared
          const modal = await page.locator('[role="dialog"], [data-testid*="modal"], [class*="modal"]').first().isVisible({ timeout: 2_000 }).catch(() => false);
          
          if (modal) {
            logger.info({ buttonIndex: btnInfo.index }, 'Modal appeared! Inspecting modal elements...');
            
            // Inspect modal elements
            const modalButtons = await page.locator('button, a, [role="tab"], [role="button"]').all();
            const modalInfo = [];
            
            for (let i = 0; i < modalButtons.length; i++) {
              const btn = modalButtons[i];
              try {
                const text = await btn.textContent().catch(() => '');
                const ariaLabel = await btn.getAttribute('aria-label').catch(() => '');
                const dataTestId = await btn.getAttribute('data-testid').catch(() => '');
                
                modalInfo.push({
                  index: i,
                  text: text?.trim() || '',
                  ariaLabel: ariaLabel || '',
                  dataTestId: dataTestId || '',
                  visible: await btn.isVisible().catch(() => false)
                });
                
                if ((text && text.toLowerCase().includes('usage')) || (ariaLabel && ariaLabel.toLowerCase().includes('usage'))) {
                  logger.info({ index: i, text, ariaLabel }, 'Found potential usage button');
                }
              } catch (error) {
                // Skip
              }
            }
            
            await writeFile('modal-inspect.json', JSON.stringify(modalInfo, null, 2));
            await page.screenshot({ path: 'settings-modal.png', fullPage: true });
            logger.info('Saved modal info to modal-inspect.json and screenshot to settings-modal.png');
            
            break;
          } else {
            logger.warn({ buttonIndex: btnInfo.index }, 'No modal appeared');
          }
        } catch (error) {
          logger.warn({ error, buttonIndex: btnInfo.index }, 'Error clicking button');
        }
      }
    }

    logger.info('Inspection complete. Check button-inspect.json, modal-inspect.json, and screenshots');
    
  } finally {
    await context.close();
    await profileStore.disconnect();
  }
}

inspectElements().catch((error) => {
  logger.error({ error }, 'Inspection failed');
  process.exit(1);
});


