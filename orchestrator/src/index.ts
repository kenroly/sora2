#!/usr/bin/env node
import { logger } from './logger.js';
import { runtimeConfig } from './config.js';
import { TaskClient } from './taskClient.js';
import { AccountSelector } from './accountSelector.js';
import { WorkerRunner } from './workerRunner.js';
import { TaskStore } from './taskStore.js';
import { initTelegram, sendErrorNotification, sendTelegramMessage } from './telegram.js';
import type { TaskData } from './taskClient.js';
import type { ProfileRecord } from './accountSelector.js';
import type { WorkerResult } from './workerRunner.js';

// Map dimension to orientation
function mapDimensionToOrientation(dimension?: string): 'portrait' | 'landscape' {
  if (!dimension) return 'portrait';
  
  const portraitDims = ['9:16', '3:4'];
  const landscapeDims = ['16:9', '21:9', '4:3'];
  
  if (portraitDims.includes(dimension)) return 'portrait';
  if (landscapeDims.includes(dimension)) return 'landscape';
  
  // Default to portrait if unknown
  return 'portrait';
}

// Map timing to duration (must be 10 or 15)
function mapTimingToDuration(timing?: number): 10 | 15 {
  if (!timing) return 15;
  
  // Round to nearest valid duration
  if (timing <= 12) return 10;
  return 15;
}

interface ActiveWorker {
  taskId: string;
  task: TaskData;
  profile: ProfileRecord;
  promise: Promise<WorkerResult>;
  startedAt: Date;
}

class Orchestrator {
  private taskClient: TaskClient;
  private accountSelector: AccountSelector;
  private workerRunner: WorkerRunner;
  private taskStore: TaskStore;
  private activeWorkers: Map<string, ActiveWorker> = new Map();
  public isShuttingDown = false;

  constructor() {
    this.taskClient = new TaskClient();
    this.accountSelector = new AccountSelector();
    this.workerRunner = new WorkerRunner();
    this.taskStore = new TaskStore();
  }

  async initialize(): Promise<void> {
    await this.accountSelector.connect();
    await this.taskStore.connect();
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return; // Already shutting down
    }
    
    this.isShuttingDown = true;
    logger.info({ activeWorkers: this.activeWorkers.size }, 'Shutting down, waiting for active workers');
    
    // Wait for all active workers to complete (with timeout)
    if (this.activeWorkers.size > 0) {
      const promises = Array.from(this.activeWorkers.values()).map(w => w.promise);
      await Promise.allSettled(promises);
    }
    
    await this.accountSelector.disconnect();
    await this.taskStore.disconnect();
    logger.info('Orchestrator shutdown complete');
  }

  getActiveWorkerCount(): number {
    return this.activeWorkers.size;
  }

  canStartNewWorker(): boolean {
    return this.activeWorkers.size < runtimeConfig.MAX_CONCURRENT_WORKERS;
  }

  async startWorker(task: TaskData, profile: ProfileRecord): Promise<void> {
    const taskId = task.id;
    
    // Save task to database
    await this.taskStore.saveTask(task, runtimeConfig.PRODUCT_CODE);

    logger.info({ taskId: task.id, prompt: task.prompt, profile: profile.name }, 'Processing task');

    // Update task with profile
    await this.taskStore.updateTaskStatus(task.id, 'processing', {
      profileName: profile.name
    });

    // Map task parameters
    const duration = mapTimingToDuration(task.timing);
    const orientation = mapDimensionToOrientation(task.dimension);

    logger.info(
      { taskId: task.id, profile: profile.name, duration, orientation },
      'Starting worker'
    );

    // Start worker (don't await - run in background)
    const workerPromise = this.workerRunner.runWorker(
      profile,
      task.prompt,
      duration,
      orientation,
      task.id
    );

    // Track active worker
    const activeWorker: ActiveWorker = {
      taskId,
      task,
      profile,
      promise: workerPromise,
      startedAt: new Date()
    };

    this.activeWorkers.set(taskId, activeWorker);

    // Handle worker completion
    workerPromise
      .then((result) => {
        this.handleWorkerComplete(taskId, result);
      })
      .catch((error) => {
        logger.error({ taskId, error }, 'Worker promise rejected');
        this.handleWorkerComplete(taskId, {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private async handleWorkerComplete(taskId: string, result: WorkerResult): Promise<void> {
    // Remove from active workers
    const activeWorker = this.activeWorkers.get(taskId);
    if (!activeWorker) {
      logger.warn({ taskId }, 'Worker not found in active workers');
      return;
    }

    this.activeWorkers.delete(taskId);
    const duration = Date.now() - activeWorker.startedAt.getTime();
    
    logger.info(
      { taskId, success: result.success, durationMs: duration },
      'Worker completed'
    );

    try {
      if (result.success && result.publicUrl) {
        // Update task as completed
        await this.taskStore.updateTaskStatus(taskId, 'completed', {
          publicUrl: result.publicUrl
        });
        await this.taskStore.incrementDailyStats('completed', 1);

        // Complete task on server
        const completed = await this.taskClient.completeTask(taskId, result.publicUrl);
        if (completed) {
          logger.info({ taskId, publicUrl: result.publicUrl }, 'Task completed successfully');
        } else {
          logger.error({ taskId }, 'Failed to mark task as completed on server');
        }
      } else {
        // Check if it's a timeout
        const errorMessage = result.error || 'Unknown error';
        const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('Timeout');
        const status: 'failed' | 'timeout' = isTimeout ? 'timeout' : 'failed';

        // Update task status
        await this.taskStore.updateTaskStatus(taskId, status, {
          error: errorMessage
        });
        await this.taskStore.incrementDailyStats('failed');

        logger.error({ taskId, error: errorMessage, status }, 'Task failed');
        await this.taskClient.reportTask(taskId, errorMessage);
        await sendErrorNotification(taskId, errorMessage, activeWorker.profile.name);
      }
    } catch (error) {
      logger.error({ taskId, error }, 'Error handling worker completion');
    }
  }

  async tryClaimAndStartTask(): Promise<boolean> {
    // Check if we can start new worker
    if (!this.canStartNewWorker()) {
      logger.debug(
        { active: this.activeWorkers.size, max: runtimeConfig.MAX_CONCURRENT_WORKERS },
        'Max workers reached, skipping task claim'
      );
      return false;
    }

    // Check for available profile first before claiming a task
    const profile = await this.accountSelector.selectAvailableProfile();
    
    if (!profile) {
      logger.debug('No available profiles, skipping task claim');
      return false;
    }

    logger.info({ profile: profile.name }, 'Profile available, claiming task');

    // Claim a task only when we have an available profile
    const task = await this.taskClient.claimTask(runtimeConfig.PRODUCT_CODE);
    
    if (!task) {
      // No pending tasks
      return false;
    }

    // Start worker immediately (non-blocking)
    await this.startWorker(task, profile);
    return true;
  }

  async monitor(): Promise<void> {
    const activeCount = this.activeWorkers.size;
    if (activeCount > 0) {
      const workers = Array.from(this.activeWorkers.values()).map(w => ({
        taskId: w.taskId,
        profile: w.profile.name,
        runningFor: Math.round((Date.now() - w.startedAt.getTime()) / 1000)
      }));
      logger.debug({ activeCount, workers }, 'Active workers status');
    }
  }
}

async function main(): Promise<void> {
  logger.info({ maxConcurrentWorkers: runtimeConfig.MAX_CONCURRENT_WORKERS }, 'Starting orchestrator service');
  
  initTelegram();
  await sendTelegramMessage(`🚀 Orchestrator service started (max workers: ${runtimeConfig.MAX_CONCURRENT_WORKERS})`);

  const orchestrator = new Orchestrator();
  orchestratorInstance = orchestrator;
  await orchestrator.initialize();

  const pollInterval = 10 * 1000; // 10 seconds as requested

  // Monitor loop - check active workers every 5 seconds
  const monitorInterval = setInterval(() => {
    orchestrator.monitor().catch((error) => {
      logger.error({ error }, 'Error in monitor loop');
    });
  }, 5000);

  // Main loop - try to claim and start tasks
  try {
    while (!orchestrator.isShuttingDown) {
      try {
        await orchestrator.tryClaimAndStartTask();
      } catch (error) {
        logger.error({ error }, 'Error in main loop');
        await sendErrorNotification('unknown', error instanceof Error ? error.message : String(error));
      }

      // Wait 10 seconds before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  } finally {
    clearInterval(monitorInterval);
    await orchestrator.shutdown();
  }
}

// Handle graceful shutdown
let orchestratorInstance: Orchestrator | null = null;

process.on('SIGINT', async () => {
  logger.info('Shutting down orchestrator');
  if (orchestratorInstance) {
    await orchestratorInstance.shutdown();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down orchestrator');
  if (orchestratorInstance) {
    await orchestratorInstance.shutdown();
  }
  process.exit(0);
});

main().catch((error) => {
  logger.fatal({ error }, 'Fatal error in orchestrator');
  process.exit(1);
});
