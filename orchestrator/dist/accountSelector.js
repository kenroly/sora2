import { MongoClient } from 'mongodb';
import { logger } from './logger.js';
import { runtimeConfig } from './config.js';
export class AccountSelector {
    client;
    db;
    profilesCollection;
    constructor() {
        this.client = new MongoClient(runtimeConfig.MONGODB_URI);
        this.db = this.client.db(runtimeConfig.MONGODB_DATABASE);
        this.profilesCollection = this.db.collection('profiles');
    }
    async connect() {
        await this.client.connect();
        logger.info('AccountSelector connected to MongoDB');
    }
    async disconnect() {
        await this.client.close();
    }
    async selectAvailableProfile() {
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
        if (profile) {
            logger.info({ profileName: profile.name, creditRemaining: profile.creditRemaining }, 'Selected profile');
        }
        else {
            logger.warn('No available profiles found');
        }
        return profile;
    }
}
