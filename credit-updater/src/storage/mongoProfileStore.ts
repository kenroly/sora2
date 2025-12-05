import { MongoClient, type Collection, type Db } from 'mongodb';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../logger.js';
import { defaultProxies } from './proxySeed.js';

export interface ProfileRecord {
  name: string;
  proxy: string;
  userDataDir: string;
  fingerprint: string | null;
  machineId?: string | null;
  status: 'active' | 'blocked' | 'low_credit' | 'disabled';
  creditRemaining: number | null;
  dailyRunCount: number;
  lastRunAt: string | null;
  lastCreditCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyRecord {
  proxy: string;
  assignedProfile: string | null;
  addedAt: string;
}

interface MongoProfileStoreOptions {
  mongoUri: string;
  databaseName: string;
  profileRoot: string;
  // machineId is accepted for compatibility with callers; not used yet.
  machineId?: string;
}

export class MongoProfileStore {
  private client: MongoClient;
  private db: Db;
  private profilesCollection: Collection<ProfileRecord>;
  private proxiesCollection: Collection<ProxyRecord>;

  constructor(private readonly options: MongoProfileStoreOptions) {
    this.client = new MongoClient(options.mongoUri);
    this.db = this.client.db(options.databaseName);
    this.profilesCollection = this.db.collection<ProfileRecord>('profiles');
    this.proxiesCollection = this.db.collection<ProxyRecord>('proxies');
  }

  async connect(): Promise<void> {
    await this.client.connect();
    await this.ensureIndexes();
    await this.seedDefaultProxies();
    logger.info('Connected to MongoDB');
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  private async ensureIndexes(): Promise<void> {
    await this.profilesCollection.createIndex({ name: 1 }, { unique: true });
    await this.profilesCollection.createIndex({ status: 1, creditRemaining: 1, lastRunAt: 1 });
    await this.profilesCollection.createIndex({ machineId: 1 });
    await this.proxiesCollection.createIndex({ proxy: 1 }, { unique: true });
    await this.proxiesCollection.createIndex({ assignedProfile: 1 }, { unique: true, sparse: true });
  }

  private async seedDefaultProxies(): Promise<void> {
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

  async getProfile(name: string): Promise<ProfileRecord | null> {
    return await this.profilesCollection.findOne({ name });
  }

  async ensureProfile(name: string): Promise<ProfileRecord> {
    const existing = await this.getProfile(name);
    if (existing) {
      return existing;
    }

    const available = await this.proxiesCollection.findOne(
      { assignedProfile: null },
      { sort: { addedAt: 1 } }
    );

    if (!available) {
      throw new Error('No proxies available. Insert new records into the "proxies" collection before creating more profiles.');
    }

    const userDataDir = resolve(this.options.profileRoot, name);
    mkdirSync(userDataDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const record: ProfileRecord = {
      name,
      proxy: available.proxy,
      userDataDir,
      fingerprint: null,
      machineId: this.options.machineId ?? null,
      status: 'active',
      creditRemaining: null,
      dailyRunCount: 0,
      lastRunAt: null,
      lastCreditCheckAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await this.profilesCollection.insertOne(record);
    await this.proxiesCollection.updateOne(
      { proxy: available.proxy },
      { $set: { assignedProfile: name } }
    );

    logger.info({ name, proxy: available.proxy, userDataDir }, 'Created new profile entry');
    return record;
  }

  async setFingerprint(name: string, fingerprint: string): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.profilesCollection.updateOne(
      { name },
      { $set: { fingerprint, updatedAt } }
    );
  }

  async updateCredit(name: string, creditRemaining: number): Promise<void> {
    const updatedAt = new Date().toISOString();
    const lastCreditCheckAt = new Date().toISOString();
    const status = creditRemaining >= 5 ? 'active' : 'low_credit';

    await this.profilesCollection.updateOne(
      { name },
      {
        $set: {
          creditRemaining,
          status,
          lastCreditCheckAt,
          updatedAt
        }
      }
    );
  }

  async incrementRunCount(name: string): Promise<void> {
    const updatedAt = new Date().toISOString();
    const lastRunAt = new Date().toISOString();

    await this.profilesCollection.updateOne(
      { name },
      {
        $set: { lastRunAt, updatedAt },
        $inc: { dailyRunCount: 1 }
      }
    );
  }

  async resetDailyCounts(): Promise<void> {
    await this.profilesCollection.updateMany(
      {},
      { $set: { dailyRunCount: 0 } }
    );
    logger.info('Reset daily run counts for all profiles');
  }

  async findAvailableProfile(): Promise<ProfileRecord | null> {
    const machineFilter = this.options.machineId ? { machineId: this.options.machineId } : {};
    // Find active profiles with credit >= 5, ordered by lastRunAt (ascending - least used first)
    const profile = await this.profilesCollection.findOne(
      {
        ...machineFilter,
        status: 'active',
        $or: [
          { creditRemaining: { $gte: 5 } },
          { creditRemaining: null } // Allow profiles without credit info yet
        ]
      },
      {
        sort: { lastRunAt: 1 } // nulls first (never used)
      }
    );

    return profile;
  }

  async getAllProfiles(): Promise<ProfileRecord[]> {
    const filter = this.options.machineId ? { machineId: this.options.machineId } : {};
    return await this.profilesCollection.find(filter).toArray();
  }
}

