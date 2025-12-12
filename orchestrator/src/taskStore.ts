import { MongoClient, type Db, type Collection } from 'mongodb';
import { logger } from './logger.js';
import { runtimeConfig } from './config.js';
import type { TaskData } from './taskClient.js';

export interface TaskRecord {
  taskId: string;
  productCode: string;
  prompt: string;
  imageUrls?: string[];
  timing?: number;
  resolution?: string;
  dimension?: string;
  count?: number;
  generateType?: string;
  status: 'pending' | 'claimed' | 'processing' | 'completed' | 'failed' | 'timeout';
  profileName?: string;
  publicUrl?: string;
  error?: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DailyStats {
  date: string; // YYYY-MM-DD format
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  totalVideos: number;
  updatedAt: string;
}

export class TaskStore {
  private client: MongoClient;
  private db: Db;
  private tasksCollection: Collection<TaskRecord>;
  private dailyStatsCollection: Collection<DailyStats>;

  constructor() {
    this.client = new MongoClient(runtimeConfig.MONGODB_URI);
    this.db = this.client.db(runtimeConfig.MONGODB_DATABASE);
    this.tasksCollection = this.db.collection<TaskRecord>('tasks');
    this.dailyStatsCollection = this.db.collection<DailyStats>('daily_stats');
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.ensureIndexes();
    logger.info('TaskStore connected to MongoDB');
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  private async ensureIndexes(): Promise<void> {
    await this.tasksCollection.createIndex({ taskId: 1 }, { unique: true });
    await this.tasksCollection.createIndex({ status: 1, createdAt: 1 });
    await this.tasksCollection.createIndex({ profileName: 1, createdAt: 1 });
    await this.tasksCollection.createIndex({ publicUrl: 1, status: 1 });
    await this.dailyStatsCollection.createIndex({ date: 1 }, { unique: true });
  }

  async saveTask(task: TaskData, productCode: string): Promise<void> {
    const now = new Date().toISOString();
    const record: TaskRecord = {
      taskId: task.id,
      productCode,
      prompt: task.prompt,
      imageUrls: task.image_urls,
      timing: task.timing,
      resolution: task.resolution,
      dimension: task.dimension,
      count: task.count,
      generateType: task.generate_type,
      status: 'claimed',
      claimedAt: now,
      createdAt: now,
      updatedAt: now
    };

    await this.tasksCollection.updateOne(
      { taskId: task.id },
      { $setOnInsert: record },
      { upsert: true }
    );

    logger.info({ taskId: task.id, status: 'claimed' }, 'Task saved to database');
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskRecord['status'],
    updates?: Partial<TaskRecord>
  ): Promise<void> {
    const updateData: Partial<TaskRecord> = {
      status,
      updatedAt: new Date().toISOString(),
      ...updates
    };

    if (status === 'processing' && !updateData.startedAt) {
      updateData.startedAt = new Date().toISOString();
    }

    if (status === 'completed' && !updateData.completedAt) {
      updateData.completedAt = new Date().toISOString();
    }

    if (status === 'failed' || status === 'timeout') {
      updateData.completedAt = new Date().toISOString();
    }

    await this.tasksCollection.updateOne(
      { taskId },
      { $set: updateData }
    );

    logger.info({ taskId, status }, 'Task status updated');
  }

  async incrementDailyStats(status: 'completed' | 'failed', videoCount: number = 1): Promise<void> {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const now = new Date().toISOString();

    // First, ensure document exists
    await this.dailyStatsCollection.updateOne(
      { date: today },
      {
        $setOnInsert: {
          date: today,
          totalTasks: 0,
          completedTasks: 0,
          failedTasks: 0,
          totalVideos: 0,
          updatedAt: now
        }
      },
      { upsert: true }
    );

    // Then increment
    const incrementFields: Record<string, number> = {
      totalTasks: 1
    };

    if (status === 'completed') {
      incrementFields.completedTasks = 1;
      incrementFields.totalVideos = videoCount;
    } else {
      incrementFields.failedTasks = 1;
    }

    await this.dailyStatsCollection.updateOne(
      { date: today },
      {
        $inc: incrementFields,
        $set: {
          updatedAt: now
        }
      }
    );

    logger.debug({ date: today, status, videoCount }, 'Daily stats updated');
  }

  async getDailyStats(date?: string): Promise<DailyStats | null> {
    const targetDate = date || new Date().toISOString().split('T')[0];
    return await this.dailyStatsCollection.findOne({ date: targetDate });
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return await this.tasksCollection.findOne({ taskId });
  }

  async findTaskByPublicUrl(publicUrl: string, excludeTaskId?: string): Promise<TaskRecord | null> {
    const query: Record<string, unknown> = {
      publicUrl,
      status: 'completed'
    };

    if (excludeTaskId) {
      query.taskId = { $ne: excludeTaskId };
    }

    return await this.tasksCollection.findOne(query);
  }
}

