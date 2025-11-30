// This file ensures engine.setCwd is called correctly
// Must be imported AFTER playwright-with-fingerprints but BEFORE any plugin operations

import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { FINGERPRINT_ENGINE_DIR } from './initFingerprint.js';

// Use createRequire to access CommonJS module in ES module
const require = createRequire(import.meta.url);
const connectorModule = require('browser-with-fingerprints/src/plugin/connector');
const engine = connectorModule.engine;

if (engine && typeof engine.setCwd === 'function') {
  // Force set CWD with absolute path
  const absolutePath = resolve(FINGERPRINT_ENGINE_DIR);
  
  // Call setCwd multiple times to ensure it's set
  engine.setCwd(absolutePath);
  engine.setCwd(absolutePath); // Call twice to be sure
  
  // Also patch the setCwd method to always use our path if called with undefined
  const originalSetCwd = engine.setCwd.bind(engine);
  engine.setCwd = function(value: string | undefined) {
    const path = require('path');
    const finalValue = value || absolutePath;
    originalSetCwd(finalValue);
    console.log('[ensureEngineCwd] setCwd called with:', finalValue);
  };
  
  // Call again after patching
  engine.setCwd(absolutePath);
  
  console.log('[ensureEngineCwd] Set engine CWD to:', absolutePath);
  
  // Also set env to be sure
  process.env.FINGERPRINT_CWD = absolutePath;
}

export {};

