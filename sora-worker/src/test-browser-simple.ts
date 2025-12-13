#!/usr/bin/env node
// Simple test script to capture HTML structure of Sora composer (without fingerprint)
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';

async function main() {
  const profileName = 'acc01';
  const profilePath = resolve(process.cwd(), 'profiles', profileName);
  const artifactsDir = await mkdtemp(join(tmpdir(), 'sora-test-'));
  
  console.log('Launching browser (no fingerprint)...');
  console.log({ profilePath, artifactsDir });

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome'
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 }
  });

  const page = await context.newPage();

  try {
    // Navigate to Sora
    const soraUrl = process.env.SORA_BASE_URL || 'https://sora.chatgpt.com';
    console.log(`Navigating to ${soraUrl}...`);
    await page.goto(soraUrl, { waitUntil: 'networkidle', timeout: 120_000 });

    // Wait a bit for page to load
    await page.waitForTimeout(3_000);

    // Navigate to drafts
    const draftsUrl = new URL('/drafts', soraUrl).toString();
    console.log(`Navigating to ${draftsUrl}...`);
    await page.goto(draftsUrl, { waitUntil: 'networkidle', timeout: 120_000 });
    await page.waitForTimeout(3_000);

    // Find the prompt box
    const promptBox = page.getByPlaceholder('Describe your video...').first();
    await promptBox.waitFor({ state: 'visible', timeout: 30_000 });
    console.log('Prompt box found');

    // Capture full page HTML
    const fullHtml = await page.content();
    await writeFile(join(artifactsDir, 'full-page.html'), fullHtml);
    console.log(`Saved full page HTML to: ${join(artifactsDir, 'full-page.html')}`);

    // Capture composer area HTML
    const composerContainer = promptBox.locator('xpath=ancestor::div[contains(@class, "composer") or contains(@class, "popover")]').first();
    const composerCount = await composerContainer.count();
    
    if (composerCount > 0) {
      const composerHtml = await composerContainer.innerHTML();
      await writeFile(join(artifactsDir, 'composer-area.html'), composerHtml);
      console.log(`Saved composer area HTML to: ${join(artifactsDir, 'composer-area.html')}`);
    }

    // Find all buttons
    const buttons = await page.locator('button').all();
    console.log(`Found ${buttons.length} buttons on page`);

    // Try to find attach media button
    console.log('\n=== Testing selectors for Attach media button ===');
    
    const selectors = [
      { name: 'SVG full path', selector: 'button:has(svg path[d*="M12 6a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H7a1 1 0 1 1 0-2h4V7a1 1 0 0 1 1-1"])' },
      { name: 'SVG short path', selector: 'button:has(svg path[d*="M12 6"])' },
      { name: 'aria-label', selector: 'button:has(span.sr-only:has-text("Attach media"))' },
      { name: 'In flex-wrap', selector: 'div.flex.flex-wrap button:has(svg path[d*="M12"])' }
    ];

    for (const { name, selector } of selectors) {
      const locator = page.locator(selector).first();
      const count = await locator.count();
      const visible = count > 0 ? await locator.isVisible().catch(() => false) : false;
      console.log(`${name}: count=${count}, visible=${visible}`);
      
      if (count > 0 && visible) {
        const html = await locator.innerHTML();
        await writeFile(join(artifactsDir, `attach-button-${name.replace(/\s+/g, '-')}.html`), html);
        console.log(`  -> Saved HTML to: attach-button-${name.replace(/\s+/g, '-')}.html`);
      }
    }

    // Find all file inputs
    const fileInputs = await page.locator('input[type="file"]').all();
    console.log(`\nFound ${fileInputs.length} file inputs:`);
    
    for (let i = 0; i < fileInputs.length; i++) {
      const input = fileInputs[i];
      const accept = await input.getAttribute('accept').catch(() => '');
      const className = await input.getAttribute('class').catch(() => '');
      const isVisible = await input.isVisible().catch(() => false);
      console.log(`  Input ${i + 1}: accept="${accept}", class="${className}", visible=${isVisible}`);
    }

    // Take screenshot
    await page.screenshot({ path: join(artifactsDir, 'composer-screenshot.png'), fullPage: true });
    console.log(`\nSaved screenshot to: ${join(artifactsDir, 'composer-screenshot.png')}`);

    console.log(`\n=== Test completed ===`);
    console.log(`Artifacts directory: ${artifactsDir}`);
    console.log('\nKeeping browser open for 60 seconds for manual inspection...');
    console.log('You can inspect the page and then close the browser window.');
    
    await page.waitForTimeout(60_000);

  } catch (error) {
    console.error('Error during test:', error);
    await page.screenshot({ path: join(artifactsDir, 'error-screenshot.png'), fullPage: true });
    throw error;
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

