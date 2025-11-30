#!/usr/bin/env node
import { logger } from './logger.js';
import { runtimeConfig } from './config.js';
import { TaskClient } from './taskClient.js';
import { AccountSelector } from './accountSelector.js';
import { WorkerRunner } from './workerRunner.js';
import { TaskStore } from './taskStore.js';
import { initTelegram, sendErrorNotification, sendTelegramMessage } from './telegram.js';

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

async function processTask(): Promise<void> {
  const taskClient = new TaskClient();
  const accountSelector = new AccountSelector();
  const workerRunner = new WorkerRunner();
  const taskStore = new TaskStore();

  await accountSelector.connect();
  await taskStore.connect();

  try {
    // Claim a task
    const task = await taskClient.claimTask(runtimeConfig.PRODUCT_CODE);
    
    if (!task) {
      // No pending tasks
      return;
    }

    // Save task to database
    await taskStore.saveTask(task, runtimeConfig.PRODUCT_CODE);

    logger.info({ taskId: task.id, prompt: task.prompt }, 'Processing task');

    // Select an available profile
    const profile = await accountSelector.selectAvailableProfile();
    
    if (!profile) {
      logger.error({ taskId: task.id }, 'No available profiles, reporting task as failed');
      await taskStore.updateTaskStatus(task.id, 'failed', {
        error: 'No available profiles with sufficient credits'
      });
      await taskStore.incrementDailyStats('failed');
      await taskClient.reportTask(task.id, 'No available profiles with sufficient credits');
      await sendErrorNotification(task.id, 'No available profiles with sufficient credits');
      return;
    }

    // Update task with profile
    await taskStore.updateTaskStatus(task.id, 'processing', {
      profileName: profile.name
    });

    // Map task parameters
    const duration = mapTimingToDuration(task.timing);
    const orientation = mapDimensionToOrientation(task.dimension);

    logger.info(
      { taskId: task.id, profile: profile.name, duration, orientation },
      'Starting worker'
    );

    // Run worker
    const result = await workerRunner.runWorker(profile, task.prompt, duration, orientation, task.id);

    if (result.success && result.publicUrl) {
      // Update task as completed
      await taskStore.updateTaskStatus(task.id, 'completed', {
        publicUrl: result.publicUrl
      });
      await taskStore.incrementDailyStats('completed', 1);

      // Complete task on server
      const completed = await taskClient.completeTask(task.id, result.publicUrl);
      if (completed) {
        logger.info({ taskId: task.id, publicUrl: result.publicUrl }, 'Task completed successfully');
      } else {
        logger.error({ taskId: task.id }, 'Failed to mark task as completed on server');
      }
    } else {
      // Check if it's a timeout
      const errorMessage = result.error || 'Unknown error';
      const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('Timeout');
      const status: 'failed' | 'timeout' = isTimeout ? 'timeout' : 'failed';

      // Update task status
      await taskStore.updateTaskStatus(task.id, status, {
        error: errorMessage
      });
      await taskStore.incrementDailyStats('failed');

      logger.error({ taskId: task.id, error: errorMessage, status }, 'Task failed');
      await taskClient.reportTask(task.id, errorMessage);
      await sendErrorNotification(task.id, errorMessage, profile.name);
    }
  } catch (error) {
    logger.error({ error }, 'Error processing task');
    // Try to update task status if we have taskId in error context
    // For now, just log - task will remain in 'processing' status
  } finally {
    await accountSelector.disconnect();
    await taskStore.disconnect();
  }
}

async function main(): Promise<void> {
  logger.info('Starting orchestrator service');
  
  initTelegram();
  await sendTelegramMessage('🚀 Orchestrator service started');

  const pollInterval = runtimeConfig.POLL_INTERVAL_SECONDS * 1000;

  while (true) {
    try {
      logger.info('Processing task');
      await processTask();
    } catch (error) {
      logger.error({ error }, 'Error in main loop');
      await sendErrorNotification('unknown', error instanceof Error ? error.message : String(error));
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down orchestrator');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down orchestrator');
  process.exit(0);
});

main().catch((error) => {
  logger.fatal({ error }, 'Fatal error in orchestrator');
  process.exit(1);
});

