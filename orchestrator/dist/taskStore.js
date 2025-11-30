import { MongoClient } from 'mongodb';
import { logger } from './logger.js';
import { runtimeConfig } from './config.js';
export class TaskStore {
    client;
    db;
    tasksCollection;
    dailyStatsCollection;
    constructor() {
        this.client = new MongoClient(runtimeConfig.MONGODB_URI);
        this.db = this.client.db(runtimeConfig.MONGODB_DATABASE);
        this.tasksCollection = this.db.collection('tasks');
        this.dailyStatsCollection = this.db.collection('daily_stats');
    }
    async connect() {
        await this.client.connect();
        await this.ensureIndexes();
        logger.info('TaskStore connected to MongoDB');
    }
    async disconnect() {
        await this.client.close();
    }
    async ensureIndexes() {
        await this.tasksCollection.createIndex({ taskId: 1 }, { unique: true });
        await this.tasksCollection.createIndex({ status: 1, createdAt: 1 });
        await this.tasksCollection.createIndex({ profileName: 1, createdAt: 1 });
        await this.dailyStatsCollection.createIndex({ date: 1 }, { unique: true });
    }
    async saveTask(task, productCode) {
        const now = new Date().toISOString();
        const record = {
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
        await this.tasksCollection.updateOne({ taskId: task.id }, { $setOnInsert: record }, { upsert: true });
        logger.info({ taskId: task.id, status: 'claimed' }, 'Task saved to database');
    }
    async updateTaskStatus(taskId, status, updates) {
        const updateData = {
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
        await this.tasksCollection.updateOne({ taskId }, { $set: updateData });
        logger.info({ taskId, status }, 'Task status updated');
    }
    async incrementDailyStats(status, videoCount = 1) {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const now = new Date().toISOString();
        // First, ensure document exists
        await this.dailyStatsCollection.updateOne({ date: today }, {
            $setOnInsert: {
                date: today,
                totalTasks: 0,
                completedTasks: 0,
                failedTasks: 0,
                totalVideos: 0,
                updatedAt: now
            }
        }, { upsert: true });
        // Then increment
        const incrementFields = {
            totalTasks: 1
        };
        if (status === 'completed') {
            incrementFields.completedTasks = 1;
            incrementFields.totalVideos = videoCount;
        }
        else {
            incrementFields.failedTasks = 1;
        }
        await this.dailyStatsCollection.updateOne({ date: today }, {
            $inc: incrementFields,
            $set: {
                updatedAt: now
            }
        });
        logger.debug({ date: today, status, videoCount }, 'Daily stats updated');
    }
    async getDailyStats(date) {
        const targetDate = date || new Date().toISOString().split('T')[0];
        return await this.dailyStatsCollection.findOne({ date: targetDate });
    }
    async getTask(taskId) {
        return await this.tasksCollection.findOne({ taskId });
    }
}
