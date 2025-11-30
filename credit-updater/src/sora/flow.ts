import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

export async function ensureAuthenticated(
  page: Page,
  baseUrl: string,
  requireManualLogin: boolean,
  artifactsDir?: string,
  skipAuthCheck = false
): Promise<void> {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

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

export async function runGeneration(options: FlowOptions, input: GenerationInput): Promise<GenerationResult> {
  const { page, baseUrl, artifactsDir } = options;

  const draftsUrl = new URL(DRAFTS_PATH, baseUrl).toString();
  await page.goto(draftsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  logger.info({ draftsUrl }, 'Opened drafts workspace');
  await capturePageState(page, artifactsDir, 'drafts-before-create');

  const promptBox = page.getByPlaceholder('Describe your video...').first();
  await promptBox.waitFor({ state: 'visible', timeout: 30_000 }).catch(async (error) => {
    await capturePageState(page, artifactsDir, 'composer-missing');
    throw new Error(`Composer prompt not found: ${(error as Error).message}`);
  });
  await promptBox.click();
  await promptBox.fill(input.prompt);

  await applyComposerOptions(page, input);

  const generateButton = page.getByRole('button', { name: /create video|generate|submit/i }).first();
  await waitForEnabled(page, generateButton);
  await generateButton.click();
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
    
    // Every 6 polls (30 seconds), reload the drafts page to trigger API call
    if (pollCount % 6 === 0) {
      logger.info({ pollCount }, 'Reloading drafts page to trigger API refresh');
      try {
        // Wait for the drafts API response when reloading
        const responsePromise = page.waitForResponse(
          (res) => res.url().includes('/backend/project_y/profile/drafts') && res.request().method() === 'GET',
          { timeout: 30_000 }
        );

        await page.goto(draftsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        
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

async function applyComposerOptions(page: Page, input: GenerationInput): Promise<void> {
  const settingsButton = page.getByRole('button', { name: /^settings$/i }).last();
  if (!(await settingsButton.isVisible().catch(() => false))) {
    logger.warn('Composer settings button not found; using default duration and orientation.');
    return;
  }

  await settingsButton.click();

  await selectMenuItem(page, new RegExp(`${input.durationSeconds}\\s*s`, 'i'), 'duration');

  const orientationPattern = input.orientation === 'portrait' ? /portrait/i : /landscape/i;
  await selectMenuItem(page, orientationPattern, 'orientation');

  await page.keyboard.press('Escape').catch(() => undefined);
}

async function selectMenuItem(page: Page, pattern: RegExp, label: string): Promise<void> {
  const item = page.getByRole('menuitem', { name: pattern }).first();
  if (await item.isVisible().catch(() => false)) {
    await item.click();
    await page.waitForTimeout(200);
    logger.info({ label }, 'Composer option updated');
  } else {
    logger.warn({ label }, 'Composer option not found; leaving default');
  }
}

async function waitForEnabled(page: Page, locator: Locator): Promise<void> {
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

  const postButton = page.getByRole('button', { name: /post|publish/i }).first();
  if (await postButton.isVisible().catch(() => false)) {
    await postButton.click();
    await page.waitForTimeout(2_000);
    logger.info('Clicked Post button for the draft');
  } else {
    logger.warn('Post button not visible on draft detail page.');
  }

  const profileUrl = new URL('/profile', baseUrl).toString();
  await page.goto(profileUrl, { waitUntil: 'networkidle' });
  await capturePageState(page, artifactsDir, 'profile-feed');

  const latestProfileCard = page.locator('a[href^="/p/"]').first();
  if (!(await latestProfileCard.isVisible().catch(() => false))) {
    logger.warn('Unable to locate published video on profile feed.');
    return undefined;
  }

  await openRelativeLink(page, latestProfileCard, baseUrl);
  await page.waitForURL(/\/p\//, { timeout: 30_000 }).catch(() => undefined);
  await capturePageState(page, artifactsDir, 'profile-video');

  const finalUrl = page.url();
  logger.info({ finalUrl }, 'Captured public profile URL');
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

export async function checkCredits(
  page: Page,
  baseUrl: string,
  artifactsDir?: string
): Promise<Record<string, unknown> | undefined> {
  const endpoint = new URL('/backend/nf/check', baseUrl).toString();

  const responsePromise = page.waitForResponse((res) => res.url().includes('/backend/nf/check'), { timeout: 15_000 });

  try {
    await page.evaluate(
      async ({ url }) => {
        await fetch(url, { method: 'POST', credentials: 'include' });
      },
      { url: endpoint }
    );
  } catch (error) {
    logger.warn({ error }, 'Failed to trigger credit check from page context.');
  }

  const response = await responsePromise.catch((error) => {
    logger.warn({ error }, 'Did not capture /nf/check response');
    return undefined;
  });

  if (!response) {
    return undefined;
  }

  const payload = (await response.json()) as Record<string, unknown>;
  await capturePageState(page, artifactsDir, 'settings-usage-cache');

  const creditRemaining =
    payload?.rate_limit_and_credit_balance && typeof payload.rate_limit_and_credit_balance === 'object'
      ? (payload.rate_limit_and_credit_balance as Record<string, unknown>).estimated_num_videos_remaining
      : undefined;

  logger.info({ creditRemaining }, 'Updated credit info');

  if (typeof creditRemaining === 'number' && creditRemaining < 5) {
    logger.warn({ creditRemaining }, 'Credit pool low; consider pausing this account for today.');
  }

  return payload;
}

async function detectPolicyViolation(page: Page, artifactsDir?: string): Promise<void> {
  const violationBanner = page.locator('text=/This content may violate/i').first();
  if (await violationBanner.isVisible().catch(() => false)) {
    await capturePageState(page, artifactsDir, 'policy-violation');
    logger.warn('Policy violation banner detected on the page.');
    throw new Error('Generation flagged for policy violation.');
  }
}

