// Patch engine to ensure setCwd is called correctly
// This must be imported AFTER initFingerprint but BEFORE playwright-with-fingerprints
// Access the engine module directly using require (CommonJS)
const connectorModule = require('browser-with-fingerprints/src/plugin/connector');
const engine = connectorModule.engine;
if (engine && typeof engine.setCwd === 'function') {
    const originalSetCwd = engine.setCwd.bind(engine);
    engine.setCwd = function (value) {
        const resolved = require('path').resolve(value || process.env.FINGERPRINT_CWD || require('path').join(process.cwd(), 'data'));
        originalSetCwd(resolved);
        // Double-check it was set
        if (!this.#cwd) {
            this.#cwd = resolved;
        }
    };
}
export {};
