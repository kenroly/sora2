import { MongoClient, type Db, type Collection } from 'mongodb';
import { logger } from './logger.js';
import { runtimeConfig } from './config.js';

export interface ProfileRecord {
  name: string;
  proxy: string;
  userDataDir: string;
  fingerprint: string | null;
  machineId: string; // Machine identifier - profiles are machine-specific
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

  async selectAvailableProfile(excludeProfileNames: string[] = []): Promise<ProfileRecord | null> {
    // First, get all profiles in database to log them
    const allProfiles = await this.profilesCollection.find({}).toArray();
    const allProfilesForMachine = allProfiles.filter(p => p.machineId === runtimeConfig.MACHINE_ID);
    
    logger.info({ 
      machineId: runtimeConfig.MACHINE_ID,
      totalProfilesInDb: allProfiles.length,
      profilesForThisMachineCount: allProfilesForMachine.length,
      excludeProfileNames,
      allProfiles: allProfiles.map(p => ({
        name: p.name,
        machineId: p.machineId,
        status: p.status,
        creditRemaining: p.creditRemaining,
        lastRunAt: p.lastRunAt
      })),
      profilesForThisMachine: allProfilesForMachine.map(p => ({
        name: p.name,
        status: p.status,
        creditRemaining: p.creditRemaining,
        lastRunAt: p.lastRunAt
      }))
    }, 'Profile status check');

    // Build query to exclude profiles currently in use
    const query: any = {
      machineId: runtimeConfig.MACHINE_ID, // Only profiles for this machine
      status: 'active',
      $or: [
        { creditRemaining: { $gte: 5 } },
        { creditRemaining: null } // Allow profiles without credit info yet
      ]
    };

    // Exclude profiles that are currently being used by active workers
    if (excludeProfileNames.length > 0) {
      query.name = { $nin: excludeProfileNames };
    }

    // Find active profiles with credit >= 5 FOR THIS MACHINE, ordered by lastRunAt (ascending - least used first)
    const profile = await this.profilesCollection.findOne(
      query,
      {
        sort: { lastRunAt: 1 } // nulls first (never used)
      }
    );

    if (profile) {
      logger.info({ 
        profileName: profile.name, 
        creditRemaining: profile.creditRemaining,
        machineId: profile.machineId,
        lastRunAt: profile.lastRunAt
      }, 'Selected profile');
    } else {
      // Log detailed reason why no profile is available
      const inactiveProfiles = allProfilesForMachine.filter(p => p.status !== 'active');
      const lowCreditProfiles = allProfilesForMachine.filter(
        p => p.status === 'active' && p.creditRemaining !== null && p.creditRemaining < 5
      );
      
      logger.warn({ 
        machineId: runtimeConfig.MACHINE_ID,
        totalProfiles: allProfilesForMachine.length,
        inactiveProfiles: inactiveProfiles.map(p => ({ name: p.name, status: p.status })),
        lowCreditProfiles: lowCreditProfiles.map(p => ({ name: p.name, creditRemaining: p.creditRemaining })),
        reason: allProfilesForMachine.length === 0 
          ? 'No profiles found for this machine' 
          : inactiveProfiles.length > 0 
            ? `All ${inactiveProfiles.length} profile(s) are inactive` 
            : lowCreditProfiles.length > 0
              ? `All ${lowCreditProfiles.length} profile(s) have low credit (< 5)`
              : 'Unknown reason'
      }, 'No available profiles found for this machine');
    }

    if (profile) {
      // Update lastRunAt immediately to prevent other workers from selecting the same profile
      await this.profilesCollection.updateOne(
        { _id: profile._id },
        { $set: { lastRunAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }
      );
      logger.info({ profileName: profile.name }, 'Profile locked and lastRunAt updated');
    }

    return profile;
  }
}


