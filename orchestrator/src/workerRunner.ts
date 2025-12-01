import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { logger } from './logger.js';
import { runtimeConfig } from './config.js';
import type { ProfileRecord } from './accountSelector.js';

export interface WorkerResult {
  success: boolean;
  publicUrl?: string;
  downloadUrl?: string;
  jobId?: string;
  error?: string;
}

export class WorkerRunner {
  async runWorker(
    profile: ProfileRecord,
    prompt: string,
    duration: number,
    orientation: 'portrait' | 'landscape',
    taskId?: string
  ): Promise<WorkerResult> {
    const timeoutMs = runtimeConfig.TASK_TIMEOUT_MINUTES * 60 * 1000;
    const profileDir = resolve(runtimeConfig.PROFILE_ROOT);
    const fingerprintDir =
      runtimeConfig.FINGERPRINT_WORKDIR?.length
        ? resolve(runtimeConfig.FINGERPRINT_WORKDIR)
        : resolve(runtimeConfig.FINGERPRINT_DIR_HOST ?? resolve(process.cwd(), '../../.fingerprint-engine'));
    const workerEntry =
      runtimeConfig.WORKER_ENTRY ?? resolve(process.cwd(), '../sora-worker/dist/index.js');

    const args = [
      workerEntry,
      '--profile',
      profile.name,
      '--prompt',
      prompt,
      '--duration',
      String(duration),
      '--orientation',
      orientation,
      '--skip-auth-check'
    ];

    if (taskId) {
      args.push('--task-id', taskId);
    }

    const env = {
      ...process.env,
      PROFILE_DIR: profileDir,
      PROFILE_ROOT: profileDir,
      FINGERPRINT_WORKDIR: fingerprintDir,
      BABLOSOFT_API_KEY: process.env.BABLOSOFT_API_KEY ?? '',
      SORA_BASE_URL: process.env.SORA_BASE_URL ?? 'https://sora.chatgpt.com',
      MONGODB_URI: runtimeConfig.MONGODB_URI,
      MONGODB_DATABASE: runtimeConfig.MONGODB_DATABASE
    } as Record<string, string | undefined>;

    if (runtimeConfig.MONITOR_GATEWAY_URL) {
      env.MONITOR_GATEWAY_URL = runtimeConfig.MONITOR_GATEWAY_URL;
    }
    if (runtimeConfig.MONITOR_GATEWAY_TOKEN) {
      env.MONITOR_GATEWAY_TOKEN = runtimeConfig.MONITOR_GATEWAY_TOKEN;
    }
    env.MONITOR_CAPTURE_INTERVAL_MS = String(runtimeConfig.MONITOR_CAPTURE_INTERVAL_MS ?? 1000);

    logger.info(
      { profile: profile.name, prompt, duration, orientation, workerEntry },
      'Starting worker process'
    );

    return new Promise((resolvePromise) => {
      const workerProcess = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });

      let stdout = '';
      let stderr = '';
      let timeoutId: NodeJS.Timeout | null = null;

      workerProcess.stdout?.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        logger.debug({ text }, 'Worker stdout');
      });

      workerProcess.stderr?.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        logger.debug({ text }, 'Worker stderr');
      });

      workerProcess.on('error', (error) => {
        logger.error({ error }, 'Failed to start worker process');
        if (timeoutId) clearTimeout(timeoutId);
        resolvePromise({
          success: false,
          error: `Failed to start worker: ${error.message}`
        });
      });

      workerProcess.on('exit', (code, signal) => {
        if (timeoutId) clearTimeout(timeoutId);

        if (code === 0) {
          // Try to parse JSON output from stdout
          try {
            const lines = stdout.trim().split('\n');
            let parsedResult: any | null = null;

            // Walk from the end to prefer the final JSON status object
            for (let i = lines.length - 1; i >= 0; i -= 1) {
              const line = lines[i].trim();
              if (!line.length) continue;
              try {
                const parsed = JSON.parse(line);
                if (parsed && typeof parsed === 'object' && 'success' in parsed) {
                  parsedResult = parsed;
                  break;
                }
              } catch {
                // ignore non‑JSON lines
              }
            }

            if (parsedResult && parsedResult.success && parsedResult.publicUrl) {
              const result = parsedResult;
              logger.info({ result }, 'Worker completed successfully');
              resolvePromise({
                success: true,
                publicUrl: result.publicUrl,
                downloadUrl: result.downloadUrl,
                jobId: result.jobId
              });
              return;
            }

            // Fallback: no JSON found or success=false
            logger.warn({ stdout, stderr }, 'Worker exited but no valid result found');
            resolvePromise({
              success: false,
              error: 'Worker completed but no valid result URL found'
            });
          } catch (error) {
            logger.error({ error, stdout, stderr }, 'Failed to parse worker output');
            resolvePromise({
              success: false,
              error: `Failed to parse output: ${error instanceof Error ? error.message : String(error)}`
            });
          }
        } else {
          // Try to parse error from stderr or stdout
          let errorMessage = `Worker exited with code ${code}`;
          if (signal) {
            errorMessage += ` (signal: ${signal})`;
          }

          try {
            const lines = (stdout + stderr).trim().split('\n');
            const jsonLine = lines.find((line) => {
              try {
                const parsed = JSON.parse(line);
                return parsed.error || parsed.success === false;
              } catch {
                return false;
              }
            });

            if (jsonLine) {
              const parsed = JSON.parse(jsonLine);
              errorMessage = parsed.error || errorMessage;
            }
          } catch {
            // Ignore parse errors
          }

          logger.error({ code, signal, stdout, stderr }, 'Worker failed');
          resolvePromise({
            success: false,
            error: errorMessage
          });
        }
      });

      // Set timeout
      timeoutId = setTimeout(() => {
        logger.warn({ profile: profile.name, timeoutMs }, 'Worker timeout, killing process');
        try {
          workerProcess.kill('SIGKILL');
        } catch (error) {
          // Ignore kill errors
        }
        resolvePromise({
          success: false,
          error: `Task timeout after ${runtimeConfig.TASK_TIMEOUT_MINUTES} minutes`
        });
      }, timeoutMs);
    });
  }
}
