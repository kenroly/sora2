import { createWriteStream } from 'node:fs';
import { type Page, type Request, type Response } from '@playwright/test';

interface SerializedEntry {
  type: 'request' | 'response';
  url: string;
  method?: string;
  status?: number;
  headers: Record<string, string>;
  body?: string;
  timestamp: string;
}

export class NetworkRecorder {
  private stream?: ReturnType<typeof createWriteStream>;
  private requestHandler?: (request: Request) => void;
  private responseHandler?: (response: Response) => Promise<void>;

  constructor(private readonly page: Page, private readonly filePath: string) {}

  start(): void {
    this.stream = createWriteStream(this.filePath, { flags: 'a' });

    this.requestHandler = (request) => {
      const entry: SerializedEntry = {
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
      let body: string | undefined;
      if ((headers['content-type'] ?? '').includes('application/json')) {
        try {
          body = await response.text();
        } catch {
          body = undefined;
        }
      }

      const entry: SerializedEntry = {
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

  async stop(): Promise<void> {
    if (this.requestHandler) this.page.off('request', this.requestHandler);
    if (this.responseHandler) this.page.off('response', this.responseHandler);
    await new Promise<void>((resolve, reject) => {
      if (!this.stream) return resolve();
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

