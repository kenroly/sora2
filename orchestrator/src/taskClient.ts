import { logger } from './logger.js';
import { runtimeConfig } from './config.js';

export interface TaskData {
  id: string;
  prompt: string;
  image_urls?: string[];
  timing?: number;
  duration?: number; // Some APIs return duration directly
  resolution?: string;
  dimension?: string;
  count?: number;
  generate_type?: string;
}

export interface TaskResponse {
  error_code: number;
  message: string;
  data?: TaskData;
}

export class TaskClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.baseUrl = runtimeConfig.API_BASE_URL;
    this.apiKey = runtimeConfig.API_KEY;
  }

  async claimTask(productCode: string): Promise<TaskData | null> {
    const url = `${this.baseUrl}/tasks/${productCode}`;
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-API-Key': this.apiKey
        }
      });

      const data = (await response.json()) as TaskResponse;

      if (data.error_code === 0 && data.data) {
        logger.info({ taskId: data.data.id, productCode }, 'Claimed task');
        return data.data;
      }

      if (data.error_code === 180005) {
        // No pending tasks
        return null;
      }

      logger.warn({ error_code: data.error_code, message: data.message }, 'Failed to claim task');
      return null;
    } catch (error) {
      logger.error({ error, url }, 'Error claiming task');
      return null;
    }
  }

  async completeTask(taskId: string, resultUrl: string): Promise<boolean> {
    const url = `${this.baseUrl}/tasks/${taskId}`;
    
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ result_url: resultUrl })
      });

      const data = (await response.json()) as TaskResponse;

      if (data.error_code === 0) {
        logger.info({ taskId, resultUrl }, 'Task completed');
        return true;
      }

      logger.warn({ taskId, error_code: data.error_code, message: data.message }, 'Failed to complete task');
      return false;
    } catch (error) {
      logger.error({ error, taskId }, 'Error completing task');
      return false;
    }
  }

  async reportTask(taskId: string, reason: string): Promise<boolean> {
    const url = `${this.baseUrl}/tasks/${taskId}/report`;
    
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ reason })
      });

      const data = (await response.json()) as TaskResponse;

      if (data.error_code === 0) {
        logger.info({ taskId, reason }, 'Task reported as failed');
        return true;
      }

      logger.warn({ taskId, error_code: data.error_code, message: data.message }, 'Failed to report task');
      return false;
    } catch (error) {
      logger.error({ error, taskId }, 'Error reporting task');
      return false;
    }
  }

  async resetTask(taskId: string): Promise<boolean> {
    const url = `${this.baseUrl}/tasks/${taskId}/reset`;
    
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'X-API-Key': this.apiKey
        }
      });

      const data = (await response.json()) as TaskResponse;

      if (data.error_code === 0) {
        logger.info({ taskId }, 'Task reset');
        return true;
      }

      logger.warn({ taskId, error_code: data.error_code, message: data.message }, 'Failed to reset task');
      return false;
    } catch (error) {
      logger.error({ error, taskId }, 'Error resetting task');
      return false;
    }
  }
}

