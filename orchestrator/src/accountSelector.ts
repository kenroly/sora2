import { MongoClient, type Db, type Collection } from 'mongodb';
import { logger } from './logger.js';
import { runtimeConfig } from './config.js';

export interface ProfileRecord {
  name: string;
  proxy: string;
  userDataDir: string;
  fingerprint: string | null;
  status: 'active' | 'blocked' | 'low_credit' | 'disabled';
  creditRemaining: number | null;
  dailyRunCount: number;
  lastRunAt: string | null;
  lastCreditCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class AccountSelector {
  private client: MongoClient;
  private db: Db;
  private profilesCollection: Collection<ProfileRecord>;

  constructor() {
    this.client = new MongoClient(runtimeConfig.MONGODB_URI);
    this.db = this.client.db(runtimeConfig.MONGODB_DATABASE);
    this.profilesCollection = this.db.collection<ProfileRecord>('profiles');
  }

  async connect(): Promise<void> {
    await this.client.connect();
    logger.info('AccountSelector connected to MongoDB');
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  async selectAvailableProfile(): Promise<ProfileRecord | null> {
    // Find active profiles with credit >= 5, ordered by lastRunAt (ascending - least used first)
    const profile = await this.profilesCollection.findOne(
      {
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

    if (profile) {
      logger.info({ profileName: profile.name, creditRemaining: profile.creditRemaining }, 'Selected profile');
    } else {
      logger.warn('No available profiles found');
    }

    return profile;
  }
}


