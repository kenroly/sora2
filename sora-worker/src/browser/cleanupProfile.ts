import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';

const execAsync = promisify(exec);

/**
 * Cleanup lock files in Chrome/Chromium profile folder
 * Chrome creates lock files like SingletonLock, lockfile, etc.
 */
export async function cleanupLockFiles(userDataDir: string): Promise<void> {
  try {
    const lockFilePatterns = [
      'SingletonLock',
      'lockfile',
      'SingletonSocket',
      'SingletonCookie',
      '.lock'
    ];

    const files = await readdir(userDataDir).catch(() => []);
    let cleanedCount = 0;

    for (const file of files) {
      const filePath = join(userDataDir, file);
      const fileStat = await stat(filePath).catch(() => null);
      
      if (!fileStat || !fileStat.isFile()) continue;

      // Check if file matches lock patterns
      const isLockFile = lockFilePatterns.some(pattern => 
        file.includes(pattern) || file.startsWith(pattern)
      );

      if (isLockFile) {
        try {
          await unlink(filePath);
          cleanedCount++;
          logger.debug({ filePath }, 'Removed lock file');
        } catch (error) {
          // File might be in use, that's okay
          logger.debug({ filePath, error: (error as Error).message }, 'Could not remove lock file (may be in use)');
        }
      }
    }

    if (cleanedCount > 0) {
      logger.info({ userDataDir, cleanedCount }, 'Cleaned up lock files from profile');
    }
  } catch (error) {
    logger.warn({ userDataDir, error: (error as Error).message }, 'Error during lock file cleanup');
  }
}

/**
 * Kill browser processes that might be using the profile folder
 * On Windows, we look for chrome.exe, msedge.exe, chromium.exe processes
 */
export async function killBrowserProcesses(userDataDir: string): Promise<void> {
  try {
    // On Windows, use taskkill to kill browser processes
    if (process.platform === 'win32') {
      const browserProcesses = ['chrome.exe', 'msedge.exe', 'chromium.exe', 'playwright.exe'];
      let killedAny = false;

      for (const processName of browserProcesses) {
        try {
          // Try to kill the process (force kill with /F, kill tree with /T)
          // Use || exit 0 to ignore errors if process doesn't exist
          await execAsync(`taskkill /F /IM ${processName} /T 2>nul || exit 0`);
          killedAny = true;
          logger.debug({ processName }, 'Attempted to kill browser process');
        } catch (error) {
          // Process might not exist, that's fine
        }
      }

      if (killedAny) {
        logger.info({ userDataDir }, 'Attempted to kill browser processes');
        // Wait a bit for processes to terminate and release locks
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } else {
      // Linux/Mac: use pkill or killall
      try {
        await execAsync(`pkill -f "user-data-dir.*${userDataDir}" || true`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        logger.debug({ error: (error as Error).message }, 'No browser processes to kill');
      }
    }
  } catch (error) {
    logger.warn({ userDataDir, error: (error as Error).message }, 'Error during browser process cleanup');
  }
}

/**
 * Comprehensive cleanup: remove lock files and optionally kill processes
 * @param userDataDir Profile directory to clean
 * @param killProcesses Whether to kill browser processes (default: false, only cleanup lock files)
 */
export async function cleanupProfile(userDataDir: string, killProcesses: boolean = false): Promise<void> {
  logger.info({ userDataDir, killProcesses }, 'Cleaning up profile before launch');
  
  // Only kill processes if explicitly requested (e.g., during retry after timeout)
  if (killProcesses) {
    await killBrowserProcesses(userDataDir);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for processes to release locks
  }
  
  // Always cleanup lock files
  await cleanupLockFiles(userDataDir);
  
  logger.info({ userDataDir, killProcesses }, 'Profile cleanup completed');
}

