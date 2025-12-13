import type { WebviewToExtensionMessage } from '../../shared/types';

type Logger = {
  debug: (message: string, ...args: unknown[]) => void;
};

type MessageHandlerMap = {
  [K in WebviewToExtensionMessage['command']]?: (
    message: Extract<WebviewToExtensionMessage, { command: K }>
  ) => Promise<void> | void;
};

interface WebviewMessageRouterOptions {
  logger: Logger;
  handlers: MessageHandlerMap;
}

export class WebviewMessageRouter {
  private readonly logger: Logger;
  private readonly handlers: MessageHandlerMap;

  constructor(options: WebviewMessageRouterOptions) {
    this.logger = options.logger;
    this.handlers = options.handlers;
  }

  async handle(message: WebviewToExtensionMessage): Promise<void> {
    this.logger.debug('Received message', message.command);
    const handler = this.handlers[message.command];
    if (handler) {
      await handler(message as never);
    }
  }
}
