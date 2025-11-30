#!/usr/bin/env node
/**
 * Test script: Launch a browser and test browser manager detection
 * 
 * This script:
 * 1. Launches a browser using the same launchBrowser function as sora-worker
 * 2. Keeps it running for testing
 * 3. Tests the browser manager detection logic
 */

// CRITICAL: Import initFingerprint FIRST
import './browser/initFingerprint.js';

import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { launchBrowser } from './browser/launch.js';
import { runtimeConfig } from './config.js';
import { logger } from './logger.js';

// Import browser manager detection function
// Use dynamic import to avoid circular dependencies
async function getBrowserInstances() {
  const { getBrowserInstances } = await import('../../browser-manager/src/index.js');
  return getBrowserInstances();
}

async function main() {
  console.log('=== Browser Launch & Detection Test ===\n');
  
  // Create a test profile directory
  const testProfileName = 'test-browser-manager';
  const testUserDataDir = resolve(process.cwd(), '../../profiles', testProfileName);
  await mkdir(testUserDataDir, { recursive: true });
  
  console.log('1. Launching browser...');
  console.log(`   User Data Dir: ${testUserDataDir}`);
  console.log(`   Headless: ${runtimeConfig.BROWSER_HEADLESS}`);
  console.log('');
  
  // Launch browser
  // Use a simple proxy format or empty string for no proxy
  // The plugin might need a valid format, so let's use a dummy one or check if empty works
  const { context, page } = await launchBrowser({
    userDataDir: testUserDataDir,
    proxy: '', // Empty string for no proxy - might need to check plugin docs
    fingerprint: null,
    onFingerprintPersist: async () => {}
  });
  
  console.log('2. Browser launched successfully!');
  console.log(`   Context pages: ${context.pages().length}`);
  console.log('');
  
  // Wait a bit for browser to fully initialize
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  console.log('3. Testing browser detection...');
  console.log('');
  
  // Test detection multiple times
  for (let i = 0; i < 5; i++) {
    console.log(`   Attempt ${i + 1}/5:`);
    const instances = await getBrowserInstances();
    
    if (instances.length > 0) {
      console.log(`   ✓ Found ${instances.length} instance(s):`);
      instances.forEach((inst, idx) => {
        console.log(`     [${idx + 1}] PID: ${inst.pid}, Profile: ${inst.profile}`);
        if (inst.windowTitle) {
          console.log(`         Window: ${inst.windowTitle.substring(0, 50)}...`);
        }
      });
    } else {
      console.log('   ✗ No instances found');
    }
    console.log('');
    
    if (i < 4) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  console.log('4. Browser will stay open for 30 seconds for manual inspection...');
  console.log('   Press Ctrl+C to close early');
  console.log('');
  
  // Keep browser open for 30 seconds
  await new Promise(resolve => setTimeout(resolve, 30000));
  
  console.log('5. Closing browser...');
  await context.close();
  console.log('   Browser closed. Test complete.');
}

main().catch((error) => {
  console.error('Test failed:', error);
  process.exit(1);
});

