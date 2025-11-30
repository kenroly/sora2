#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBrowserInstances = getBrowserInstances;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_url_1 = require("node:url");
const __filename = (0, node_url_1.fileURLToPath)(import.meta.url);
const __dirname = (0, node_path_1.dirname)(__filename);
async function getBrowserInstances() {
    // Get browser instances from sora-worker
    // Look for: Worker.exe, FastExecuteScript.exe, and Chrome/Chromium processes with --user-data-dir pointing to profiles/
    return new Promise((resolve) => {
        const processes = [];
        // Use PowerShell script file for easier debugging and maintenance
        const scriptPath = resolve(__dirname, '../detect-browsers.ps1');
        const ps = (0, node_child_process_1.spawn)('powershell', [
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath
        ]);
        let output = '';
        ps.stdout.on('data', (data) => {
            output += data.toString();
        });
        ps.stderr.on('data', (data) => {
            // Ignore stderr
        });
        ps.on('close', (code) => {
            try {
                const trimmed = output.trim();
                // Debug: log raw output for troubleshooting
                if (trimmed && trimmed !== '[]') {
                    console.error('[DEBUG] PowerShell returned:', trimmed.substring(0, 1000));
                }
                else if (trimmed === '[]') {
                    console.error('[DEBUG] PowerShell returned empty array - no browsers detected');
                }
                if (trimmed && trimmed !== '[]' && !trimmed.includes('No matching processes found')) {
                    const procs = JSON.parse(trimmed);
                    const instances = Array.isArray(procs) ? procs : [procs];
                    instances.forEach((proc) => {
                        if (proc && proc.ProcessId) {
                            // Extract profile name from command line
                            const cmdLine = proc.CommandLine || '';
                            const processName = proc.Name || '';
                            let profile = 'unknown';
                            // For Worker.exe or FastExecuteScript.exe, try to extract profile from command line
                            if (processName.includes('Worker') || processName.includes('FastExecuteScript')) {
                                // Try to find profile path in command line
                                const profileMatch = cmdLine.match(/profiles[\\\\/]([^\\\\/\\s]+)/i);
                                if (profileMatch) {
                                    profile = profileMatch[1];
                                }
                                else {
                                    profile = processName; // Use process name as fallback
                                }
                            }
                            else {
                                // For Chrome/Chromium processes, extract from --user-data-dir
                                const userDataDirMatch = cmdLine.match(/--user-data-dir[=:]"?([^"\\s]+)"/i) ||
                                    cmdLine.match(/--user-data-dir[=:]([^\\s]+)/i);
                                if (userDataDirMatch) {
                                    const userDataDir = userDataDirMatch[1];
                                    const profileMatch = userDataDir.match(/[\\\\/]profiles[\\\\/]([^\\\\/]+)/i) ||
                                        userDataDir.match(/profiles[\\\\/]([^\\\\/]+)/i);
                                    if (profileMatch) {
                                        profile = profileMatch[1];
                                    }
                                    else if (userDataDir.includes('profiles')) {
                                        // Fallback: extract last part of path
                                        const parts = userDataDir.split(/[\\\\/]/);
                                        const profilesIdx = parts.findIndex((p) => p.toLowerCase() === 'profiles');
                                        if (profilesIdx >= 0 && profilesIdx < parts.length - 1) {
                                            profile = parts[profilesIdx + 1];
                                        }
                                    }
                                }
                                else {
                                    // Fallback: try to find profiles/xxx in command line
                                    const fallbackMatch = cmdLine.match(/profiles[\\\\/]([^\\\\/\\s]+)/i);
                                    if (fallbackMatch) {
                                        profile = fallbackMatch[1];
                                    }
                                }
                            }
                            // Extract task ID if available
                            const taskIdMatch = cmdLine.match(/--task-id[=:]"?([^"\\s]+)"/i) ||
                                cmdLine.match(/--task-id[=:]([^\\s]+)/i);
                            const taskId = taskIdMatch ? taskIdMatch[1] : undefined;
                            processes.push({
                                pid: proc.ProcessId,
                                profile: profile,
                                taskId: taskId,
                                windowTitle: proc.WindowTitle || undefined
                            });
                        }
                    });
                }
            }
            catch (e) {
                // Ignore parse errors - might be empty or invalid JSON
                // console.error('Parse error:', e);
            }
            resolve(processes);
        });
    });
}
async function getProfilesFromMongo() {
    // Try to read profile info from MongoDB or local files
    const profiles = new Map();
    try {
        // Read from profiles directory
        const profilesDir = (0, node_path_1.join)(process.cwd(), '../../profiles');
        // This is a simple implementation - you can enhance it
    }
    catch (e) {
        // Ignore
    }
    return profiles;
}
function displayInstances(instances) {
    console.clear();
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         Browser Instances Manager (BAS-like)              ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    if (instances.length === 0) {
        console.log('  No automation browser instances found.');
        console.log('  (Looking for Worker.exe, FastExecuteScript.exe, and Chrome with profiles/)');
    }
    else {
        console.log(`  Found ${instances.length} automation browser instance(s):\n`);
        instances.forEach((inst, idx) => {
            console.log(`  [${idx + 1}] PID: ${inst.pid}`);
            console.log(`      Profile: ${inst.profile}`);
            if (inst.taskId) {
                console.log(`      Task ID: ${inst.taskId}`);
            }
            if (inst.windowTitle) {
                console.log(`      Window: ${inst.windowTitle.substring(0, 60)}...`);
            }
            console.log('');
        });
    }
    console.log('  Commands:');
    console.log('    - Press R to refresh');
    console.log('    - Press Q to quit');
    if (instances.length > 0) {
        console.log(`    - Press 1-${Math.min(instances.length, 9)} to focus window`);
    }
    console.log('');
}
function focusWindow(pid) {
    // Use SetForegroundWindow API via PowerShell
    (0, node_child_process_1.spawn)('powershell', [
        '-Command',
        `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32 { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); public const int SW_RESTORE = 9; }'; $proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) { [Win32]::ShowWindow($proc.MainWindowHandle, [Win32]::SW_RESTORE); [Win32]::SetForegroundWindow($proc.MainWindowHandle); Write-Host "Focused window for PID ${pid}" } else { Write-Host "Cannot focus: Window handle not available" }`
    ]);
}
async function main() {
    console.log('Starting Browser Manager...\n');
    let instances = await getBrowserInstances();
    displayInstances(instances);
    // Refresh every 5 seconds
    const refreshInterval = setInterval(async () => {
        instances = await getBrowserInstances();
        displayInstances(instances);
    }, 5000);
    // Handle input (simplified - in real app you'd use readline)
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
        const keyStr = key.toString();
        if (keyStr === 'q' || keyStr === 'Q' || keyStr === '\u0003' || keyStr === '\u001b') {
            clearInterval(refreshInterval);
            process.exit(0);
        }
        else if (keyStr === 'r' || keyStr === 'R' || keyStr === '\r') {
            getBrowserInstances().then((insts) => {
                instances = insts;
                displayInstances(instances);
            });
        }
        else if (keyStr >= '1' && keyStr <= '9') {
            const idx = parseInt(keyStr) - 1;
            if (instances[idx]) {
                console.log(`\nFocusing window for instance ${idx + 1} (PID: ${instances[idx].pid})...`);
                focusWindow(instances[idx].pid);
                // Refresh display after a short delay
                setTimeout(() => {
                    displayInstances(instances);
                }, 500);
            }
            else {
                console.log(`\nInvalid instance number. Available: 1-${instances.length}`);
            }
        }
    });
}
main().catch(console.error);
