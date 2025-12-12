import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Locator, Page } from '@playwright/test';
import { logger } from '../logger.js';
import type { GenerationInput, GenerationResult } from '../types.js';
import { ask } from '../utils/prompt.js';

interface FlowOptions {
  page: Page;
  baseUrl: string;
  artifactsDir: string;
}

const CREATE_PATH = '/create';
const DRAFTS_PATH = '/drafts';

async function capturePageState(page: Page, artifactsDir: string | undefined, label: string): Promise<void> {
  if (!artifactsDir) return;
  const timestamp = `${label}-${Date.now()}`;
  const screenshotPath = join(artifactsDir, `${timestamp}.png`);
  const htmlPath = join(artifactsDir, `${timestamp}.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  await writeFile(htmlPath, await page.content()).catch(() => undefined);
}

async function dismissWelcomePopup(page: Page, artifactsDir?: string): Promise<void> {
  try {
    // Look for the "Get started" button in the welcome popup
    const getStartedButton = page.getByRole('button', { name: /get started/i }).first();
    
    if (await getStartedButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      logger.info('Welcome popup detected, clicking "Get started" to dismiss');
      await getStartedButton.click();
      await page.waitForTimeout(1_000); // Wait for popup to close
      await capturePageState(page, artifactsDir, 'welcome-popup-dismissed');
      logger.info('Welcome popup dismissed');
    }
  } catch (error) {
    // If popup not found or error, continue - it's not critical
    logger.debug({ error }, 'Welcome popup not found or already dismissed');
  }
}

export async function ensureAuthenticated(
  page: Page,
  baseUrl: string,
  requireManualLogin: boolean,
  artifactsDir?: string,
  skipAuthCheck = false
): Promise<void> {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  // Dismiss welcome popup if it appears
  await dismissWelcomePopup(page, artifactsDir);

  if (skipAuthCheck) {
    logger.warn('Skipping login detection as requested (--skip-auth-check).');
    await capturePageState(page, artifactsDir, 'auth-check-skipped');
    return;
  }

  const loggedIn = await detectLoggedIn(page);
  if (loggedIn) {
    logger.info('Detected existing authenticated session');
    return;
  }

  if (!requireManualLogin) {
    throw new Error('Not logged in. Re-run with --manual-login to capture session.');
  }

  logger.warn('No active session found. Complete login flow in the opened browser.');
  await ask('After you finish logging in, press Enter here to continue...');

  try {
    await page.waitForFunction(
      () =>
        !!document.querySelector('[data-testid="sora-workspace-root"]') ||
        !!document.querySelector('button[aria-label*="New video"]') ||
        !!document.querySelector('a[aria-label="Profile"]') ||
        !!document.querySelector('a[href="/profile"]'),
      undefined,
      { timeout: 120_000 }
    );
    logger.info('Login detected. Session will be reused through persistent profile.');
    await capturePageState(page, artifactsDir, 'login-detected');
  } catch (error) {
    logger.warn(
      { error },
      'Workspace elements not detected after manual login; continuing so the profile can be saved.'
    );
    await capturePageState(page, artifactsDir, 'login-detect-failed');
  }
}

async function detectLoggedIn(page: Page): Promise<boolean> {
  return Boolean(
    await page
      .locator('button:has-text("New video"), [data-testid="composer-textarea"]')
      .first()
      .elementHandle({ timeout: 5_000 })
      .catch(() => null)
  );
}

async function gotoWithRetry(
  page: Page,
  url: string,
  options: { waitUntil?: 'domcontentloaded' | 'load' | 'networkidle', timeout?: number, maxRetries?: number } = {}
): Promise<void> {
  const { waitUntil = 'domcontentloaded', timeout = 120_000, maxRetries = 3 } = options;
  
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, { waitUntil, timeout });
      return; // Success
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const waitTime = attempt * 2000; // 2s, 4s, 6s...
        logger.warn({ attempt, maxRetries, waitTime, url }, 'Page navigation failed, retrying...');
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw new Error(`Failed to navigate to ${url} after ${maxRetries} attempts: ${lastError?.message}`);
}

export async function runGeneration(options: FlowOptions, input: GenerationInput): Promise<GenerationResult> {
  const { page, baseUrl, artifactsDir } = options;

  const draftsUrl = new URL(DRAFTS_PATH, baseUrl).toString();
  await gotoWithRetry(page, draftsUrl, { waitUntil: 'domcontentloaded', timeout: 120_000, maxRetries: 3 });
  
  // Dismiss welcome popup if it appears after navigation
  await dismissWelcomePopup(page, artifactsDir);
  
  logger.info({ draftsUrl }, 'Opened drafts workspace');
  await capturePageState(page, artifactsDir, 'drafts-before-create');

  const promptBox = page.getByPlaceholder('Describe your video...').first();
  await promptBox.waitFor({ state: 'visible', timeout: 30_000 }).catch(async (error) => {
    await capturePageState(page, artifactsDir, 'composer-missing');
    throw new Error(`Composer prompt not found: ${(error as Error).message}`);
  });

  await applyComposerOptions(page, promptBox, input, artifactsDir);

  // Upload images if provided
  if (input.imageUrls && input.imageUrls.length > 0) {
    await uploadImages(page, input.imageUrls, artifactsDir);
  }

  await promptBox.click();
  await promptBox.fill(input.prompt);

  const composerForm = promptBox.locator('xpath=ancestor::form[1]');
  let composerButton: Locator | null = null;
  if ((await composerForm.count().catch(() => 0)) > 0) {
    composerButton = composerForm.getByRole('button', { name: /create video|generate|submit/i }).first();
  } else {
    logger.warn('Composer form not found; falling back to global generate button search');
    composerButton = page.getByRole('button', { name: /create video|generate|submit/i }).first();
  }

  let submitted = false;
  if (composerButton) {
    try {
      await waitForEnabled(page, composerButton, artifactsDir);
      await composerButton.click({ timeout: 10_000 });
      submitted = true;
      logger.info('Submitted prompt by clicking composer button');
    } catch (buttonError) {
      logger.warn({ buttonError }, 'Generate button click failed, falling back to keyboard submit');
    }
  }

  if (!submitted) {
    await promptBox.click().catch(() => undefined);
    try {
      await page.keyboard.press('Control+Enter');
      submitted = true;
      logger.info('Submitted prompt using Control+Enter fallback');
    } catch (ctrlError) {
      logger.warn({ ctrlError }, 'Control+Enter fallback failed, trying Enter');
      try {
        await page.keyboard.press('Enter');
        submitted = true;
        logger.info('Submitted prompt using Enter fallback');
      } catch (enterError) {
        logger.error({ enterError }, 'Failed to submit prompt via keyboard');
        throw enterError instanceof Error ? enterError : new Error(String(enterError));
      }
    }
  }
  logger.info('Prompt submitted. Waiting for completion…');

  const jobId = await waitForJobId(page);
  const jobData = await waitForCompletion(page, baseUrl, jobId);
  
  // Only check for policy violation if video is not ready (no videoPath means it might be blocked)
  const hasVideoPath = jobData?.encodings && typeof jobData.encodings === 'object' 
    ? (jobData.encodings as any).source?.path || jobData.url 
    : false;
  if (!hasVideoPath) {
    await detectPolicyViolation(page, artifactsDir);
  }

  const publicUrl = await publishLatestDraft(page, baseUrl, artifactsDir);
  const creditInfo = await checkCredits(page, baseUrl, artifactsDir);

  const screenshotPath = join(artifactsDir, `sora-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await writeFile(join(artifactsDir, `sora-${Date.now()}.html`), await page.content());

  return {
    jobId,
    publicUrl,
    artifactsDir,
    metadata: {
      jobId,
      jobStatus: jobData?.status,
      creditInfo
    }
  };
}

async function waitForJobId(page: Page): Promise<string> {
  const response = await page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().includes('/backend/nf/create'),
    { timeout: 120_000 }
  );

  try {
    const payload = await response.json();
    const jobId = payload?.id ?? payload?.job_id ?? payload?.data?.id;
    if (jobId) {
      logger.info({ jobId }, 'Captured job identifier from network');
      return jobId;
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to parse job response');
  }

  const fallback = randomUUID();
  logger.warn({ fallback }, 'Falling back to synthetic job id');
  return fallback;
}

async function waitForCompletion(page: Page, baseUrl: string, jobId: string): Promise<Record<string, unknown>> {
  const draftsUrl = new URL('/drafts', baseUrl).toString();
  const deadline = Date.now() + 20 * 60 * 1_000;
  let lastResponse: Record<string, unknown> | null = null;
  let pollCount = 0;

  while (Date.now() < deadline) {
    pollCount++;
    
    // Every 12 polls (~60 seconds), reload the drafts page to trigger API call
    if (pollCount % 12 === 0) {
      logger.info({ pollCount }, 'Reloading drafts page to trigger API refresh');
      try {
        // Wait for the drafts API response when reloading
        const responsePromise = page.waitForResponse(
          (res) => res.url().includes('/backend/project_y/profile/drafts') && res.request().method() === 'GET',
          { timeout: 30_000 }
        );

        await gotoWithRetry(page, draftsUrl, { waitUntil: 'domcontentloaded', timeout: 120_000, maxRetries: 3 });
        
        // Get the response from the reload
        let payload: Record<string, unknown>;
        try {
          const browserResponse = await responsePromise;
          payload = (await browserResponse.json()) as Record<string, unknown>;
          logger.info({ url: browserResponse.url(), itemCount: Array.isArray(payload.items) ? payload.items.length : 0 }, 'Captured drafts API response from page reload');
          lastResponse = payload;
        } catch (error) {
          logger.warn({ error }, 'Failed to capture response from reload, will retry');
          await page.waitForTimeout(5_000);
          continue;
        }

        // Process the payload
        const items = Array.isArray(payload.items) ? (payload.items as Array<Record<string, unknown>>) : [];
        logger.info({ totalItems: items.length, lookingForJobId: jobId }, 'Checking drafts for job completion');

        const foundTaskIds = items.map((item) => item?.task_id).filter(Boolean);
        if (foundTaskIds.length > 0) {
          logger.info({ foundTaskIds: foundTaskIds.slice(0, 5) }, 'Sample task IDs found in drafts');
        }

        const draft = items.find((item) => item?.task_id === jobId);

        if (draft) {
          const kind = (draft.kind ?? '').toString();
          logger.info({ jobId, kind }, 'Found matching draft in API response');

          if (kind === 'sora_content_violation') {
            const reason = (draft.markdown_reason_str ?? draft.reason_str ?? 'Content violation') as string;
            logger.warn({ jobId, reason }, 'Draft marked as policy violation from drafts API');
            await capturePageState(page, undefined, 'policy-violation-detected');
            throw new Error(`Generation failed due to policy violation: ${reason}`);
          }

          if (kind === 'sora_error') {
            const reason = (draft.markdown_reason_str ?? draft.reason_str ?? draft.error_message ?? 'Something went wrong') as string;
            logger.warn({ jobId, reason }, 'Draft marked as error from drafts API');
            await capturePageState(page, undefined, 'error-detected');
            throw new Error(`Generation failed: ${reason}`);
          }

          const encodings = draft.encodings as Record<string, unknown> | undefined;
          const source = encodings && typeof encodings === 'object' ? (encodings as any).source : undefined;
          const videoPath = source && typeof source === 'object' ? (source as any).path : undefined;

          logger.info({ jobId, hasVideoPath: !!videoPath, hasUrl: !!draft.url, encodingsKeys: encodings ? Object.keys(encodings) : [] }, 'Draft status check');

          if (videoPath || draft.url) {
            logger.info({ jobId, videoPath: videoPath || draft.url }, 'Draft video is ready according to drafts API');
            return draft;
          } else {
            logger.info({ jobId }, 'Draft found but video not ready yet (no path/url)');
          }
        } else {
          logger.info({ jobId, checkedItems: items.length }, 'Job not found in drafts yet');
        }

        await page.waitForTimeout(5_000);
        continue;
      } catch (error) {
        // Re-throw policy violation errors immediately
        if (error instanceof Error && error.message.includes('policy violation')) {
          throw error;
        }
        logger.warn({ error }, 'Failed to reload drafts page');
      }
    }

    // Between reloads, just wait
    await page.waitForTimeout(5_000);
  }

  logger.error({ jobId, lastResponseItems: lastResponse ? (Array.isArray(lastResponse.items) ? lastResponse.items.length : 0) : 0 }, 'Timeout waiting for job completion');
  throw new Error(`Timed out waiting for job ${jobId} to appear as completed draft.`);
}

async function promoteAndCopyPublicUrl(page: Page): Promise<string | undefined> {
  const shareButton = page.getByRole('button', { name: /share|publish/i }).first();
  if (!(await shareButton.isVisible())) {
    logger.warn('Share button not visible; skip publishing step');
    return undefined;
  }

  await shareButton.click();

  const publicLinkInput = page.locator('input[type="url"], input[readonly][value^="https"]');
  const url = await publicLinkInput.inputValue().catch(() => undefined);
  if (!url) {
    logger.warn('Unable to read public share URL');
    return undefined;
  }
  logger.info({ url }, 'Public share URL captured');
  return url;
}

async function uploadImages(
  page: Page,
  imageUrls: string[],
  artifactsDir?: string
): Promise<void> {
  if (!imageUrls || imageUrls.length === 0) {
    return;
  }

  // Sora supports only 1 image - use the first one
  const imageUrl = imageUrls[0];
  logger.info({ imageUrl, totalImages: imageUrls.length }, 'Starting image upload (using first image only)');

  try {
    // Find the "Attach media" button with aria-label="Attach media"
    const attachButton = page.locator('button[aria-label="Attach media"]').first();
    
    // Find the hidden file input - it should be near the attach button
    // The file input accepts: image/jpeg,image/png,image/webp
    const fileInput = page.locator('input[type="file"][accept*="image"]').first();
    
    let fileInputHandle: Locator | null = null;

    // Try to find file input directly (it's hidden but still accessible)
    const fileInputCount = await fileInput.count();
    if (fileInputCount > 0) {
      fileInputHandle = fileInput;
      logger.info('Found file input directly');
    } else {
      // If file input not found, try clicking the attach button first
      if (await attachButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
        logger.info('Clicking Attach media button to reveal file input');
        await attachButton.click();
        await page.waitForTimeout(500);
        
        // Look for file input again after clicking
        const fileInputAfterClick = page.locator('input[type="file"][accept*="image"]').first();
        const countAfterClick = await fileInputAfterClick.count();
        if (countAfterClick > 0) {
          fileInputHandle = fileInputAfterClick;
          logger.info('Found file input after clicking attach button');
        }
      }
    }

    if (!fileInputHandle) {
      logger.warn('Could not find image upload input, skipping image upload');
      await capturePageState(page, artifactsDir, 'image-upload-input-not-found');
      return;
    }

    // Download the image to a temp file
    const tempPath = join(tmpdir(), `sora-image-${Date.now()}.jpg`);
    
    try {
      logger.info({ imageUrl }, 'Downloading image');

      // Download image using Playwright's context
      const response = await page.request.get(imageUrl);
      if (!response.ok()) {
        throw new Error(`Failed to download image: ${response.status()} ${response.statusText()}`);
      }

      const buffer = await response.body();
      await writeFile(tempPath, buffer);
      logger.info({ tempPath }, 'Image downloaded to temp file');

      // Upload file via file input
      await fileInputHandle.setInputFiles(tempPath);
      logger.info({ imageUrl }, 'Image uploaded successfully');

      // Wait a bit for upload to process
      await page.waitForTimeout(1_000);
      
      await capturePageState(page, artifactsDir, 'image-uploaded');
    } catch (error) {
      logger.error({ imageUrl, error }, 'Failed to upload image');
      await capturePageState(page, artifactsDir, 'image-upload-error');
      throw error; // Re-throw to be caught by outer catch
    } finally {
      // Clean up temp file
      try {
        await unlink(tempPath);
      } catch (error) {
        logger.warn({ tempPath, error }, 'Failed to delete temp file');
      }
    }
  } catch (error) {
    logger.error({ error }, 'Error during image upload');
    await capturePageState(page, artifactsDir, 'image-upload-error');
    // Don't throw - continue with generation even if image upload fails
  }
}

async function applyComposerOptions(
  page: Page,
  promptBox: Locator,
  input: GenerationInput,
  artifactsDir?: string
): Promise<void> {
  const settingsButton = page.getByRole('button', { name: /^settings$/i }).last();
  if (!(await settingsButton.isVisible().catch(() => false))) {
    logger.warn('Composer settings button not found; using default duration and orientation.');
    return;
  }

  let rootMenu = await openSettingsMenu(page, settingsButton);

  const durationPatterns = [
    new RegExp(`${input.durationSeconds}\\s*s`, 'i'),
    new RegExp(`${input.durationSeconds}\\s*seconds?`, 'i'),
    new RegExp(`${input.durationSeconds}\\s*sec`, 'i'),
    new RegExp(`^${input.durationSeconds}$`, 'i')
  ];

  const durationSelected = await selectFromSubmenu(
    page,
    rootMenu,
    /^Duration/i,
    durationPatterns,
    'duration'
  );

  if (durationSelected) {
    await capturePageState(page, artifactsDir, 'composer-duration-selected');
    await promptBox.focus().catch(() => undefined);
  }

  await page.keyboard.press('Escape').catch(() => undefined); // Close after duration

  if (!durationSelected) {
    logger.warn({ duration: input.durationSeconds }, 'Duration option not found; leaving default');
  }

  rootMenu = await openSettingsMenu(page, settingsButton);

  const orientationPatterns = input.orientation === 'portrait' ? [/portrait/i] : [/landscape/i];
  const orientationSelected = await selectFromSubmenu(
    page,
    rootMenu,
    /^Orientation/i,
    orientationPatterns,
    'orientation'
  );

  if (orientationSelected) {
    await capturePageState(page, artifactsDir, 'composer-orientation-selected');
    await promptBox.focus().catch(() => undefined);
  }

  if (!orientationSelected) {
    logger.warn({ orientation: input.orientation }, 'Orientation option not found; leaving default');
  }

  await page.keyboard.press('Escape').catch(() => undefined); // Close after orientation
}

async function openSettingsMenu(page: Page, settingsButton: Locator): Promise<Locator> {
  await settingsButton.click();
  await page.waitForTimeout(400);
  return page.locator('[role="menu"]').last();
}

async function selectFromSubmenu(
  page: Page,
  parentMenu: Locator,
  triggerPattern: RegExp,
  optionPatterns: RegExp[],
  label: string
): Promise<boolean> {
  const trigger = parentMenu.getByRole('menuitem', { name: triggerPattern }).first();
  if (!(await trigger.isVisible().catch(() => false))) {
    logger.warn({ label }, 'Submenu trigger not found');
    return false;
  }

  const menus = page.locator('[role="menu"]');
  const beforeCount = await menus.count();

  await trigger.click();
  await page.waitForTimeout(200);

  const afterCount = await menus.count();
  const submenuIndex = Math.max(afterCount - 1, 0);
  const submenu = menus.nth(submenuIndex);

  return await selectMenuItemInMenu(page, submenu, optionPatterns, label);
}

async function selectMenuItemInMenu(
  page: Page,
  menu: Locator,
  patterns: RegExp[],
  label: string
): Promise<boolean> {
  for (const pattern of patterns) {
    const menuItem = menu.getByRole('menuitem', { name: pattern }).first();
    const radioItem = menu.getByRole('menuitemradio', { name: pattern }).first();

    if (await menuItem.isVisible({ timeout: 500 }).catch(() => false)) {
      const enabled = await menuItem
        .evaluate((el) => !el.hasAttribute('aria-disabled') && el.getAttribute('data-disabled') !== 'true')
        .catch(() => false);
      if (enabled) {
        await menuItem.focus().catch(() => undefined);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        logger.info({ label, pattern: pattern.toString(), role: 'menuitem' }, 'Composer option updated');
        return true;
      } else {
        logger.warn({ label, pattern: pattern.toString(), role: 'menuitem' }, 'Matched option is disabled, skipping');
      }
    }

    if (await radioItem.isVisible({ timeout: 500 }).catch(() => false)) {
      const enabled = await radioItem
        .evaluate((el) => !el.hasAttribute('aria-disabled') && el.getAttribute('data-disabled') !== 'true')
        .catch(() => false);
      if (enabled) {
        await radioItem.focus().catch(() => undefined);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        logger.info({ label, pattern: pattern.toString(), role: 'menuitemradio' }, 'Composer option updated');
        return true;
      } else {
        logger.warn({ label, pattern: pattern.toString(), role: 'menuitemradio' }, 'Matched option is disabled, skipping');
      }
    }
  }

  const allItems = await menu.locator('[role="menuitem"], [role="menuitemradio"]').all();
  for (const item of allItems) {
    const text = await item.textContent({ timeout: 500 }).catch(() => null);
    if (!text) continue;
    if (patterns.some((pattern) => pattern.test(text))) {
      const enabled = await item
        .evaluate((el) => !el.hasAttribute('aria-disabled') && el.getAttribute('data-disabled') !== 'true')
        .catch(() => false);
      if (!enabled) {
        logger.warn({ label, text }, 'Matched option by text is disabled, skipping');
        continue;
      }
      await item.focus().catch(() => undefined);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      logger.info({ label, text }, 'Composer option updated (by text)');
      return true;
    }
  }

  return false;
}

async function waitForEnabled(page: Page, locator: Locator, artifactsDir?: string): Promise<void> {
  try {
    await locator.waitFor({ state: 'visible', timeout: 30_000 });
    const handle = await locator.elementHandle({ timeout: 30_000 });
    if (!handle) {
      throw new Error('Failed to resolve button handle for enablement check.');
    }
    await page.waitForFunction(
      (btn) => !btn.hasAttribute('disabled') && btn.getAttribute('data-disabled') !== 'true',
      handle,
      { timeout: 15_000 }
    );
  } catch (error) {
    logger.warn({ error }, 'waitForEnabled: button did not become enabled in time, clicking anyway');
    await capturePageState(page, artifactsDir, 'generate-button-not-enabled');
  }
}

async function publishLatestDraft(page: Page, baseUrl: string, artifactsDir?: string): Promise<string | undefined> {
  const draftsUrl = new URL(DRAFTS_PATH, baseUrl).toString();
  await page.goto(draftsUrl, { waitUntil: 'networkidle' });
  await capturePageState(page, artifactsDir, 'drafts-before-publish');

  // Get the first draft (newest) - all drafts show as "NEW" so we just take the first one
  const newCard = page.locator('a[href^="/d/"]').first();

  if (!(await newCard.isVisible().catch(() => false))) {
    logger.warn('Could not find any draft to publish. Manual review needed.');
    return undefined;
  }

  await openRelativeLink(page, newCard, baseUrl);
  await page.waitForURL(/\/d\//, { timeout: 30_000 }).catch(() => undefined);
  await capturePageState(page, artifactsDir, 'draft-detail');

  await trimPromptIfTooLong(page, 1000, artifactsDir);

  // Wait for post button and click it
  const postButton = page.getByRole('button', { name: /post|publish/i }).first();
  if (await postButton.isVisible().catch(() => false)) {
    // Wait for post API response
    const postResponsePromise = page.waitForResponse(
      (res) => {
        const url = res.url();
        return (
          (url.includes('/backend/project_y/') && res.request().method() === 'POST') ||
          (url.includes('/backend/nf/') && res.request().method() === 'POST')
        );
      },
      { timeout: 30_000 }
    );

    await postButton.click();
    logger.info('Clicked Post button for the draft');

    // Wait for post to complete
    try {
      await postResponsePromise;
      logger.info('Post API response received');
    } catch (error) {
      logger.warn({ error }, 'Did not capture post API response, continuing anyway');
    }

    // Wait a bit for post to process
    await page.waitForTimeout(3_000);
  } else {
    logger.warn('Post button not visible on draft detail page.');
  }

  // Navigate to profile and wait for new post to appear
  const profileUrl = new URL('/profile', baseUrl).toString();
  
  // Retry logic to find published post
  let finalUrl: string | undefined;
  const maxRetries = 10;
  const retryDelay = 2_000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logger.info({ attempt, maxRetries }, 'Checking profile feed for published post');

    // Wait for profile API response
    const profileResponsePromise = page.waitForResponse(
      (res) => res.url().includes('/backend/project_y/profile') && res.request().method() === 'GET',
      { timeout: 15_000 }
    );

  await page.goto(profileUrl, { waitUntil: 'networkidle' });
    
    try {
      await profileResponsePromise;
    } catch (error) {
      logger.warn({ error }, 'Did not capture profile API response');
    }

    await capturePageState(page, artifactsDir, `profile-feed-attempt-${attempt}`);

    // Look for published post link
  const latestProfileCard = page.locator('a[href^="/p/"]').first();
    
    if (await latestProfileCard.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const href = await latestProfileCard.getAttribute('href');
      if (href) {
        const postUrl = new URL(href, baseUrl).toString();
        await page.goto(postUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  await capturePageState(page, artifactsDir, 'profile-video');

        finalUrl = page.url();
        logger.info({ finalUrl, attempt }, 'Captured public profile URL');
        break;
      }
    }

    if (attempt < maxRetries) {
      logger.info({ attempt, nextAttemptIn: `${retryDelay}ms` }, 'Published post not found yet, retrying...');
      await page.waitForTimeout(retryDelay);
    }
  }

  if (!finalUrl) {
    logger.error('Unable to locate published video on profile feed after all retries.');
    // Try to get URL from current page as fallback
    if (page.url().includes('/p/')) {
      finalUrl = page.url();
      logger.warn({ finalUrl }, 'Using current page URL as fallback');
    }
  }

  return finalUrl;
}

async function openRelativeLink(page: Page, locator: Locator, baseUrl: string): Promise<void> {
  const href = await locator.getAttribute('href');
  if (href) {
    await page.goto(new URL(href, baseUrl).toString(), { waitUntil: 'networkidle' });
  } else {
    await locator.click();
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }
}

async function trimPromptIfTooLong(page: Page, maxLength: number, artifactsDir?: string): Promise<void> {
  const editButton = page
    .locator('button')
    .filter({ has: page.locator('svg path[d*="4.536 4.536"]') }) // pencil icon path
    .first();

  const editButtonVisible = await editButton.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!editButtonVisible) {
    logger.warn('Edit prompt button not found; skipping prompt trim');
    return;
  }

  await editButton.click();

  const captionBox = page.getByPlaceholder('Add caption...').first();
  const textareaVisible = await captionBox.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!textareaVisible) {
    logger.warn('Caption textarea not visible after clicking edit; skipping prompt trim');
    return;
  }

  const current = await captionBox.inputValue().catch(() => '');
  if (!current || current.length <= maxLength) {
    logger.info({ length: current.length }, 'Prompt length within limit; no trim needed');
    return;
  }

  const trimmed = current.slice(0, maxLength);
  await captionBox.fill(trimmed);
  await capturePageState(page, artifactsDir, 'prompt-trimmed');

  try {
    await captionBox.press('Enter');
  } catch {
    // Fallback to clicking confirm/check button if available
    const confirmButton = captionBox.locator('xpath=following::button[1]').first();
    await confirmButton.click().catch(() => undefined);
  }

  logger.info({ originalLength: current.length, trimmedLength: trimmed.length }, 'Trimmed prompt to fit posting limit');
  await page.waitForTimeout(500);
}

export async function checkCredits(
  page: Page,
  baseUrl: string,
  artifactsDir?: string
): Promise<Record<string, unknown> | undefined> {
  try {
    // Wait for usage API response when opening usage tab (optional, don't fail if timeout)
    const usageResponsePromise = page.waitForResponse(
      (res) => {
        const url = res.url();
        return (
          (url.includes('/backend/nf/') && url.includes('check')) ||
          (url.includes('/backend/project_y/') && (url.includes('usage') || url.includes('settings')))
        );
      },
      { timeout: 10_000 }
    ).catch(() => null); // Don't throw on timeout

    // Step 1: Find and click settings button (aria-label="Settings")
    const settingsButton = page.locator('button[aria-label="Settings"]').first();
    
    if (!(await settingsButton.isVisible({ timeout: 5_000 }).catch(() => false))) {
      logger.warn('Settings button not found');
      return undefined;
    }

    await settingsButton.click();
    await page.waitForTimeout(500);
    logger.info('Clicked settings button');

    // Step 2: Wait for dropdown menu and click "Settings" option
    // The dropdown should appear after clicking the settings button
    await page.waitForTimeout(1_000);
    
    // Wait for dropdown/menu to appear
    try {
      await page.waitForSelector('[role="menu"], [role="menuitem"], [data-radix-popper-content-wrapper]', { timeout: 3_000 });
    } catch (error) {
      logger.warn('Dropdown menu did not appear, trying to find Settings anyway');
    }
    
    // Look for "Settings" text in dropdown menu (not the button itself)
    // Try multiple approaches
    let clicked = false;
    
    // Method 1: Find menu items
    try {
      const menuItems = await page.locator('[role="menuitem"]').all();
      for (const item of menuItems) {
        const text = await item.textContent().catch(() => '');
        if (text && text.toLowerCase().trim().includes('settings')) {
          if (await item.isVisible({ timeout: 1_000 }).catch(() => false)) {
            await item.click();
            logger.info('Clicked Settings in dropdown menu (menuitem)');
            clicked = true;
            break;
          }
        }
      }
    } catch (error) {
      // Continue to next method
    }
    
    // Method 2: Find by text but exclude the button
    if (!clicked) {
      try {
        const allSettingsElements = await page.locator('text=/^Settings$/i').all();
        for (const element of allSettingsElements) {
          const tagName = await element.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
          const ariaLabel = await element.getAttribute('aria-label').catch(() => '');
          const parent = await element.evaluateHandle((el) => el.closest('[role="menu"], [role="menuitem"]')).catch(() => null);
          
          // Skip if it's the button itself
          if (tagName === 'button' && ariaLabel === 'Settings' && !parent) {
            continue;
          }
          
          if (await element.isVisible({ timeout: 1_000 }).catch(() => false)) {
            await element.click();
            logger.info('Clicked Settings in dropdown menu (text match)');
            clicked = true;
            break;
          }
        }
      } catch (error) {
        // Continue
      }
    }
    
    // Method 3: Find any clickable element with Settings text in a menu context
    if (!clicked) {
      try {
        const menuContainer = page.locator('[role="menu"], [data-radix-popper-content-wrapper]').first();
        if (await menuContainer.isVisible({ timeout: 2_000 }).catch(() => false)) {
          const settingsInMenu = menuContainer.locator('text=/Settings/i').first();
          if (await settingsInMenu.isVisible({ timeout: 1_000 }).catch(() => false)) {
            await settingsInMenu.click();
            logger.info('Clicked Settings in dropdown menu (menu container)');
            clicked = true;
          }
        }
  } catch (error) {
        // Continue
      }
    }
    
    if (!clicked) {
      // Maybe the dropdown auto-opens the modal, or Settings is already selected
      logger.warn('Settings menu item not found, assuming modal opens directly or trying direct navigation');
    }
    
    await page.waitForTimeout(1_500);

    // Step 3: Wait for settings modal to appear
    // Try multiple ways to detect modal
    let modalAppeared = false;
    try {
      await page.waitForSelector('role=dialog', { timeout: 10_000 });
      modalAppeared = true;
    } catch (error) {
      // Try alternative selectors
      try {
        await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
        modalAppeared = true;
      } catch (e) {
        // Check if modal is already there
        const existingModal = await page.locator('role=dialog, [role="dialog"]').first().isVisible({ timeout: 2_000 }).catch(() => false);
        if (existingModal) {
          modalAppeared = true;
        }
      }
    }

    if (!modalAppeared) {
      logger.warn('Settings modal did not appear, but continuing anyway');
    } else {
      logger.info('Settings modal appeared');
    }

    await page.waitForTimeout(1_000);
    await capturePageState(page, artifactsDir, 'settings-modal-opened');

    // Step 4: Find and click "Usage" tab in sidebar
    // Usage tab has role="tab" and contains text "Usage" - don't rely on id
    // Find all tabs and look for one with "Usage" text
    const allTabs = await page.locator('[role="tab"]').all();
    
    let usageTab = null;
    for (const tab of allTabs) {
      try {
        const text = await tab.textContent().catch(() => '');
        if (text && text.toLowerCase().trim().includes('usage')) {
          if (await tab.isVisible({ timeout: 1_000 }).catch(() => false)) {
            usageTab = tab;
            logger.info('Found Usage tab by text content');
            break;
          }
        }
      } catch (error) {
        continue;
      }
    }
    
    if (!usageTab) {
      // Fallback: try selector with text
      try {
        const tab = page.locator('[role="tab"]').filter({ hasText: /usage/i }).first();
        if (await tab.isVisible({ timeout: 3_000 }).catch(() => false)) {
          usageTab = tab;
          logger.info('Found Usage tab by filter');
        }
      } catch (error) {
        logger.warn({ error }, 'Failed to find Usage tab');
      }
    }

    if (!usageTab) {
      logger.error('Could not find Usage tab');
    return undefined;
  }

    await usageTab.click();
    await page.waitForTimeout(2_000);
    logger.info('Clicked Usage tab');

    // Step 5: Wait for usage tabpanel to be active and load content
    // Don't rely on specific id, just wait for any active tabpanel
    await page.waitForSelector('[role="tabpanel"][data-state="active"]', { timeout: 5_000 }).catch(() => {
      // Fallback: wait for tabpanel to appear
      page.waitForSelector('[role="tabpanel"]', { timeout: 3_000 }).catch(() => {
        logger.warn('Usage tabpanel did not appear');
      });
    });
    
    await page.waitForTimeout(1_000);

    // Wait for API response (optional)
    const response = await usageResponsePromise;

    if (response) {
  const payload = (await response.json()) as Record<string, unknown>;
      await capturePageState(page, artifactsDir, 'settings-usage-loaded');

  const creditRemaining =
    payload?.rate_limit_and_credit_balance && typeof payload.rate_limit_and_credit_balance === 'object'
      ? (payload.rate_limit_and_credit_balance as Record<string, unknown>).estimated_num_videos_remaining
      : undefined;

      if (typeof creditRemaining === 'number') {
        logger.info({ creditRemaining }, 'Updated credit info from usage API');
        return payload;
      }
    }

    // Step 6: Extract credit from page content
    // Look for the number in "video gens left" text
    // Format: <div class="text-5xl leading-none">2</div><div class="mb-[5px] text-base leading-none">video gens left</div>
    try {
      // Method 1: Find the large number (text-5xl)
      const creditNumberElement = page.locator('.text-5xl.leading-none').first();
      if (await creditNumberElement.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const creditText = await creditNumberElement.textContent();
        if (creditText) {
          const creditRemaining = parseInt(creditText.trim(), 10);
          if (!isNaN(creditRemaining)) {
            logger.info({ creditRemaining, source: 'page-element' }, 'Extracted credit info from usage page');
            return {
              rate_limit_and_credit_balance: {
                estimated_num_videos_remaining: creditRemaining
              }
            } as Record<string, unknown>;
          }
        }
      }

      // Method 2: Find text containing "video gens left" and extract number before it
      const creditTextElement = page.locator('text=/video gens left/i').first();
      if (await creditTextElement.isVisible({ timeout: 3_000 }).catch(() => false)) {
        // Get parent container and find the number
        const parent = creditTextElement.locator('..');
        const allText = await parent.textContent();
        if (allText) {
          const match = allText.match(/(\d+)\s*video\s*gens?\s*left/i);
          if (match) {
            const creditRemaining = parseInt(match[1], 10);
            logger.info({ creditRemaining, source: 'text-extraction' }, 'Extracted credit info from text');
            return {
              rate_limit_and_credit_balance: {
                estimated_num_videos_remaining: creditRemaining
              }
            } as Record<string, unknown>;
          }
        }
      }

      // Method 3: Generic search for number + "video" + "left"
      const usageContent = await page.locator('[role="tabpanel"][data-state="active"]').first().textContent({ timeout: 3_000 }).catch(() => null);
      if (usageContent) {
        const match = usageContent.match(/(\d+)\s*video\s*gens?\s*left/i);
        if (match) {
          const creditRemaining = parseInt(match[1], 10);
          logger.info({ creditRemaining, source: 'content-extraction' }, 'Extracted credit info from tabpanel content');
          return {
            rate_limit_and_credit_balance: {
              estimated_num_videos_remaining: creditRemaining
            }
          } as Record<string, unknown>;
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to extract credit from page content');
  }

    await capturePageState(page, artifactsDir, 'settings-usage-final');
    logger.warn('Could not retrieve credit information');
    return undefined;
  } catch (error) {
    logger.error({ error }, 'Error checking credits');
    return undefined;
  }
}

async function detectPolicyViolation(page: Page, artifactsDir?: string): Promise<void> {
  // Check for policy violation banner
  const violationBanner = page.locator('text=/This content may violate/i').first();
  if (await violationBanner.isVisible().catch(() => false)) {
    await capturePageState(page, artifactsDir, 'policy-violation');
    logger.warn('Policy violation banner detected on the page.');
    throw new Error('Generation flagged for policy violation.');
  }

  // Check for "Something went wrong" error
  const errorBanner = page.locator('text=/Something went wrong/i').first();
  if (await errorBanner.isVisible().catch(() => false)) {
    await capturePageState(page, artifactsDir, 'error-something-went-wrong');
    logger.warn('"Something went wrong" error detected on the page.');
    throw new Error('Generation failed: Something went wrong');
  }

  // Check for generic error messages
  const genericError = page.locator('text=/error|failed|went wrong/i').first();
  if (await genericError.isVisible().catch(() => false)) {
    const errorText = await genericError.textContent().catch(() => 'Unknown error');
    await capturePageState(page, artifactsDir, 'error-generic');
    logger.warn({ errorText }, 'Generic error detected on the page.');
    throw new Error(`Generation failed: ${errorText}`);
  }
}

