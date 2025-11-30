import { MongoClient } from 'mongodb';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../logger.js';
import { defaultProxies } from './proxySeed.js';
export class MongoProfileStore {
    options;
    client;
    db;
    profilesCollection;
    proxiesCollection;
    constructor(options) {
        this.options = options;
        this.client = new MongoClient(options.mongoUri);
        this.db = this.client.db(options.databaseName);
        this.profilesCollection = this.db.collection('profiles');
        this.proxiesCollection = this.db.collection('proxies');
    }
    async connect() {
        await this.client.connect();
        await this.ensureIndexes();
        await this.seedDefaultProxies();
        logger.info('Connected to MongoDB');
    }
    async disconnect() {
        await this.client.close();
    }
    async ensureIndexes() {
        await this.profilesCollection.createIndex({ name: 1 }, { unique: true });
        await this.profilesCollection.createIndex({ status: 1, creditRemaining: 1, lastRunAt: 1 });
        await this.proxiesCollection.createIndex({ proxy: 1 }, { unique: true });
        await this.proxiesCollection.createIndex({ assignedProfile: 1 }, { sparse: true });
    }
    async seedDefaultProxies() {
        if (!defaultProxies.length) {
            return;
        }
        const now = new Date().toISOString();
        const operations = defaultProxies.map((proxy) => ({
            updateOne: {
                filter: { proxy },
                update: { $setOnInsert: { proxy, assignedProfile: null, addedAt: now } },
                upsert: true
            }
        }));
        if (operations.length > 0) {
            await this.proxiesCollection.bulkWrite(operations);
            logger.info({ count: defaultProxies.length }, 'Seeded default proxies');
        }
    }
    async getProfile(name) {
        return await this.profilesCollection.findOne({ name });
    }
    async ensureProfile(name) {
        const existing = await this.getProfile(name);
        if (existing) {
            return existing;
        }
        const available = await this.proxiesCollection.findOne({ assignedProfile: null }, { sort: { addedAt: 1 } });
        if (!available) {
            throw new Error('No proxies available. Insert new records into the "proxies" collection before creating more profiles.');
        }
        const userDataDir = resolve(this.options.profileRoot, name);
        mkdirSync(userDataDir, { recursive: true });
        const timestamp = new Date().toISOString();
        const record = {
            name,
            proxy: available.proxy,
            userDataDir,
            fingerprint: null,
            status: 'active',
            creditRemaining: null,
            dailyRunCount: 0,
            lastRunAt: null,
            lastCreditCheckAt: null,
            createdAt: timestamp,
            updatedAt: timestamp
        };
        await this.profilesCollection.insertOne(record);
        await this.proxiesCollection.updateOne({ proxy: available.proxy }, { $set: { assignedProfile: name } });
        logger.info({ name, proxy: available.proxy, userDataDir }, 'Created new profile entry');
        return record;
    }
    async setFingerprint(name, fingerprint) {
        const updatedAt = new Date().toISOString();
        await this.profilesCollection.updateOne({ name }, { $set: { fingerprint, updatedAt } });
    }
    async updateCredit(name, creditRemaining) {
        const updatedAt = new Date().toISOString();
        const lastCreditCheckAt = new Date().toISOString();
        const status = creditRemaining >= 5 ? 'active' : 'low_credit';
        await this.profilesCollection.updateOne({ name }, {
            $set: {
                creditRemaining,
                status,
                lastCreditCheckAt,
                updatedAt
            }
        });
    }
    async incrementRunCount(name) {
        const updatedAt = new Date().toISOString();
        const lastRunAt = new Date().toISOString();
        await this.profilesCollection.updateOne({ name }, {
            $set: { lastRunAt, updatedAt },
            $inc: { dailyRunCount: 1 }
        });
    }
    async resetDailyCounts() {
        await this.profilesCollection.updateMany({}, { $set: { dailyRunCount: 0 } });
        logger.info('Reset daily run counts for all profiles');
    }
    async findAvailableProfile() {
        // Find active profiles with credit >= 5, ordered by lastRunAt (ascending - least used first)
        const profile = await this.profilesCollection.findOne({
            status: 'active',
            $or: [
                { creditRemaining: { $gte: 5 } },
                { creditRemaining: null } // Allow profiles without credit info yet
            ]
        }, {
            sort: { lastRunAt: 1 } // nulls first (never used)
        });
        return profile;
    }
    async getAllProfiles() {
        return await this.profilesCollection.find({}).toArray();
    }
}
