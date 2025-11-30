declare module 'node-telegram-bot-api' {
  export default class TelegramBot {
    constructor(token: string, options?: any);
    sendMessage(chatId: string | number, text: string, options?: any): Promise<any>;
  }
}


