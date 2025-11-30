#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import Database from 'better-sqlite3';
import { MongoClient } from 'mongodb';
import { resolve } from 'node:path';
import { z } from 'zod';

loadEnv();

const schema = z.object({
  SQLITE_PATH: z.string().default('sora.sqlite'),
  MONGODB_URI: z.string().min(1, 'MongoDB URI is required'),
  MONGODB_DATABASE: z.string().default('sora'),
  PROFILE_ROOT: z.string().default('profiles')
});

const config = schema.parse({
  SQLITE_PATH: process.env.SQLITE_PATH,
  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DATABASE: process.env.MONGODB_DATABASE,
  PROFILE_ROOT: process.env.PROFILE_ROOT
});

interface SQLiteProfile {
  name: string;
  proxy: string;
  userDataDir: string;
  fingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SQLiteProxy {
  proxy: string;
  assignedProfile: string | null;
  addedAt: string;
}

async function migrate(): Promise<void> {
  console.log('Starting migration from SQLite to MongoDB...');

  // Connect to SQLite
  const sqlitePath = resolve(config.SQLITE_PATH);
  console.log(`Reading from SQLite: ${sqlitePath}`);
  const db = new Database(sqlitePath);

  // Connect to MongoDB
  console.log(`Connecting to MongoDB: ${config.MONGODB_URI}`);
  const mongoClient = new MongoClient(config.MONGODB_URI);
  await mongoClient.connect();
  const mongoDb = mongoClient.db(config.MONGODB_DATABASE);
  const profilesCollection = mongoDb.collection('profiles');
  const proxiesCollection = mongoDb.collection('proxies');

  try {
    // Migrate proxies
    console.log('\nMigrating proxies...');
    const sqliteProxies = db.prepare('SELECT * FROM proxies').all() as SQLiteProxy[];
    console.log(`Found ${sqliteProxies.length} proxies in SQLite`);

    for (const proxy of sqliteProxies) {
      await proxiesCollection.updateOne(
        { proxy: proxy.proxy },
        {
          $setOnInsert: {
            proxy: proxy.proxy,
            assignedProfile: proxy.assignedProfile || null,
            addedAt: proxy.addedAt
          }
        },
        { upsert: true }
      );
    }
    console.log(`✓ Migrated ${sqliteProxies.length} proxies`);

    // Migrate profiles
    console.log('\nMigrating profiles...');
    const sqliteProfiles = db.prepare('SELECT * FROM profiles').all() as SQLiteProfile[];
    console.log(`Found ${sqliteProfiles.length} profiles in SQLite`);

    for (const profile of sqliteProfiles) {
      const mongoProfile = {
        name: profile.name,
        proxy: profile.proxy,
        userDataDir: profile.userDataDir,
        fingerprint: profile.fingerprint,
        status: 'active' as const,
        creditRemaining: null as number | null,
        dailyRunCount: 0,
        lastRunAt: null as string | null,
        lastCreditCheckAt: null as string | null,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt
      };

      await profilesCollection.updateOne(
        { name: profile.name },
        { $set: mongoProfile },
        { upsert: true }
      );
      console.log(`  ✓ Migrated profile: ${profile.name}`);
    }
    console.log(`✓ Migrated ${sqliteProfiles.length} profiles`);

    // Create indexes (drop existing first to avoid conflicts)
    console.log('\nCreating indexes...');
    try {
      await profilesCollection.dropIndexes();
      await proxiesCollection.dropIndexes();
    } catch (e) {
      // Ignore if indexes don't exist
    }
    
    await profilesCollection.createIndex({ name: 1 }, { unique: true });
    await profilesCollection.createIndex({ status: 1, creditRemaining: 1, lastRunAt: 1 });
    await proxiesCollection.createIndex({ proxy: 1 }, { unique: true });
    // Sparse index for assignedProfile (not unique since multiple proxies can be unassigned)
    await proxiesCollection.createIndex(
      { assignedProfile: 1 },
      { sparse: true }
    );
    console.log('✓ Indexes created');

    console.log('\n✅ Migration completed successfully!');
  } finally {
    db.close();
    await mongoClient.close();
  }
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});

