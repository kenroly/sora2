#!/usr/bin/env node
// CRITICAL: Import initFingerprint FIRST to set FINGERPRINT_CWD before any other imports
// This must be imported before launch.ts which imports playwright-with-fingerprints
import './browser/initFingerprint.js';

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cac } from 'cac';
import { runtimeConfig } from './config.js';
import { launchBrowser } from './browser/launch.js';
import { ensureAuthenticated, runGeneration } from './sora/flow.js';
import { NetworkRecorder } from './network/recorder.js';
import { logger } from './logger.js';
import { MongoProfileStore } from './storage/mongoProfileStore.js';
import type { GenerationInput, VideoOrientation } from './types.js';
import { MonitorStreamer } from './monitor/streamer.js';

const cli = cac('sora-automation');

cli
  .command('', 'Generate a Sora video end-to-end')
  .option('--prompt <text>', 'Prompt that describes the video')
  .option('--duration <seconds>', 'Duration in seconds (10 or 15)', { default: '15' })
  .option('--orientation <mode>', 'Orientation: portrait|landscape', { default: 'portrait' })
  .option('--manual-login', 'Pause for manual login if session missing', { default: false })
  .option('--profile <name>', 'Profile identifier (binds to a dedicated proxy)', { default: 'default' })
  .option('--login-only', 'Exit after ensuring the profile is logged in', { default: false })
  .option('--skip-auth-check', 'Skip login detection (use stored session as-is)', { default: false })
  .option('--task-id <id>', 'Optional orchestrator task ID to attach monitor stream')
  .action(async (flags) => {
    const duration = Number(flags.duration);
    if (![10, 15].includes(duration)) {
      throw new Error('Duration must be 10 or 15 seconds');
    }

    const orientation = (flags.orientation ?? 'portrait').toLowerCase() as VideoOrientation;
    if (!['portrait', 'landscape'].includes(orientation)) {
      throw new Error('Orientation must be portrait or landscape');
    }

    if (!flags.prompt) {
      throw new Error('--prompt is required');
    }

    const profileName: string = flags.profile;
    const taskId: string | undefined = flags.taskId;
    const profileStore = new MongoProfileStore({
      mongoUri: runtimeConfig.MONGODB_URI,
      databaseName: runtimeConfig.MONGODB_DATABASE,
      profileRoot: runtimeConfig.PROFILE_ROOT
    });

    await profileStore.connect();
    const profile = await profileStore.ensureProfile(profileName);

    const { context, page, artifactsDir } = await launchBrowser({
      userDataDir: profile.userDataDir,
      proxy: profile.proxy,
      fingerprint: profile.fingerprint,
      onFingerprintPersist: async (fingerprint) => {
        await profileStore.setFingerprint(profile.name, fingerprint);
      }
    });

    const monitorStreamer = new MonitorStreamer(page, {
      taskId,
      profileName: profile.name
    });
    monitorStreamer.start();

    const recorder = new NetworkRecorder(page, join(artifactsDir, 'network.ndjson'));
    recorder.start();

    try {
      await ensureAuthenticated(
        page,
        runtimeConfig.SORA_BASE_URL,
        Boolean(flags.manualLogin),
        artifactsDir,
        Boolean(flags.skipAuthCheck)
      );

      if (flags.loginOnly) {
        logger.info('Login-only mode complete. Session persisted to profile folder.');
        return;
      }

      const input: GenerationInput = {
        prompt: flags.prompt,
        durationSeconds: duration as 10 | 15,
        orientation
      };

      const result = await runGeneration({ page, baseUrl: runtimeConfig.SORA_BASE_URL, artifactsDir }, input);
      
      // Update credit info if available
      if (result.metadata?.creditInfo) {
        const creditRemaining = (result.metadata.creditInfo as any)?.rate_limit_and_credit_balance?.estimated_num_videos_remaining;
        if (typeof creditRemaining === 'number') {
          await profileStore.updateCredit(profile.name, creditRemaining);
        }
      }

      // Increment run count
      await profileStore.incrementRunCount(profile.name);

      logger.info(result, 'Generation finished');
      
      // Output JSON result for orchestrator to parse
      const output = {
        success: true,
        jobId: result.jobId,
        publicUrl: result.publicUrl,
        downloadUrl: result.downloadUrl,
        metadata: result.metadata,
        taskId
      };
      console.log(JSON.stringify(output));

      await mkdir('artifacts', { recursive: true });
      await mkdir(join('artifacts', result.jobId), { recursive: true });
    } catch (error) {
      // Output error for orchestrator
      const errorOutput = {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
      console.error(JSON.stringify(errorOutput));
      throw error;
    } finally {
      await recorder.stop();
      await monitorStreamer.stop();
      await context.close();
      await profileStore.disconnect();
    }
  });

cli.help();
cli.parse();

