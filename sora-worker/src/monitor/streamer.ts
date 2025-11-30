import type { Page } from 'playwright-core';
import { logger } from '../logger.js';
import { runtimeConfig } from '../config.js';

interface StreamerOptions {
  taskId?: string;
  profileName: string;
}

export class MonitorStreamer {
  private intervalId: NodeJS.Timeout | null = null;
  private sending = false;

  constructor(private readonly page: Page, private readonly options: StreamerOptions) {}

  start(): void {
    if (!this.canStream()) {
      logger.debug('Monitor streaming disabled (missing config or task id)');
      return;
    }

    this.intervalId = setInterval(() => {
      void this.captureFrame();
    }, runtimeConfig.MONITOR_CAPTURE_INTERVAL_MS);

    logger.info(
      {
        taskId: this.options.taskId,
        intervalMs: runtimeConfig.MONITOR_CAPTURE_INTERVAL_MS
      },
      'Monitor streamer started'
    );
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private canStream(): boolean {
    return Boolean(
      runtimeConfig.MONITOR_GATEWAY_URL &&
        runtimeConfig.MONITOR_GATEWAY_TOKEN &&
        this.options.taskId
    );
  }

  private async captureFrame(): Promise<void> {
    if (this.sending || !this.canStream()) {
      return;
    }

    this.sending = true;
    try {
      const buffer = await this.page.screenshot({
        type: 'jpeg',
        quality: 60,
        fullPage: false
      });

      const payload = {
        taskId: this.options.taskId,
        profileName: this.options.profileName,
        capturedAt: new Date().toISOString(),
        frame: buffer.toString('base64')
      };

      const response = await fetch(`${runtimeConfig.MONITOR_GATEWAY_URL}/frames`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${runtimeConfig.MONITOR_GATEWAY_TOKEN}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        logger.warn({ status: response.status, text }, 'Failed to push monitor frame');
      }
    } catch (error) {
      logger.warn({ error }, 'Monitor streamer failed to capture frame');
    } finally {
      this.sending = false;
    }
  }
}


