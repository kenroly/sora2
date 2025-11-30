import { createWriteStream } from 'node:fs';
import {} from '@playwright/test';
export class NetworkRecorder {
    page;
    filePath;
    stream;
    requestHandler;
    responseHandler;
    constructor(page, filePath) {
        this.page = page;
        this.filePath = filePath;
    }
    start() {
        this.stream = createWriteStream(this.filePath, { flags: 'a' });
        this.requestHandler = (request) => {
            const entry = {
                type: 'request',
                url: request.url(),
                method: request.method(),
                headers: request.headers(),
                timestamp: new Date().toISOString()
            };
            this.stream?.write(`${JSON.stringify(entry)}\n`);
        };
        this.responseHandler = async (response) => {
            const headers = response.headers();
            let body;
            if ((headers['content-type'] ?? '').includes('application/json')) {
                try {
                    body = await response.text();
                }
                catch {
                    body = undefined;
                }
            }
            const entry = {
                type: 'response',
                url: response.url(),
                status: response.status(),
                headers,
                body,
                timestamp: new Date().toISOString()
            };
            this.stream?.write(`${JSON.stringify(entry)}\n`);
        };
        this.page.on('request', this.requestHandler);
        this.page.on('response', this.responseHandler);
    }
    async stop() {
        if (this.requestHandler)
            this.page.off('request', this.requestHandler);
        if (this.responseHandler)
            this.page.off('response', this.responseHandler);
        await new Promise((resolve, reject) => {
            if (!this.stream)
                return resolve();
            this.stream.end((err) => (err ? reject(err) : resolve()));
        });
    }
}
