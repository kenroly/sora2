import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeConfig } from './config.js';
export function buildServer() {
    const app = Fastify({
        logger: true
    });
    const latestFrames = new Map();
    const subscribers = new Map();
    function authorize(request, reply) {
        if (!runtimeConfig.AUTH_TOKEN) {
            return;
        }
        const header = request.headers.authorization;
        if (!header || header !== `Bearer ${runtimeConfig.AUTH_TOKEN}`) {
            reply.code(401).send({ error: 'Unauthorized' });
            return false;
        }
    }
    function broadcast(frame) {
        const subs = subscribers.get(frame.taskId);
        if (!subs)
            return;
        for (const sub of subs) {
            sub.write(frame);
        }
    }
    app.get('/health', async () => ({ status: 'ok' }));
    app.get('/tasks', async (_request, reply) => {
        const tasks = Array.from(latestFrames.values()).map((frame) => ({
            taskId: frame.taskId,
            profileName: frame.profileName,
            capturedAt: frame.capturedAt,
            streamUrl: `/stream/${frame.taskId}`
        }));
        reply.send({ tasks });
    });
    app.get('/stream/:taskId', { logLevel: 'warn' }, async (request, reply) => {
        const taskId = request.params.taskId;
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.write('\n');
        const subscriber = {
            taskId,
            write: (frame) => {
                reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
            },
            close: () => {
                reply.raw.end();
            }
        };
        const subs = subscribers.get(taskId) ?? new Set();
        subs.add(subscriber);
        subscribers.set(taskId, subs);
        const latest = latestFrames.get(taskId);
        if (latest) {
            subscriber.write(latest);
        }
        request.raw.on('close', () => {
            subscriber.close();
            subs.delete(subscriber);
        });
    });
    app.post('/frames', async (request, reply) => {
        if (authorize(request, reply) === false) {
            return;
        }
        const payload = request.body;
        if (!payload?.taskId || !payload.profileName || !payload.frame) {
            reply.code(400).send({ error: 'taskId, profileName and frame are required' });
            return;
        }
        const capturedAt = payload.capturedAt ?? new Date().toISOString();
        const buffer = Buffer.from(payload.frame, 'base64');
        const taskDir = join(runtimeConfig.ARTIFACTS_DIR, payload.taskId);
        await mkdir(taskDir, { recursive: true });
        const filename = join(taskDir, `${Date.now()}.jpg`);
        await writeFile(filename, buffer);
        const storedFrame = {
            taskId: payload.taskId,
            profileName: payload.profileName,
            capturedAt,
            filePath: filename
        };
        latestFrames.set(payload.taskId, storedFrame);
        broadcast(storedFrame);
        reply.send({ ok: true });
    });
    app.get('/', async (_request, reply) => {
        const html = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Sora Monitor</title>
        <style>
          body { font-family: sans-serif; margin: 24px; }
          .task { margin-bottom: 32px; }
          img { max-width: 480px; border: 1px solid #ddd; border-radius: 8px; }
        </style>
      </head>
      <body>
        <h1>Sora Monitor</h1>
        <div id="tasks"></div>
        <script>
          async function loadTasks() {
            const res = await fetch('/tasks');
            const data = await res.json();
            const container = document.getElementById('tasks');
            container.innerHTML = '';
            for (const task of data.tasks) {
              const el = document.createElement('div');
              el.className = 'task';
              el.innerHTML = '<h3>' + task.taskId + ' (' + task.profileName + ')</h3>' +
                '<img id="img-' + task.taskId + '" alt="frame" />' +
                '<p>Last update: <span id="ts-' + task.taskId + '">' + task.capturedAt + '</span></p>';
              container.appendChild(el);
              const img = document.getElementById('img-' + task.taskId);
              const ts = document.getElementById('ts-' + task.taskId);
              const evt = new EventSource(task.streamUrl);
              evt.onmessage = (event) => {
                const payload = JSON.parse(event.data);
                img.src = '/preview?path=' + encodeURIComponent(payload.filePath) + '&t=' + Date.now();
                ts.textContent = payload.capturedAt;
              };
            }
          }
          loadTasks();
          setInterval(loadTasks, 10000);
        </script>
      </body>
    </html>`;
        reply.type('text/html').send(html);
    });
    app.get('/preview', async (request, reply) => {
        const path = request.query.path;
        if (!path || !path.startsWith(runtimeConfig.ARTIFACTS_DIR)) {
            reply.code(400).send({ error: 'Invalid path' });
            return;
        }
        try {
            await access(path);
        }
        catch {
            reply.code(404).send({ error: 'Not found' });
            return;
        }
        reply.type('image/jpeg').send(createReadStream(path));
    });
    return app;
}
