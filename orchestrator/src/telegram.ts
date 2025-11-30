import TelegramBot from 'node-telegram-bot-api';
import { logger } from './logger.js';
import { runtimeConfig } from './config.js';

let bot: TelegramBot | null = null;

export function initTelegram(): void {
  if (!runtimeConfig.TELEGRAM_BOT_TOKEN || !runtimeConfig.TELEGRAM_CHAT_ID) {
    logger.warn('Telegram bot token or chat ID not configured, skipping Telegram notifications');
    return;
  }

  bot = new TelegramBot(runtimeConfig.TELEGRAM_BOT_TOKEN);
  logger.info('Telegram bot initialized');
}

export async function sendTelegramMessage(message: string): Promise<void> {
  if (!bot || !runtimeConfig.TELEGRAM_CHAT_ID) {
    return;
  }

  try {
    await bot.sendMessage(runtimeConfig.TELEGRAM_CHAT_ID, message, {
      parse_mode: 'HTML'
    });
  } catch (error) {
    logger.error({ error }, 'Failed to send Telegram message');
  }
}

export async function sendErrorNotification(taskId: string, error: string, profileName?: string): Promise<void> {
  const message = `
🚨 <b>Task Failed</b>

Task ID: <code>${taskId}</code>
${profileName ? `Profile: <code>${profileName}</code>\n` : ''}
Error: <code>${error}</code>
  `.trim();

  await sendTelegramMessage(message);
}


